function parseRetentionDays(raw, fallbackDays) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallbackDays;
  return parsed;
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function getCleanupPolicy() {
  const sampleLimitParsed = Number.parseInt(process.env.CLEANUP_SAMPLE_LIMIT || '10', 10);
  return {
    includeCancelledEvents: parseBoolean(process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS, false),
    cancelledEventsTtlDays: parseRetentionDays(process.env.CLEANUP_CANCELLED_EVENTS_TTL_DAYS, 60),
    readNotificationsTtlDays: parseRetentionDays(process.env.CLEANUP_READ_NOTIFICATIONS_TTL_DAYS, 30),
    outboxSentTtlDays: parseRetentionDays(process.env.CLEANUP_OUTBOX_SENT_TTL_DAYS, 30),
    outboxDeadTtlDays: parseRetentionDays(process.env.CLEANUP_OUTBOX_DEAD_TTL_DAYS, 90),
    expiredInvitesTtlDays: parseRetentionDays(process.env.CLEANUP_EXPIRED_INVITES_TTL_DAYS, 7),
    sampleLimit:
      Number.isInteger(sampleLimitParsed) && sampleLimitParsed > 0 ? sampleLimitParsed : 10
  };
}

module.exports = {
  getCleanupPolicy
};
