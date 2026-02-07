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
  getGroupMembersWithTokens
};