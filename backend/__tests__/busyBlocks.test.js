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

test('busy block creation is idempotent by clientRequestId', async () => {
  const user = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  const startMs = Date.UTC(2026, 0, 1, 10, 0, 0);
  const endMs = Date.UTC(2026, 0, 1, 11, 0, 0);

  const body = {
    title: 'Focus',
    clientRequestId: 'req-123',
    startMs,
    endMs,
    blockingLevel: 'B3'
  };

  const first = await agent.post('/api/busy-blocks').send(body).expect(201);
  const second = await agent.post('/api/busy-blocks').send(body).expect(200);

  expect(second.body.busyBlockId).toBe(first.body.busyBlockId);

  const list = await agent
    .get(`/api/busy-blocks?start=${startMs - 60_000}&end=${endMs + 60_000}`)
    .expect(200);

  expect(Array.isArray(list.body)).toBe(true);
  expect(list.body).toHaveLength(1);
  expect(list.body[0].busyBlockId).toBe(first.body.busyBlockId);
});

test('busy block clientRequestId reuse with different payload returns 409', async () => {
  const user = await createUser({
    googleSub: 'sub-a',
    email: 'a@example.com',
    name: 'User A'
  });

  const agent = request.agent(app);
  await agent.post('/test/login').send({ userId: user.id }).expect(200);

  const startMs = Date.UTC(2026, 0, 1, 10, 0, 0);
  const endMs = Date.UTC(2026, 0, 1, 11, 0, 0);

  await agent
    .post('/api/busy-blocks')
    .send({
      title: 'Focus',
      clientRequestId: 'req-123',
      startMs,
      endMs,
      blockingLevel: 'B3'
    })
    .expect(201);

  await agent
    .post('/api/busy-blocks')
    .send({
      title: 'Different',
      clientRequestId: 'req-123',
      startMs,
      endMs,
      blockingLevel: 'B3'
    })
    .expect(409);
});

