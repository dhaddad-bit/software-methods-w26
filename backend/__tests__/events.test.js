process.env.NODE_ENV = 'test';

jest.mock('../services/googleCalendar', () => ({
  fetchBusyIntervalsForUser: jest.fn(),
  listGoogleEvents: jest.fn()
}));

const request = require('supertest');
const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { listGoogleEvents } = require('../services/googleCalendar');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  listGoogleEvents.mockReset();
});

test('GET /api/events persists events and dedupes by Google event id', async () => {
  const user = await createUser({
    googleSub: 'sub-events',
    email: 'events@example.com',
    name: 'Events User',
    refreshToken: 'refresh-events'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  listGoogleEvents.mockResolvedValue([
    {
      id: 'gcal-1',
      summary: 'Event One',
      start: { dateTime: '2026-02-01T10:00:00Z' },
      end: { dateTime: '2026-02-01T11:00:00Z' }
    },
    {
      id: 'gcal-2',
      summary: 'Event Two',
      start: { dateTime: '2026-02-02T12:00:00Z' },
      end: { dateTime: '2026-02-02T13:00:00Z' }
    }
  ]);

  const first = await agent.get('/api/events').expect(200);
  expect(first.body).toHaveLength(2);

  const calendarRows = await db.query(
    'SELECT calendar_id, user_id, gcal_id FROM calendar ORDER BY calendar_id'
  );
  expect(calendarRows.rows).toHaveLength(1);
  expect(calendarRows.rows[0]).toMatchObject({ user_id: user.id, gcal_id: 'primary' });

  const eventCount = await db.query('SELECT COUNT(*)::int AS count FROM cal_event');
  expect(eventCount.rows[0].count).toBe(2);

  const second = await agent.get('/api/events').expect(200);
  expect(second.body).toHaveLength(2);

  const eventCountAfter = await db.query('SELECT COUNT(*)::int AS count FROM cal_event');
  expect(eventCountAfter.rows[0].count).toBe(2);
});
