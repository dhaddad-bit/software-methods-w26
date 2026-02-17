const db = require('../db');
const { ApiError } = require('../lib/apiError');

const VALID_REPAIR_MODES = new Set(['FULL_RESYNC', 'RESET_SYNC_TOKEN']);

async function repairCalendarsForUser({ userId, gcalId = null, mode = 'FULL_RESYNC' }) {
  const normalizedMode = String(mode || '').trim().toUpperCase();
  if (!VALID_REPAIR_MODES.has(normalizedMode)) {
    throw new ApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'mode must be FULL_RESYNC or RESET_SYNC_TOKEN.',
      retryable: false,
      details: { mode }
    });
  }

  const calendars = await db.listUserCalendars({
    userId,
    gcalId: gcalId || null
  });

  if (calendars.length === 0) {
    return {
      mode: normalizedMode,
      repairedCount: 0,
      calendars: []
    };
  }

  const repaired = [];

  for (const calendar of calendars) {
    const syncState = await db.getCalendarSyncState(calendar.calendar_id);
    if (syncState?.in_progress) {
      throw new ApiError({
        status: 409,
        code: 'REPAIR_ALREADY_IN_PROGRESS',
        message: 'Cannot repair sync state while a calendar sync is in progress.',
        retryable: true,
        details: {
          calendarId: calendar.gcal_id,
          calendarDbId: calendar.calendar_id
        }
      });
    }

    if (normalizedMode === 'FULL_RESYNC') {
      await db.query(`DELETE FROM cal_event WHERE calendar_id = $1`, [calendar.calendar_id]);
    }

    await db.resetCalendarSyncState({
      calendarId: calendar.calendar_id,
      clearSyncToken: true
    });

    repaired.push({
      calendarDbId: calendar.calendar_id,
      calendarId: calendar.gcal_id,
      mode: normalizedMode,
      deletedEvents: normalizedMode === 'FULL_RESYNC'
    });
  }

  return {
    mode: normalizedMode,
    repairedCount: repaired.length,
    calendars: repaired
  };
}

module.exports = {
  repairCalendarsForUser,
  VALID_REPAIR_MODES
};
