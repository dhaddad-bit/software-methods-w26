process.env.NODE_ENV = 'test';

const request = require('supertest');
const { runMigrations, resetDb } = require('./testUtils');
const {
  app,
  setOAuthCodeExchangeForTest,
  resetOAuthCodeExchangeForTest
} = require('../server');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  resetOAuthCodeExchangeForTest();
});

afterEach(() => {
  resetOAuthCodeExchangeForTest();
});

function parseStateFromRedirect(location) {
  const parsed = new URL(location);
  return parsed.searchParams.get('state');
}

test('oauth callback rejects missing state before token exchange', async () => {
  const agent = request.agent(app);
  const exchangeSpy = jest.fn(async () => {
    throw new Error('should-not-be-called');
  });
  setOAuthCodeExchangeForTest(exchangeSpy);

  await agent.get('/auth/google').expect(302);
  const callback = await agent.get('/oauth2callback?code=fake-code').expect(302);

  expect(callback.headers.location).toContain('error=invalid_state');
  expect(exchangeSpy).not.toHaveBeenCalled();
});

test('oauth callback rejects mismatched state before token exchange', async () => {
  const agent = request.agent(app);
  const exchangeSpy = jest.fn(async () => {
    throw new Error('should-not-be-called');
  });
  setOAuthCodeExchangeForTest(exchangeSpy);

  const authRes = await agent.get('/auth/google').expect(302);
  const generatedState = parseStateFromRedirect(authRes.headers.location);
  expect(typeof generatedState).toBe('string');

  const callback = await agent
    .get('/oauth2callback?code=fake-code&state=wrong-state')
    .expect(302);

  expect(callback.headers.location).toContain('error=invalid_state');
  expect(exchangeSpy).not.toHaveBeenCalled();
});

test('oauth callback accepts valid state and logs in user', async () => {
  const agent = request.agent(app);
  setOAuthCodeExchangeForTest(async () => ({
    tokens: { refresh_token: 'refresh-token' },
    userInfo: {
      id: 'google-sub-1',
      email: 'oauth-valid@example.com',
      name: 'OAuth Valid User'
    }
  }));

  const authRes = await agent.get('/auth/google').expect(302);
  const generatedState = parseStateFromRedirect(authRes.headers.location);
  expect(typeof generatedState).toBe('string');

  await agent
    .get(`/oauth2callback?code=fake-code&state=${encodeURIComponent(generatedState)}`)
    .expect(302)
    .expect('Location', '/');

  const me = await agent.get('/api/me').expect(200);
  expect(me.body).toMatchObject({
    email: 'oauth-valid@example.com',
    name: 'OAuth Valid User'
  });
});
