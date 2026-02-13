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

async function insertEvent({ calendarId, providerEventId, startIso, endIso, blockingLevel = 'B3' }) {
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

async function createGroupWithTwoMembers() {
  const owner = await createUser({
    googleSub: 'petition-owner-sub',
    email: 'petition-owner@example.com',
    name: 'Petition Owner',
    refreshToken: 'owner-refresh'
  });
  const member = await createUser({
    googleSub: 'petition-member-sub',
    email: 'petition-member@example.com',
    name: 'Petition Member',
    refreshToken: 'member-refresh'
  });

  const ownerAgent = request.agent(app);
  await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
  const groupRes = await ownerAgent.post('/api/groups').send({ name: 'Petition Group' }).expect(201);
  const groupId = groupRes.body.id;
  await ownerAgent
    .post(`/api/groups/${groupId}/members`)
    .send({ email: member.email })
    .expect(200);

  const memberAgent = request.agent(app);
  await memberAgent.post('/test/login').send({ userId: member.id }).expect(200);

  return { owner, member, groupId, ownerAgent, memberAgent };
}

function petitionWindow() {
  const start = Date.UTC(2026, 1, 10, 10, 0, 0);
  const end = Date.UTC(2026, 1, 10, 11, 0, 0);
  return { start, end };
}

async function createPetition(ownerAgent, groupId, title = 'Planning Meeting') {
  const { start, end } = petitionWindow();
  const res = await ownerAgent
    .post(`/api/groups/${groupId}/petitions`)
    .send({ title, start, end, level: 'AVAILABLE' })
    .expect(201);
  return res.body;
}

test('create petition persists and appears in group list', async () => {
  const { groupId, ownerAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Design Review');

  const list = await ownerAgent.get(`/api/groups/${groupId}/petitions`).expect(200);
  const found = list.body.find((item) => item.id === petition.id);
  expect(found).toBeTruthy();
  expect(found.title).toBe('Design Review');
  expect(found.current_user_response).toBe('ACCEPTED');
});

test('decline marks petition FAILED and removes availability impact', async () => {
  const { groupId, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Decline Case');
  const { start, end } = petitionWindow();

  const declineRes = await memberAgent
    .post(`/api/petitions/${petition.id}/respond`)
    .send({ response: 'DECLINE' })
    .expect(200);
  expect(declineRes.body.status).toBe('FAILED');

  const availability = await ownerAgent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=AVAILABLE`)
    .expect(200);
  expect(availability.body).toHaveLength(1);
  expect(availability.body[0]).toMatchObject({
    totalCount: 2,
    availableCount: 2,
    busyCount: 0
  });
});

test('creator can delete FAILED petition', async () => {
  const { groupId, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Delete Failed');

  await memberAgent
    .post(`/api/petitions/${petition.id}/respond`)
    .send({ response: 'DECLINE' })
    .expect(200);

  await ownerAgent.delete(`/api/petitions/${petition.id}`).expect(200);

  const list = await ownerAgent.get(`/api/groups/${groupId}/petitions`).expect(200);
  expect(list.body.find((item) => item.id === petition.id)).toBeUndefined();
});

test('accept all marks petition ACCEPTED_ALL and blocks availability', async () => {
  const { groupId, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Accept All');
  const { start, end } = petitionWindow();

  const acceptRes = await memberAgent
    .post(`/api/petitions/${petition.id}/respond`)
    .send({ response: 'ACCEPT' })
    .expect(200);
  expect(acceptRes.body.status).toBe('ACCEPTED_ALL');

  const availability = await ownerAgent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=AVAILABLE`)
    .expect(200);
  expect(availability.body).toHaveLength(1);
  expect(availability.body[0]).toMatchObject({
    totalCount: 2,
    availableCount: 0,
    busyCount: 2
  });
});

test('accepted petition in another group blocks shared members availability', async () => {
  const { owner, member, groupId, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  const { start, end } = petitionWindow();

  const secondaryOwner = await createUser({
    googleSub: 'secondary-owner-sub',
    email: 'secondary-owner@example.com',
    name: 'Secondary Owner',
    refreshToken: 'secondary-refresh'
  });
  const secondaryOwnerAgent = request.agent(app);
  await secondaryOwnerAgent.post('/test/login').send({ userId: secondaryOwner.id }).expect(200);
  const group2Res = await secondaryOwnerAgent
    .post('/api/groups')
    .send({ name: 'Secondary Group' })
    .expect(201);
  const group2Id = group2Res.body.id;
  await secondaryOwnerAgent
    .post(`/api/groups/${group2Id}/members`)
    .send({ email: member.email })
    .expect(200);

  const group2Petition = await secondaryOwnerAgent
    .post(`/api/groups/${group2Id}/petitions`)
    .send({
      title: 'Cross-group',
      start,
      end,
      level: 'AVAILABLE'
    })
    .expect(201);

  await memberAgent
    .post(`/api/petitions/${group2Petition.body.id}/respond`)
    .send({ response: 'ACCEPT' })
    .expect(200);

  const availability = await ownerAgent
    .get(`/api/groups/${groupId}/availability?start=${start}&end=${end}&granularity=60&level=AVAILABLE`)
    .expect(200);

  expect(availability.body[0].totalCount).toBe(2);
  expect(availability.body[0].availableCount).toBe(1);
  expect(availability.body[0].busyCount).toBe(1);
  expect(owner.id).toBeDefined();
});

test('server-side validation rejects non-free petition window', async () => {
  const { owner, groupId, ownerAgent } = await createGroupWithTwoMembers();
  const calendarId = await createPrimaryCalendar(owner.id);
  await insertEvent({
    calendarId,
    providerEventId: 'busy-window',
    startIso: '2026-02-10T10:00:00Z',
    endIso: '2026-02-10T11:00:00Z',
    blockingLevel: 'B3'
  });

  const { start, end } = petitionWindow();

  const response = await ownerAgent
    .post(`/api/groups/${groupId}/petitions`)
    .send({
      title: 'Should Fail',
      start,
      end,
      level: 'AVAILABLE'
    })
    .expect(400);

  expect(response.body.error).toMatch(/not fully available/i);
});
