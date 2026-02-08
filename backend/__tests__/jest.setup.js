const { checkDbSafety, teardown } = require('./testUtils');

beforeAll(() => {
  checkDbSafety();
});

afterAll(async () => {
  await teardown();
});
