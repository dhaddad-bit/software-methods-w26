const fs = require('fs');
const path = require('path');

const METRICS = ['statements', 'branches', 'functions', 'lines'];

function parseArgs(argv) {
  const args = {
    summaryPath: path.join(__dirname, '..', 'coverage', 'coverage-summary.json'),
    baselinePath: path.join(__dirname, '..', 'coverage-baseline.json')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--summary') {
      args.summaryPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--baseline') {
      args.baselinePath = path.resolve(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getMetricValue(object, metric) {
  const raw = object?.[metric];
  if (typeof raw === 'number') return raw;
  if (typeof raw?.pct === 'number') return raw.pct;
  return null;
}

function compareCoverage({ summary, baseline }) {
  const failures = [];
  for (const metric of METRICS) {
    const current = getMetricValue(summary?.total, metric);
    const expected = getMetricValue(baseline?.global, metric);

    if (!Number.isFinite(current)) {
      failures.push(`Missing current ${metric} coverage value`);
      continue;
    }
    if (!Number.isFinite(expected)) {
      failures.push(`Missing baseline ${metric} coverage value`);
      continue;
    }
    if (current < expected) {
      failures.push(
        `Coverage regression on ${metric}: current=${current.toFixed(2)} baseline=${expected.toFixed(2)}`
      );
    }
  }
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.summaryPath)) {
    throw new Error(`Coverage summary not found: ${args.summaryPath}`);
  }
  if (!fs.existsSync(args.baselinePath)) {
    throw new Error(`Coverage baseline not found: ${args.baselinePath}`);
  }

  const summary = readJson(args.summaryPath);
  const baseline = readJson(args.baselinePath);
  const failures = compareCoverage({ summary, baseline });

  if (failures.length > 0) {
    failures.forEach((line) => process.stderr.write(`${line}\n`));
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Coverage regression check passed.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  compareCoverage
};
