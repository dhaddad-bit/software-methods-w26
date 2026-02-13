process.env.NODE_ENV = 'test';

const {
  normalizeNotificationLimit,
  normalizeNotificationOffset,
  mapNotificationRow
} = require('../notifications/service');

describe('notifications/service', () => {
  test('normalizeNotificationLimit enforces defaults and max', () => {
    expect(normalizeNotificationLimit(undefined)).toBe(50);
    expect(normalizeNotificationLimit('abc')).toBe(50);
    expect(normalizeNotificationLimit('0')).toBe(50);
    expect(normalizeNotificationLimit('10')).toBe(10);
    expect(normalizeNotificationLimit('999')).toBe(200);
  });

  test('normalizeNotificationOffset enforces non-negative offsets', () => {
    expect(normalizeNotificationOffset(undefined)).toBe(0);
    expect(normalizeNotificationOffset('-1')).toBe(0);
    expect(normalizeNotificationOffset('abc')).toBe(0);
    expect(normalizeNotificationOffset('2')).toBe(2);
  });

  test('mapNotificationRow maps db fields to API shape', () => {
    const row = {
      notification_id: 1,
      recipient_user_id: 2,
      type: 'PETITION_CREATED',
      event_key: 'event-key',
      payload_json: { petitionId: 3 },
      is_read: false,
      read_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z')
    };

    expect(mapNotificationRow(row)).toEqual({
      notificationId: 1,
      recipientUserId: 2,
      type: 'PETITION_CREATED',
      eventKey: 'event-key',
      payload: { petitionId: 3 },
      isRead: false,
      readAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z')
    });
  });
});
