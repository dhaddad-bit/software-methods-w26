#!/usr/bin/env node

const db = require('../db');
const { repairCalendarsForUser } = require('../services/syncRepair');

function parseArgs(argv) {
  const args = {
    userId: null,
    calendarId: null,
    mode: 'FULL_RESYNC'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--user-id') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      args.userId = Number.isInteger(parsed) ? parsed : null;
      index += 1;
      continue;
    }

    if (token === '--calendar-id') {
      args.calendarId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (token === '--mode') {
      args.mode = String(argv[index + 1] || '').trim().toUpperCase() || 'FULL_RESYNC';
      index += 1;
    }
  }

  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  await db.runSchemaMigrations();

  const userIds = [];
  if (Number.isInteger(args.userId)) {
    userIds.push(args.userId);
  } else {
    const userRows = await db.query(
      `SELECT id
       FROM users
       WHERE google_refresh_token IS NOT NULL
       ORDER BY id`
    );
    userRows.rows.forEach((row) => userIds.push(row.id));
  }

  const results = [];
  for (const userId of userIds) {
    const repaired = await repairCalendarsForUser({
      userId,
      gcalId: args.calendarId,
      mode: args.mode
    });

    results.push({
      userId,
      ...repaired
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, count: results.length, results }, null, 2)}\n`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  run
};
