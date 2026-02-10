const fs = require('fs');
const path = require('path');
const db = require('../db');

function checkDbSafety() {
  const dbName = process.env.DB_NAME || '';
  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(
      `Unsafe DB_NAME "${dbName || 'undefined'}" for tests. Set DB_NAME to a dedicated test database (must include "test").`
    );
  }
}

async function runMigrations() {
  const sqlPath = path.join(__dirname, '..', 'db', 'table_initialization.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await db.query(stmt);
  }
}

async function resetDb() {
  await db.query(
    'TRUNCATE TABLE cal_event, calendar, petition_responses, petitions, group_memberships, groups, users RESTART IDENTITY CASCADE'
  );
}

async function createUser({ googleSub, email, name, refreshToken }) {
  const result = await db.query(
    `INSERT INTO users (google_sub, email, name, google_refresh_token)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name`,
    [googleSub || null, email, name || null, refreshToken || null]
  );
  return result.rows[0];
}

module.exports = {
  checkDbSafety,
  runMigrations,
  resetDb,
  createUser,
  teardown: async () => db.pool.end()
};
