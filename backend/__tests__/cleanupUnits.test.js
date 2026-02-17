process.env.NODE_ENV = 'test';

jest.mock('../db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn()
}));

const db = require('../db');
const { getCleanupPolicy } = require('../maintenance/cleanup/policy');
const { getCleanupSelectors } = require('../maintenance/cleanup/selectors');
const {
  parseArgs,
  sortIdValues,
  collectDryRunReport,
  applyCleanup,
  runCleanup,
  main
} = require('../maintenance/cleanup');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS;
  delete process.env.CLEANUP_CANCELLED_EVENTS_TTL_DAYS;
  delete process.env.CLEANUP_READ_NOTIFICATIONS_TTL_DAYS;
  delete process.env.CLEANUP_OUTBOX_SENT_TTL_DAYS;
  delete process.env.CLEANUP_OUTBOX_DEAD_TTL_DAYS;
  delete process.env.CLEANUP_EXPIRED_INVITES_TTL_DAYS;
  delete process.env.CLEANUP_SAMPLE_LIMIT;
});

test('cleanup policy parsing applies defaults and env overrides', () => {
  const defaults = getCleanupPolicy();
  expect(defaults).toMatchObject({
    includeCancelledEvents: false,
    sampleLimit: 10
  });

  process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS = 'true';
  process.env.CLEANUP_SAMPLE_LIMIT = '25';
  process.env.CLEANUP_OUTBOX_DEAD_TTL_DAYS = '100';
  const overridden = getCleanupPolicy();
  expect(overridden).toMatchObject({
    includeCancelledEvents: true,
    sampleLimit: 25,
    outboxDeadTtlDays: 100
  });
});

test('cleanup selectors include optional cancelled events based on policy', () => {
  let selectors = getCleanupSelectors({
    includeCancelledEvents: false,
    cancelledEventsTtlDays: 60,
    readNotificationsTtlDays: 30,
    outboxSentTtlDays: 30,
    outboxDeadTtlDays: 90,
    expiredInvitesTtlDays: 7
  });
  expect(selectors.some((entry) => entry.key === 'cancelled_calendar_events')).toBe(false);

  selectors = getCleanupSelectors({
    includeCancelledEvents: true,
    cancelledEventsTtlDays: 60,
    readNotificationsTtlDays: 30,
    outboxSentTtlDays: 30,
    outboxDeadTtlDays: 90,
    expiredInvitesTtlDays: 7
  });
  expect(selectors.some((entry) => entry.key === 'cancelled_calendar_events')).toBe(true);
});

test('cleanup argument parsing and deterministic id sorting', () => {
  expect(parseArgs([])).toMatchObject({ dryRun: true, apply: false, json: false });
  expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, apply: false, json: false });
  expect(parseArgs(['--apply', '--confirm', 'APPLY_CLEANUP', '--json'])).toMatchObject({
    apply: true,
    confirm: 'APPLY_CLEANUP',
    json: true
  });
  expect(sortIdValues([9, 1, 5])).toEqual([1, 5, 9]);
  expect(sortIdValues(['c', 'a'])).toEqual(['a', 'c']);
});

test('collectDryRunReport returns counts and sorted sample IDs', async () => {
  const queryFn = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{ count: 2 }] })
    .mockResolvedValueOnce({ rows: [{ invite_id: 20 }, { invite_id: 2 }] });
  const selectors = [
    {
      key: 'expired_invites',
      idColumn: 'invite_id',
      countSql: 'count',
      sampleSql: 'sample'
    }
  ];

  const report = await collectDryRunReport({
    queryFn,
    selectors,
    sampleLimit: 10
  });
  expect(report).toEqual([
    {
      key: 'expired_invites',
      count: 2,
      sampleIds: [2, 20]
    }
  ]);
});

test('applyCleanup runs inside transaction and returns sorted deleted IDs', async () => {
  db.withTransaction.mockImplementation(async (handler) =>
    handler({
      query: jest.fn().mockResolvedValue({
        rows: [{ outbox_id: 3 }, { outbox_id: 1 }]
      })
    })
  );

  const report = await applyCleanup({
    selectors: [
      {
        key: 'outbox_dead',
        idColumn: 'outbox_id',
        deleteSql: 'delete from notification_outbox'
      }
    ],
    sampleLimit: 1
  });

  expect(report).toEqual([
    {
      key: 'outbox_dead',
      deletedCount: 2,
      sampleIds: [1]
    }
  ]);
});

test('runCleanup enforces confirmation token and supports dry-run json output', async () => {
  await expect(
    runCleanup({
      args: {
        dryRun: false,
        apply: true,
        confirm: 'NO',
        json: true
      }
    })
  ).rejects.toMatchObject({ code: 'MISSING_CONFIRMATION' });

  const queryFn = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] });

  const output = await runCleanup({
    args: {
      dryRun: true,
      apply: false,
      confirm: '',
      json: true
    },
    queryFn
  });
  const parsed = JSON.parse(output);
  expect(parsed.mode).toBe('dry-run');
  expect(Array.isArray(parsed.entries)).toBe(true);
});

test('runCleanup returns formatted text report when json flag is disabled', async () => {
  const queryFn = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{ count: 1 }] })
    .mockResolvedValueOnce({ rows: [{ invite_id: 7 }] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    .mockResolvedValueOnce({ rows: [] });

  const output = await runCleanup({
    args: {
      dryRun: true,
      apply: false,
      confirm: '',
      json: false
    },
    queryFn
  });

  expect(output).toContain('mode=dry-run');
  expect(output).toContain('expired_invites: count=1 sample_ids=[7]');
});

test('cleanup main writes output to stdout', async () => {
  const originalArgv = process.argv;
  process.argv = ['node', 'cleanup.js', '--dry-run'];

  db.query.mockImplementation(async (sql) => {
    if (String(sql).toLowerCase().includes('count')) {
      return { rows: [{ count: 0 }] };
    }
    return { rows: [] };
  });

  const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('mode=dry-run'));
  } finally {
    writeSpy.mockRestore();
    process.argv = originalArgv;
  }
});
