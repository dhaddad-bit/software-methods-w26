function daysToInterval(days) {
  return `INTERVAL '${days} days'`;
}

function getCleanupSelectors(policy) {
  const selectors = [
    {
      key: 'expired_invites',
      idColumn: 'invite_id',
      sampleSql: `
        SELECT invite_id
        FROM group_invites
        WHERE (
            status = 'EXPIRED'
            OR (status = 'PENDING' AND expires_at < NOW())
          )
          AND COALESCE(updated_at, expires_at) < NOW() - ${daysToInterval(policy.expiredInvitesTtlDays)}
        ORDER BY invite_id ASC
        LIMIT $1`,
      countSql: `
        SELECT COUNT(*)::int AS count
        FROM group_invites
        WHERE (
            status = 'EXPIRED'
            OR (status = 'PENDING' AND expires_at < NOW())
          )
          AND COALESCE(updated_at, expires_at) < NOW() - ${daysToInterval(policy.expiredInvitesTtlDays)}`,
      deleteSql: `
        DELETE FROM group_invites
        WHERE (
            status = 'EXPIRED'
            OR (status = 'PENDING' AND expires_at < NOW())
          )
          AND COALESCE(updated_at, expires_at) < NOW() - ${daysToInterval(policy.expiredInvitesTtlDays)}
        RETURNING invite_id`
    },
    {
      key: 'read_notifications',
      idColumn: 'notification_id',
      sampleSql: `
        SELECT notification_id
        FROM notifications
        WHERE is_read = TRUE
          AND read_at IS NOT NULL
          AND read_at < NOW() - ${daysToInterval(policy.readNotificationsTtlDays)}
        ORDER BY notification_id ASC
        LIMIT $1`,
      countSql: `
        SELECT COUNT(*)::int AS count
        FROM notifications
        WHERE is_read = TRUE
          AND read_at IS NOT NULL
          AND read_at < NOW() - ${daysToInterval(policy.readNotificationsTtlDays)}`,
      deleteSql: `
        DELETE FROM notifications
        WHERE is_read = TRUE
          AND read_at IS NOT NULL
          AND read_at < NOW() - ${daysToInterval(policy.readNotificationsTtlDays)}
        RETURNING notification_id`
    },
    {
      key: 'outbox_sent',
      idColumn: 'outbox_id',
      sampleSql: `
        SELECT outbox_id
        FROM notification_outbox
        WHERE status = 'SENT'
          AND sent_at IS NOT NULL
          AND sent_at < NOW() - ${daysToInterval(policy.outboxSentTtlDays)}
        ORDER BY outbox_id ASC
        LIMIT $1`,
      countSql: `
        SELECT COUNT(*)::int AS count
        FROM notification_outbox
        WHERE status = 'SENT'
          AND sent_at IS NOT NULL
          AND sent_at < NOW() - ${daysToInterval(policy.outboxSentTtlDays)}`,
      deleteSql: `
        DELETE FROM notification_outbox
        WHERE status = 'SENT'
          AND sent_at IS NOT NULL
          AND sent_at < NOW() - ${daysToInterval(policy.outboxSentTtlDays)}
        RETURNING outbox_id`
    },
    {
      key: 'outbox_dead',
      idColumn: 'outbox_id',
      sampleSql: `
        SELECT outbox_id
        FROM notification_outbox
        WHERE status = 'DEAD'
          AND updated_at < NOW() - ${daysToInterval(policy.outboxDeadTtlDays)}
        ORDER BY outbox_id ASC
        LIMIT $1`,
      countSql: `
        SELECT COUNT(*)::int AS count
        FROM notification_outbox
        WHERE status = 'DEAD'
          AND updated_at < NOW() - ${daysToInterval(policy.outboxDeadTtlDays)}`,
      deleteSql: `
        DELETE FROM notification_outbox
        WHERE status = 'DEAD'
          AND updated_at < NOW() - ${daysToInterval(policy.outboxDeadTtlDays)}
        RETURNING outbox_id`
    },
  ];

  if (policy.includeCancelledEvents) {
    selectors.push({
      key: 'cancelled_calendar_events',
      idColumn: 'event_id',
      sampleSql: `
        SELECT event_id
        FROM cal_event
        WHERE status = 'cancelled'
          AND last_synced_at < NOW() - ${daysToInterval(policy.cancelledEventsTtlDays)}
        ORDER BY event_id ASC
        LIMIT $1`,
      countSql: `
        SELECT COUNT(*)::int AS count
        FROM cal_event
        WHERE status = 'cancelled'
          AND last_synced_at < NOW() - ${daysToInterval(policy.cancelledEventsTtlDays)}`,
      deleteSql: `
        DELETE FROM cal_event
        WHERE status = 'cancelled'
          AND last_synced_at < NOW() - ${daysToInterval(policy.cancelledEventsTtlDays)}
        RETURNING event_id`
    });
  }

  return selectors;
}

module.exports = {
  getCleanupSelectors
};
