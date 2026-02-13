const PHASE_THRESHOLDS = {
  0: { statements: 55, branches: 40, functions: 50, lines: 55 },
  1: { statements: 65, branches: 50, functions: 60, lines: 65 },
  2: { statements: 72, branches: 58, functions: 68, lines: 72 },
  3: { statements: 78, branches: 63, functions: 72, lines: 78 },
  4: { statements: 82, branches: 68, functions: 78, lines: 82 },
  5: { statements: 85, branches: 72, functions: 82, lines: 85 }
};

function getCoveragePhase() {
  const parsed = Number.parseInt(process.env.COVERAGE_PHASE || '0', 10);
  if (!Number.isInteger(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 5) return 5;
  return parsed;
}

const strictFolderThreshold = {
  statements: 90,
  branches: 80,
  functions: 90,
  lines: 90
};

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: false,
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/__tests__/jest.setup.js'],
  collectCoverage: true,
  coverageReporters: ['json-summary', 'text', 'lcov'],
  collectCoverageFrom: [
    '<rootDir>/server.js',
    '<rootDir>/db/**/*.js',
    '<rootDir>/services/**/*.js',
    '<rootDir>/inviteToken.js',
    '<rootDir>/invites/**/*.js',
    '<rootDir>/notifications/**/*.js',
    '<rootDir>/outbox/**/*.js',
    '<rootDir>/maintenance/**/*.js',
    '!<rootDir>/coverage/**',
    '!<rootDir>/node_modules/**',
    '!<rootDir>/__tests__/**',
    '!<rootDir>/oauth-test/**',
    '!<rootDir>/algorithm/**',
    '!<rootDir>/init_remote_db.js'
  ],
  coverageThreshold: {
    global: PHASE_THRESHOLDS[getCoveragePhase()],
    './invites/**/*.js': strictFolderThreshold,
    './notifications/**/*.js': strictFolderThreshold,
    './outbox/**/*.js': strictFolderThreshold,
    './maintenance/cleanup.js': strictFolderThreshold,
    './maintenance/cleanup/**/*.js': strictFolderThreshold
  }
};
