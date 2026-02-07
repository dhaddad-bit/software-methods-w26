process.env.NODE_ENV = 'test';

jest.mock('../services/googleCalendar', () => ({
  fetchBusyIntervalsForUser: jest.fn(),
  listGoogleEvents: jest.fn()
}));

const request = require('supertest');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { fetchBusyIntervalsForUser } = require('../services/googleCalendar');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  fetchBusyIntervalsForUser.mockReset();
});

test('availability endpoint returns correct response shape', async () => {
  const userA = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A',
    refreshToken: 'refresh-a'
  });
  const userB = await createUser({
    googleSub: 'sub-b',
    email: 'b@example.com',
    name: 'User B',
    refreshToken: 'refresh-b'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: userA.id }).expect(200);

  const groupRes = await agent.post('/api/groups').send({ name: 'Group A' }).expect(201);
  const groupId = groupRes.body.id;

  await agent.post(`/api/groups/${groupId}/members`).send({ email: userB.email }).expect(200);

  fetchBusyIntervalsForUser.mockImplementation(async ({ userId }) => {
    if (String(userId) === String(userA.id)) {
      return [
        {
          eventRef: 'e1',
          userId: String(userA.id),
          startMs: Date.UTC(2025, 0, 1, 10, 0, 0),
          endMs: Date.UTC(2025, 0, 1, 11, 0, 0),
          source: 'google'
        }
      ];
    }
    return [];
  });

  const start = Date.UTC(2025, 0, 1, 9, 0, 0);
  const end = Date.UTC(2025, 0, 1, 12, 0, 0);

  const res = await agent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=30`)
    .expect(200);

  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBeGreaterThan(0);

  const block = res.body[0];
  expect(block).toHaveProperty('startMs');
  expect(block).toHaveProperty('endMs');
  expect(block).toHaveProperty('freeUserIds');
  expect(block).toHaveProperty('busyUserIds');
  expect(block).toHaveProperty('availableCount');
  expect(block).toHaveProperty('busyCount');
  expect(block).toHaveProperty('totalCount');
  expect(block).toHaveProperty('availabilityFraction');
});
