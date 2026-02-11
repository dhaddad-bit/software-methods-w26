process.env.NODE_ENV = 'test';

const request = require('supertest');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

test('group creation and add-member', async () => {
  const userA = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });
  const userB = await createUser({
    googleSub: 'sub-b',
    email: 'b@example.com',
    name: 'User B'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: userA.id }).expect(200);

  const groupRes = await agent.post('/api/groups').send({ name: 'Study Group' }).expect(201);
  expect(groupRes.body).toHaveProperty('id');
  const groupId = groupRes.body.id;

  const addRes = await agent
    .post(`/api/groups/${groupId}/members`)
    .send({ email: userB.email })
    .expect(200);

  expect(addRes.body.email).toBe(userB.email);

  const membersRes = await agent.get(`/api/groups/${groupId}/members`).expect(200);
  const memberEmails = membersRes.body.map((m) => m.email);
  expect(memberEmails).toEqual(expect.arrayContaining([userA.email, userB.email]));
});

test('membership guard returns 403', async () => {
  const userA = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });
  const userB = await createUser({
    googleSub: 'sub-b',
    email: 'b@example.com',
    name: 'User B'
  });

  const agentA = request.agent(app);
  await agentA.post('/test/login').send({ userId: userA.id }).expect(200);
  const groupRes = await agentA.post('/api/groups').send({ name: 'Project Team' }).expect(201);
  const groupId = groupRes.body.id;

  const agentB = request.agent(app);
  await agentB.post('/test/login').send({ userId: userB.id }).expect(200);

  await agentB.get(`/api/groups/${groupId}/members`).expect(403);
});

test('cannot add yourself as a group member', async () => {
  const userA = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: userA.id }).expect(200);

  const groupRes = await agent.post('/api/groups').send({ name: 'Solo Group' }).expect(201);
  const groupId = groupRes.body.id;

  const addRes = await agent
    .post(`/api/groups/${groupId}/members`)
    .send({ email: userA.email })
    .expect(400);

  expect(addRes.body.error).toMatch(/cannot add yourself/i);
});

test('enforces an 8-member group limit (including owner)', async () => {
  const owner = await createUser({
    googleSub: 'sub-owner',
    email: 'owner@example.com',
    name: 'Owner'
  });

  const otherUsers = [];
  for (let i = 0; i < 8; i++) {
    otherUsers.push(
      await createUser({
        googleSub: `sub-${i}`,
        email: `u${i}@example.com`,
        name: `User ${i}`
      })
    );
  }

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: owner.id }).expect(200);

  const groupRes = await agent.post('/api/groups').send({ name: 'Big Group' }).expect(201);
  const groupId = groupRes.body.id;

  // Add 7 users to reach 8 total including owner.
  for (let i = 0; i < 7; i++) {
    await agent
      .post(`/api/groups/${groupId}/members`)
      .send({ email: otherUsers[i].email })
      .expect(200);
  }

  // 9th user should be rejected.
  const limitRes = await agent
    .post(`/api/groups/${groupId}/members`)
    .send({ email: otherUsers[7].email })
    .expect(400);
  expect(limitRes.body.error).toMatch(/limit/i);
});

test('creator can delete group via DELETE /api/groups/:groupId', async () => {
  const userA = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });
  const userB = await createUser({
    googleSub: 'sub-b',
    email: 'b@example.com',
    name: 'User B'
  });

  const agentA = request.agent(app);
  await agentA.post('/test/login').send({ userId: userA.id }).expect(200);
  const groupRes = await agentA.post('/api/groups').send({ name: 'To Delete' }).expect(201);
  const groupId = groupRes.body.id;

  const agentB = request.agent(app);
  await agentB.post('/test/login').send({ userId: userB.id }).expect(200);
  await agentB.delete(`/api/groups/${groupId}`).expect(403);

  await agentA.delete(`/api/groups/${groupId}`).expect(200);

  const groups = await agentA.get('/api/groups').expect(200);
  expect(groups.body).toHaveLength(0);
});
