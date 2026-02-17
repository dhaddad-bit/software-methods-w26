process.env.NODE_ENV = 'test';

const request = require('supertest');
const { runMigrations, resetDb } = require('./testUtils');
const { app } = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

test('API errors include structured envelope fields', async () => {
  const res = await request(app).get('/api/events').expect(401);

  expect(res.body).toMatchObject({
    error: 'User not authenticated',
    code: 'AUTH_REQUIRED',
    retryable: false,
    details: null
  });

  expect(typeof res.body.requestId).toBe('string');
  expect(res.body.requestId.length).toBeGreaterThan(0);
});

test('API error envelope preserves caller-provided request ID', async () => {
  const requestId = 'req-phase0-contract-test';
  const res = await request(app)
    .get('/api/events')
    .set('x-request-id', requestId)
    .expect(401);

  expect(res.headers['x-request-id']).toBe(requestId);
  expect(res.body.requestId).toBe(requestId);
});
