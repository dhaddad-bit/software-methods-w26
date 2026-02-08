process.env.NODE_ENV = 'test';

const { runMigrations, resetDb, createUser } = require('./testUtils');
const db = require('../db');

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

test('addGroupMember is idempotent', async () => {
  // SRS IF-04: Group Management Interface
  const user = await createUser({
    googleSub: 'sub-idempotent',
    email: 'idempotent@example.com',
    name: 'Idempotent User'
  });

  const group = await db.createGroup('Idempotent Group', user.id);

  const first = await db.addGroupMember(group.id, user.id);
  const second = await db.addGroupMember(group.id, user.id);

  expect(first).toMatchObject({ group_id: group.id, user_id: user.id });
  expect(second).toBeUndefined();

  const members = await db.getGroupMembers(group.id);
  const memberIds = members.map((member) => member.id);
  expect(memberIds.filter((id) => id === user.id)).toHaveLength(1);
});
