process.env.NODE_ENV = 'test';

const path = require('path');
const { pathToFileURL } = require('url');

const PREV_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});

afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

async function loadRenderer() {
  const fileUrl = pathToFileURL(
    path.resolve(__dirname, '..', '..', 'frontend', 'js', 'calendar', 'renderUtils.mjs')
  ).href;
  return import(fileUrl);
}

test('processEventsForRender splits a cross-midnight event into day-bounded segments', async () => {
  const { processEventsForRender } = await loadRenderer();

  const startMs = new Date(2026, 0, 1, 23, 0, 0, 0).getTime();
  const endMs = new Date(2026, 0, 2, 1, 0, 0, 0).getTime();
  const midnightMs = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();

  const segments = processEventsForRender([
    { id: 1, source: 'google', title: 'Overnight', start: startMs, end: endMs }
  ]);

  expect(segments).toHaveLength(2);
  expect(segments[0].startMs).toBe(startMs);
  expect(segments[0].endMs).toBe(midnightMs);
  expect(segments[1].startMs).toBe(midnightMs);
  expect(segments[1].endMs).toBe(endMs);

  expect(segments[0].fullStartMs).toBe(startMs);
  expect(segments[0].fullEndMs).toBe(endMs);
  expect(segments[1].fullStartMs).toBe(startMs);
  expect(segments[1].fullEndMs).toBe(endMs);

  expect(segments[0].renderKey).not.toBe(segments[1].renderKey);
});

test('processEventsForRender does not create a zero-length segment when event ends at midnight', async () => {
  const { processEventsForRender } = await loadRenderer();

  const startMs = new Date(2026, 0, 1, 22, 0, 0, 0).getTime();
  const endMs = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();

  const segments = processEventsForRender([
    { id: 2, source: 'google', title: 'To Midnight', start: startMs, end: endMs }
  ]);

  expect(segments).toHaveLength(1);
  expect(segments[0].startMs).toBe(startMs);
  expect(segments[0].endMs).toBe(endMs);
});

test('processEventsForRender supports multi-day events (one segment per day boundary)', async () => {
  const { processEventsForRender } = await loadRenderer();

  const startMs = new Date(2026, 0, 1, 23, 0, 0, 0).getTime();
  const endMs = new Date(2026, 0, 3, 1, 0, 0, 0).getTime();

  const jan2Midnight = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();
  const jan3Midnight = new Date(2026, 0, 3, 0, 0, 0, 0).getTime();

  const segments = processEventsForRender([
    { id: 3, source: 'manual', title: 'Multi-day', start: startMs, end: endMs }
  ]);

  expect(segments).toHaveLength(3);
  expect(segments[0].startMs).toBe(startMs);
  expect(segments[0].endMs).toBe(jan2Midnight);
  expect(segments[1].startMs).toBe(jan2Midnight);
  expect(segments[1].endMs).toBe(jan3Midnight);
  expect(segments[2].startMs).toBe(jan3Midnight);
  expect(segments[2].endMs).toBe(endMs);
});
