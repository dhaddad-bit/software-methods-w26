process.env.NODE_ENV = 'test';

const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const provider = require('../outbox/provider');
const worker = require('../outbox/worker');
const runWorker = require('../outbox/run_worker');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  delete process.env.EMAIL_PROVIDER;
  delete process.env.NOTIFICATIONS_EMAIL_ENABLED;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS;
});

async function seedPendingOutboxRow({ dedupeKey = 'outbox-seed-1' } = {}) {
  const user = await createUser({
    googleSub: `sub-${dedupeKey}`,
    email: `${dedupeKey}@example.com`,
    name: `User ${dedupeKey}`
  });

  const notificationResult = await db.query(
    `INSERT INTO notifications (recipient_user_id, type, event_key, payload_json)
     VALUES ($1, 'PETITION_CREATED', $2, '{"petitionId":1}'::jsonb)
     RETURNING notification_id`,
    [user.id, `event-${dedupeKey}`]
  );

  const outboxResult = await db.query(
    `INSERT INTO notification_outbox (
       notification_id,
       channel,
       dedupe_key,
       status,
       attempt_count,
       next_attempt_at
     )
     VALUES ($1, 'EMAIL', $2, 'PENDING', 0, NOW() - INTERVAL '1 minute')
     RETURNING outbox_id`,
    [notificationResult.rows[0].notification_id, dedupeKey]
  );

  return {
    userId: user.id,
    notificationId: notificationResult.rows[0].notification_id,
    outboxId: outboxResult.rows[0].outbox_id
  };
}

describe('outbox/provider', () => {
  test('provider helpers respect env configuration', () => {
    expect(provider.getEmailProvider()).toBe('noop');
    expect(provider.isEmailEnabled()).toBe(false);

    process.env.EMAIL_PROVIDER = ' SENDGRID ';
    process.env.NOTIFICATIONS_EMAIL_ENABLED = 'TRUE';
    expect(provider.getEmailProvider()).toBe('sendgrid');
    expect(provider.isEmailEnabled()).toBe(true);
  });

  test('buildEmailPayload and provider dispatch branches', async () => {
    const payload = provider.buildEmailPayload({
      notification: {
        recipient_user_id: 9,
        type: 'PETITION_STATUS',
        payload_json: { petitionId: 1 }
      }
    });
    expect(payload).toMatchObject({
      toUserId: 9,
      type: 'PETITION_STATUS'
    });

    await expect(
      provider.sendEmailViaProvider({
        provider: 'sendgrid',
        message: payload
      })
    ).rejects.toThrow('SENDGRID_API_KEY is required');

    await expect(
      provider.sendEmailViaProvider({
        provider: 'resend',
        message: payload
      })
    ).rejects.toThrow('RESEND_API_KEY is required');

    await expect(
      provider.sendEmailViaProvider({
        provider: 'unknown',
        message: payload
      })
    ).rejects.toThrow('Unsupported EMAIL_PROVIDER');

    const noopResult = await provider.sendEmailViaProvider({
      provider: 'noop',
      message: payload
    });
    expect(noopResult).toMatchObject({ ok: true, provider: 'noop' });

    const skipped = await provider.dispatchOutboxMessage({
      channel: 'SMS',
      notification: { payload_json: {} }
    });
    expect(skipped).toMatchObject({ ok: true, skipped: true });

    process.env.NOTIFICATIONS_EMAIL_ENABLED = 'true';
    process.env.EMAIL_PROVIDER = 'noop';
    const sent = await provider.dispatchOutboxMessage({
      channel: 'EMAIL',
      notification: {
        recipient_user_id: 1,
        type: 'PETITION_STATUS',
        payload_json: {}
      }
    });
    expect(sent).toMatchObject({ ok: true });
  });
});

describe('outbox/worker and runner', () => {
  test('getMaxOutboxAttempts uses env and fallback', () => {
    expect(worker.getMaxOutboxAttempts()).toBe(5);
    process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS = '7';
    expect(worker.getMaxOutboxAttempts()).toBe(7);
    process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS = '0';
    expect(worker.getMaxOutboxAttempts()).toBe(5);
  });

  test('backoff helpers compute delay and next attempt', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const delay = worker.computeBackoffDelayMs({
      attemptCount: 2,
      baseDelayMs: 1000,
      capDelayMs: 10_000,
      jitterMaxMs: 250
    });
    expect(delay).toBe(4000);

    const nextAttempt = worker.getNextAttemptAt({
      attemptCount: 2,
      now: new Date('2026-01-01T00:00:00Z')
    });
    expect(nextAttempt.getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:04Z'));
    randomSpy.mockRestore();
  });

  test('processOutboxBatch marks rows SENT on success', async () => {
    const fixture = await seedPendingOutboxRow({ dedupeKey: 'success-row' });
    const sender = jest.fn(async () => ({ ok: true }));

    const result = await worker.processOutboxBatch({
      limit: 10,
      sender
    });

    expect(result).toMatchObject({
      claimed: 1,
      sent: 1,
      failed: 0,
      dead: 0
    });
    expect(sender).toHaveBeenCalledTimes(1);

    const outboxRow = await db.query(
      `SELECT status, sent_at
       FROM notification_outbox
       WHERE outbox_id = $1`,
      [fixture.outboxId]
    );
    expect(outboxRow.rows[0].status).toBe('SENT');
    expect(outboxRow.rows[0].sent_at).toBeTruthy();
  });

  test('processOutboxBatch marks rows DEAD after max attempts', async () => {
    await seedPendingOutboxRow({ dedupeKey: 'dead-row' });
    process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS = '1';

    const result = await worker.processOutboxBatch({
      limit: 10,
      sender: async () => {
        throw new Error('send failed');
      }
    });

    expect(result).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      dead: 1
    });

    const outboxRow = await db.query(
      `SELECT status, attempt_count
       FROM notification_outbox
       WHERE dedupe_key = 'dead-row'`
    );
    expect(outboxRow.rows[0]).toMatchObject({
      status: 'DEAD',
      attempt_count: 1
    });
  });

  test('claimOutboxBatch prevents duplicate claims', async () => {
    await seedPendingOutboxRow({ dedupeKey: 'claim-row' });
    const firstClaim = await db.claimOutboxBatch({ limit: 10, now: new Date() });
    const secondClaim = await db.claimOutboxBatch({ limit: 10, now: new Date() });

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
  });

  test('run_worker parseArgs and main process outbox rows', async () => {
    await seedPendingOutboxRow({ dedupeKey: 'runner-row' });
    process.env.NOTIFICATIONS_EMAIL_ENABLED = 'false';

    expect(runWorker.parseArgs(['--limit', '12'])).toMatchObject({ limit: 12 });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWorker.main();
    writeSpy.mockRestore();

    const outboxRow = await db.query(
      `SELECT status
       FROM notification_outbox
       WHERE dedupe_key = 'runner-row'`
    );
    expect(outboxRow.rows[0].status).toBe('SENT');
  });
});
