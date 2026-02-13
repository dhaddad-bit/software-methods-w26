const { createInviteToken, verifyInviteToken } = require('../inviteToken');

function getDefaultInviteTtlHours() {
  const raw = process.env.INVITE_DEFAULT_TTL_HOURS;
  const parsed = Number.parseInt(raw || '168', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 168;
  return parsed;
}

function computeInviteExpiry({ nowMs = Date.now(), ttlHours = getDefaultInviteTtlHours() } = {}) {
  return new Date(nowMs + ttlHours * 60 * 60 * 1000);
}

function buildInviteToken({ inviteId, groupId, expiresAt }) {
  return createInviteToken({
    inviteId,
    groupId,
    expiresAtMs: new Date(expiresAt).getTime()
  });
}

function parseInviteToken(token) {
  const verification = verifyInviteToken(token);
  if (!verification.valid) return verification;

  return {
    valid: true,
    inviteId: verification.inviteId,
    groupId: verification.groupId,
    expiresAtMs: verification.expiresAtMs
  };
}

module.exports = {
  getDefaultInviteTtlHours,
  computeInviteExpiry,
  buildInviteToken,
  parseInviteToken
};
