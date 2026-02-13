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

async function createGroupWithTwoMembers() {
  const owner = await createUser({
    googleSub: 'notif-owner-sub',
    email: 'notif-owner@example.com',
    name: 'Notif Owner',
    refreshToken: 'owner-refresh'
  });
  const member = await createUser({
    googleSub: 'notif-member-sub',
    email: 'notif-member@example.com',
    name: 'Notif Member',
    refreshToken: 'member-refresh'
  });

  const ownerAgent = request.agent(app);
  await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
  const groupRes = await ownerAgent.post('/api/groups').send({ name: 'Notif Group' }).expect(201);
  const groupId = groupRes.body.id;
  await ownerAgent
    .post(`/api/groups/${groupId}/members`)
    .send({ email: member.email })
    .expect(200);

  const memberAgent = request.agent(app);
  await memberAgent.post('/test/login').send({ userId: member.id }).expect(200);

  return {
    owner,
    member,
    groupId,
    ownerAgent,
    memberAgent
  };
}

async function createPetition(agent, groupId, label = 'Petition') {
  const start = Date.UTC(2026, 0, 10, 10, 0, 0);
  const end = Date.UTC(2026, 0, 10, 11, 0, 0);
  const petitionRes = await agent
    .post(`/api/groups/${groupId}/petitions`)
    .send({
      title: label,
      start,
      end,
      level: 'AVAILABLE'
    })
    .expect(201);
  return petitionRes.body;
}

test('petition create emits notifications and outbox rows for recipients', async () => {
  const { groupId, owner, member, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Kickoff');

  expect(petition).toMatchObject({
    group_id: groupId,
    created_by_user_id: owner.id,
    acceptedCount: 1
  });

  const memberNotifications = await memberAgent.get('/api/notifications').expect(200);
  expect(memberNotifications.body.items.length).toBeGreaterThan(0);
  expect(memberNotifications.body.items[0].type).toBe('PETITION_CREATED');

  const notificationId = memberNotifications.body.items[0].notificationId;
  const outboxRows = await db.query(
    `SELECT outbox_id
     FROM notification_outbox
     WHERE notification_id = $1`,
    [notificationId]
  );
  expect(outboxRows.rowCount).toBe(1);
});

test('notification APIs support list/read/read-all/delete with idempotent delete', async () => {
  const { groupId, ownerAgent, memberAgent } = await createGroupWithTwoMembers();
  await createPetition(ownerAgent, groupId, 'Read/Delete Test');

  const listRes = await memberAgent.get('/api/notifications?limit=5&offset=0').expect(200);
  expect(listRes.body.limit).toBe(5);
  expect(listRes.body.offset).toBe(0);
  expect(listRes.body.items.length).toBeGreaterThan(0);

  const firstNotification = listRes.body.items[0];

  const readRes = await memberAgent
    .post(`/api/notifications/${firstNotification.notificationId}/read`)
    .expect(200);
  expect(readRes.body).toMatchObject({
    notificationId: firstNotification.notificationId,
    isRead: true
  });

  const readAllRes = await memberAgent.post('/api/notifications/read-all').expect(200);
  expect(readAllRes.body.ok).toBe(true);

  await memberAgent.delete(`/api/notifications/${firstNotification.notificationId}`).expect(200);
  const secondDelete = await memberAgent
    .delete(`/api/notifications/${firstNotification.notificationId}`)
    .expect(200);
  expect(secondDelete.body.alreadyDeleted).toBe(true);
});

test('petition responses emit deduped response notifications and status notifications', async () => {
  const { groupId, owner, ownerAgent, member, memberAgent } = await createGroupWithTwoMembers();
  const petition = await createPetition(ownerAgent, groupId, 'Response Test');

  await memberAgent
    .post(`/api/petitions/${petition.id}/respond`)
    .send({ response: 'ACCEPT' })
    .expect(200);

  await memberAgent
    .post(`/api/petitions/${petition.id}/respond`)
    .send({ response: 'ACCEPT' })
    .expect(200);

  const ownerNotifications = await ownerAgent.get('/api/notifications').expect(200);
  const ownerTypes = ownerNotifications.body.items.map((item) => item.type);
  expect(ownerTypes).toEqual(expect.arrayContaining(['PETITION_RESPONSE', 'PETITION_STATUS']));

  const responseNotifications = ownerNotifications.body.items.filter(
    (item) =>
      item.type === 'PETITION_RESPONSE' &&
      item.payload.petitionId === petition.id &&
      item.payload.responderUserId === member.id
  );
  expect(responseNotifications).toHaveLength(1);

  const notificationCounts = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE recipient_user_id = $1`,
    [owner.id]
  );
  const outboxCounts = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM notification_outbox o
     INNER JOIN notifications n ON n.notification_id = o.notification_id
     WHERE n.recipient_user_id = $1`,
    [owner.id]
  );
  expect(outboxCounts.rows[0].count).toBe(notificationCounts.rows[0].count);
});
