process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const googleCalendar = require('../services/googleCalendar');
const {
  normalizeEventsToIntervals,
  fetchBusyIntervalsForUser,
  getGoogleErrorInfo,
  isGoogleAuthError,
  isRetryableGoogleError,
  normalizeGoogleEventForStorage
} = googleCalendar;

function loadParseEventTime() {
  const filePath = path.join(__dirname, '..', 'services', 'googleCalendar.js');
  const code = fs.readFileSync(filePath, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    process,
    __dirname: path.dirname(filePath),
    __filename: filePath
  };

  vm.runInNewContext(code, sandbox, { filename: filePath });

  if (typeof sandbox.parseEventTime !== 'function') {
    throw new Error('parseEventTime not available for testing');
  }

  return sandbox.parseEventTime;
}

test('parseEventTime uses midnight UTC for date-only events', () => {
  // SRS FN-02: Calendar Retrieval and Processing
  const parseEventTime = loadParseEventTime();
  const result = parseEventTime({ date: '2026-02-01' });
  expect(result).toBe(Date.parse('2026-02-01T00:00:00Z'));
});

test('normalizeEventsToIntervals skips invalid events', () => {
  // SRS FN-02: Calendar Retrieval and Processing
  const events = [
    null,
    { id: 'missing-end', start: { dateTime: '2026-02-01T10:00:00Z' } },
    { id: 'missing-start', end: { dateTime: '2026-02-01T11:00:00Z' } },
    { id: 'bad-date', start: { dateTime: 'not-a-date' }, end: { dateTime: '2026-02-01T11:00:00Z' } },
    { id: 'end-before-start', start: { dateTime: '2026-02-01T12:00:00Z' }, end: { dateTime: '2026-02-01T11:00:00Z' } },
    { id: 'good', start: { dateTime: '2026-02-01T13:00:00Z' }, end: { dateTime: '2026-02-01T14:00:00Z' } }
  ];

  const intervals = normalizeEventsToIntervals(events, 42);
  expect(intervals).toHaveLength(1);
  expect(intervals[0]).toMatchObject({
    eventRef: 'good',
    userId: 42,
    startMs: Date.parse('2026-02-01T13:00:00Z'),
    endMs: Date.parse('2026-02-01T14:00:00Z'),
    source: 'google'
  });
});

test('fetchBusyIntervalsForUser throws NO_REFRESH_TOKEN before any API call', async () => {
  // SRS FN-02: Calendar Retrieval and Processing
  const spy = jest.spyOn(googleCalendar, 'listGoogleEvents');

  await expect(
    fetchBusyIntervalsForUser({ userId: 7, windowStartMs: Date.now(), windowEndMs: Date.now() + 1000 })
  ).rejects.toMatchObject({ code: 'NO_REFRESH_TOKEN' });

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('Google error helpers classify auth and retryable failures', () => {
  const authError = new Error('invalid_grant');
  authError.response = {
    status: 401,
    data: {
      error: 'invalid_grant',
      error_description: 'Token revoked'
    }
  };

  expect(getGoogleErrorInfo(authError)).toMatchObject({
    status: 401,
    message: 'Token revoked'
  });
  expect(isGoogleAuthError(authError)).toBe(true);
  expect(isRetryableGoogleError(authError)).toBe(false);

  const retryable = new Error('upstream');
  retryable.response = {
    status: 503,
    data: {
      error: {
        message: 'service unavailable'
      }
    }
  };

  expect(isRetryableGoogleError(retryable)).toBe(true);
});

test('normalizeGoogleEventForStorage handles confirmed, cancelled, and invalid events', () => {
  const confirmed = normalizeGoogleEventForStorage({
    id: 'evt-confirmed',
    summary: 'Planning',
    start: { dateTime: '2026-03-01T10:00:00Z' },
    end: { dateTime: '2026-03-01T11:00:00Z' }
  });
  expect(confirmed).toMatchObject({
    providerEventId: 'evt-confirmed',
    title: 'Planning',
    status: 'confirmed',
    isAllDay: false
  });

  const cancelled = normalizeGoogleEventForStorage({
    id: 'evt-cancelled',
    status: 'cancelled'
  });
  expect(cancelled).toMatchObject({
    providerEventId: 'evt-cancelled',
    status: 'cancelled'
  });

  const invalid = normalizeGoogleEventForStorage({
    id: 'evt-invalid',
    start: { dateTime: 'not-a-date' },
    end: { dateTime: '2026-03-01T11:00:00Z' }
  });
  expect(invalid).toBeNull();
});
