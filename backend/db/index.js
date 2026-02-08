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

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
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
  getGroupMemberIds
};
