process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../db');
const { createInviteToken } = require('../inviteToken');
const { runMigrations, resetDb, createUser } = require('./testUtils');
const { app } = require('../server');

beforeAll(async () => {
  process.env.INVITE_LINK_SECRET = process.env.INVITE_LINK_SECRET || 'invite-api-secret';
  await runMigrations();
});

beforeEach(async () => {
  await resetDb();
});

async function createGroupAs(agent, name = 'Group') {
  const groupRes = await agent.post('/api/groups').send({ name }).expect(201);
  return groupRes.body.id;
}

describe('invite APIs', () => {
  test('create, list, inspect, accept and idempotent re-accept invite', async () => {
    const owner = await createUser({
      googleSub: 'owner-sub',
      email: 'owner@example.com',
      name: 'Owner'
    });
    const invitee = await createUser({
      googleSub: 'invitee-sub',
      email: 'invitee@example.com',
      name: 'Invitee'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Invite Group');

    const createInviteRes = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    expect(createInviteRes.body).toMatchObject({
      groupId,
      status: 'PENDING',
      targetEmail: invitee.email
    });
    expect(typeof createInviteRes.body.token).toBe('string');

    const listRes = await ownerAgent.get(`/api/groups/${groupId}/invites`).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({ inviteId: createInviteRes.body.inviteId });

    const inspectRes = await request(app)
      .get(`/api/invites/${encodeURIComponent(createInviteRes.body.token)}`)
      .expect(200);
    expect(inspectRes.body).toMatchObject({
      canAccept: true,
      tokenStatus: 'VALID'
    });

    const inviteeAgent = request.agent(app);
    await inviteeAgent.post('/test/login').send({ userId: invitee.id }).expect(200);
    const acceptRes = await inviteeAgent
      .post(`/api/invites/${encodeURIComponent(createInviteRes.body.token)}/accept`)
      .expect(200);
    expect(acceptRes.body).toMatchObject({
      ok: true,
      status: 'ACCEPTED',
      alreadyMember: false
    });

    const reacceptRes = await inviteeAgent
      .post(`/api/invites/${encodeURIComponent(createInviteRes.body.token)}/accept`)
      .expect(200);
    expect(reacceptRes.body).toMatchObject({
      ok: true,
      status: 'ALREADY_ACCEPTED'
    });

    const members = await ownerAgent.get(`/api/groups/${groupId}/members`).expect(200);
    const memberIds = members.body.map((member) => member.id);
    expect(memberIds).toEqual(expect.arrayContaining([owner.id, invitee.id]));

    const inspectAfterAccept = await request(app)
      .get(`/api/invites/${encodeURIComponent(createInviteRes.body.token)}`)
      .expect(200);
    expect(inspectAfterAccept.body.canAccept).toBe(false);
  });

  test('invite acceptance enforces target email match', async () => {
    const owner = await createUser({
      googleSub: 'owner-sub-2',
      email: 'owner2@example.com',
      name: 'Owner2'
    });
    const invitee = await createUser({
      googleSub: 'invitee-sub-2',
      email: 'invitee2@example.com',
      name: 'Invitee2'
    });
    const otherUser = await createUser({
      googleSub: 'other-sub-2',
      email: 'other2@example.com',
      name: 'Other2'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Email Guard Group');

    const invite = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    const otherAgent = request.agent(app);
    await otherAgent.post('/test/login').send({ userId: otherUser.id }).expect(200);
    await otherAgent
      .post(`/api/invites/${encodeURIComponent(invite.body.token)}/accept`)
      .expect(403);
  });

  test('revoke invite is idempotent and accepted invite cannot be revoked', async () => {
    const owner = await createUser({
      googleSub: 'owner-sub-3',
      email: 'owner3@example.com',
      name: 'Owner3'
    });
    const invitee = await createUser({
      googleSub: 'invitee-sub-3',
      email: 'invitee3@example.com',
      name: 'Invitee3'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Revoke Group');

    const invite = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    const firstRevoke = await ownerAgent
      .delete(`/api/groups/${groupId}/invites/${invite.body.inviteId}`)
      .expect(200);
    expect(firstRevoke.body.status).toBe('REVOKED');

    const secondRevoke = await ownerAgent
      .delete(`/api/groups/${groupId}/invites/${invite.body.inviteId}`)
      .expect(200);
    expect(secondRevoke.body).toMatchObject({
      status: 'ALREADY_REVOKED',
      alreadyRevoked: true
    });

    const inviteAccepted = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    const inviteeAgent = request.agent(app);
    await inviteeAgent.post('/test/login').send({ userId: invitee.id }).expect(200);
    await inviteeAgent
      .post(`/api/invites/${encodeURIComponent(inviteAccepted.body.token)}/accept`)
      .expect(200);

    await ownerAgent
      .delete(`/api/groups/${groupId}/invites/${inviteAccepted.body.inviteId}`)
      .expect(409);
  });

  test('token-group mismatch is rejected even with valid signature', async () => {
    const owner = await createUser({
      googleSub: 'owner-sub-4',
      email: 'owner4@example.com',
      name: 'Owner4'
    });
    const invitee = await createUser({
      googleSub: 'invitee-sub-4',
      email: 'invitee4@example.com',
      name: 'Invitee4'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Mismatch Group');

    const invite = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    const mismatchedToken = createInviteToken({
      inviteId: invite.body.inviteId,
      groupId: groupId + 1,
      expiresAtMs: Date.now() + 60_000
    });

    const inviteeAgent = request.agent(app);
    await inviteeAgent.post('/test/login').send({ userId: invitee.id }).expect(200);
    await inviteeAgent
      .post(`/api/invites/${encodeURIComponent(mismatchedToken)}/accept`)
      .expect(400);
  });

  test('concurrent accepts are idempotent and race-safe', async () => {
    const owner = await createUser({
      googleSub: 'owner-sub-5',
      email: 'owner5@example.com',
      name: 'Owner5'
    });
    const invitee = await createUser({
      googleSub: 'invitee-sub-5',
      email: 'invitee5@example.com',
      name: 'Invitee5'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Race Group');

    const invite = await ownerAgent
      .post(`/api/groups/${groupId}/invites`)
      .send({ targetEmail: invitee.email })
      .expect(201);

    const inviteeAgent = request.agent(app);
    await inviteeAgent.post('/test/login').send({ userId: invitee.id }).expect(200);

    const [first, second] = await Promise.all([
      inviteeAgent.post(`/api/invites/${encodeURIComponent(invite.body.token)}/accept`),
      inviteeAgent.post(`/api/invites/${encodeURIComponent(invite.body.token)}/accept`)
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.status, second.body.status]).toEqual(
      expect.arrayContaining(['ACCEPTED', 'ALREADY_ACCEPTED'])
    );

    const memberships = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM group_memberships
       WHERE group_id = $1
         AND user_id = $2`,
      [groupId, invitee.id]
    );
    expect(memberships.rows[0].count).toBe(1);
  });
});

describe('membership delete API', () => {
  test('creator can remove member and deletion is idempotent', async () => {
    const owner = await createUser({
      googleSub: 'member-owner-sub',
      email: 'member-owner@example.com',
      name: 'Member Owner'
    });
    const member = await createUser({
      googleSub: 'member-sub',
      email: 'member@example.com',
      name: 'Member'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Member Delete Group');
    await ownerAgent
      .post(`/api/groups/${groupId}/members`)
      .send({ email: member.email })
      .expect(200);

    await ownerAgent.delete(`/api/groups/${groupId}/members/${member.id}`).expect(200);
    const secondDelete = await ownerAgent
      .delete(`/api/groups/${groupId}/members/${member.id}`)
      .expect(200);
    expect(secondDelete.body.alreadyRemoved).toBe(true);
  });

  test('member can remove self but cannot remove creator', async () => {
    const owner = await createUser({
      googleSub: 'member-owner-sub-2',
      email: 'member-owner2@example.com',
      name: 'Member Owner2'
    });
    const member = await createUser({
      googleSub: 'member-sub-2',
      email: 'member2@example.com',
      name: 'Member2'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Self Leave Group');
    await ownerAgent
      .post(`/api/groups/${groupId}/members`)
      .send({ email: member.email })
      .expect(200);

    const memberAgent = request.agent(app);
    await memberAgent.post('/test/login').send({ userId: member.id }).expect(200);
    await memberAgent.delete(`/api/groups/${groupId}/members/${member.id}`).expect(200);

    await ownerAgent.delete(`/api/groups/${groupId}/members/${owner.id}`).expect(400);
  });

  test('non-creator cannot remove another member', async () => {
    const owner = await createUser({
      googleSub: 'member-owner-sub-3',
      email: 'member-owner3@example.com',
      name: 'Member Owner3'
    });
    const memberA = await createUser({
      googleSub: 'member-a-sub',
      email: 'member-a@example.com',
      name: 'Member A'
    });
    const memberB = await createUser({
      googleSub: 'member-b-sub',
      email: 'member-b@example.com',
      name: 'Member B'
    });

    const ownerAgent = request.agent(app);
    await ownerAgent.post('/test/login').send({ userId: owner.id }).expect(200);
    const groupId = await createGroupAs(ownerAgent, 'Forbidden Remove Group');
    await ownerAgent
      .post(`/api/groups/${groupId}/members`)
      .send({ email: memberA.email })
      .expect(200);
    await ownerAgent
      .post(`/api/groups/${groupId}/members`)
      .send({ email: memberB.email })
      .expect(200);

    const memberAgent = request.agent(app);
    await memberAgent.post('/test/login').send({ userId: memberA.id }).expect(200);
    await memberAgent.delete(`/api/groups/${groupId}/members/${memberB.id}`).expect(403);
  });
});
