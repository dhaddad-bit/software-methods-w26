function normalizeNotificationLimit(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function normalizeNotificationOffset(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function mapNotificationRow(row) {
  return {
    notificationId: row.notification_id,
    recipientUserId: row.recipient_user_id,
    type: row.type,
    eventKey: row.event_key,
    payload: row.payload_json,
    isRead: row.is_read,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  normalizeNotificationLimit,
  normalizeNotificationOffset,
  mapNotificationRow
};
