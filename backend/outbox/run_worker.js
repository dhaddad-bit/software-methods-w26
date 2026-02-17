const { processOutboxBatch } = require('./worker');
const { dispatchOutboxMessage } = require('./provider');

function parseArgs(argv) {
  const args = { limit: 25 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--limit') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (Number.isInteger(value) && value > 0) {
        args.limit = value;
      }
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await processOutboxBatch({
    limit: args.limit,
    sender: async ({ channel, notification }) =>
      dispatchOutboxMessage({
        channel,
        notification
      })
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  main
};
