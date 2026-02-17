process.env.NODE_ENV = 'test';
process.env.GOOGLE_SYNC_RETRY_BASE_DELAY_MS = '1';
process.env.GOOGLE_SYNC_RETRY_MAX_DELAY_MS = '2';
process.env.GOOGLE_SYNC_MAX_RETRIES = '2';

jest.mock('../db', () => ({
  pool: {
    connect: jest.fn()
  },
  getOrCreateCalendar: jest.fn(),
  getCalendarSyncState: jest.fn(),
  getCalendarSyncStateForUpdate: jest.fn(),
  markCalendarSyncStarted: jest.fn(),
  markCalendarSyncSucceeded: jest.fn(),
  markCalendarSyncFailed: jest.fn(),
  createCalendarSyncRun: jest.fn(),
  completeCalendarSyncRun: jest.fn(),
  upsertCalEvents: jest.fn(),
  markCalEventsCancelled: jest.fn()
}));

jest.mock('../services/googleCalendar', () => ({
  syncGoogleEvents: jest.fn(),
  listGoogleCalendars: jest.fn(async () => []),
  normalizeGoogleEventForStorage: jest.fn((event) => {
    if (!event?.id) return null;
    if (event.status === 'cancelled') {
      return {
        providerEventId: event.id,
        status: 'cancelled'
      };
    }

    return {
      providerEventId: event.id,
      iCalUID: event.iCalUID || null,
      recurringEventId: null,
      originalStartTime: null,
      title: event.summary || null,
      start: event.start?.dateTime || null,
      end: event.end?.dateTime || null,
      status: 'confirmed',
      providerUpdatedAt: null,
      etag: null,
      isAllDay: false,
      eventTimeZone: null
    };
  }),
  getGoogleErrorInfo: jest.fn((error) => ({
    status: error?.response?.status || error?.status || null,
    message: error?.message || 'error'
  })),
  isGoogleAuthError: jest.fn((error) =>
    String(error?.message || '').toLowerCase().includes('invalid_grant')
  ),
  isRetryableGoogleError: jest.fn((error) => {
    const status = error?.response?.status || error?.status || null;
    return status === 429 || (typeof status === 'number' && status >= 500);
  })
}));

const db = require('../db');
const googleCalendar = require('../services/googleCalendar');
const {
  classifySyncFailure,
  syncSingleCalendarForUserRobust,
  syncGroupMembers
} = require('../services/syncCoordinator');

function buildLockClient() {
  const query = jest.fn(async (sql) => {
    if (String(sql).includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: true }] };
    }

    if (String(sql).includes('pg_advisory_unlock')) {
      return { rows: [{ unlocked: true }] };
    }

    return { rows: [] };
  });

  return {
    query,
    release: jest.fn()
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  db.pool.connect.mockResolvedValue(buildLockClient());
  db.getOrCreateCalendar.mockResolvedValue({ calendar_id: 101 });
  db.getCalendarSyncState.mockResolvedValue({
    sync_token: 'TOKEN-OLD',
    last_synced_at: new Date(0),
    in_progress: false
  });
  db.getCalendarSyncStateForUpdate.mockResolvedValue({
    sync_token: 'TOKEN-OLD'
  });
  db.markCalendarSyncStarted.mockResolvedValue({});
  db.createCalendarSyncRun.mockResolvedValue({ run_id: 999 });
  db.upsertCalEvents.mockResolvedValue({ inserted: 1, updated: 0 });
  db.markCalEventsCancelled.mockResolvedValue(0);
  db.markCalendarSyncSucceeded.mockResolvedValue({});
  db.completeCalendarSyncRun.mockResolvedValue({});
  db.markCalendarSyncFailed.mockResolvedValue({});
});

test('classifySyncFailure maps invalid grant to GOOGLE_REAUTH_REQUIRED', () => {
  const error = new Error('invalid_grant');
  const classified = classifySyncFailure(error);

  expect(classified).toMatchObject({
    code: 'GOOGLE_REAUTH_REQUIRED',
    httpStatus: 401,
    retryable: false
  });
});

test('syncSingleCalendarForUserRobust retries once on sync token expiry and then succeeds', async () => {
  const expired = new Error('token expired');
  expired.code = 'SYNC_TOKEN_EXPIRED';

  googleCalendar.syncGoogleEvents
    .mockRejectedValueOnce(expired)
    .mockResolvedValueOnce({
      fullSync: true,
      nextSyncToken: 'TOKEN-NEW',
      items: [
        {
          id: 'evt-1',
          summary: 'Event 1',
          start: { dateTime: '2026-02-01T10:00:00Z' },
          end: { dateTime: '2026-02-01T11:00:00Z' }
        }
      ]
    });

  const result = await syncSingleCalendarForUserRobust({
    userId: 7,
    refreshToken: 'refresh-token',
    gcalId: 'primary',
    calendarName: 'Primary',
    force: false
  });

  expect(googleCalendar.syncGoogleEvents).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ syncToken: 'TOKEN-OLD' })
  );
  expect(googleCalendar.syncGoogleEvents).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ syncToken: null })
  );
  expect(db.markCalendarSyncSucceeded).toHaveBeenCalledWith(
    expect.objectContaining({
      calendarId: 101,
      syncToken: 'TOKEN-NEW'
    })
  );
  expect(result).toMatchObject({
    skipped: false,
    inserted: 1,
    updated: 0,
    cancelled: 0,
    fullSync: true
  });
});

test('syncSingleCalendarForUserRobust marks failed state for non-retryable errors', async () => {
  const upstream = new Error('upstream bad request');
  upstream.response = { status: 400 };

  googleCalendar.syncGoogleEvents.mockRejectedValue(upstream);

  await expect(
    syncSingleCalendarForUserRobust({
      userId: 7,
      refreshToken: 'refresh-token',
      gcalId: 'primary',
      force: true
    })
  ).rejects.toMatchObject({ code: 'GOOGLE_UPSTREAM_ERROR' });

  expect(db.markCalendarSyncFailed).toHaveBeenCalledWith(
    expect.objectContaining({
      calendarId: 101,
      lastErrorCode: 'GOOGLE_UPSTREAM_ERROR'
    })
  );
  expect(db.completeCalendarSyncRun).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 999,
      status: 'FAILED'
    })
  );
});

test('syncGroupMembers fails fast with MEMBER_SYNC_REAUTH_REQUIRED when a member has no token', async () => {
  await expect(
    syncGroupMembers({
      members: [
        { id: 1, email: 'a@example.com', google_refresh_token: null },
        { id: 2, email: 'b@example.com', google_refresh_token: 'refresh' }
      ]
    })
  ).rejects.toMatchObject({
    code: 'MEMBER_SYNC_REAUTH_REQUIRED',
    status: 409
  });
});
