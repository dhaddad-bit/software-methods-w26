process.env.NODE_ENV = 'test';

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
      recurringEventId: event.recurringEventId || null,
      originalStartTime: event.originalStartTime?.dateTime || event.originalStartTime?.date || null,
      title: event.summary || null,
      start: event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00Z` : null),
      end: event.end?.dateTime || (event.end?.date ? `${event.end.date}T00:00:00Z` : null),
      status: event.status || 'confirmed',
      providerUpdatedAt: event.updated || null,
      etag: event.etag || null,
      isAllDay: Boolean(event.start?.date && event.end?.date),
      eventTimeZone: event.start?.timeZone || event.end?.timeZone || null
    };
  }),
  getGoogleErrorInfo: jest.fn((error) => ({
    status: error?.response?.status || error?.status || null,
    message: error?.message || 'error'
  })),
  isGoogleAuthError: jest.fn((error) => {
    const combined = `${error?.message || ''} ${error?.response?.data?.error || ''}`.toLowerCase();
    return combined.includes('invalid_grant') || combined.includes('invalid credentials');
  }),
  isRetryableGoogleError: jest.fn((error) => {
    const status = error?.response?.status || error?.status || null;
    return status === 429 || (typeof status === 'number' && status >= 500);
  })
}));

const request = require('supertest');
const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { syncGoogleEvents } = require('../services/googleCalendar');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  syncGoogleEvents.mockReset();
});

test('revoked token marks sync state as needs_reauth and returns structured 401', async () => {
  const user = await createUser({
    googleSub: 'sync-recovery-sub',
    email: 'sync-recovery@example.com',
    name: 'Sync Recovery',
    refreshToken: 'refresh-recovery'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  const invalidGrant = new Error('invalid_grant');
  invalidGrant.response = {
    status: 401,
    data: {
      error: 'invalid_grant'
    }
  };
  syncGoogleEvents.mockRejectedValue(invalidGrant);

  const syncResponse = await agent
    .post('/api/google/sync')
    .send({ calendarId: 'primary', force: true })
    .expect(401);

  expect(syncResponse.body).toMatchObject({
    code: 'GOOGLE_REAUTH_REQUIRED',
    retryable: false
  });

  const syncStateRows = await db.query(
    `SELECT needs_reauth, last_error_code, consecutive_failures
     FROM calendar_sync_state`
  );

  expect(syncStateRows.rowCount).toBe(1);
  expect(syncStateRows.rows[0]).toMatchObject({
    needs_reauth: true,
    last_error_code: 'GOOGLE_REAUTH_REQUIRED',
    consecutive_failures: 1
  });

  const statusResponse = await agent.get('/api/google/sync/status').expect(200);
  expect(statusResponse.body.calendars).toHaveLength(1);
  expect(statusResponse.body.calendars[0]).toMatchObject({
    calendarId: 'primary',
    needsReauth: true,
    lastErrorCode: 'GOOGLE_REAUTH_REQUIRED'
  });
});

test('sync token expiry falls back to full sync and remains idempotent', async () => {
  const user = await createUser({
    googleSub: 'sync-410-sub',
    email: 'sync-410@example.com',
    name: 'Sync 410',
    refreshToken: 'refresh-410'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  syncGoogleEvents.mockResolvedValueOnce({
    fullSync: true,
    nextSyncToken: 'TOKEN-A',
    items: [
      {
        id: 'evt-410',
        summary: 'Initial Event',
        start: { dateTime: '2026-02-10T10:00:00Z' },
        end: { dateTime: '2026-02-10T11:00:00Z' }
      }
    ]
  });

  await agent.post('/api/google/sync').send({ calendarId: 'primary', force: true }).expect(200);

  const tokenExpired = new Error('token expired');
  tokenExpired.code = 'SYNC_TOKEN_EXPIRED';

  syncGoogleEvents
    .mockRejectedValueOnce(tokenExpired)
    .mockResolvedValueOnce({
      fullSync: true,
      nextSyncToken: 'TOKEN-B',
      items: [
        {
          id: 'evt-410',
          summary: 'Initial Event (Updated)',
          start: { dateTime: '2026-02-10T10:30:00Z' },
          end: { dateTime: '2026-02-10T11:30:00Z' }
        }
      ]
    });

  const response = await agent.post('/api/google/sync').send({ calendarId: 'primary' }).expect(200);

  expect(response.body).toMatchObject({
    inserted: 0,
    updated: 1,
    cancelled: 0
  });

  expect(syncGoogleEvents).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ syncToken: 'TOKEN-A' })
  );
  expect(syncGoogleEvents).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({ syncToken: null })
  );

  const events = await agent
    .get(`/api/events?start=${Date.parse('2026-02-01T00:00:00Z')}&end=${Date.parse('2026-02-20T00:00:00Z')}`)
    .expect(200);

  expect(events.body).toHaveLength(1);
  expect(events.body[0]).toMatchObject({
    providerEventId: 'evt-410',
    title: 'Initial Event (Updated)'
  });
});

test('sync repair route resets needs_reauth state', async () => {
  const user = await createUser({
    googleSub: 'sync-repair-sub',
    email: 'sync-repair@example.com',
    name: 'Sync Repair',
    refreshToken: 'refresh-repair'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  const invalidGrant = new Error('invalid_grant');
  invalidGrant.response = {
    status: 401,
    data: {
      error: 'invalid_grant'
    }
  };

  syncGoogleEvents.mockRejectedValueOnce(invalidGrant);
  await agent.post('/api/google/sync').send({ calendarId: 'primary', force: true }).expect(401);

  const repair = await agent
    .post('/api/google/sync/repair')
    .send({ calendarId: 'primary', mode: 'RESET_SYNC_TOKEN' })
    .expect(200);

  expect(repair.body).toMatchObject({
    ok: true,
    queuedOrExecuted: true
  });

  const syncStateRows = await db.query(
    `SELECT needs_reauth, consecutive_failures, sync_token
     FROM calendar_sync_state`
  );
  expect(syncStateRows.rows[0]).toMatchObject({
    needs_reauth: false,
    consecutive_failures: 0,
    sync_token: null
  });
});
