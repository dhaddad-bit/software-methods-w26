const crypto = require('crypto');

const TOKEN_VERSION = 2;

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(value) {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Buffer.from(normalized, 'base64');
}

function sign(payloadPart, secret) {
  return toBase64Url(crypto.createHmac('sha256', secret).update(payloadPart).digest());
}

function parsePositiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function createInviteToken({ inviteId, groupId, expiresAtMs }) {
  const secret = process.env.INVITE_LINK_SECRET;
  if (!secret) throw new Error('INVITE_LINK_SECRET is required');

  const normalizedInviteId = parsePositiveInteger(inviteId);
  const normalizedGroupId = parsePositiveInteger(groupId);
  const normalizedExpiresAtMs = Number(expiresAtMs);

  if (!normalizedInviteId) throw new Error('inviteId must be a positive integer');
  if (!normalizedGroupId) throw new Error('groupId must be a positive integer');
  if (!Number.isFinite(normalizedExpiresAtMs) || normalizedExpiresAtMs <= 0) {
    throw new Error('expiresAtMs must be a positive number');
  }

  const payload = {
    v: TOKEN_VERSION,
    iid: normalizedInviteId,
    gid: normalizedGroupId,
    exp: normalizedExpiresAtMs
  };
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signaturePart = sign(payloadPart, secret);

  return `${payloadPart}.${signaturePart}`;
}

function verifyInviteToken(token) {
  const secret = process.env.INVITE_LINK_SECRET;
  if (!secret) return { valid: false, reason: 'missing_secret' };
  if (typeof token !== 'string' || !token) return { valid: false, reason: 'malformed' };

  const tokenParts = token.split('.');
  if (tokenParts.length !== 2) return { valid: false, reason: 'malformed' };

  const [payloadPart, signaturePart] = tokenParts;
  const expectedSignature = sign(payloadPart, secret);

  const signatureBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadPart).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const normalizedGroupId = parsePositiveInteger(payload?.gid);
  const normalizedInviteId = payload?.v === 1 ? null : parsePositiveInteger(payload?.iid);
  const normalizedExpiresAtMs = Number(payload?.exp);

  if (payload?.v !== 1 && payload?.v !== TOKEN_VERSION) {
    return { valid: false, reason: 'bad_version' };
  }
  if (!normalizedGroupId) return { valid: false, reason: 'bad_group_id' };
  if (payload?.v === TOKEN_VERSION && !normalizedInviteId) {
    return { valid: false, reason: 'bad_invite_id' };
  }
  if (!Number.isFinite(normalizedExpiresAtMs) || normalizedExpiresAtMs <= 0) {
    return { valid: false, reason: 'bad_exp' };
  }

  if (Date.now() > normalizedExpiresAtMs) {
    return {
      valid: false,
      reason: 'expired',
      groupId: normalizedGroupId,
      inviteId: normalizedInviteId,
      expiresAtMs: normalizedExpiresAtMs
    };
  }

  return {
    valid: true,
    version: payload.v,
    inviteId: normalizedInviteId,
    groupId: normalizedGroupId,
    expiresAtMs: normalizedExpiresAtMs
  };
}

module.exports = {
  TOKEN_VERSION,
  createInviteToken,
  verifyInviteToken
};
