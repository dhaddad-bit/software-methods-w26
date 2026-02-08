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

test('GET /api/events returns 401 for unauthenticated users', async () => {
  // SRS IF-02: Calendar Retrieval Interface
  const res = await request(app).get('/api/events').expect(401);
  expect(res.body).toEqual({ error: 'User not authenticated' });
});
