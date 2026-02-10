process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function createPrimaryCalendar(userId) {
  const result = await db.query(
    `INSERT INTO calendar (user_id, gcal_id, calendar_name)
     VALUES ($1, 'primary', 'primary')
     RETURNING calendar_id`,
    [userId]
  );
  return result.rows[0].calendar_id;
}

async function insertEvent({ calendarId, providerEventId, startIso, endIso, blockingLevel }) {
  await db.query(
    `INSERT INTO cal_event (
       calendar_id,
       provider_event_id,
       event_name,
       event_start,
       event_end,
       status,
       blocking_level,
       last_synced_at
     )
     VALUES ($1,$2,$3,$4,$5,'confirmed',$6,NOW())`,
    [calendarId, providerEventId, providerEventId, startIso, endIso, blockingLevel]
  );
}

test('availability endpoint respects level thresholds (AVAILABLE/FLEXIBLE/MAYBE)', async () => {
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

  const calA = await createPrimaryCalendar(userA.id);
  const calB = await createPrimaryCalendar(userB.id);

  await insertEvent({
    calendarId: calA,
    providerEventId: 'A-B3',
    startIso: '2026-02-01T10:00:00Z',
    endIso: '2026-02-01T11:00:00Z',
    blockingLevel: 'B3'
  });

  await insertEvent({
    calendarId: calA,
    providerEventId: 'A-B1',
    startIso: '2026-02-01T11:00:00Z',
    endIso: '2026-02-01T12:00:00Z',
    blockingLevel: 'B1'
  });

  await insertEvent({
    calendarId: calB,
    providerEventId: 'B-B2',
    startIso: '2026-02-01T10:00:00Z',
    endIso: '2026-02-01T11:00:00Z',
    blockingLevel: 'B2'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: userA.id }).expect(200);

  const groupRes = await agent.post('/api/groups').send({ name: 'Group A' }).expect(201);
  const groupId = groupRes.body.id;
  await agent.post(`/api/groups/${groupId}/members`).send({ email: userB.email }).expect(200);

  const start = Date.parse('2026-02-01T09:00:00Z');
  const end = Date.parse('2026-02-01T12:00:00Z');

  const resAvailable = await agent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=AVAILABLE`)
    .expect(200);

  const resFlexible = await agent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=FLEXIBLE`)
    .expect(200);

  const resMaybe = await agent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=MAYBE`)
    .expect(200);

  const block10Available = resAvailable.body.find((b) => b.startMs === Date.parse('2026-02-01T10:00:00Z'));
  const block10Flexible = resFlexible.body.find((b) => b.startMs === Date.parse('2026-02-01T10:00:00Z'));
  const block10Maybe = resMaybe.body.find((b) => b.startMs === Date.parse('2026-02-01T10:00:00Z'));

  expect(block10Available).toMatchObject({ totalCount: 2, availableCount: 1, busyCount: 1 });
  expect(block10Flexible).toMatchObject({ totalCount: 2, availableCount: 0, busyCount: 2 });
  expect(block10Maybe).toMatchObject({ totalCount: 2, availableCount: 0, busyCount: 2 });

  const block11Available = resAvailable.body.find((b) => b.startMs === Date.parse('2026-02-01T11:00:00Z'));
  const block11Flexible = resFlexible.body.find((b) => b.startMs === Date.parse('2026-02-01T11:00:00Z'));
  const block11Maybe = resMaybe.body.find((b) => b.startMs === Date.parse('2026-02-01T11:00:00Z'));

  expect(block11Available).toMatchObject({ totalCount: 2, availableCount: 2, busyCount: 0 });
  expect(block11Flexible).toMatchObject({ totalCount: 2, availableCount: 2, busyCount: 0 });
  expect(block11Maybe).toMatchObject({ totalCount: 2, availableCount: 1, busyCount: 1 });
});

