process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const { createInviteToken, verifyInviteToken, TOKEN_VERSION } = require('../inviteToken');

function encodeB64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signPayload(payloadPart, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payloadPart)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeSignedToken(payloadObject, secret = process.env.INVITE_LINK_SECRET) {
  const payloadPart = encodeB64Url(JSON.stringify(payloadObject));
  const signature = signPayload(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

describe('inviteToken', () => {
  const previousSecret = process.env.INVITE_LINK_SECRET;

  beforeEach(() => {
    process.env.INVITE_LINK_SECRET = 'test-invite-secret';
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.INVITE_LINK_SECRET;
    } else {
      process.env.INVITE_LINK_SECRET = previousSecret;
    }
  });

  test('creates and verifies v2 token', () => {
    const expiresAtMs = Date.now() + 60_000;
    const token = createInviteToken({
      inviteId: 10,
      groupId: 20,
      expiresAtMs
    });

    const verified = verifyInviteToken(token);
    expect(verified).toMatchObject({
      valid: true,
      version: TOKEN_VERSION,
      inviteId: 10,
      groupId: 20,
      expiresAtMs
    });
  });

  test('createInviteToken validates required fields', () => {
    expect(() =>
      createInviteToken({
        inviteId: 0,
        groupId: 1,
        expiresAtMs: Date.now() + 1000
      })
    ).toThrow('inviteId must be a positive integer');

    expect(() =>
      createInviteToken({
        inviteId: 1,
        groupId: -1,
        expiresAtMs: Date.now() + 1000
      })
    ).toThrow('groupId must be a positive integer');

    expect(() =>
      createInviteToken({
        inviteId: 1,
        groupId: 1,
        expiresAtMs: 'bad'
      })
    ).toThrow('expiresAtMs must be a positive number');
  });

  test('createInviteToken throws when secret is missing', () => {
    delete process.env.INVITE_LINK_SECRET;
    expect(() =>
      createInviteToken({
        inviteId: 1,
        groupId: 2,
        expiresAtMs: Date.now() + 1000
      })
    ).toThrow('INVITE_LINK_SECRET is required');
  });

  test('verifyInviteToken reports malformed and bad signature cases', () => {
    expect(verifyInviteToken(null)).toMatchObject({ valid: false, reason: 'malformed' });
    expect(verifyInviteToken('a.b.c')).toMatchObject({ valid: false, reason: 'malformed' });

    const valid = createInviteToken({
      inviteId: 1,
      groupId: 2,
      expiresAtMs: Date.now() + 60_000
    });
    const [payloadPart, signaturePart] = valid.split('.');
    const tamperedSignature = `${signaturePart.slice(0, -1)}${signaturePart.endsWith('A') ? 'B' : 'A'}`;
    const tampered = `${payloadPart}.${tamperedSignature}`;

    expect(verifyInviteToken(tampered)).toMatchObject({
      valid: false,
      reason: 'bad_signature'
    });
  });

  test('verifyInviteToken validates payload version and claims', () => {
    const baseExp = Date.now() + 60_000;

    const badVersion = makeSignedToken({ v: 99, iid: 1, gid: 2, exp: baseExp });
    expect(verifyInviteToken(badVersion)).toMatchObject({
      valid: false,
      reason: 'bad_version'
    });

    const badGroup = makeSignedToken({ v: TOKEN_VERSION, iid: 1, gid: 'x', exp: baseExp });
    expect(verifyInviteToken(badGroup)).toMatchObject({
      valid: false,
      reason: 'bad_group_id'
    });

    const badInvite = makeSignedToken({ v: TOKEN_VERSION, iid: 'x', gid: 2, exp: baseExp });
    expect(verifyInviteToken(badInvite)).toMatchObject({
      valid: false,
      reason: 'bad_invite_id'
    });

    const badExp = makeSignedToken({ v: TOKEN_VERSION, iid: 1, gid: 2, exp: 'soon' });
    expect(verifyInviteToken(badExp)).toMatchObject({
      valid: false,
      reason: 'bad_exp'
    });
  });

  test('verifyInviteToken reports expired token with metadata', () => {
    const token = makeSignedToken({
      v: TOKEN_VERSION,
      iid: 8,
      gid: 4,
      exp: Date.now() - 1
    });
    expect(verifyInviteToken(token)).toMatchObject({
      valid: false,
      reason: 'expired',
      inviteId: 8,
      groupId: 4
    });
  });

  test('verifyInviteToken supports v1 payloads for backward compatibility', () => {
    const token = makeSignedToken({
      v: 1,
      gid: 101,
      exp: Date.now() + 60_000
    });

    expect(verifyInviteToken(token)).toMatchObject({
      valid: true,
      version: 1,
      inviteId: null,
      groupId: 101
    });
  });

  test('verifyInviteToken returns missing_secret when secret is unset', () => {
    delete process.env.INVITE_LINK_SECRET;
    expect(verifyInviteToken('a.b')).toMatchObject({
      valid: false,
      reason: 'missing_secret'
    });
  });
});
