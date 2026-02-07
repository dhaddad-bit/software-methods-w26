const { google } = require('googleapis');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function parseEventTime(eventTime) {
  if (!eventTime) return null;
  if (eventTime.dateTime) {
    const ms = Date.parse(eventTime.dateTime);
    return Number.isNaN(ms) ? null : ms;
  }
  if (eventTime.date) {
    const ms = Date.parse(`${eventTime.date}T00:00:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function normalizeEventsToIntervals(events, userId) {
  if (!Array.isArray(events)) return [];
  const intervals = [];

  for (const event of events) {
    if (!event || !event.start || !event.end) continue;
    const startMs = parseEventTime(event.start);
    const endMs = parseEventTime(event.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;

    intervals.push({
      eventRef: event.id || event.iCalUID || 'google-event',
      userId,
      startMs,
      endMs,
      source: 'google'
    });
  }

  return intervals;
}

async function listGoogleEvents({ refreshToken, timeMin, timeMax }) {
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: 'v3', auth });

  const params = {
    calendarId: 'primary',
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500
  };

  if (timeMin) params.timeMin = new Date(timeMin).toISOString();
  if (timeMax) params.timeMax = new Date(timeMax).toISOString();

  const response = await calendar.events.list(params);
  return response.data.items || [];
}

async function fetchBusyIntervalsForUser({ userId, refreshToken, windowStartMs, windowEndMs }) {
  if (!refreshToken) {
    const err = new Error('No refresh token for user');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }

  const events = await listGoogleEvents({
    refreshToken,
    timeMin: windowStartMs,
    timeMax: windowEndMs
  });

  return normalizeEventsToIntervals(events, userId);
}

module.exports = {
  listGoogleEvents,
  normalizeEventsToIntervals,
  fetchBusyIntervalsForUser
};
