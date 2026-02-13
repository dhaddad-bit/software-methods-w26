process.env.NODE_ENV = 'test';

const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { getCleanupPolicy } = require('../maintenance/cleanup/policy');
const { getCleanupSelectors } = require('../maintenance/cleanup/selectors');
const { parseArgs, runCleanup, sortIdValues } = require('../maintenance/cleanup');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
  process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS = 'false';
  process.env.CLEANUP_EXPIRED_INVITES_TTL_DAYS = '7';
  process.env.CLEANUP_READ_NOTIFICATIONS_TTL_DAYS = '30';
  process.env.CLEANUP_OUTBOX_SENT_TTL_DAYS = '30';
  process.env.CLEANUP_OUTBOX_DEAD_TTL_DAYS = '90';
  process.env.CLEANUP_CANCELLED_EVENTS_TTL_DAYS = '60';
  process.env.CLEANUP_SAMPLE_LIMIT = '10';
});

function makeArgs(overrides = {}) {
  return {
    dryRun: false,
    apply: false,
    confirm: '',
    json: true,
    ...overrides
  };
}

async function seedCleanupFixtures() {
  const owner = await createUser({
    googleSub: 'cleanup-owner-sub',
    email: 'cleanup-owner@example.com',
    name: 'Cleanup Owner'
  });
  const group = await db.createGroup('Cleanup Group', owner.id);
  await db.addGroupMember(group.id, owner.id, 'owner');

  const expiredInvite = await db.createGroupInvite({
    groupId: group.id,
    createdByUserId: owner.id,
    targetEmail: 'expired@example.com',
    expiresAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
  });
  await db.query(
    `UPDATE group_invites
     SET status = 'EXPIRED',
         updated_at = NOW() - INTERVAL '20 days'
     WHERE invite_id = $1`,
    [expiredInvite.invite_id]
  );

  const pendingExpiredInvite = await db.createGroupInvite({
    groupId: group.id,
    createdByUserId: owner.id,
    targetEmail: 'pending-expired@example.com',
    expiresAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
  });
  await db.query(
    `UPDATE group_invites
     SET status = 'PENDING',
         expires_at = NOW() - INTERVAL '20 days',
         updated_at = NOW() - INTERVAL '20 days'
     WHERE invite_id = $1`,
    [pendingExpiredInvite.invite_id]
  );

  const freshInvite = await db.createGroupInvite({
    groupId: group.id,
    createdByUserId: owner.id,
    targetEmail: 'fresh@example.com',
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
  });

  const oldNotificationResult = await db.query(
    `INSERT INTO notifications (recipient_user_id, type, event_key, payload_json, is_read, read_at, created_at, updated_at)
     VALUES ($1, 'PETITION_STATUS', 'cleanup-old-read', '{"kind":"old"}'::jsonb, TRUE, NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days')
     RETURNING notification_id`,
    [owner.id]
  );
  const oldNotificationId = oldNotificationResult.rows[0].notification_id;

  const freshNotificationResult = await db.query(
    `INSERT INTO notifications (recipient_user_id, type, event_key, payload_json, is_read)
     VALUES ($1, 'PETITION_STATUS', 'cleanup-fresh-unread', '{"kind":"fresh"}'::jsonb, FALSE)
     RETURNING notification_id`,
    [owner.id]
  );
  const freshNotificationId = freshNotificationResult.rows[0].notification_id;

  const oldSentOutboxResult = await db.query(
    `INSERT INTO notification_outbox (
       notification_id,
       channel,
       dedupe_key,
       status,
       attempt_count,
       sent_at,
       next_attempt_at,
       updated_at,
       created_at
     )
     VALUES ($1, 'EMAIL', 'cleanup-old-sent', 'SENT', 1, NOW() - INTERVAL '40 days', NULL, NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days')
     RETURNING outbox_id`,
    [oldNotificationId]
  );

  const oldDeadOutboxResult = await db.query(
    `INSERT INTO notification_outbox (
       notification_id,
       channel,
       dedupe_key,
       status,
       attempt_count,
       next_attempt_at,
       updated_at,
       created_at
     )
     VALUES ($1, 'EMAIL', 'cleanup-old-dead', 'DEAD', 5, NULL, NOW() - INTERVAL '100 days', NOW() - INTERVAL '100 days')
     RETURNING outbox_id`,
    [oldNotificationId]
  );

  await db.query(
    `INSERT INTO notification_outbox (
       notification_id,
       channel,
       dedupe_key,
       status,
       attempt_count,
       next_attempt_at
     )
     VALUES ($1, 'EMAIL', 'cleanup-pending', 'PENDING', 0, NOW() + INTERVAL '1 day')`,
    [freshNotificationId]
  );

  const calendar = await db.upsertCalendarForUser({
    userId: owner.id,
    gcalId: 'primary',
    calendarName: 'Primary'
  });

  await db.query(
    `INSERT INTO cal_event (
       calendar_id,
       provider_event_id,
       event_name,
       event_start,
       event_end,
       status,
       blocking_level,
       last_synced_at
     )
     VALUES ($1, 'cleanup-cancelled', 'Cancelled', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days', 'cancelled', 'B3', NOW() - INTERVAL '100 days')`,
    [calendar.calendar_id]
  );

  return {
    inviteIds: {
      expired: expiredInvite.invite_id,
      pendingExpired: pendingExpiredInvite.invite_id,
      fresh: freshInvite.invite_id
    },
    notificationIds: {
      old: oldNotificationId,
      fresh: freshNotificationId
    },
    outboxIds: {
      sent: oldSentOutboxResult.rows[0].outbox_id,
      dead: oldDeadOutboxResult.rows[0].outbox_id
    }
  };
}

test('cleanup parseArgs defaults to dry-run and parses flags', () => {
  expect(parseArgs([])).toMatchObject({ dryRun: true, apply: false, json: false });
  expect(parseArgs(['--apply', '--confirm', 'APPLY_CLEANUP', '--json'])).toMatchObject({
    dryRun: false,
    apply: true,
    confirm: 'APPLY_CLEANUP',
    json: true
  });
});

test('cleanup policy toggles cancelled-events selector', () => {
  process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS = 'false';
  let selectors = getCleanupSelectors(getCleanupPolicy());
  expect(selectors.some((selector) => selector.key === 'cancelled_calendar_events')).toBe(false);

  process.env.CLEANUP_INCLUDE_CANCELLED_EVENTS = 'true';
  selectors = getCleanupSelectors(getCleanupPolicy());
  expect(selectors.some((selector) => selector.key === 'cancelled_calendar_events')).toBe(true);
});

test('sortIdValues keeps deterministic ordering', () => {
  expect(sortIdValues([10, 2, 1])).toEqual([1, 2, 10]);
  expect(sortIdValues(['b', 'a'])).toEqual(['a', 'b']);
});

test('dry-run reports counts and sample ids without mutating data', async () => {
  const fixtures = await seedCleanupFixtures();

  const reportText = await runCleanup({
    args: makeArgs({ dryRun: true, apply: false, json: true })
  });
  const report = JSON.parse(reportText);

  expect(report.mode).toBe('dry-run');

  const expiredInvitesEntry = report.entries.find((entry) => entry.key === 'expired_invites');
  expect(expiredInvitesEntry.count).toBeGreaterThanOrEqual(2);
  expect(expiredInvitesEntry.sampleIds).toEqual(
    [...expiredInvitesEntry.sampleIds].sort((a, b) => a - b)
  );

  const oldInviteStillExists = await db.query(
    `SELECT 1 FROM group_invites WHERE invite_id = $1`,
    [fixtures.inviteIds.expired]
  );
  expect(oldInviteStillExists.rowCount).toBe(1);
});

test('apply mode requires explicit confirmation token', async () => {
  await seedCleanupFixtures();

  await expect(
    runCleanup({
      args: makeArgs({ apply: true, dryRun: false, confirm: 'NOPE', json: true })
    })
  ).rejects.toMatchObject({ code: 'MISSING_CONFIRMATION' });
});

test('apply mode deletes only selected rows and reports deterministic ids', async () => {
  const fixtures = await seedCleanupFixtures();

  const reportText = await runCleanup({
    args: makeArgs({ apply: true, dryRun: false, confirm: 'APPLY_CLEANUP', json: true })
  });
  const report = JSON.parse(reportText);

  expect(report.mode).toBe('apply');

  const inviteEntry = report.entries.find((entry) => entry.key === 'expired_invites');
  expect(inviteEntry.deletedCount).toBeGreaterThanOrEqual(2);
  expect(inviteEntry.sampleIds).toEqual([...inviteEntry.sampleIds].sort((a, b) => a - b));

  const removedInvites = await db.query(
    `SELECT invite_id
     FROM group_invites
     WHERE invite_id = ANY($1::int[])`,
    [[fixtures.inviteIds.expired, fixtures.inviteIds.pendingExpired]]
  );
  expect(removedInvites.rowCount).toBe(0);

  const freshInvite = await db.query(`SELECT invite_id FROM group_invites WHERE invite_id = $1`, [
    fixtures.inviteIds.fresh
  ]);
  expect(freshInvite.rowCount).toBe(1);

  const oldNotification = await db.query(
    `SELECT notification_id FROM notifications WHERE notification_id = $1`,
    [fixtures.notificationIds.old]
  );
  expect(oldNotification.rowCount).toBe(0);

  const freshNotification = await db.query(
    `SELECT notification_id FROM notifications WHERE notification_id = $1`,
    [fixtures.notificationIds.fresh]
  );
  expect(freshNotification.rowCount).toBe(1);

  const oldOutboxRows = await db.query(
    `SELECT outbox_id
     FROM notification_outbox
     WHERE outbox_id = ANY($1::int[])`,
    [[fixtures.outboxIds.sent, fixtures.outboxIds.dead]]
  );
  expect(oldOutboxRows.rowCount).toBe(0);
});
