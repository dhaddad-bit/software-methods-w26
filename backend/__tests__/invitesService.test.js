process.env.NODE_ENV = 'test';

const {
  getDefaultInviteTtlHours,
  computeInviteExpiry,
  buildInviteToken,
  parseInviteToken
} = require('../invites/service');

describe('invites/service', () => {
  const previousSecret = process.env.INVITE_LINK_SECRET;
  const previousTtl = process.env.INVITE_DEFAULT_TTL_HOURS;

  beforeEach(() => {
    process.env.INVITE_LINK_SECRET = 'service-secret';
  });

  afterEach(() => {
    if (previousTtl === undefined) delete process.env.INVITE_DEFAULT_TTL_HOURS;
    else process.env.INVITE_DEFAULT_TTL_HOURS = previousTtl;
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.INVITE_LINK_SECRET;
    else process.env.INVITE_LINK_SECRET = previousSecret;
  });

  test('getDefaultInviteTtlHours uses env with fallback', () => {
    delete process.env.INVITE_DEFAULT_TTL_HOURS;
    expect(getDefaultInviteTtlHours()).toBe(168);

    process.env.INVITE_DEFAULT_TTL_HOURS = '24';
    expect(getDefaultInviteTtlHours()).toBe(24);

    process.env.INVITE_DEFAULT_TTL_HOURS = '-5';
    expect(getDefaultInviteTtlHours()).toBe(168);
  });

  test('computeInviteExpiry uses ttl and now', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiresAt = computeInviteExpiry({ nowMs, ttlHours: 2 });
    expect(expiresAt.toISOString()).toBe('2026-01-01T02:00:00.000Z');
  });

  test('buildInviteToken and parseInviteToken round-trip', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const token = buildInviteToken({
      inviteId: 123,
      groupId: 456,
      expiresAt
    });

    const parsed = parseInviteToken(token);
    expect(parsed).toMatchObject({
      valid: true,
      inviteId: 123,
      groupId: 456
    });
    expect(parsed.expiresAtMs).toBe(expiresAt.getTime());
  });

  test('parseInviteToken rejects malformed or legacy tokens', () => {
    expect(parseInviteToken('invalid')).toMatchObject({
      valid: false
    });

    const legacyToken = require('../inviteToken').createInviteToken({
      inviteId: 1,
      groupId: 2,
      expiresAtMs: Date.now() + 1000
    });
    const parsed = parseInviteToken(legacyToken);
    expect(parsed).toMatchObject({
      valid: true,
      inviteId: 1,
      groupId: 2
    });
  });
});
