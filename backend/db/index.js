const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
});

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool(
  isProduction
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        ssl: false
      }
);

async function runSchemaMigrations() {
  const basePath = path.join(__dirname, 'table_initialization.sql');
  const migrationPath = path.join(__dirname, 'priority_migrations.sql');

  const baseSql = fs.readFileSync(basePath, 'utf8');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const statements = [baseSql, migrationSql]
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await client.query(stmt);
    }

    // Legacy upgrade: backfill provider_event_id from gcal_event_id and drop legacy column.
    const legacyColumnCheck = await client.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'cal_event'
         AND column_name = 'gcal_event_id'
       LIMIT 1`
    );

    if (legacyColumnCheck.rowCount > 0) {
      await client.query(
        `UPDATE cal_event
         SET provider_event_id = gcal_event_id
         WHERE provider_event_id IS NULL`
      );
      await client.query(`ALTER TABLE cal_event DROP COLUMN IF EXISTS gcal_event_id`);
    }

    await client.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

const testConnection = async () => {
  const result = await pool.query('SELECT NOW()');
  return {
    success: true,
    timestamp: result.rows[0].now,
    message: 'Database connected successfully!'
  };
};

const upsertUserFromGoogle = async (googleSub, email, name, refreshToken) => {
  if (!googleSub && !email) {
    throw new Error('googleSub or email is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let user = null;

    if (googleSub) {
      const existingBySub = await client.query(
        'SELECT id FROM users WHERE google_sub = $1',
        [googleSub]
      );
      if (existingBySub.rows[0]) {
        const updated = await client.query(
          `UPDATE users
           SET email = $2,
               name = $3,
               google_refresh_token = COALESCE($4, google_refresh_token),
               updated_at = NOW()
           WHERE google_sub = $1
           RETURNING id, email, name`,
          [googleSub, email, name, refreshToken || null]
        );
        user = updated.rows[0];
      }
    }

    if (!user && email) {
      const existingByEmail = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      if (existingByEmail.rows[0]) {
        const updated = await client.query(
          `UPDATE users
           SET google_sub = COALESCE($2, google_sub),
               name = $3,
               google_refresh_token = COALESCE($4, google_refresh_token),
               updated_at = NOW()
           WHERE email = $1
           RETURNING id, email, name`,
          [email, googleSub || null, name, refreshToken || null]
        );
        user = updated.rows[0];
      }
    }

    if (!user) {
      const inserted = await client.query(
        `INSERT INTO users (google_sub, email, name, google_refresh_token)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name`,
        [googleSub || null, email, name, refreshToken || null]
      );
      user = inserted.rows[0];
    }

    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getUserById = async (userId) => {
  const result = await pool.query(
    `SELECT id, email, name, google_refresh_token
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0];
};

const getUserByEmail = async (email) => {
  const result = await pool.query(
    `SELECT id, email, name, google_refresh_token
     FROM users
     WHERE email = $1`,
    [email]
  );
  return result.rows[0];
};

const createGroup = async (name, createdByUserId) => {
  const result = await pool.query(
    `INSERT INTO groups (name, created_by_user_id)
     VALUES ($1, $2)
     RETURNING id, name, created_by_user_id, created_at, updated_at`,
    [name, createdByUserId]
  );
  return result.rows[0];
};

const listGroupsForUser = async (userId) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.created_by_user_id, g.created_at, g.updated_at
     FROM groups g
     INNER JOIN group_memberships gm ON gm.group_id = g.id
     WHERE gm.user_id = $1
     ORDER BY g.id`,
    [userId]
  );
  return result.rows;
};

const getGroupById = async (groupId) => {
  const result = await pool.query(
    `SELECT id, name, created_by_user_id, created_at, updated_at
     FROM groups
     WHERE id = $1`,
    [groupId]
  );
  return result.rows[0];
};

const isUserInGroup = async (groupId, userId) => {
  const result = await pool.query(
    `SELECT 1 FROM group_memberships WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );
  return result.rowCount > 0;
};

const addGroupMember = async (groupId, userId, role = null) => {
  const result = await pool.query(
    `INSERT INTO group_memberships (group_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO NOTHING
     RETURNING group_id, user_id, role`,
    [groupId, userId, role]
  );
  return result.rows[0];
};

const getGroupMembers = async (groupId) => {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name
     FROM users u
     INNER JOIN group_memberships gm ON gm.user_id = u.id
     WHERE gm.group_id = $1
     ORDER BY u.id`,
    [groupId]
  );
  return result.rows;
};

const getGroupMembersWithTokens = async (groupId) => {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.google_refresh_token
     FROM users u
     INNER JOIN group_memberships gm ON gm.user_id = u.id
     WHERE gm.group_id = $1
     ORDER BY u.id`,
    [groupId]
  );
  return result.rows;
};

const createPetition = async ({
  groupId,
  createdByUserId,
  title,
  startTime,
  endTime,
  priority = 'HIGHEST',
  status = 'OPEN'
}) => {
  const result = await pool.query(
    `INSERT INTO petitions (group_id, created_by_user_id, title, start_time, end_time, priority, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
    [groupId, createdByUserId, title, startTime, endTime, priority, status]
  );
  return result.rows[0];
};

const getPetitionById = async (petitionId) => {
  const result = await pool.query(
    `SELECT id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at
     FROM petitions
     WHERE id = $1`,
    [petitionId]
  );
  return result.rows[0];
};

const listGroupPetitions = async ({ groupId, userId }) => {
  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            p.created_at, p.updated_at,
            g.name AS group_name,
            COUNT(DISTINCT gm.user_id) AS group_size,
            COUNT(DISTINCT pr_accept.user_id) AS accepted_count,
            COUNT(DISTINCT pr_decline.user_id) AS declined_count,
            cur.response AS current_user_response
     FROM petitions p
     INNER JOIN groups g ON g.id = p.group_id
     INNER JOIN group_memberships gm ON gm.group_id = p.group_id
     LEFT JOIN petition_responses pr_accept
       ON pr_accept.petition_id = p.id AND pr_accept.response = 'ACCEPTED'
     LEFT JOIN petition_responses pr_decline
       ON pr_decline.petition_id = p.id AND pr_decline.response = 'DECLINED'
     LEFT JOIN petition_responses cur
       ON cur.petition_id = p.id AND cur.user_id = $2
     WHERE p.group_id = $1
     GROUP BY p.id, g.name, cur.response
     ORDER BY p.start_time, p.id`,
    [groupId, userId]
  );
  return result.rows;
};

const listUserPetitions = async ({ userId }) => {
  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            p.created_at, p.updated_at,
            g.name AS group_name,
            COUNT(DISTINCT gm_all.user_id) AS group_size,
            COUNT(DISTINCT pr_accept.user_id) AS accepted_count,
            COUNT(DISTINCT pr_decline.user_id) AS declined_count,
            cur.response AS current_user_response
     FROM petitions p
     INNER JOIN groups g ON g.id = p.group_id
     INNER JOIN group_memberships gm_user
       ON gm_user.group_id = p.group_id AND gm_user.user_id = $1
     INNER JOIN group_memberships gm_all
       ON gm_all.group_id = p.group_id
     LEFT JOIN petition_responses pr_accept
       ON pr_accept.petition_id = p.id AND pr_accept.response = 'ACCEPTED'
     LEFT JOIN petition_responses pr_decline
       ON pr_decline.petition_id = p.id AND pr_decline.response = 'DECLINED'
     LEFT JOIN petition_responses cur
       ON cur.petition_id = p.id AND cur.user_id = $1
     GROUP BY p.id, g.name, cur.response
     ORDER BY p.start_time, p.id`,
    [userId]
  );
  return result.rows;
};

const upsertPetitionResponse = async ({ petitionId, userId, response }) => {
  const result = await pool.query(
    `INSERT INTO petition_responses (petition_id, user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (petition_id, user_id)
     DO UPDATE SET response = EXCLUDED.response, responded_at = NOW()
     RETURNING petition_id, user_id, response, responded_at`,
    [petitionId, userId, response]
  );
  return result.rows[0];
};

const getPetitionResponseCounts = async (petitionId) => {
  const result = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE response = 'ACCEPTED') AS accepted_count,
        COUNT(*) FILTER (WHERE response = 'DECLINED') AS declined_count
     FROM petition_responses
     WHERE petition_id = $1`,
    [petitionId]
  );
  return result.rows[0];
};

const updatePetitionStatus = async (petitionId, status) => {
  const result = await pool.query(
    `UPDATE petitions
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
    [petitionId, status]
  );
  return result.rows[0];
};

const deletePetition = async (petitionId) => {
  await pool.query(`DELETE FROM petitions WHERE id = $1`, [petitionId]);
};

const listPetitionsForAvailability = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            ARRAY_REMOVE(ARRAY_AGG(pr.user_id) FILTER (WHERE pr.response = 'ACCEPTED'), NULL) AS accepted_user_ids
     FROM petitions p
     LEFT JOIN petition_responses pr
       ON pr.petition_id = p.id
       AND pr.user_id = ANY($1)
     WHERE p.status != 'FAILED'
       AND p.start_time < $3
       AND p.end_time > $2
       AND EXISTS (
         SELECT 1
         FROM petition_responses pr2
         WHERE pr2.petition_id = p.id
           AND pr2.response = 'ACCEPTED'
           AND pr2.user_id = ANY($1)
       )
     GROUP BY p.id
     ORDER BY p.start_time`,
    [userIds, new Date(windowStartMs), new Date(windowEndMs)]
  );
  return result.rows;
};

const getGroupMemberCount = async (groupId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM group_memberships
     WHERE group_id = $1`,
    [groupId]
  );
  return result.rows[0]?.count || 0;
};

const getGroupMemberIds = async (groupId) => {
  const result = await pool.query(
    `SELECT user_id
     FROM group_memberships
     WHERE group_id = $1
     ORDER BY user_id`,
    [groupId]
  );
  return result.rows.map((row) => row.user_id);
};

const upsertCalendarForUser = async ({ userId, gcalId = 'primary', calendarName = null }) => {
  const result = await pool.query(
    `INSERT INTO calendar (user_id, gcal_id, calendar_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, gcal_id)
     DO UPDATE SET calendar_name = COALESCE(EXCLUDED.calendar_name, calendar.calendar_name)
     RETURNING calendar_id`,
    [userId, gcalId, calendarName]
  );
  return result.rows[0];
};

const getOrCreateCalendar = upsertCalendarForUser;

const getCalendarSyncState = async (calendarId) => {
  const result = await pool.query(
    `SELECT calendar_id, sync_token, last_synced_at, last_full_synced_at, last_error, updated_at
     FROM calendar_sync_state
     WHERE calendar_id = $1`,
    [calendarId]
  );
  return result.rows[0] || null;
};

const upsertCalendarSyncState = async ({
  calendarId,
  syncToken,
  lastSyncedAt,
  lastFullSyncedAt,
  lastError
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (calendar_id, sync_token, last_synced_at, last_full_synced_at, last_error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       sync_token = EXCLUDED.sync_token,
       last_synced_at = EXCLUDED.last_synced_at,
       last_full_synced_at = EXCLUDED.last_full_synced_at,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()
     RETURNING calendar_id, sync_token, last_synced_at, last_full_synced_at, last_error, updated_at`,
    [calendarId, syncToken ?? null, lastSyncedAt ?? null, lastFullSyncedAt ?? null, lastError ?? null]
  );
  return result.rows[0];
};

const upsertCalEvents = async (calendarId, events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let updated = 0;

    for (const event of events) {
      if (!event || !event.providerEventId || !event.start || !event.end) {
        continue;
      }

      const result = await client.query(
        `INSERT INTO cal_event (
           calendar_id,
           provider_event_id,
           ical_uid,
           recurring_event_id,
           original_start_time,
           event_name,
           event_start,
           event_end,
           status,
           provider_updated_at,
           etag,
           last_synced_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (calendar_id, provider_event_id)
         DO UPDATE SET
           ical_uid = EXCLUDED.ical_uid,
           recurring_event_id = EXCLUDED.recurring_event_id,
           original_start_time = EXCLUDED.original_start_time,
           event_name = EXCLUDED.event_name,
           event_start = EXCLUDED.event_start,
           event_end = EXCLUDED.event_end,
           status = EXCLUDED.status,
           provider_updated_at = EXCLUDED.provider_updated_at,
           etag = EXCLUDED.etag,
           last_synced_at = EXCLUDED.last_synced_at
         RETURNING (xmax = 0) AS inserted`,
        [
          calendarId,
          event.providerEventId,
          event.iCalUID ?? null,
          event.recurringEventId ?? null,
          event.originalStartTime ?? null,
          event.title ?? null,
          event.start,
          event.end,
          event.status ?? 'confirmed',
          event.providerUpdatedAt ?? null,
          event.etag ?? null
        ]
      );

      const wasInserted = result.rows[0]?.inserted === true;
      if (wasInserted) inserted += 1;
      else updated += 1;
    }

    await client.query('COMMIT');
    return { inserted, updated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const markCalEventsCancelled = async (calendarId, providerEventIds) => {
  if (!Array.isArray(providerEventIds) || providerEventIds.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `UPDATE cal_event
     SET status = 'cancelled',
         last_synced_at = NOW()
     WHERE calendar_id = $1
       AND provider_event_id = ANY($2::text[])`,
    [calendarId, providerEventIds]
  );
  return result.rowCount;
};

const listGoogleEventsForUser = async ({ userId, windowStartMs, windowEndMs }) => {
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT e.event_id,
            e.provider_event_id,
            e.ical_uid,
            e.event_name,
            e.event_start,
            e.event_end,
            e.status,
            e.blocking_level
     FROM cal_event e
     INNER JOIN calendar c ON c.calendar_id = e.calendar_id
     WHERE c.user_id = $1
       AND e.status != 'cancelled'
       AND e.event_start < $3
       AND e.event_end > $2
     ORDER BY e.event_start, e.event_id`,
    [userId, start, end]
  );
  return result.rows;
};

const listGoogleEventsForUsers = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);

  const result = await pool.query(
    `SELECT c.user_id,
            e.event_id,
            e.provider_event_id,
            e.event_start,
            e.event_end,
            e.status,
            e.blocking_level
     FROM cal_event e
     INNER JOIN calendar c ON c.calendar_id = e.calendar_id
     WHERE c.user_id = ANY($1)
       AND e.status != 'cancelled'
       AND e.event_start < $3
       AND e.event_end > $2
     ORDER BY c.user_id, e.event_start, e.event_id`,
    [userIds, start, end]
  );

  return result.rows;
};

const updateGoogleEventBlockingLevel = async ({ userId, eventId, blockingLevel }) => {
  const result = await pool.query(
    `UPDATE cal_event e
     SET blocking_level = $1
     FROM calendar c
     WHERE e.event_id = $2
       AND e.calendar_id = c.calendar_id
       AND c.user_id = $3
     RETURNING e.event_id,
               e.provider_event_id,
               e.ical_uid,
               e.event_name,
               e.event_start,
               e.event_end,
               e.status,
               e.blocking_level`,
    [blockingLevel, eventId, userId]
  );
  return result.rows[0] || null;
};

const createUserBusyBlock = async ({ userId, title, startTime, endTime, blockingLevel }) => {
  const result = await pool.query(
    `INSERT INTO user_busy_block (user_id, title, start_time, end_time, blocking_level)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING busy_block_id, user_id, title, start_time, end_time, blocking_level, created_at, updated_at`,
    [userId, title ?? null, startTime, endTime, blockingLevel]
  );
  return result.rows[0];
};

const listUserBusyBlocks = async ({ userId, windowStartMs, windowEndMs }) => {
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT busy_block_id, user_id, title, start_time, end_time, blocking_level, created_at, updated_at
     FROM user_busy_block
     WHERE user_id = $1
       AND start_time < $3
       AND end_time > $2
     ORDER BY start_time, busy_block_id`,
    [userId, start, end]
  );
  return result.rows;
};

const listUserBusyBlocksForUsers = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT busy_block_id, user_id, title, start_time, end_time, blocking_level
     FROM user_busy_block
     WHERE user_id = ANY($1)
       AND start_time < $3
       AND end_time > $2
     ORDER BY user_id, start_time, busy_block_id`,
    [userIds, start, end]
  );
  return result.rows;
};

const updateUserBusyBlock = async ({
  userId,
  busyBlockId,
  title,
  startTime,
  endTime,
  blockingLevel
}) => {
  const result = await pool.query(
    `UPDATE user_busy_block
     SET title = COALESCE($3, title),
         start_time = COALESCE($4, start_time),
         end_time = COALESCE($5, end_time),
         blocking_level = COALESCE($6, blocking_level),
         updated_at = NOW()
     WHERE busy_block_id = $2
       AND user_id = $1
     RETURNING busy_block_id, user_id, title, start_time, end_time, blocking_level, created_at, updated_at`,
    [userId, busyBlockId, title ?? null, startTime ?? null, endTime ?? null, blockingLevel ?? null]
  );
  return result.rows[0] || null;
};

const deleteUserBusyBlock = async ({ userId, busyBlockId }) => {
  const result = await pool.query(
    `DELETE FROM user_busy_block
     WHERE busy_block_id = $1
       AND user_id = $2`,
    [busyBlockId, userId]
  );
  return result.rowCount;
};

// Backwards-compatible wrapper (deprecated): insert Google events into cal_event.
const addCalendarEvents = async (calendarId, events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  const normalized = events
    .map((event) => {
      if (!event || !event.gcalEventId || !event.start || !event.end) return null;
      return {
        providerEventId: event.gcalEventId,
        title: event.title ?? null,
        start: event.start,
        end: event.end,
        status: 'confirmed'
      };
    })
    .filter(Boolean);

  const result = await upsertCalEvents(calendarId, normalized);
  return result.inserted;
};

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  runSchemaMigrations,
  testConnection,
  upsertUserFromGoogle,
  getUserById,
  getUserByEmail,
  createGroup,
  listGroupsForUser,
  getGroupById,
  isUserInGroup,
  addGroupMember,
  getGroupMembers,
  getGroupMembersWithTokens,
  createPetition,
  getPetitionById,
  listGroupPetitions,
  listUserPetitions,
  upsertPetitionResponse,
  getPetitionResponseCounts,
  updatePetitionStatus,
  deletePetition,
  listPetitionsForAvailability,
  getGroupMemberCount,
  getGroupMemberIds,
  upsertCalendarForUser,
  getOrCreateCalendar,
  getCalendarSyncState,
  upsertCalendarSyncState,
  upsertCalEvents,
  markCalEventsCancelled,
  listGoogleEventsForUser,
  listGoogleEventsForUsers,
  updateGoogleEventBlockingLevel,
  createUserBusyBlock,
  listUserBusyBlocks,
  listUserBusyBlocksForUsers,
  updateUserBusyBlock,
  deleteUserBusyBlock,
  addCalendarEvents
};
