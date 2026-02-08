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

async function setupGroup() {
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

  const agentA = request.agent(app);
  await agentA.post('/test/login').send({ userId: userA.id }).expect(200);

  const groupRes = await agentA.post('/api/groups').send({ name: 'Team' }).expect(201);
  const groupId = groupRes.body.id;

  await agentA.post(`/api/groups/${groupId}/members`).send({ email: userB.email }).expect(200);

  const agentB = request.agent(app);
  await agentB.post('/test/login').send({ userId: userB.id }).expect(200);

  return { userA, userB, agentA, agentB, groupId };
}

test('create petition and list endpoints', async () => {
  const { agentA, groupId } = await setupGroup();

  fetchBusyIntervalsForUser.mockResolvedValue([]);

  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  const end = Date.UTC(2026, 0, 1, 11, 0, 0);

  const createRes = await agentA
    .post(`/api/groups/${groupId}/petitions`)
    .send({ start, end })
    .expect(201);

  expect(createRes.body.status).toBe('OPEN');
  expect(createRes.body.acceptedCount).toBe(1);
  expect(createRes.body.groupSize).toBe(2);

  const groupList = await agentA.get(`/api/groups/${groupId}/petitions`).expect(200);
  expect(groupList.body.length).toBe(1);

  const userList = await agentA.get('/api/petitions').expect(200);
  expect(userList.body.length).toBe(1);
});

test('decline marks petition FAILED and removes availability impact', async () => {
  const { agentA, agentB, groupId } = await setupGroup();

  fetchBusyIntervalsForUser.mockResolvedValue([]);

  const start = Date.UTC(2026, 0, 2, 9, 0, 0);
  const end = Date.UTC(2026, 0, 2, 10, 0, 0);

  const createRes = await agentA
    .post(`/api/groups/${groupId}/petitions`)
    .send({ start, end })
    .expect(201);

  const petitionId = createRes.body.id;

  const declineRes = await agentB
    .post(`/api/petitions/${petitionId}/respond`)
    .send({ response: 'DECLINE' })
    .expect(200);

  expect(declineRes.body.status).toBe('FAILED');

  const availability = await agentA
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=15`)
    .expect(200);

  const firstBlock = availability.body.find((block) => block.startMs === start);
  expect(firstBlock.availableCount).toBe(firstBlock.totalCount);
});

test('creator can delete FAILED petition', async () => {
  const { agentA, agentB, groupId } = await setupGroup();

  fetchBusyIntervalsForUser.mockResolvedValue([]);

  const start = Date.UTC(2026, 0, 3, 12, 0, 0);
  const end = Date.UTC(2026, 0, 3, 13, 0, 0);

  const createRes = await agentA
    .post(`/api/groups/${groupId}/petitions`)
    .send({ start, end })
    .expect(201);

  const petitionId = createRes.body.id;

  await agentB
    .post(`/api/petitions/${petitionId}/respond`)
    .send({ response: 'DECLINE' })
    .expect(200);

  await agentA.delete(`/api/petitions/${petitionId}`).expect(200);

  const groupList = await agentA.get(`/api/groups/${groupId}/petitions`).expect(200);
  expect(groupList.body.length).toBe(0);
});

test('accept all marks petition ACCEPTED_ALL and blocks availability', async () => {
  const { agentA, agentB, groupId } = await setupGroup();

  fetchBusyIntervalsForUser.mockResolvedValue([]);

  const start = Date.UTC(2026, 0, 4, 14, 0, 0);
  const end = Date.UTC(2026, 0, 4, 15, 0, 0);

  const createRes = await agentA
    .post(`/api/groups/${groupId}/petitions`)
    .send({ start, end })
    .expect(201);

  const petitionId = createRes.body.id;

  const acceptRes = await agentB
    .post(`/api/petitions/${petitionId}/respond`)
    .send({ response: 'ACCEPT' })
    .expect(200);

  expect(acceptRes.body.status).toBe('ACCEPTED_ALL');

  const availability = await agentA
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=15`)
    .expect(200);

  const firstBlock = availability.body.find((block) => block.startMs === start);
  expect(firstBlock.availableCount).toBe(0);
});

test('server-side validation rejects non-free petition window', async () => {
  const { agentA, groupId, userA } = await setupGroup();

  const start = Date.UTC(2026, 0, 5, 9, 0, 0);
  const end = Date.UTC(2026, 0, 5, 9, 30, 0);

  fetchBusyIntervalsForUser.mockImplementation(async ({ userId }) => {
    if (String(userId) === String(userA.id)) {
      return [
        {
          eventRef: 'busy',
          userId: String(userA.id),
          startMs: start,
          endMs: end,
          source: 'google'
        }
      ];
    }
    return [];
  });

  await agentA
    .post(`/api/groups/${groupId}/petitions`)
    .send({ start, end })
    .expect(400);
});
