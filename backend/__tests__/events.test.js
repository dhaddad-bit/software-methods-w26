process.env.NODE_ENV = 'test';

jest.mock('../services/googleCalendar', () => ({
  syncGoogleEvents: jest.fn()
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

test('POST /api/google/sync persists events, supports cancel, and preserves blocking level overrides', async () => {
  const user = await createUser({
    googleSub: 'sub-sync',
    email: 'sync@example.com',
    name: 'Sync User',
    refreshToken: 'refresh-sync'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  syncGoogleEvents.mockResolvedValueOnce({
    fullSync: true,
    nextSyncToken: 'T1',
    items: [
      {
        id: 'evt-a',
        summary: 'Event A',
        start: { dateTime: '2026-02-01T10:00:00Z' },
        end: { dateTime: '2026-02-01T11:00:00Z' }
      },
      {
        id: 'evt-b',
        summary: 'Event B',
        start: { dateTime: '2026-02-02T12:00:00Z' },
        end: { dateTime: '2026-02-02T13:00:00Z' }
      }
    ]
  });

  const firstSync = await agent
    .post('/api/google/sync')
    .send({ calendarId: 'primary', force: true })
    .expect(200);

  expect(firstSync.body).toMatchObject({
    calendarId: 'primary',
    fullSync: true,
    inserted: 2,
    cancelled: 0
  });

  const start = Date.UTC(2026, 0, 25);
  const end = Date.UTC(2026, 1, 10);
  const events1 = await agent.get(`/api/events?start=${start}&end=${end}`).expect(200);
  expect(events1.body).toHaveLength(2);
  expect(events1.body[0]).toHaveProperty('eventId');
  expect(events1.body[0]).toHaveProperty('providerEventId');
  expect(events1.body[0]).toHaveProperty('blockingLevel');

  const eventA = events1.body.find((ev) => ev.providerEventId === 'evt-a');
  expect(eventA).toBeTruthy();

  await agent
    .post(`/api/events/${eventA.eventId}/priority`)
    .send({ blockingLevel: 'B1' })
    .expect(200);

  syncGoogleEvents.mockResolvedValueOnce({
    fullSync: false,
    nextSyncToken: 'T2',
    items: [
      {
        id: 'evt-a',
        summary: 'Event A (Updated)',
        start: { dateTime: '2026-02-01T10:30:00Z' },
        end: { dateTime: '2026-02-01T11:30:00Z' }
      },
      {
        id: 'evt-b',
        status: 'cancelled'
      }
    ]
  });

  const secondSync = await agent
    .post('/api/google/sync')
    .send({ calendarId: 'primary', force: true })
    .expect(200);

  expect(syncGoogleEvents).toHaveBeenCalledWith(
    expect.objectContaining({ calendarId: 'primary', syncToken: 'T1' })
  );
  expect(secondSync.body).toMatchObject({
    calendarId: 'primary',
    fullSync: false,
    inserted: 0,
    updated: 1,
    cancelled: 1
  });

  const events2 = await agent.get(`/api/events?start=${start}&end=${end}`).expect(200);
  expect(events2.body).toHaveLength(1);

  const updatedA = events2.body[0];
  expect(updatedA.providerEventId).toBe('evt-a');
  expect(updatedA.title).toBe('Event A (Updated)');
  expect(updatedA.blockingLevel).toBe('B1'); // preserved override

  const calEventCount = await db.query('SELECT COUNT(*)::int AS count FROM cal_event');
  expect(calEventCount.rows[0].count).toBe(2);
});

