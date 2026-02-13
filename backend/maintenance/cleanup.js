const db = require('../db');
const { getCleanupPolicy } = require('./cleanup/policy');
const { getCleanupSelectors } = require('./cleanup/selectors');

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    confirm: '',
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--apply') {
      args.apply = true;
      continue;
    }
    if (token === '--confirm') {
      args.confirm = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (token === '--json') {
      args.json = true;
    }
  }

  if (!args.apply && !args.dryRun) {
    args.dryRun = true;
  }

  return args;
}

function sortIdValues(values) {
  return [...values].sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
    return String(left).localeCompare(String(right));
  });
}

async function collectDryRunReport({ queryFn, selectors, sampleLimit }) {
  const rows = [];
  for (const selector of selectors) {
    const countResult = await queryFn(selector.countSql);
    const sampleResult = await queryFn(selector.sampleSql, [sampleLimit]);
    const sampleIds = sortIdValues(
      sampleResult.rows.map((entry) => entry[selector.idColumn]).filter((value) => value !== null)
    );
    rows.push({
      key: selector.key,
      count: Number.parseInt(countResult.rows[0]?.count, 10) || 0,
      sampleIds
    });
  }
  return rows;
}

async function applyCleanup({ selectors, sampleLimit }) {
  return db.withTransaction(async (client) => {
    const rows = [];
    for (const selector of selectors) {
      const deleteResult = await client.query(selector.deleteSql);
      const deletedIds = sortIdValues(
        deleteResult.rows.map((entry) => entry[selector.idColumn]).filter((value) => value !== null)
      );
      rows.push({
        key: selector.key,
        deletedCount: deletedIds.length,
        sampleIds: deletedIds.slice(0, sampleLimit)
      });
    }
    return rows;
  });
}

function formatTextReport({ mode, entries }) {
  const lines = [`mode=${mode}`];
  entries.forEach((entry) => {
    const count = mode === 'dry-run' ? entry.count : entry.deletedCount;
    const ids = entry.sampleIds.join(',');
    lines.push(`${entry.key}: count=${count} sample_ids=[${ids}]`);
  });
  return lines.join('\n');
}

async function runCleanup({ args, queryFn = db.query }) {
  const policy = getCleanupPolicy();
  const selectors = getCleanupSelectors(policy);

  if (args.apply && args.confirm !== 'APPLY_CLEANUP') {
    const error = new Error('Refusing to apply cleanup without --confirm APPLY_CLEANUP');
    error.code = 'MISSING_CONFIRMATION';
    throw error;
  }

  const report = args.apply
    ? await applyCleanup({
        selectors,
        sampleLimit: policy.sampleLimit
      })
    : await collectDryRunReport({
        queryFn,
        selectors,
        sampleLimit: policy.sampleLimit
      });

  const payload = {
    mode: args.apply ? 'apply' : 'dry-run',
    policy,
    entries: report
  };

  if (args.json) {
    return JSON.stringify(payload, null, 2);
  }

  return formatTextReport({
    mode: payload.mode,
    entries: payload.entries
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = await runCleanup({ args });
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  sortIdValues,
  collectDryRunReport,
  applyCleanup,
  runCleanup,
  main
};
