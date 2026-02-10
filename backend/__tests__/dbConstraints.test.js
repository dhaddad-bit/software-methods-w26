process.env.NODE_ENV = 'test';

const db = require('../db');
const { runMigrations, resetDb, createUser } = require('./testUtils');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function createPrimaryCalendar(userId) {
  const result = await db.query(
    `INSERT INTO calendar (user_id, gcal_id, calendar_name)
     VALUES ($1, 'primary', 'primary')
     RETURNING calendar_id`,
    [userId]
  );
  return result.rows[0].calendar_id;
}

test('cal_event enforces event_end > event_start', async () => {
  const user = await createUser({
    googleSub: 'sub-constraints-a',
    email: 'constraints-a@example.com',
    name: 'Constraints A',
    refreshToken: 'refresh-a'
  });
  const calendarId = await createPrimaryCalendar(user.id);

  await expect(
    db.query(
      `INSERT INTO cal_event (calendar_id, provider_event_id, event_name, event_start, event_end, status, blocking_level, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'B3', NOW())`,
      [calendarId, 'bad-time', 'Bad Time', '2026-02-01T10:00:00Z', '2026-02-01T10:00:00Z']
    )
  ).rejects.toMatchObject({ code: '23514' });
});

test('cal_event enforces blocking_level domain', async () => {
  const user = await createUser({
    googleSub: 'sub-constraints-b',
    email: 'constraints-b@example.com',
    name: 'Constraints B',
    refreshToken: 'refresh-b'
  });
  const calendarId = await createPrimaryCalendar(user.id);

  await expect(
    db.query(
      `INSERT INTO cal_event (calendar_id, provider_event_id, event_name, event_start, event_end, status, blocking_level, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'B9', NOW())`,
      [calendarId, 'bad-level', 'Bad Level', '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z']
    )
  ).rejects.toMatchObject({ code: '23514' });
});

test('cal_event prevents duplicate provider_event_id per calendar', async () => {
  const user = await createUser({
    googleSub: 'sub-constraints-c',
    email: 'constraints-c@example.com',
    name: 'Constraints C',
    refreshToken: 'refresh-c'
  });
  const calendarId = await createPrimaryCalendar(user.id);

  await db.query(
    `INSERT INTO cal_event (calendar_id, provider_event_id, event_name, event_start, event_end, status, blocking_level, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', 'B3', NOW())`,
    [calendarId, 'dup-event', 'Dup', '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z']
  );

  await expect(
    db.query(
      `INSERT INTO cal_event (calendar_id, provider_event_id, event_name, event_start, event_end, status, blocking_level, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'B3', NOW())`,
      [calendarId, 'dup-event', 'Dup2', '2026-02-02T10:00:00Z', '2026-02-02T11:00:00Z']
    )
  ).rejects.toMatchObject({ code: '23505' });
});

test('user_busy_block enforces end_time > start_time', async () => {
  const user = await createUser({
    googleSub: 'sub-constraints-d',
    email: 'constraints-d@example.com',
    name: 'Constraints D',
    refreshToken: 'refresh-d'
  });

  await expect(
    db.query(
      `INSERT INTO user_busy_block (user_id, title, start_time, end_time, blocking_level)
       VALUES ($1, $2, $3, $4, 'B3')`,
      [user.id, 'Bad Block', '2026-02-01T10:00:00Z', '2026-02-01T09:00:00Z']
    )
  ).rejects.toMatchObject({ code: '23514' });
});

