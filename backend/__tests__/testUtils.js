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
  const migrationPath = path.join(__dirname, '..', 'db', 'priority_migrations.sql');
  const sqlParts = [fs.readFileSync(sqlPath, 'utf8'), fs.readFileSync(migrationPath, 'utf8')];

  const statements = sqlParts
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await db.query(stmt);
  }

  // Legacy upgrade: if cal_event.gcal_event_id exists, backfill provider_event_id and drop legacy columns.
  const legacyColumnCheck = await db.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'cal_event'
       AND column_name = 'gcal_event_id'
     LIMIT 1`
  );

  if (legacyColumnCheck.rowCount > 0) {
    await db.query(
      `UPDATE cal_event
       SET provider_event_id = gcal_event_id
       WHERE provider_event_id IS NULL`
    );
    await db.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);
    await db.query(`ALTER TABLE cal_event DROP COLUMN IF EXISTS gcal_event_id`);
  } else {
    // Ensure the final schema expectation holds for tests even if the DB was pre-migrated.
    await db.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);
  }
}

async function resetDb() {
  await db.query(
    'TRUNCATE TABLE cal_event, calendar_sync_state, calendar, user_busy_block, petition_responses, petitions, group_memberships, groups, users RESTART IDENTITY CASCADE'
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
