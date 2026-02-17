const { google } = require('googleapis');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function isSyncTokenExpired(error) {
  const status = error?.code || error?.response?.status || error?.status;
  return status === 410;
}

function getGoogleErrorInfo(error) {
  const status = error?.code || error?.response?.status || error?.status || null;
  const data = error?.response?.data || {};
  const nestedError = data?.error;

  const oauthError =
    typeof nestedError === 'string'
      ? nestedError
      : typeof nestedError?.status === 'string'
        ? nestedError.status
        : null;

  const oauthDescription =
    typeof data?.error_description === 'string' ? data.error_description : null;

  const reason =
    data?.error?.errors?.[0]?.reason ||
    data?.error?.details?.[0]?.reason ||
    null;

  const message =
    oauthDescription ||
    data?.error?.message ||
    error?.message ||
    'Unknown Google API error';

  return {
    status,
    oauthError,
    oauthDescription,
    reason,
    message
  };
}

function isGoogleAuthError(error) {
  const details = getGoogleErrorInfo(error);
  if (details.status === 401 || details.status === 403) return true;

  const combined = `${details.oauthError || ''} ${details.oauthDescription || ''} ${details.message || ''}`
    .trim()
    .toLowerCase();

  return combined.includes('invalid_grant') || combined.includes('invalid credentials');
}

function isRetryableGoogleError(error) {
  const details = getGoogleErrorInfo(error);
  if (details.status === 429) return true;
  if (typeof details.status === 'number' && details.status >= 500) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(error?.code)) {
    return true;
  }
  return false;
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

function normalizeGoogleDateString(value) {
  if (!value || typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00Z`;
  }
  return value;
}

function normalizeGoogleEventForStorage(event, calendarTimeZone = null) {
  const providerEventId = event?.id || null;
  if (!providerEventId) return null;

  const status = typeof event?.status === 'string' ? event.status : 'confirmed';
  if (status === 'cancelled') {
    return {
      providerEventId,
      status: 'cancelled'
    };
  }

  const startRaw = event?.start?.dateTime || event?.start?.date;
  const endRaw = event?.end?.dateTime || event?.end?.date;
  const start = normalizeGoogleDateString(startRaw);
  const end = normalizeGoogleDateString(endRaw);
  if (!start || !end) return null;

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  const originalStartTime = normalizeGoogleDateString(
    event?.originalStartTime?.dateTime || event?.originalStartTime?.date
  );
  const eventTimeZone = event?.start?.timeZone || event?.end?.timeZone || calendarTimeZone || null;

  return {
    providerEventId,
    iCalUID: event?.iCalUID || null,
    recurringEventId: event?.recurringEventId || null,
    originalStartTime: originalStartTime || null,
    title: event?.summary || null,
    start,
    end,
    status,
    providerUpdatedAt: event?.updated || null,
    etag: event?.etag || null,
    isAllDay: Boolean(event?.start?.date && event?.end?.date),
    eventTimeZone
  };
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

async function listGoogleCalendars({ refreshToken }) {
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: 'v3', auth });

  const items = [];
  let pageToken = undefined;
  do {
    const response = await calendar.calendarList.list({
      pageToken,
      maxResults: 250
    });
    items.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return items.map((entry) => ({
    id: entry.id,
    summary: entry.summary || entry.id || 'calendar',
    primary: Boolean(entry.primary),
    accessRole: entry.accessRole || null,
    selected: entry.selected !== false
  }));
}

async function syncGoogleEvents({ refreshToken, calendarId = 'primary', syncToken = null }) {
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: 'v3', auth });

  /** @type {any} */
  const baseParams = {
    calendarId,
    maxResults: 2500,
    singleEvents: true,
    showDeleted: true
  };

  if (syncToken) {
    baseParams.syncToken = syncToken;
  }

  const items = [];
  let pageToken = undefined;
  let nextSyncToken = null;

  try {
    do {
      const response = await calendar.events.list({
        ...baseParams,
        pageToken
      });

      const pageItems = response.data.items || [];
      items.push(...pageItems);

      pageToken = response.data.nextPageToken || undefined;
      if (!pageToken && response.data.nextSyncToken) {
        nextSyncToken = response.data.nextSyncToken;
      }
    } while (pageToken);
  } catch (error) {
    if (isSyncTokenExpired(error)) {
      const err = new Error('Google Calendar sync token expired');
      err.code = 'SYNC_TOKEN_EXPIRED';
      throw err;
    }
    throw error;
  }

  return {
    items,
    nextSyncToken,
    fullSync: !syncToken
  };
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
  getGoogleErrorInfo,
  isGoogleAuthError,
  isRetryableGoogleError,
  listGoogleEvents,
  listGoogleCalendars,
  syncGoogleEvents,
  normalizeEventsToIntervals,
  normalizeGoogleEventForStorage,
  fetchBusyIntervalsForUser
};
