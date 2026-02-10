// backend/init_remote_db.js
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Your Render External Connection String
const connectionString = 'postgresql://david:3k4jNCxlTh95JO3RJjnBlcVsN1Uqi0Qc@dpg-d63o0fq4d50c73dsned0-a.oregon-postgres.render.com/mvp_db_ezsq';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false // Required for Render
  }
});

async function run() {
  try {
    await client.connect();
    console.log('✅ Connected to Render Database...');

    // Read the SQL files
    const sqlPath = path.join(__dirname, 'db', 'table_initialization.sql');
    const migrationPath = path.join(__dirname, 'db', 'priority_migrations.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const migrations = fs.readFileSync(migrationPath, 'utf8');

    console.log('⏳ Running table initialization + migrations...');
    await client.query(`${sql}\n${migrations}`);

    // Legacy upgrade: if cal_event.gcal_event_id exists, backfill provider_event_id and drop it.
    const legacyCheck = await client.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'cal_event'
         AND column_name = 'gcal_event_id'
       LIMIT 1`
    );

    if (legacyCheck.rowCount > 0) {
      console.log('⏳ Migrating legacy cal_event.gcal_event_id -> provider_event_id...');
      await client.query(
        `UPDATE cal_event
         SET provider_event_id = gcal_event_id
         WHERE provider_event_id IS NULL`
      );
      await client.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);
      await client.query(`ALTER TABLE cal_event DROP COLUMN IF EXISTS gcal_event_id`);
    } else {
      await client.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);
    }

    console.log('🎉 Success! Tables created successfully.');
  } catch (err) {
    console.error('❌ Error initializing database:', err);
  } finally {
    await client.end();
  }
}

run();
