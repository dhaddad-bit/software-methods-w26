// requirements
const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
const path = require('path');
const db = require('./db/index');
const session = require('express-session');
const url = require('url');
const pgSession = require('connect-pg-simple')(session);
const { computeAvailabilityBlocks } = require('./algorithm/index.cjs');
const { syncGoogleEvents, listGoogleCalendars } = require('./services/googleCalendar');
const {
  syncCalendarForUserRobust,
  syncGroupMembers,
  classifySyncFailure
} = require('./services/syncCoordinator');
const { repairCalendarsForUser } = require('./services/syncRepair');
const { normalizeErrorPayload, sendError } = require('./lib/apiError');
const { attachRequestId, logRequestCompletion } = require('./lib/requestId');
const {
  computeInviteExpiry,
  buildInviteToken,
  parseInviteToken
} = require('./invites/service');
const {
  normalizeNotificationLimit,
  normalizeNotificationOffset,
  mapNotificationRow
} = require('./notifications/service');

// .env config
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
});
console.log('Database URL Check:', process.env.DATABASE_URL ? 'Found it!' : 'It is UNDEFINED');

console.log('ENV:', process.env.NODE_ENV);
console.log('Frontend URL:', process.env.FRONTEND_URL);

const frontend = process.env.FRONTEND_URL;
const app = express();

const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());
app.set('trust proxy', 1);
app.use(attachRequestId);
app.use(logRequestCompletion());

app.use(
  session({
    store: new pgSession({
      pool: db.pool,
      tableName: 'session',
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    }
  })
);

app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: false }));

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const isApiRoute = req.path.startsWith('/api') || req.path.startsWith('/test');

  res.json = (body) => {
    if (
      isApiRoute &&
      res.statusCode >= 400 &&
      body &&
      typeof body === 'object' &&
      Object.prototype.hasOwnProperty.call(body, 'error')
    ) {
      return originalJson(normalizeErrorPayload(body, res.statusCode, req.requestId));
    }
    return originalJson(body);
  };

  next();
});

const defaultRedirectUri = isProduction
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'YOUR-APP-NAME.onrender.com'}/oauth2callback`
  : 'http://localhost:3000/oauth2callback';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || defaultRedirectUri;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

const scopes = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const PORT = process.env.PORT || 3000;
let oauthCodeExchange = async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  return { tokens, userInfo };
};

function setOAuthCodeExchangeForTest(handler) {
  if (typeof handler !== 'function') {
    throw new Error('handler must be a function');
  }
  oauthCodeExchange = handler;
}

function resetOAuthCodeExchangeForTest() {
  oauthCodeExchange = async (code) => {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    return { tokens, userInfo };
  };
}

function isValidOAuthState(sessionState, queryState) {
  if (typeof sessionState !== 'string' || !sessionState) return false;
  if (typeof queryState !== 'string' || !queryState) return false;

  const expectedBuffer = Buffer.from(sessionState);
  const providedBuffer = Buffer.from(queryState);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  return next();
}

async function requireGroupMember(req, res, next) {
  const groupId = Number.parseInt(req.params.groupId, 10);
  if (!Number.isInteger(groupId)) {
    return res.status(400).json({ error: 'Invalid groupId' });
  }

  const group = await db.getGroupById(groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const isMember = await db.isUserInGroup(groupId, req.session.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.group = group;
  req.groupId = groupId;
  return next();
}

function parseTimeParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && String(value).match(/^\d+$/)) {
    return numeric;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function parseBooleanParam(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toEpochMs(value) {
  if (!value) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeGoogleDateString(value) {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
    // Date-only events: treat as midnight UTC (MVP behavior).
    return `${value}T00:00:00Z`;
  }
  return value;
}

function getGoogleErrorDetails(error) {
  const status = error?.code || error?.response?.status || error?.status || 500;
  const data = error?.response?.data;
  const nestedError = data?.error;
  const oauthError =
    typeof nestedError === 'string'
      ? nestedError
      : typeof nestedError?.status === 'string'
        ? nestedError.status
        : null;
  const oauthDescription =
    typeof data?.error_description === 'string' ? data.error_description : null;
  const reason =
    data?.error?.errors?.[0]?.reason ||
    data?.error?.details?.[0]?.reason ||
    null;
  const message =
    oauthDescription ||
    data?.error?.message ||
    error?.message ||
    'Unknown Google API error';

  return {
    status,
    oauthError,
    oauthDescription,
    reason,
    message
  };
}

function classifyGoogleSyncFailure(error) {
  if (error?.code === 'NO_REFRESH_TOKEN') {
    return {
      code: 'NO_REFRESH_TOKEN',
      message: 'Google Calendar access missing/expired. Please log out and log in with Google again.'
    };
  }
  if (error?.code === 'SYNC_TOKEN_EXPIRED') {
    return {
      code: 'SYNC_TOKEN_EXPIRED',
      message: 'Google sync token expired; full re-sync is required.'
    };
  }

  const details = getGoogleErrorDetails(error);
  const combined = `${details.oauthError || ''} ${details.oauthDescription || ''} ${details.message || ''}`
    .trim()
    .toLowerCase();

  if (combined.includes('invalid_grant') || combined.includes('invalid credentials')) {
    return {
      code: 'INVALID_GRANT',
      message: 'Google refresh token is invalid or revoked. User must re-authenticate.',
      details
    };
  }
  if (combined.includes('could not determine client id from request')) {
    return {
      code: 'GOOGLE_CLIENT_CONFIG_ERROR',
      message: 'Google OAuth client configuration mismatch (client ID / secret / redirect URI).',
      details
    };
  }
  if (details.status === 401 || details.status === 403) {
    return {
      code: 'GOOGLE_AUTH_EXPIRED',
      message: 'Google authentication expired or lacks required permissions.',
      details
    };
  }
  if (details.status === 400) {
    return {
      code: 'GOOGLE_BAD_REQUEST',
      message: details.message || 'Google API rejected the sync request.',
      details
    };
  }

  return {
    code: 'GOOGLE_SYNC_FAILED',
    message: details.message || 'Google calendar sync failed unexpectedly.',
    details
  };
}

const VALID_BLOCKING_LEVELS = new Set(['B1', 'B2', 'B3']);
const VALID_AVAILABILITY_LEVELS = new Set(['AVAILABLE', 'FLEXIBLE', 'MAYBE']);

function isGoogleAuthExpiredError(error) {
  const status = error?.code || error?.response?.status || error?.status;
  if (status === 401 || status === 403) return true;

  const data = error?.response?.data;
  const oauthError = typeof data?.error === 'string' ? data.error : '';
  const oauthDescription = typeof data?.error_description === 'string' ? data.error_description : '';

  const message = typeof error?.message === 'string' ? error.message : '';
  const combined = `${oauthError} ${oauthDescription} ${message}`.toLowerCase();

  if (combined.includes('invalid_grant')) return true;
  if (combined.includes('invalid credentials')) return true;

  return false;
}

function normalizeAvailabilityLevel(raw) {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (VALID_AVAILABILITY_LEVELS.has(value)) return value;
  return 'MAYBE';
}

function availabilityLevelToMinBlockingLevel(level) {
  const normalized = normalizeAvailabilityLevel(level);
  if (normalized === 'AVAILABLE') return 'B3';
  if (normalized === 'FLEXIBLE') return 'B2';
  return 'B1'; // MAYBE (strict)
}

function resolveInviteStatus(inviteRow) {
  if (!inviteRow) return null;
  if (inviteRow.status !== 'PENDING') return inviteRow.status;
  const expiresAtMs = toEpochMs(inviteRow.expires_at);
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
    return 'EXPIRED';
  }
  return inviteRow.status;
}

function mapInviteRow(inviteRow, options = {}) {
  if (!inviteRow) return null;
  const status = resolveInviteStatus(inviteRow);
  const mapped = {
    inviteId: inviteRow.invite_id,
    groupId: inviteRow.group_id,
    createdByUserId: inviteRow.created_by_user_id,
    targetEmail: inviteRow.target_email,
    status,
    expiresAt: inviteRow.expires_at,
    acceptedByUserId: inviteRow.accepted_by_user_id,
    acceptedAt: inviteRow.accepted_at,
    revokedByUserId: inviteRow.revoked_by_user_id,
    revokedAt: inviteRow.revoked_at,
    createdAt: inviteRow.created_at,
    updatedAt: inviteRow.updated_at
  };
  if (options.token) {
    mapped.token = options.token;
  }
  return mapped;
}

function buildInviteLink(req, token) {
  const frontendBase =
    typeof process.env.FRONTEND_URL === 'string' && process.env.FRONTEND_URL.trim()
      ? process.env.FRONTEND_URL.replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host')}`;
  return `${frontendBase}/invite/${encodeURIComponent(token)}`;
}

const PETITION_GRANULARITY_MINUTES = 15;
const PETITION_PRIORITY_DEFAULT = 'HIGHEST';
const MAX_GROUP_MEMBERS = 8;

const CALENDAR_SYNC_TTL_MS = 5 * 60 * 1000;

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

async function syncSingleGoogleCalendar({
  userId,
  refreshToken,
  gcalId,
  calendarName,
  force = false
}) {
  if (!refreshToken) {
    const err = new Error('No refresh token for user');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }

  const calendarRecord = await db.getOrCreateCalendar({
    userId,
    gcalId,
    calendarName: calendarName || gcalId
  });

  const calendarDbId = calendarRecord?.calendar_id;
  if (!calendarDbId) {
    throw new Error('Failed to create calendar record');
  }

  const existingState = await db.getCalendarSyncState(calendarDbId);
  const lastSyncedMs = toEpochMs(existingState?.last_synced_at);

  if (
    !force &&
    process.env.NODE_ENV !== 'test' &&
    Number.isFinite(lastSyncedMs) &&
    Date.now() - lastSyncedMs < CALENDAR_SYNC_TTL_MS
  ) {
    return {
      gcalId,
      calendarName: calendarName || gcalId,
      calendarDbId,
      skipped: true,
      inserted: 0,
      updated: 0,
      cancelled: 0,
      fullSync: Boolean(existingState?.last_full_synced_at),
      fetchedItems: 0,
      syncTokenUpdated: false
    };
  }

  const startingSyncToken = existingState?.sync_token || null;
  let syncToken = startingSyncToken;

  let syncResult;
  try {
    syncResult = await syncGoogleEvents({ refreshToken, calendarId: gcalId, syncToken });
  } catch (error) {
    if (error?.code === 'SYNC_TOKEN_EXPIRED') {
      syncToken = null;
      syncResult = await syncGoogleEvents({ refreshToken, calendarId: gcalId, syncToken: null });
    } else if (isGoogleAuthExpiredError(error)) {
      const err = new Error('Google authentication expired');
      err.code = 'NO_REFRESH_TOKEN';
      err.cause = error;
      throw err;
    } else {
      throw error;
    }
  }

  const items = Array.isArray(syncResult?.items) ? syncResult.items : [];
  const cancelledProviderEventIds = [];
  const eventsForDb = [];
  let invalidEventsSkipped = 0;

  for (const item of items) {
    const providerEventId = item?.id;
    if (!providerEventId) continue;

    const status = typeof item.status === 'string' ? item.status : 'confirmed';
    if (status === 'cancelled') {
      cancelledProviderEventIds.push(providerEventId);
      continue;
    }

    const start = normalizeGoogleDateString(item?.start?.dateTime || item?.start?.date);
    const end = normalizeGoogleDateString(item?.end?.dateTime || item?.end?.date);
    if (!start || !end) continue;

    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      invalidEventsSkipped += 1;
      continue;
    }

    const originalStartTime = normalizeGoogleDateString(
      item?.originalStartTime?.dateTime || item?.originalStartTime?.date
    );

    eventsForDb.push({
      providerEventId,
      iCalUID: item.iCalUID || null,
      recurringEventId: item.recurringEventId || null,
      originalStartTime: originalStartTime || null,
      title: item.summary || null,
      start,
      end,
      status,
      providerUpdatedAt: item.updated || null,
      etag: item.etag || null
    });
  }

  const { inserted, updated } = await db.upsertCalEvents(calendarDbId, eventsForDb);
  const cancelled = await db.markCalEventsCancelled(calendarDbId, cancelledProviderEventIds);

  const now = new Date();
  const nextSyncToken = syncResult?.nextSyncToken ?? syncToken ?? null;
  const nextState = {
    calendarId: calendarDbId,
    syncToken: nextSyncToken,
    lastSyncedAt: now,
    lastFullSyncedAt: syncResult?.fullSync ? now : existingState?.last_full_synced_at || null,
    lastError: null
  };
  await db.upsertCalendarSyncState(nextState);

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
    fullSync: Boolean(syncResult?.fullSync),
    syncTokenUpdated: nextSyncToken !== startingSyncToken
  };
}

async function syncCalendarForUser({
  userId,
  refreshToken,
  gcalId = 'primary',
  force = false,
  includeAllCalendars = false
}) {
  if (!refreshToken) {
    const err = new Error('No refresh token for user');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }

  const targets = await resolveCalendarTargets({
    refreshToken,
    gcalId,
    includeAllCalendars
  });

  const calendarResults = [];
  const failedCalendars = [];

  for (const target of targets) {
    try {
      const result = await syncSingleGoogleCalendar({
        userId,
        refreshToken,
        gcalId: target.id,
        calendarName: target.summary || target.id,
        force
      });
      calendarResults.push(result);
    } catch (error) {
      if (error?.code === 'NO_REFRESH_TOKEN') {
        throw error;
      }

      failedCalendars.push({
        gcalId: target.id,
        calendarName: target.summary || target.id,
        ...getGoogleErrorDetails(error)
      });
    }
  }

  if (calendarResults.length === 0 && failedCalendars.length > 0) {
    const err = new Error('All calendar sync targets failed');
    err.code = 'GOOGLE_SYNC_FAILED';
    err.failedCalendars = failedCalendars;
    throw err;
  }

  return {
    calendarDbId: calendarResults[0]?.calendarDbId || null,
    calendarId: includeAllCalendars ? 'all' : (gcalId || 'primary'),
    skipped: calendarResults.every((entry) => entry.skipped),
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
    calendarTargetCount: targets.length
  };
}

async function buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs) {
  const members = await db.getGroupMembersWithTokens(groupId);
  const memberIds = members.map((member) => member.id);

  if (process.env.NODE_ENV !== 'test') {
    await syncGroupMembers({
      members,
      gcalId: 'primary',
      force: false,
      includeAllCalendars: parseBooleanParam(
        process.env.GOOGLE_SYNC_ALL_CALENDARS_DEFAULT,
        false
      )
    });
  }

  const participantsById = new Map(
    memberIds.map((id) => [String(id), { userId: String(id), events: [] }])
  );

  const [googleRows, busyRows] = await Promise.all([
    db.listGoogleEventsForUsers({ userIds: memberIds, windowStartMs, windowEndMs }),
    db.listUserBusyBlocksForUsers({ userIds: memberIds, windowStartMs, windowEndMs })
  ]);

  googleRows.forEach((row) => {
    const userId = String(row.user_id);
    const participant = participantsById.get(userId);
    if (!participant) return;

    const startMs = toEpochMs(row.event_start);
    const endMs = toEpochMs(row.event_end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    participant.events.push({
      eventRef: `google-${row.provider_event_id}`,
      userId,
      startMs,
      endMs,
      source: 'google',
      blockingLevel: row.blocking_level
    });
  });

  busyRows.forEach((row) => {
    const userId = String(row.user_id);
    const participant = participantsById.get(userId);
    if (!participant) return;

    const startMs = toEpochMs(row.start_time);
    const endMs = toEpochMs(row.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    participant.events.push({
      eventRef: `busy-${row.busy_block_id}`,
      userId,
      startMs,
      endMs,
      source: 'manual',
      blockingLevel: row.blocking_level
    });
  });

  const petitions = await db.listPetitionsForAvailability({
    userIds: memberIds,
    windowStartMs,
    windowEndMs
  });

  petitions.forEach((petition) => {
    if (petition.status === 'FAILED') return;
    const startMs = toEpochMs(petition.start_time);
    const endMs = toEpochMs(petition.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    const acceptedIds = Array.isArray(petition.accepted_user_ids) ? petition.accepted_user_ids : [];

    acceptedIds.forEach((acceptedUserId) => {
      const participant = participantsById.get(String(acceptedUserId));
      if (!participant) return;
      participant.events.push({
        eventRef: `petition-${petition.id}`,
        userId: String(acceptedUserId),
        startMs,
        endMs,
        source: 'petition',
        blockingLevel: 'B3'
      });
    });
  });

  return [...participantsById.values()];
}

async function computeGroupAvailability({
  groupId,
  windowStartMs,
  windowEndMs,
  granularityMinutes,
  level
}) {
  const participants = await buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs);
  const minBlockingLevel = availabilityLevelToMinBlockingLevel(level);
  return computeAvailabilityBlocks({
    windowStartMs,
    windowEndMs,
    participants,
    granularityMinutes,
    priority: minBlockingLevel
  });
}

// ===================PAGES========================

app.get('/', (req, res) => {
  if (typeof req.session.userId !== 'undefined') {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html'));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  const user = await db.getUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  return res.json({ id: user.id, email: user.email, name: user.name });
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return console.log(err);
    }
    res.redirect('/login');
  });
});

// Database test route
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await db.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/auth/google', async (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.state = state;

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    include_granted_scopes: true,
    state: state,
    prompt: 'consent select_account'
  });
  res.redirect(authorizationUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const q = url.parse(req.url, true).query;

  if (q.error) {
    console.log(q);
    return res.redirect(frontend + '/error.html');
  }

  const queryState = typeof q.state === 'string' ? q.state : '';
  const sessionState = req.session?.state;

  if (!isValidOAuthState(sessionState, queryState)) {
    delete req.session.state;
    return res.redirect(frontend + '/error.html?error=invalid_state');
  }

  delete req.session.state;

  try {
    const { tokens, userInfo } = await oauthCodeExchange(q.code);

    const displayName = userInfo.name || `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim();
    const refreshToken = tokens.refresh_token || null;

    const user = await db.upsertUserFromGoogle(
      userInfo.id,
      userInfo.email,
      displayName,
      refreshToken
    );

    req.session.userId = user.id;
    req.session.isAuthenticated = true;

    await new Promise((resolve, reject) => {
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session Save Error:', saveErr);
          reject(saveErr);
        } else {
          resolve();
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    res.redirect('/');
  } catch (authErr) {
    console.error('Login failed', authErr);
    res.redirect('/login fail');
  }
});

// ===================GROUPS========================

app.post('/api/groups', requireAuth, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  const group = await db.createGroup(name, req.session.userId);
  await db.addGroupMember(group.id, req.session.userId, 'owner');

  return res.status(201).json(group);
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await db.listGroupsForUser(req.session.userId);
  return res.json(groups);
});

app.get('/api/groups/:groupId/members', requireAuth, requireGroupMember, async (req, res) => {
  const members = await db.getGroupMembers(req.groupId);
  return res.json(members);
});

app.post('/api/groups/:groupId/members', requireAuth, requireGroupMember, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = await db.getUserByEmail(email);
  if (!user) {
    // MVP: no invites; user must have logged in before
    return res.status(404).json({ error: 'User not found. User must log in first.' });
  }

  if (String(user.id) === String(req.session.userId)) {
    return res.status(400).json({ error: 'Cannot add yourself; you are already a member.' });
  }

  try {
    const result = await db.addGroupMemberWithLimit({
      groupId: req.groupId,
      userId: user.id,
      role: null,
      maxMembers: MAX_GROUP_MEMBERS
    });

    if (result.status === 'ALREADY_MEMBER') {
      return res.status(409).json({ error: 'User is already a member.' });
    }
  } catch (error) {
    if (error.code === 'GROUP_MEMBER_LIMIT') {
      return res.status(400).json({ error: `Group member limit reached (${MAX_GROUP_MEMBERS}).` });
    }
    console.error('Error adding group member', error);
    return res.status(500).json({ error: 'Failed to add member' });
  }
  return res.status(200).json({ id: user.id, email: user.email, name: user.name });
});

app.delete(
  '/api/groups/:groupId/members/:userId',
  requireAuth,
  requireGroupMember,
  async (req, res) => {
    const targetUserId = Number.parseInt(req.params.userId, 10);
    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (targetUserId === Number(req.group.created_by_user_id)) {
      return res.status(400).json({ error: 'Cannot remove the group creator from the group.' });
    }

    const requesterIsCreator = Number(req.group.created_by_user_id) === Number(req.session.userId);
    const requesterIsTarget = Number(req.session.userId) === targetUserId;

    if (!requesterIsCreator && !requesterIsTarget) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const wasMember = await db.isUserInGroup(req.groupId, targetUserId);
    if (!wasMember) {
      return res.json({ ok: true, alreadyRemoved: true });
    }

    const deletedCount = await db.removeGroupMember({
      groupId: req.groupId,
      userId: targetUserId
    });

    return res.json({ ok: true, alreadyRemoved: deletedCount === 0 });
  }
);

app.post('/api/groups/:groupId/invites', requireAuth, requireGroupMember, async (req, res) => {
  const targetEmailRaw = typeof req.body?.targetEmail === 'string' ? req.body.targetEmail : '';
  const targetEmail = targetEmailRaw.trim().toLowerCase() || null;
  const ttlHoursRaw = req.body?.ttlHours;
  let ttlHours = undefined;

  if (ttlHoursRaw !== undefined && ttlHoursRaw !== null && ttlHoursRaw !== '') {
    const parsed = Number.parseInt(ttlHoursRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 24 * 30) {
      return res.status(400).json({ error: 'ttlHours must be an integer between 1 and 720' });
    }
    ttlHours = parsed;
  }

  const expiresAt = computeInviteExpiry({ ttlHours });
  const invite = await db.createGroupInvite({
    groupId: req.groupId,
    createdByUserId: req.session.userId,
    targetEmail,
    expiresAt
  });

  const token = buildInviteToken({
    inviteId: invite.invite_id,
    groupId: invite.group_id,
    expiresAt: invite.expires_at
  });

  return res.status(201).json({
    ...mapInviteRow(invite, { token }),
    inviteLink: buildInviteLink(req, token)
  });
});

app.get('/api/groups/:groupId/invites', requireAuth, requireGroupMember, async (req, res) => {
  const invites = await db.listGroupInvites({ groupId: req.groupId });
  return res.json(invites.map((row) => mapInviteRow(row)));
});

app.delete('/api/groups/:groupId/invites/:inviteId', requireAuth, requireGroupMember, async (req, res) => {
  const inviteId = Number.parseInt(req.params.inviteId, 10);
  if (!Number.isInteger(inviteId)) {
    return res.status(400).json({ error: 'Invalid inviteId' });
  }

  const outcome = await db.revokeGroupInvite({
    groupId: req.groupId,
    inviteId,
    revokedByUserId: req.session.userId
  });

  if (outcome.status === 'NOT_FOUND') {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (outcome.status === 'CONFLICT_ACCEPTED') {
    return res.status(409).json({
      error: 'Invite has already been accepted and cannot be revoked',
      invite: mapInviteRow(outcome.invite)
    });
  }

  return res.json({
    ok: true,
    status: outcome.status,
    alreadyRevoked: outcome.status === 'ALREADY_REVOKED',
    alreadyExpired: outcome.status === 'ALREADY_EXPIRED',
    invite: mapInviteRow(outcome.invite)
  });
});

app.get('/api/invites/:token', async (req, res) => {
  const verification = parseInviteToken(req.params.token);
  if (!verification.valid && verification.reason !== 'expired') {
    return res.status(400).json({ error: 'Invalid invite token', reason: verification.reason });
  }

  if (!Number.isInteger(verification.inviteId) || verification.inviteId <= 0) {
    return res.status(400).json({ error: 'Unsupported invite token version' });
  }

  const invite = await db.getGroupInviteById(verification.inviteId);
  if (!invite) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (invite.group_id !== verification.groupId) {
    return res.status(400).json({ error: 'Invite token does not match invitation record' });
  }

  const group = await db.getGroupById(invite.group_id);
  const status = resolveInviteStatus(invite);

  return res.json({
    invite: mapInviteRow({ ...invite, status }),
    group: group ? { id: group.id, name: group.name } : null,
    canAccept: status === 'PENDING',
    tokenStatus: verification.valid ? 'VALID' : String(verification.reason || 'invalid').toUpperCase()
  });
});

app.post('/api/invites/:token/accept', requireAuth, async (req, res) => {
  const verification = parseInviteToken(req.params.token);
  if (!verification.valid) {
    const statusCode = verification.reason === 'expired' ? 410 : 400;
    return res.status(statusCode).json({
      error: verification.reason === 'expired' ? 'Invite token expired' : 'Invalid invite token',
      reason: verification.reason
    });
  }

  if (!Number.isInteger(verification.inviteId) || verification.inviteId <= 0) {
    return res.status(400).json({ error: 'Unsupported invite token version' });
  }

  const invite = await db.getGroupInviteById(verification.inviteId);
  if (!invite) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (invite.group_id !== verification.groupId) {
    return res.status(400).json({ error: 'Invite token does not match invitation record' });
  }

  if (invite.target_email) {
    const currentUser = await db.getUserById(req.session.userId);
    const currentEmail = (currentUser?.email || '').trim().toLowerCase();
    if (currentEmail !== invite.target_email.trim().toLowerCase()) {
      return res.status(403).json({ error: 'Invite is restricted to a different email address' });
    }
  }

  const accepted = await db.acceptGroupInvite({
    inviteId: verification.inviteId,
    tokenGroupId: verification.groupId,
    userId: req.session.userId,
    maxMembers: MAX_GROUP_MEMBERS
  });

  if (accepted.status === 'NOT_FOUND') {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (accepted.status === 'TOKEN_GROUP_MISMATCH') {
    return res.status(400).json({ error: 'Invite token does not match invitation record' });
  }
  if (accepted.status === 'REVOKED') {
    return res.status(410).json({ error: 'Invite has been revoked' });
  }
  if (accepted.status === 'EXPIRED') {
    return res.status(410).json({ error: 'Invite has expired' });
  }
  if (accepted.status === 'GROUP_MEMBER_LIMIT') {
    return res.status(409).json({ error: `Group member limit reached (${MAX_GROUP_MEMBERS}).` });
  }
  if (accepted.status === 'INVALID_STATE') {
    return res.status(409).json({ error: 'Invite is not in an acceptable state' });
  }

  return res.json({
    ok: true,
    status: accepted.status,
    alreadyMember: accepted.status === 'ALREADY_MEMBER',
    alreadyAccepted: accepted.status === 'ALREADY_ACCEPTED',
    invite: mapInviteRow(accepted.invite)
  });
});

app.delete('/api/groups/:groupId', requireAuth, requireGroupMember, async (req, res) => {
  if (String(req.group.created_by_user_id) !== String(req.session.userId)) {
    return res.status(403).json({ error: 'Only the group creator can delete this group.' });
  }

  try {
    await db.deleteGroup({ groupId: req.groupId });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting group', error);
    return res.status(500).json({ error: 'Failed to delete group' });
  }
});

// ===================PETITIONS========================

app.post('/api/groups/:groupId/petitions', requireAuth, requireGroupMember, async (req, res) => {
  const startMs = parseTimeParam(req.body?.start);
  const endMs = parseTimeParam(req.body?.end);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const level = normalizeAvailabilityLevel(req.body?.level);
  let priority =
    typeof req.body?.priority === 'string' && req.body.priority.trim()
      ? req.body.priority.trim().toUpperCase()
      : PETITION_PRIORITY_DEFAULT;
  if (!['HIGHEST', 'HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
    priority = PETITION_PRIORITY_DEFAULT;
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
  }
  if (endMs <= startMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  const blockMs = PETITION_GRANULARITY_MINUTES * 60 * 1000;
  if (startMs % blockMs !== 0 || endMs % blockMs !== 0) {
    return res.status(400).json({ error: 'start and end must align to 15-minute blocks' });
  }

  try {
    const blocks = await computeGroupAvailability({
      groupId: req.groupId,
      windowStartMs: startMs,
      windowEndMs: endMs,
      granularityMinutes: PETITION_GRANULARITY_MINUTES,
      level
    });

    const windowBlocks = blocks.filter(
      (block) => block.startMs >= startMs && block.endMs <= endMs
    );
    if (windowBlocks.length === 0) {
      return res.status(400).json({ error: 'Invalid petition window' });
    }

    const allFree = windowBlocks.every((block) => block.availableCount === block.totalCount);
    if (!allFree) {
      return res
        .status(400)
        .json({ error: 'Selected window is not fully available for all members' });
    }

    const petitionResult = await db.createPetitionWithNotifications({
      groupId: req.groupId,
      createdByUserId: req.session.userId,
      title: title || 'Petitioned Meeting',
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      priority: priority || PETITION_PRIORITY_DEFAULT,
      status: 'OPEN'
    });
    const { petition, groupSize } = petitionResult;

    return res.status(201).json({
      ...petition,
      group_name: req.group.name,
      acceptedCount: 1,
      declinedCount: 0,
      groupSize,
      currentUserResponse: 'ACCEPTED'
    });
  } catch (error) {
    if (error.code === 'NO_REFRESH_TOKEN') {
      return res.status(400).json({ error: 'One or more members need to re-authenticate.' });
    }
    console.error('Error creating petition', error);
    return res.status(500).json({ error: 'Failed to create petition' });
  }
});

app.get('/api/groups/:groupId/petitions', requireAuth, requireGroupMember, async (req, res) => {
  const petitions = await db.listGroupPetitions({
    groupId: req.groupId,
    userId: req.session.userId
  });
  return res.json(petitions);
});

app.get('/api/petitions', requireAuth, async (req, res) => {
  const petitions = await db.listUserPetitions({ userId: req.session.userId });
  return res.json(petitions);
});

app.post('/api/petitions/:petitionId/respond', requireAuth, async (req, res) => {
  const petitionId = Number.parseInt(req.params.petitionId, 10);
  if (!Number.isInteger(petitionId)) {
    return res.status(400).json({ error: 'Invalid petitionId' });
  }

  const responseValue = typeof req.body?.response === 'string' ? req.body.response.trim() : '';
  if (!['ACCEPT', 'DECLINE'].includes(responseValue.toUpperCase())) {
    return res.status(400).json({ error: 'response must be ACCEPT or DECLINE' });
  }
  const normalizedResponse = responseValue.toUpperCase() === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';

  const petition = await db.getPetitionById(petitionId);
  if (!petition) {
    return res.status(404).json({ error: 'Petition not found' });
  }

  const isMember = await db.isUserInGroup(petition.group_id, req.session.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const responseResult = await db.respondToPetitionWithNotifications({
    petitionId,
    userId: req.session.userId,
    response: normalizedResponse
  });

  return res.json({
    ...responseResult.petition,
    acceptedCount: responseResult.acceptedCount,
    declinedCount: responseResult.declinedCount,
    groupSize: responseResult.groupSize,
    currentUserResponse: normalizedResponse
  });
});

app.delete('/api/petitions/:petitionId', requireAuth, async (req, res) => {
  const petitionId = Number.parseInt(req.params.petitionId, 10);
  if (!Number.isInteger(petitionId)) {
    return res.status(400).json({ error: 'Invalid petitionId' });
  }

  const petition = await db.getPetitionById(petitionId);
  if (!petition) {
    return res.status(404).json({ error: 'Petition not found' });
  }

  if (petition.created_by_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (petition.status !== 'FAILED') {
    return res.status(400).json({ error: 'Only FAILED petitions can be deleted' });
  }

  await db.deletePetition(petitionId);
  return res.json({ ok: true });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  const limit = normalizeNotificationLimit(req.query.limit);
  const offset = normalizeNotificationOffset(req.query.offset);

  const notifications = await db.listNotificationsForUser({
    userId: req.session.userId,
    limit,
    offset
  });

  return res.json({
    limit,
    offset,
    items: notifications.map((row) => mapNotificationRow(row))
  });
});

app.post('/api/notifications/:notificationId/read', requireAuth, async (req, res) => {
  const notificationId = Number.parseInt(req.params.notificationId, 10);
  if (!Number.isInteger(notificationId)) {
    return res.status(400).json({ error: 'Invalid notificationId' });
  }

  const updated = await db.markNotificationRead({
    userId: req.session.userId,
    notificationId
  });
  if (!updated) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  return res.json(mapNotificationRow(updated));
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  const updatedCount = await db.markAllNotificationsRead({
    userId: req.session.userId
  });
  return res.json({ ok: true, updatedCount });
});

app.delete('/api/notifications/:notificationId', requireAuth, async (req, res) => {
  const notificationId = Number.parseInt(req.params.notificationId, 10);
  if (!Number.isInteger(notificationId)) {
    return res.status(400).json({ error: 'Invalid notificationId' });
  }

  const deleted = await db.deleteNotificationForUser({
    userId: req.session.userId,
    notificationId
  });

  return res.json({
    ok: true,
    alreadyDeleted: deleted === 0
  });
});

// ===================AVAILABILITY========================

app.get('/api/groups/:groupId/availability', requireAuth, requireGroupMember, async (req, res) => {
  const windowStartMs = parseTimeParam(req.query.start);
  const windowEndMs = parseTimeParam(req.query.end);
  const granularityRaw = req.query.granularity;
  const level = normalizeAvailabilityLevel(req.query.level);

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
  }
  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  let granularityMinutes;
  if (granularityRaw !== undefined) {
    granularityMinutes = Number.parseInt(granularityRaw, 10);
    if (!Number.isInteger(granularityMinutes) || granularityMinutes <= 0) {
      return res.status(400).json({ error: 'granularity must be a positive integer (minutes)' });
    }
  }

  try {
    const blocks = await computeGroupAvailability({
      groupId: req.groupId,
      windowStartMs,
      windowEndMs,
      granularityMinutes: granularityMinutes || undefined,
      level
    });
    return res.json(blocks);
  } catch (error) {
    if (error.code === 'MEMBER_SYNC_REAUTH_REQUIRED') {
      return res.status(409).json({
        error: error.message || 'One or more members need to reconnect Google Calendar.',
        code: 'MEMBER_SYNC_REAUTH_REQUIRED',
        retryable: false,
        details: error.details || null
      });
    }
    console.error('Error computing availability', error);
    return res.status(500).json({ error: 'Failed to compute availability' });
  }
});

// ===================CALENDAR EVENTS========================

app.post('/api/google/sync', requireAuth, async (req, res) => {
  const calendarId =
    typeof req.body?.calendarId === 'string' && req.body.calendarId.trim()
      ? req.body.calendarId.trim()
      : 'primary';
  const force = Boolean(req.body?.force);
  const allowAllCalendars = parseBooleanParam(
    process.env.GOOGLE_SYNC_ALLOW_ALL_CALENDARS,
    false
  );
  const requestedIncludeAllCalendars = parseBooleanParam(
    req.body?.includeAllCalendars,
    parseBooleanParam(process.env.GOOGLE_SYNC_ALL_CALENDARS_DEFAULT, false)
  );
  const includeAllCalendars = allowAllCalendars && requestedIncludeAllCalendars;
  const diagnosticsRequested = parseBooleanParam(req.body?.diagnostics, false);
  const windowStartMs = parseTimeParam(req.body?.windowStartMs);
  const windowEndMs = parseTimeParam(req.body?.windowEndMs);

  try {
    const user = await db.getUserById(req.session.userId);
    if (!user || !user.google_refresh_token) {
      return res.status(401).json({
        error: 'Google Calendar access missing/expired. Please reconnect Google Calendar.',
        code: 'GOOGLE_REAUTH_REQUIRED'
      });
    }

    const result = await syncCalendarForUserRobust({
      userId: req.session.userId,
      refreshToken: user.google_refresh_token,
      gcalId: calendarId,
      force,
      includeAllCalendars
    });

    let diagnostics = undefined;
    if (diagnosticsRequested) {
      const totalCountResult = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM cal_event e
         INNER JOIN calendar c ON c.calendar_id = e.calendar_id
         WHERE c.user_id = $1
           AND e.status != 'cancelled'`,
        [req.session.userId]
      );

      let windowCount = null;
      if (Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs) && windowEndMs > windowStartMs) {
        const windowCountResult = await db.query(
          `SELECT COUNT(*)::int AS count
           FROM cal_event e
           INNER JOIN calendar c ON c.calendar_id = e.calendar_id
           WHERE c.user_id = $1
             AND e.status != 'cancelled'
             AND e.event_start < $3
             AND e.event_end > $2`,
          [req.session.userId, new Date(windowStartMs), new Date(windowEndMs)]
        );
        windowCount = windowCountResult.rows[0]?.count ?? 0;
      }

      diagnostics = {
        mode: includeAllCalendars ? 'ALL_CALENDARS' : 'PRIMARY_ONLY',
        requestedIncludeAllCalendars,
        allowAllCalendars,
        calendarTargetCount: result.calendarTargetCount || 0,
        fetchedItems: result.fetchedItems || 0,
        invalidEventsSkipped: result.invalidEventsSkipped || 0,
        failedCalendars: result.failedCalendars || [],
        totalStoredEvents: totalCountResult.rows[0]?.count ?? 0,
        windowEventCount: windowCount,
        windowStartMs: Number.isFinite(windowStartMs) ? windowStartMs : null,
        windowEndMs: Number.isFinite(windowEndMs) ? windowEndMs : null
      };
    }

    return res.json({
      calendarId: result.calendarId || calendarId,
      calendarDbId: result.calendarDbId,
      includeAllCalendars,
      fullSync: result.fullSync,
      skipped: result.skipped,
      syncedAt: new Date().toISOString(),
      inserted: result.inserted,
      updated: result.updated,
      cancelled: result.cancelled,
      invalidEventsSkipped: result.invalidEventsSkipped || 0,
      fetchedItems: result.fetchedItems,
      syncTokenUpdated: result.syncTokenUpdated,
      attempts: result.attempts || 0,
      calendars: result.calendars,
      failedCalendars: result.failedCalendars,
      diagnostics
    });
  } catch (error) {
    const classified =
      error?.status && error?.code
        ? {
            code: error.code,
            message: error.message,
            details: error.details || null,
            retryable: Boolean(error.retryable),
            httpStatus: Number(error.status)
          }
        : classifySyncFailure(error);

    console.error('Error syncing Google calendar', {
      userId: req.session.userId,
      code: classified.code,
      details: classified.details,
      error: error?.message
    });

    return res.status(classified.httpStatus || 502).json({
      error: classified.message || 'Failed to sync Google calendar',
      code: classified.code,
      retryable: classified.retryable,
      details: classified.details || null,
      failedCalendars: error?.failedCalendars || []
    });
  }
});

app.get('/api/google/sync/status', requireAuth, async (req, res) => {
  const calendarId =
    typeof req.query?.calendarId === 'string' && req.query.calendarId.trim()
      ? req.query.calendarId.trim()
      : null;

  const calendars = await db.listCalendarSyncStatusForUser({
    userId: req.session.userId,
    gcalId: calendarId
  });

  return res.json({
    calendars: calendars.map((row) => ({
      calendarDbId: row.calendar_id,
      calendarId: row.gcal_id,
      calendarName: row.calendar_name,
      lastSyncedAt: row.last_synced_at,
      lastSucceededAt: row.last_succeeded_at,
      lastAttemptedAt: row.last_attempted_at,
      lastErrorCode: row.last_error_code,
      needsReauth: Boolean(row.needs_reauth),
      inProgress: Boolean(row.in_progress),
      inProgressStartedAt: row.in_progress_started_at,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      lastErrorDetails: row.last_error_details || null
    }))
  });
});

app.post('/api/google/sync/repair', requireAuth, async (req, res) => {
  const calendarId =
    typeof req.body?.calendarId === 'string' && req.body.calendarId.trim()
      ? req.body.calendarId.trim()
      : null;
  const mode =
    typeof req.body?.mode === 'string' && req.body.mode.trim()
      ? req.body.mode.trim().toUpperCase()
      : 'FULL_RESYNC';

  try {
    const details = await repairCalendarsForUser({
      userId: req.session.userId,
      gcalId: calendarId,
      mode
    });

    return res.json({
      ok: true,
      queuedOrExecuted: true,
      details
    });
  } catch (error) {
    if (error?.status && error?.code) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        retryable: Boolean(error.retryable),
        details: error.details || null
      });
    }

    console.error('Error repairing Google sync state', error);
    return res.status(500).json({
      error: 'Failed to repair Google sync state',
      code: 'SYNC_REPAIR_FAILED'
    });
  }
});

app.get('/api/events', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.query.start);
  const endMs = parseTimeParam(req.query.end);

  let windowStartMs = startMs;
  let windowEndMs = endMs;

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    if (startMs === null && endMs === null) {
      const now = Date.now();
      windowEndMs = now;
      windowStartMs = now - 14 * 24 * 60 * 60 * 1000;
    } else {
      return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
    }
  }

  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  try {
    const rows = await db.listGoogleEventsForUser({
      userId: req.session.userId,
      windowStartMs,
      windowEndMs
    });

    const out = rows.map((row) => ({
      eventId: row.event_id,
      providerEventId: row.provider_event_id,
      iCalUID: row.ical_uid,
      title: row.event_name || 'No Title',
      start: row.event_start,
      end: row.event_end,
      status: row.status,
      blockingLevel: row.blocking_level,
      source: 'google'
    }));

    return res.json(out);
  } catch (error) {
    console.error('Error listing events', error);
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/events/:eventId/priority', requireAuth, async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  if (!Number.isInteger(eventId)) {
    return res.status(400).json({ error: 'Invalid eventId' });
  }

  const levelRaw = typeof req.body?.blockingLevel === 'string' ? req.body.blockingLevel : '';
  const blockingLevel = levelRaw.trim().toUpperCase();
  if (!VALID_BLOCKING_LEVELS.has(blockingLevel)) {
    return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
  }

  try {
    const updated = await db.updateGoogleEventBlockingLevel({
      userId: req.session.userId,
      eventId,
      blockingLevel
    });

    if (!updated) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.json({
      eventId: updated.event_id,
      providerEventId: updated.provider_event_id,
      iCalUID: updated.ical_uid,
      title: updated.event_name || 'No Title',
      start: updated.event_start,
      end: updated.event_end,
      status: updated.status,
      blockingLevel: updated.blocking_level,
      source: 'google'
    });
  } catch (error) {
    console.error('Error updating event priority', error);
    return res.status(500).json({ error: 'Failed to update event priority' });
  }
});

// ===================USER BUSY BLOCKS========================

app.get('/api/busy-blocks', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.query.start);
  const endMs = parseTimeParam(req.query.end);

  let windowStartMs = startMs;
  let windowEndMs = endMs;

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    if (startMs === null && endMs === null) {
      const now = Date.now();
      windowEndMs = now;
      windowStartMs = now - 14 * 24 * 60 * 60 * 1000;
    } else {
      return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
    }
  }

  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  try {
    const rows = await db.listUserBusyBlocks({
      userId: req.session.userId,
      windowStartMs,
      windowEndMs
    });

    const out = rows.map((row) => ({
      busyBlockId: row.busy_block_id,
      title: row.title || 'Busy',
      start: row.start_time,
      end: row.end_time,
      blockingLevel: row.blocking_level,
      source: 'manual'
    }));

    return res.json(out);
  } catch (error) {
    console.error('Error listing busy blocks', error);
    return res.status(500).json({ error: 'Failed to fetch busy blocks' });
  }
});

app.post('/api/busy-blocks', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.body?.startMs);
  const endMs = parseTimeParam(req.body?.endMs);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const clientRequestIdRaw = req.body?.clientRequestId;
  const clientRequestId =
    typeof clientRequestIdRaw === 'string' ? clientRequestIdRaw.trim() : '';
  if (!clientRequestId || clientRequestId.length > 128) {
    return res.status(400).json({ error: 'clientRequestId is required (max 128 chars)' });
  }

  const levelRaw = typeof req.body?.blockingLevel === 'string' ? req.body.blockingLevel : 'B3';
  const blockingLevel = levelRaw.trim().toUpperCase() || 'B3';
  if (!VALID_BLOCKING_LEVELS.has(blockingLevel)) {
    return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return res.status(400).json({ error: 'startMs and endMs are required (ISO or epoch ms)' });
  }
  if (endMs <= startMs) {
    return res.status(400).json({ error: 'endMs must be greater than startMs' });
  }

  try {
    const result = await db.createUserBusyBlock({
      userId: req.session.userId,
      title: title || null,
      clientRequestId,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      blockingLevel
    });

    const row = result.row;
    return res.status(result.inserted ? 201 : 200).json({
      busyBlockId: row.busy_block_id,
      title: row.title || 'Busy',
      start: row.start_time,
      end: row.end_time,
      blockingLevel: row.blocking_level,
      source: 'manual'
    });
  } catch (error) {
    if (error.code === 'IDEMPOTENCY_KEY_REUSE') {
      return res.status(409).json({ error: 'clientRequestId reused with different payload' });
    }
    console.error('Error creating busy block', error);
    return res.status(500).json({ error: 'Failed to create busy block' });
  }
});

app.post('/api/busy-blocks/:busyBlockId', requireAuth, async (req, res) => {
  const busyBlockId = Number.parseInt(req.params.busyBlockId, 10);
  if (!Number.isInteger(busyBlockId)) {
    return res.status(400).json({ error: 'Invalid busyBlockId' });
  }

  const startMs = parseTimeParam(req.body?.startMs);
  const endMs = parseTimeParam(req.body?.endMs);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : null;

  let blockingLevel = null;
  if (typeof req.body?.blockingLevel === 'string') {
    const candidate = req.body.blockingLevel.trim().toUpperCase();
    if (!VALID_BLOCKING_LEVELS.has(candidate)) {
      return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
    }
    blockingLevel = candidate;
  }

  if (startMs !== null && endMs !== null && Number.isFinite(startMs) && Number.isFinite(endMs)) {
    if (endMs <= startMs) {
      return res.status(400).json({ error: 'endMs must be greater than startMs' });
    }
  }

  try {
    const updated = await db.updateUserBusyBlock({
      userId: req.session.userId,
      busyBlockId,
      title,
      startTime: Number.isFinite(startMs) ? new Date(startMs) : null,
      endTime: Number.isFinite(endMs) ? new Date(endMs) : null,
      blockingLevel
    });

    if (!updated) {
      return res.status(404).json({ error: 'Busy block not found' });
    }

    return res.json({
      busyBlockId: updated.busy_block_id,
      title: updated.title || 'Busy',
      start: updated.start_time,
      end: updated.end_time,
      blockingLevel: updated.blocking_level,
      source: 'manual'
    });
  } catch (error) {
    console.error('Error updating busy block', error);
    return res.status(500).json({ error: 'Failed to update busy block' });
  }
});

app.delete('/api/busy-blocks/:busyBlockId', requireAuth, async (req, res) => {
  const busyBlockId = Number.parseInt(req.params.busyBlockId, 10);
  if (!Number.isInteger(busyBlockId)) {
    return res.status(400).json({ error: 'Invalid busyBlockId' });
  }

  try {
    const deleted = await db.deleteUserBusyBlock({
      userId: req.session.userId,
      busyBlockId
    });

    if (deleted === 0) {
      return res.status(404).json({ error: 'Busy block not found' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting busy block', error);
    return res.status(500).json({ error: 'Failed to delete busy block' });
  }
});

if (process.env.NODE_ENV === 'test') {
  app.post('/test/login', (req, res) => {
    const userId = req.body?.userId;
    req.session.userId = userId;
    req.session.isAuthenticated = true;
    res.json({ ok: true });
  });
}

app.get('/test-session', (req, res) => {
  res.json({
    sessionID: req.sessionID,
    userId: req.session.userId,
    isAuthenticated: req.session.isAuthenticated,
    fullSession: req.session
  });
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  console.error('Unhandled API error', {
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
    message: error?.message
  });
  sendError(res, error, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Unexpected server error',
    retryable: true
  });
});

if (require.main === module) {
  (async () => {
    try {
      await db.runSchemaMigrations();
      console.log('DB schema migrations complete');
    } catch (error) {
      console.error('Fatal: failed to run DB schema migrations', error);
      process.exit(1);
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })();
}

module.exports = {
  app,
  isValidOAuthState,
  setOAuthCodeExchangeForTest,
  resetOAuthCodeExchangeForTest
};
