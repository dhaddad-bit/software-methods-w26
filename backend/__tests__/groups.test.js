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
