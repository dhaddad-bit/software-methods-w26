const db = require('../db');
const { ApiError } = require('../lib/apiError');
const {
  syncGoogleEvents,
  listGoogleCalendars,
  normalizeGoogleEventForStorage,
  getGoogleErrorInfo,
  isGoogleAuthError,
  isRetryableGoogleError
} = require('./googleCalendar');

const CALENDAR_SYNC_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = Number.parseInt(process.env.GOOGLE_SYNC_LOCK_TIMEOUT_MS || '5000', 10);
const DEFAULT_LOCK_POLL_MS = Number.parseInt(process.env.GOOGLE_SYNC_LOCK_POLL_MS || '100', 10);
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.GOOGLE_SYNC_RETRY_BASE_DELAY_MS || '1000', 10);
const RETRY_MAX_DELAY_MS = Number.parseInt(process.env.GOOGLE_SYNC_RETRY_MAX_DELAY_MS || '30000', 10);
const MAX_RETRY_ATTEMPTS = Number.parseInt(process.env.GOOGLE_SYNC_MAX_RETRIES || '5', 10);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeLockKey(calendarDbId) {
  return String(9_000_000_000 + Number(calendarDbId || 0));
}

function computeBackoffDelayMs(retryAttempt) {
  const exponent = Math.max(0, Number(retryAttempt || 0));
  const baseDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 250);
  return baseDelay + jitter;
}

async function acquireCalendarSyncLock({ calendarDbId, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS }) {
  const client = await db.pool.connect();
  const lockKey = computeLockKey(calendarDbId);
  const startedAtMs = Date.now();

  try {
    while (Date.now() - startedAtMs <= timeoutMs) {
      const result = await client.query(
        `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
        [lockKey]
      );

      if (result.rows[0]?.locked) {
        return {
          lockKey,
          client
        };
      }

      await sleep(DEFAULT_LOCK_POLL_MS);
    }

    client.release();
    return null;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseCalendarSyncLock(lockHandle) {
  if (!lockHandle?.client) return;

  try {
    await lockHandle.client.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockHandle.lockKey]);
  } catch (_) {
    // lock cleanup is best-effort; releasing the connection still releases session locks.
  } finally {
    lockHandle.client.release();
  }
}

function dedupeCalendarTargets(calendars) {
  const seen = new Set();
  const out = [];

  for (const calendar of calendars) {
    const id = typeof calendar?.id === 'string' ? calendar.id.trim() : '';
    if (!id || seen.has(id)) continue;

    seen.add(id);
    out.push({
      id,
      summary: calendar.summary || id,
      primary: Boolean(calendar.primary),
      selected: calendar.selected !== false
    });
  }

  return out;
}

async function resolveCalendarTargets({ refreshToken, gcalId = 'primary', includeAllCalendars = false }) {
  if (!includeAllCalendars) {
    return [{ id: gcalId || 'primary', summary: gcalId || 'primary', primary: gcalId === 'primary' }];
  }

  const list = await listGoogleCalendars({ refreshToken });
  const filtered = dedupeCalendarTargets(list.filter((entry) => entry.selected !== false));
  if (filtered.length === 0) {
    return [{ id: 'primary', summary: 'primary', primary: true }];
  }

  filtered.sort((left, right) => {
    if (left.primary && !right.primary) return -1;
    if (!left.primary && right.primary) return 1;
    return String(left.summary || left.id).localeCompare(String(right.summary || right.id));
  });

  return filtered;
}

function classifySyncFailure(error) {
  if (error?.code === 'SYNC_LOCK_TIMEOUT') {
    return {
      code: 'SYNC_LOCK_TIMEOUT',
      httpStatus: 503,
      retryable: true,
      message: 'Another sync is in progress for this calendar.',
      details: error?.details || null
    };
  }

  if (
    error?.code === 'GOOGLE_REAUTH_REQUIRED' ||
    error?.code === 'NO_REFRESH_TOKEN' ||
    isGoogleAuthError(error)
  ) {
    return {
      code: 'GOOGLE_REAUTH_REQUIRED',
      httpStatus: 401,
      retryable: false,
      message: 'Google Calendar authorization is invalid or expired. Reconnect Google Calendar.',
      details: getGoogleErrorInfo(error)
    };
  }

  if (error?.code === 'SYNC_TOKEN_EXPIRED') {
    return {
      code: 'SYNC_TOKEN_EXPIRED',
      httpStatus: 409,
      retryable: true,
      message: 'Google sync token expired and must be reset before retry.',
      details: getGoogleErrorInfo(error)
    };
  }

  const details = getGoogleErrorInfo(error);
  if (isRetryableGoogleError(error)) {
    return {
      code: 'GOOGLE_UPSTREAM_ERROR',
      httpStatus: 502,
      retryable: true,
      message: details.message || 'Google Calendar sync failed due to an upstream error.',
      details
    };
  }

  return {
    code: 'GOOGLE_UPSTREAM_ERROR',
    httpStatus: 502,
    retryable: false,
    message: details.message || 'Google Calendar sync failed unexpectedly.',
    details
  };
}

function buildApiErrorFromClassifiedFailure(classified) {
  return new ApiError({
    status: classified.httpStatus,
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    details: classified.details || null
  });
}

function buildNormalizedSyncRows(items, calendarTimeZone = null) {
  const cancelledProviderEventIds = [];
  const eventsForDb = [];
  let invalidEventsSkipped = 0;

  for (const item of items) {
    const normalized = normalizeGoogleEventForStorage(item, calendarTimeZone);
    if (!normalized) {
      invalidEventsSkipped += 1;
      continue;
    }

    if (normalized.status === 'cancelled') {
      cancelledProviderEventIds.push(normalized.providerEventId);
      continue;
    }

    eventsForDb.push(normalized);
  }

  return {
    cancelledProviderEventIds,
    eventsForDb,
    invalidEventsSkipped
  };
}

async function syncSingleCalendarForUserRobust({
  userId,
  refreshToken,
  gcalId,
  calendarName,
  force = false
}) {
  if (!refreshToken) {
    throw new ApiError({
      status: 401,
      code: 'GOOGLE_REAUTH_REQUIRED',
      message: 'No Google refresh token is available for this user.',
      retryable: false
    });
  }

  const calendarRecord = await db.getOrCreateCalendar({
    userId,
    gcalId,
    calendarName: calendarName || gcalId
  });
  const calendarDbId = calendarRecord?.calendar_id;

  if (!calendarDbId) {
    throw new ApiError({
      status: 500,
      code: 'SYNC_STATE_WRITE_FAILED',
      message: 'Failed to create local calendar record for Google sync.',
      retryable: true
    });
  }

  const existingState = await db.getCalendarSyncState(calendarDbId);
  const lastSyncedMs = Date.parse(existingState?.last_synced_at || '');
  if (
    !force &&
    process.env.NODE_ENV !== 'test' &&
    Number.isFinite(lastSyncedMs) &&
    Date.now() - lastSyncedMs < CALENDAR_SYNC_TTL_MS &&
    !existingState?.in_progress
  ) {
    return {
      gcalId,
      calendarName: calendarName || gcalId,
      calendarDbId,
      skipped: true,
      inserted: 0,
      updated: 0,
      cancelled: 0,
      invalidEventsSkipped: 0,
      fetchedItems: 0,
      fullSync: Boolean(existingState?.last_full_synced_at),
      syncTokenUpdated: false,
      attempts: 0
    };
  }

  const lockHandle = await acquireCalendarSyncLock({
    calendarDbId,
    timeoutMs: DEFAULT_LOCK_TIMEOUT_MS
  });

  if (!lockHandle) {
    throw new ApiError({
      status: 503,
      code: 'SYNC_LOCK_TIMEOUT',
      message: 'Calendar sync is already in progress.',
      retryable: true,
      details: { gcalId, calendarDbId }
    });
  }

  const syncStartedAt = new Date();
  let syncRun = null;
  let attempts = 0;

  try {
    await db.getCalendarSyncStateForUpdate(lockHandle.client, calendarDbId);
    await db.markCalendarSyncStarted({
      calendarId: calendarDbId,
      attemptedAt: syncStartedAt,
      startedAt: syncStartedAt
    });

    const latestState = await db.getCalendarSyncState(calendarDbId);
    const startingSyncToken = latestState?.sync_token || null;

    syncRun = await db.createCalendarSyncRun({
      calendarId: calendarDbId,
      attempt: 1,
      syncTokenIn: startingSyncToken,
      startedAt: syncStartedAt
    });

    let workingSyncToken = startingSyncToken;
    let syncResult = null;
    let tokenResetAttempted = false;

    while (attempts <= MAX_RETRY_ATTEMPTS) {
      attempts += 1;

      try {
        syncResult = await syncGoogleEvents({
          refreshToken,
          calendarId: gcalId,
          syncToken: workingSyncToken
        });
        break;
      } catch (error) {
        if (error?.code === 'SYNC_TOKEN_EXPIRED' && workingSyncToken && !tokenResetAttempted) {
          tokenResetAttempted = true;
          workingSyncToken = null;
          continue;
        }

        const classified = classifySyncFailure(error);
        const shouldRetry = classified.retryable && attempts <= MAX_RETRY_ATTEMPTS;
        if (shouldRetry) {
          await sleep(computeBackoffDelayMs(attempts - 1));
          continue;
        }

        const finalRun = syncRun?.run_id || null;
        await db.markCalendarSyncFailed({
          calendarId: calendarDbId,
          lastError: classified.message,
          lastErrorCode: classified.code,
          lastErrorDetails: classified.details,
          needsReauth: classified.code === 'GOOGLE_REAUTH_REQUIRED',
          attemptedAt: new Date()
        });

        if (finalRun) {
          await db.completeCalendarSyncRun({
            runId: finalRun,
            status: 'FAILED',
            finishedAt: new Date(),
            syncTokenOut: workingSyncToken,
            itemsSeen: 0,
            itemsUpserted: 0,
            itemsCancelled: 0,
            errorCode: classified.code,
            errorPayload: classified.details || null
          });
        }

        throw buildApiErrorFromClassifiedFailure(classified);
      }
    }

    if (!syncResult) {
      const classified = classifySyncFailure(new Error('Google sync returned no result'));
      throw buildApiErrorFromClassifiedFailure(classified);
    }

    const items = Array.isArray(syncResult.items) ? syncResult.items : [];
    const { cancelledProviderEventIds, eventsForDb, invalidEventsSkipped } = buildNormalizedSyncRows(items);

    const { inserted, updated } = await db.upsertCalEvents(calendarDbId, eventsForDb);
    const cancelled = await db.markCalEventsCancelled(calendarDbId, cancelledProviderEventIds);

    const completedAt = new Date();
    const nextSyncToken = syncResult.nextSyncToken ?? workingSyncToken ?? null;

    await db.markCalendarSyncSucceeded({
      calendarId: calendarDbId,
      syncToken: nextSyncToken,
      lastSyncedAt: completedAt,
      lastFullSyncedAt: syncResult.fullSync ? completedAt : null
    });

    if (syncRun?.run_id) {
      await db.completeCalendarSyncRun({
        runId: syncRun.run_id,
        status: 'SUCCESS',
        finishedAt: completedAt,
        syncTokenOut: nextSyncToken,
        itemsSeen: items.length,
        itemsUpserted: inserted + updated,
        itemsCancelled: cancelled,
        errorCode: null,
        errorPayload: null
      });
    }

    return {
      gcalId,
      calendarName: calendarName || gcalId,
      calendarDbId,
      skipped: false,
      inserted,
      updated,
      cancelled,
      invalidEventsSkipped,
      fetchedItems: items.length,
      fullSync: Boolean(syncResult.fullSync),
      syncTokenUpdated: nextSyncToken !== startingSyncToken,
      attempts
    };
  } finally {
    await releaseCalendarSyncLock(lockHandle);
  }
}

async function syncCalendarForUserRobust({
  userId,
  refreshToken,
  gcalId = 'primary',
  force = false,
  includeAllCalendars = false
}) {
  const targets = await resolveCalendarTargets({
    refreshToken,
    gcalId,
    includeAllCalendars
  });

  const calendarResults = [];
  const failedCalendars = [];

  for (const target of targets) {
    try {
      const result = await syncSingleCalendarForUserRobust({
        userId,
        refreshToken,
        gcalId: target.id,
        calendarName: target.summary || target.id,
        force
      });
      calendarResults.push(result);
    } catch (error) {
      if (error?.code === 'GOOGLE_REAUTH_REQUIRED' || error?.code === 'SYNC_LOCK_TIMEOUT') {
        throw error;
      }

      failedCalendars.push({
        gcalId: target.id,
        calendarName: target.summary || target.id,
        ...getGoogleErrorInfo(error)
      });
    }
  }

  if (calendarResults.length === 0 && failedCalendars.length > 0) {
    const details = failedCalendars[0] || null;
    throw new ApiError({
      status: 502,
      code: 'GOOGLE_UPSTREAM_ERROR',
      message: 'All calendar sync targets failed.',
      retryable: true,
      details
    });
  }

  return {
    calendarDbId: calendarResults[0]?.calendarDbId || null,
    calendarId: includeAllCalendars ? 'all' : (gcalId || 'primary'),
    skipped: calendarResults.length > 0 && calendarResults.every((entry) => entry.skipped),
    inserted: calendarResults.reduce((total, entry) => total + entry.inserted, 0),
    updated: calendarResults.reduce((total, entry) => total + entry.updated, 0),
    cancelled: calendarResults.reduce((total, entry) => total + entry.cancelled, 0),
    invalidEventsSkipped: calendarResults.reduce(
      (total, entry) => total + (entry.invalidEventsSkipped || 0),
      0
    ),
    fetchedItems: calendarResults.reduce((total, entry) => total + (entry.fetchedItems || 0), 0),
    fullSync: calendarResults.some((entry) => entry.fullSync),
    syncTokenUpdated: calendarResults.some((entry) => entry.syncTokenUpdated),
    calendars: calendarResults,
    failedCalendars,
    calendarTargetCount: targets.length,
    attempts: calendarResults.reduce((total, entry) => total + (entry.attempts || 0), 0)
  };
}

async function syncGroupMembers({
  members,
  gcalId = 'primary',
  force = false,
  includeAllCalendars = false
}) {
  const synced = [];

  for (const member of members) {
    if (!member?.google_refresh_token) {
      throw new ApiError({
        status: 409,
        code: 'MEMBER_SYNC_REAUTH_REQUIRED',
        message: 'One or more group members must reconnect Google Calendar.',
        retryable: false,
        details: {
          members: [
            {
              userId: member?.id || null,
              email: member?.email || null,
              code: 'GOOGLE_REAUTH_REQUIRED'
            }
          ]
        }
      });
    }

    try {
      const result = await syncCalendarForUserRobust({
        userId: member.id,
        refreshToken: member.google_refresh_token,
        gcalId,
        force,
        includeAllCalendars
      });
      synced.push({
        userId: member.id,
        ...result
      });
    } catch (error) {
      if (error?.code === 'GOOGLE_REAUTH_REQUIRED') {
        throw new ApiError({
          status: 409,
          code: 'MEMBER_SYNC_REAUTH_REQUIRED',
          message: 'One or more group members must reconnect Google Calendar.',
          retryable: false,
          details: {
            members: [
              {
                userId: member.id,
                email: member.email || null,
                code: 'GOOGLE_REAUTH_REQUIRED'
              }
            ]
          }
        });
      }
      throw error;
    }
  }

  return synced;
}

module.exports = {
  classifySyncFailure,
  computeBackoffDelayMs,
  resolveCalendarTargets,
  syncSingleCalendarForUserRobust,
  syncCalendarForUserRobust,
  syncGroupMembers
};
