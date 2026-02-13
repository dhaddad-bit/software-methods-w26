const db = require('../db');

function getMaxOutboxAttempts() {
  const parsed = Number.parseInt(process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS || '5', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 5;
  return parsed;
}

function computeBackoffDelayMs({
  attemptCount,
  baseDelayMs = 1000,
  capDelayMs = 60 * 1000,
  jitterMaxMs = 250
}) {
  const exp = Math.max(0, attemptCount);
  const raw = Math.min(capDelayMs, baseDelayMs * 2 ** exp);
  const jitter = Math.floor(Math.random() * (jitterMaxMs + 1));
  return raw + jitter;
}

function getNextAttemptAt({ attemptCount, now = new Date() }) {
  const delayMs = computeBackoffDelayMs({ attemptCount });
  return new Date(now.getTime() + delayMs);
}

async function processOutboxBatch({ limit = 25, sender }) {
  const claimed = await db.claimOutboxBatch({ limit, now: new Date() });
  const maxAttempts = getMaxOutboxAttempts();

  const results = {
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    dead: 0
  };

  for (const row of claimed) {
    try {
      const notification = await db.getNotificationById(row.notification_id);
      if (!notification) {
        await db.markOutboxFailure({
          outboxId: row.outbox_id,
          lastError: 'Missing notification row',
          nextAttemptAt: null,
          maxAttempts: 1
        });
        results.dead += 1;
        continue;
      }

      await sender({
        channel: row.channel,
        dedupeKey: row.dedupe_key,
        notification
      });

      await db.markOutboxSent({ outboxId: row.outbox_id });
      results.sent += 1;
    } catch (error) {
      const nextAttemptAt = getNextAttemptAt({ attemptCount: row.attempt_count + 1, now: new Date() });
      const updated = await db.markOutboxFailure({
        outboxId: row.outbox_id,
        lastError: String(error?.message || error || 'Unknown outbox error'),
        nextAttemptAt,
        maxAttempts
      });

      if (updated?.status === 'DEAD') results.dead += 1;
      else results.failed += 1;
    }
  }

  return results;
}

module.exports = {
  getMaxOutboxAttempts,
  computeBackoffDelayMs,
  getNextAttemptAt,
  processOutboxBatch
};
