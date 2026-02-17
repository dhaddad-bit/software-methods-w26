process.env.NODE_ENV = 'test';

jest.mock('../db', () => ({
  claimOutboxBatch: jest.fn(),
  getNotificationById: jest.fn(),
  markOutboxFailure: jest.fn(),
  markOutboxSent: jest.fn()
}));

const db = require('../db');
const {
  getMaxOutboxAttempts,
  computeBackoffDelayMs,
  getNextAttemptAt,
  processOutboxBatch
} = require('../outbox/worker');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS;
});

test('processOutboxBatch handles missing notification rows as dead', async () => {
  db.claimOutboxBatch.mockResolvedValue([
    {
      outbox_id: 1,
      notification_id: 999,
      channel: 'EMAIL',
      dedupe_key: 'missing',
      attempt_count: 0
    }
  ]);
  db.getNotificationById.mockResolvedValue(null);
  db.markOutboxFailure.mockResolvedValue({
    outbox_id: 1,
    status: 'DEAD'
  });

  const result = await processOutboxBatch({
    sender: async () => ({ ok: true })
  });

  expect(db.markOutboxFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      outboxId: 1,
      maxAttempts: 1
    })
  );
  expect(result).toMatchObject({
    claimed: 1,
    sent: 0,
    failed: 0,
    dead: 1
  });
});

test('outbox worker helper functions use defaults and env overrides', () => {
  expect(getMaxOutboxAttempts()).toBe(5);
  process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS = '8';
  expect(getMaxOutboxAttempts()).toBe(8);
  process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS = '0';
  expect(getMaxOutboxAttempts()).toBe(5);

  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  try {
    expect(
      computeBackoffDelayMs({
        attemptCount: 2,
        baseDelayMs: 1000,
        capDelayMs: 10_000,
        jitterMaxMs: 250
      })
    ).toBe(4000);
  } finally {
    randomSpy.mockRestore();
  }

  const nextAttempt = getNextAttemptAt({
    attemptCount: 1,
    now: new Date('2026-01-01T00:00:00Z')
  });
  expect(nextAttempt.getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:01Z'));
});

test('processOutboxBatch marks sent rows on success', async () => {
  db.claimOutboxBatch.mockResolvedValue([
    {
      outbox_id: 11,
      notification_id: 101,
      channel: 'EMAIL',
      dedupe_key: 'success',
      attempt_count: 0
    }
  ]);
  db.getNotificationById.mockResolvedValue({
    notification_id: 101,
    recipient_user_id: 1,
    payload_json: {}
  });
  db.markOutboxSent.mockResolvedValue({ outbox_id: 11, status: 'SENT' });

  const sender = jest.fn(async () => ({ ok: true }));
  const result = await processOutboxBatch({ sender });

  expect(sender).toHaveBeenCalledTimes(1);
  expect(db.markOutboxSent).toHaveBeenCalledWith({ outboxId: 11 });
  expect(result).toMatchObject({
    claimed: 1,
    sent: 1,
    failed: 0,
    dead: 0
  });
});

test('processOutboxBatch marks failed rows with retry and dead status', async () => {
  db.claimOutboxBatch.mockResolvedValue([
    {
      outbox_id: 21,
      notification_id: 201,
      channel: 'EMAIL',
      dedupe_key: 'retry',
      attempt_count: 1
    },
    {
      outbox_id: 22,
      notification_id: 202,
      channel: 'EMAIL',
      dedupe_key: 'dead',
      attempt_count: 4
    }
  ]);
  db.getNotificationById.mockResolvedValue({
    notification_id: 201,
    recipient_user_id: 1,
    payload_json: {}
  });
  db.markOutboxFailure
    .mockResolvedValueOnce({ outbox_id: 21, status: 'FAILED' })
    .mockResolvedValueOnce({ outbox_id: 22, status: 'DEAD' });

  const sender = jest
    .fn()
    .mockRejectedValueOnce(new Error('transient'))
    .mockRejectedValueOnce(new Error('permanent'));

  const result = await processOutboxBatch({
    sender,
    limit: 2
  });

  expect(db.markOutboxFailure).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    claimed: 2,
    sent: 0,
    failed: 1,
    dead: 1
  });
});
