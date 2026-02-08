module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: false,
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/__tests__/jest.setup.js']
};
