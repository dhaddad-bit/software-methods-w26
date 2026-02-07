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

    // Read the SQL file
    const sqlPath = path.join(__dirname, 'db', 'table_initialization.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('⏳ Running table initialization...');
    await client.query(sql);

    console.log('🎉 Success! Tables created successfully.');
  } catch (err) {
    console.error('❌ Error initializing database:', err);
  } finally {
    await client.end();
  }
}

run();