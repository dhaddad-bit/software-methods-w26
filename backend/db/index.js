const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
});

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool(
  isProduction
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        ssl: false
      }
);

async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await handler(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function runSchemaMigrations() {
  const basePath = path.join(__dirname, 'table_initialization.sql');
  const migrationPath = path.join(__dirname, 'priority_migrations.sql');
  const syncHardeningPath = path.join(__dirname, 'sync_hardening_migrations.sql');
  const inviteNotificationPath = path.join(__dirname, 'invite_notification_migrations.sql');

  const baseSql = fs.readFileSync(basePath, 'utf8');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  const syncHardeningSql = fs.readFileSync(syncHardeningPath, 'utf8');
  const inviteNotificationSql = fs.readFileSync(inviteNotificationPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const statements = [baseSql, migrationSql, syncHardeningSql, inviteNotificationSql]
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await client.query(stmt);
    }

    async function getColumnFormattedType(tableName, columnName) {
      const result = await client.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
         FROM pg_attribute a
         INNER JOIN pg_class c ON c.oid = a.attrelid
         INNER JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = $1
           AND a.attname = $2
           AND a.attnum > 0
           AND NOT a.attisdropped
         LIMIT 1`,
        [tableName, columnName]
      );

      return result.rows[0]?.formatted_type || null;
    }

    async function ensureColumnIsText(tableName, columnName) {
      const tableReg = await client.query(`SELECT to_regclass($1) AS regclass`, [
        `public.${tableName}`
      ]);
      if (!tableReg.rows[0]?.regclass) return;

      const formattedType = await getColumnFormattedType(tableName, columnName);
      if (!formattedType) return;
      if (formattedType === 'text') return;
      if (!formattedType.startsWith('character varying') && formattedType !== 'varchar') return;

      await client.query(
        `ALTER TABLE ${tableName}
         ALTER COLUMN ${columnName}
         TYPE TEXT`
      );
    }

    // Legacy upgrade: safely backfill provider_event_id from gcal_event_id (if it exists).
    const calEventReg = await client.query(`SELECT to_regclass('public.cal_event') AS regclass`);
    if (calEventReg.rows[0]?.regclass) {
      const legacyGcalIdType = await getColumnFormattedType('cal_event', 'gcal_event_id');
      if (legacyGcalIdType) {
        // If the table is in a partial-migrated state, avoid conflicts with already-populated provider_event_id.
        const providerIdType = await getColumnFormattedType('cal_event', 'provider_event_id');
        if (providerIdType) {
          await client.query(
            `DELETE FROM cal_event e
             USING cal_event existing
             WHERE e.provider_event_id IS NULL
               AND existing.calendar_id = e.calendar_id
               AND existing.provider_event_id = e.gcal_event_id`
          );
        }

        // De-dupe legacy IDs so the backfill can't violate uniq_cal_event_provider on update.
        await client.query(
          `WITH ranked AS (
             SELECT event_id,
                    ROW_NUMBER() OVER (PARTITION BY calendar_id, gcal_event_id ORDER BY event_id DESC) AS rn
             FROM cal_event
           )
           DELETE FROM cal_event e
           USING ranked r
           WHERE e.event_id = r.event_id
             AND r.rn > 1`
        );

        await client.query(
          `UPDATE cal_event
           SET provider_event_id = gcal_event_id
           WHERE provider_event_id IS NULL`
        );
        await client.query(`ALTER TABLE cal_event DROP COLUMN IF EXISTS gcal_event_id`);
      }

      // Hard guard: delete any rows still missing provider_event_id, then enforce NOT NULL.
      const providerIdTypeFinal = await getColumnFormattedType('cal_event', 'provider_event_id');
      if (providerIdTypeFinal) {
        await client.query(`DELETE FROM cal_event WHERE provider_event_id IS NULL`);
        await client.query(`ALTER TABLE cal_event ALTER COLUMN provider_event_id SET NOT NULL`);
      }
    }

    // Data integrity fixups: widen common text fields (guarded by table+column+type).
    await ensureColumnIsText('user_busy_block', 'title');
    await ensureColumnIsText('cal_event', 'event_name');

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

const testConnection = async () => {
  const result = await pool.query('SELECT NOW()');
  return {
    success: true,
    timestamp: result.rows[0].now,
    message: 'Database connected successfully!'
  };
};

const upsertUserFromGoogle = async (googleSub, email, name, refreshToken) => {
  if (!googleSub && !email) {
    throw new Error('googleSub or email is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let user = null;

    if (googleSub) {
      const existingBySub = await client.query(
        'SELECT id FROM users WHERE google_sub = $1',
        [googleSub]
      );
      if (existingBySub.rows[0]) {
        const updated = await client.query(
          `UPDATE users
           SET email = $2,
               name = $3,
               google_refresh_token = COALESCE($4, google_refresh_token),
               updated_at = NOW()
           WHERE google_sub = $1
           RETURNING id, email, name`,
          [googleSub, email, name, refreshToken || null]
        );
        user = updated.rows[0];
      }
    }

    if (!user && email) {
      const existingByEmail = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      if (existingByEmail.rows[0]) {
        const updated = await client.query(
          `UPDATE users
           SET google_sub = COALESCE($2, google_sub),
               name = $3,
               google_refresh_token = COALESCE($4, google_refresh_token),
               updated_at = NOW()
           WHERE email = $1
           RETURNING id, email, name`,
          [email, googleSub || null, name, refreshToken || null]
        );
        user = updated.rows[0];
      }
    }

    if (!user) {
      const inserted = await client.query(
        `INSERT INTO users (google_sub, email, name, google_refresh_token)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name`,
        [googleSub || null, email, name, refreshToken || null]
      );
      user = inserted.rows[0];
    }

    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getUserById = async (userId) => {
  const result = await pool.query(
    `SELECT id, email, name, google_refresh_token
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0];
};

const getUserByEmail = async (email) => {
  const result = await pool.query(
    `SELECT id, email, name, google_refresh_token
     FROM users
     WHERE email = $1`,
    [email]
  );
  return result.rows[0];
};

const createGroup = async (name, createdByUserId) => {
  const result = await pool.query(
    `INSERT INTO groups (name, created_by_user_id)
     VALUES ($1, $2)
     RETURNING id, name, created_by_user_id, created_at, updated_at`,
    [name, createdByUserId]
  );
  return result.rows[0];
};

const listGroupsForUser = async (userId) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.created_by_user_id, g.created_at, g.updated_at
     FROM groups g
     INNER JOIN group_memberships gm ON gm.group_id = g.id
     WHERE gm.user_id = $1
     ORDER BY g.id`,
    [userId]
  );
  return result.rows;
};

const getGroupById = async (groupId) => {
  const result = await pool.query(
    `SELECT id, name, created_by_user_id, created_at, updated_at
     FROM groups
     WHERE id = $1`,
    [groupId]
  );
  return result.rows[0];
};

const isUserInGroup = async (groupId, userId) => {
  const result = await pool.query(
    `SELECT 1 FROM group_memberships WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );
  return result.rowCount > 0;
};

const addGroupMember = async (groupId, userId, role = null) => {
  const result = await pool.query(
    `INSERT INTO group_memberships (group_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO NOTHING
     RETURNING group_id, user_id, role`,
    [groupId, userId, role]
  );
  return result.rows[0];
};

const addGroupMemberWithLimit = async ({ groupId, userId, role = null, maxMembers = 8 }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM groups WHERE id = $1 FOR UPDATE`, [groupId]);

    const existing = await client.query(
      `SELECT 1
       FROM group_memberships
       WHERE group_id = $1
         AND user_id = $2
       LIMIT 1`,
      [groupId, userId]
    );
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return { row: null, status: 'ALREADY_MEMBER' };
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM group_memberships
       WHERE group_id = $1`,
      [groupId]
    );
    const count = countResult.rows[0]?.count || 0;
    if (count >= maxMembers) {
      const err = new Error(`Group member limit reached (${maxMembers}).`);
      err.code = 'GROUP_MEMBER_LIMIT';
      throw err;
    }

    const inserted = await client.query(
      `INSERT INTO group_memberships (group_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id, user_id, role`,
      [groupId, userId, role]
    );

    await client.query('COMMIT');
    return { row: inserted.rows[0] || null, status: inserted.rows[0] ? 'ADDED' : 'ALREADY_MEMBER' };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
};

const removeGroupMember = async ({ groupId, userId }) => {
  const result = await pool.query(
    `DELETE FROM group_memberships
     WHERE group_id = $1
       AND user_id = $2`,
    [groupId, userId]
  );
  return result.rowCount;
};

const getGroupMembers = async (groupId) => {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name
     FROM users u
     INNER JOIN group_memberships gm ON gm.user_id = u.id
     WHERE gm.group_id = $1
     ORDER BY u.id`,
    [groupId]
  );
  return result.rows;
};

const getGroupMembersWithTokens = async (groupId) => {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.google_refresh_token
     FROM users u
     INNER JOIN group_memberships gm ON gm.user_id = u.id
     WHERE gm.group_id = $1
     ORDER BY u.id`,
    [groupId]
  );
  return result.rows;
};

const deleteGroup = async ({ groupId }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM petition_responses
       WHERE petition_id IN (
         SELECT id FROM petitions WHERE group_id = $1
       )`,
      [groupId]
    );
    await client.query(`DELETE FROM petitions WHERE group_id = $1`, [groupId]);
    await client.query(`DELETE FROM group_memberships WHERE group_id = $1`, [groupId]);

    const result = await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
};

const createPetition = async ({
  groupId,
  createdByUserId,
  title,
  startTime,
  endTime,
  priority = 'HIGHEST',
  status = 'OPEN'
}) => {
  const result = await pool.query(
    `INSERT INTO petitions (group_id, created_by_user_id, title, start_time, end_time, priority, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
    [groupId, createdByUserId, title, startTime, endTime, priority, status]
  );
  return result.rows[0];
};

const getPetitionById = async (petitionId) => {
  const result = await pool.query(
    `SELECT id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at
     FROM petitions
     WHERE id = $1`,
    [petitionId]
  );
  return result.rows[0];
};

const listGroupPetitions = async ({ groupId, userId }) => {
  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            p.created_at, p.updated_at,
            g.name AS group_name,
            COUNT(DISTINCT gm.user_id) AS group_size,
            COUNT(DISTINCT pr_accept.user_id) AS accepted_count,
            COUNT(DISTINCT pr_decline.user_id) AS declined_count,
            cur.response AS current_user_response
     FROM petitions p
     INNER JOIN groups g ON g.id = p.group_id
     INNER JOIN group_memberships gm ON gm.group_id = p.group_id
     LEFT JOIN petition_responses pr_accept
       ON pr_accept.petition_id = p.id AND pr_accept.response = 'ACCEPTED'
     LEFT JOIN petition_responses pr_decline
       ON pr_decline.petition_id = p.id AND pr_decline.response = 'DECLINED'
     LEFT JOIN petition_responses cur
       ON cur.petition_id = p.id AND cur.user_id = $2
     WHERE p.group_id = $1
     GROUP BY p.id, g.name, cur.response
     ORDER BY p.start_time, p.id`,
    [groupId, userId]
  );
  return result.rows;
};

const listUserPetitions = async ({ userId }) => {
  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            p.created_at, p.updated_at,
            g.name AS group_name,
            COUNT(DISTINCT gm_all.user_id) AS group_size,
            COUNT(DISTINCT pr_accept.user_id) AS accepted_count,
            COUNT(DISTINCT pr_decline.user_id) AS declined_count,
            cur.response AS current_user_response
     FROM petitions p
     INNER JOIN groups g ON g.id = p.group_id
     INNER JOIN group_memberships gm_user
       ON gm_user.group_id = p.group_id AND gm_user.user_id = $1
     INNER JOIN group_memberships gm_all
       ON gm_all.group_id = p.group_id
     LEFT JOIN petition_responses pr_accept
       ON pr_accept.petition_id = p.id AND pr_accept.response = 'ACCEPTED'
     LEFT JOIN petition_responses pr_decline
       ON pr_decline.petition_id = p.id AND pr_decline.response = 'DECLINED'
     LEFT JOIN petition_responses cur
       ON cur.petition_id = p.id AND cur.user_id = $1
     GROUP BY p.id, g.name, cur.response
     ORDER BY p.start_time, p.id`,
    [userId]
  );
  return result.rows;
};

const upsertPetitionResponse = async ({ petitionId, userId, response }) => {
  const result = await pool.query(
    `INSERT INTO petition_responses (petition_id, user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (petition_id, user_id)
     DO UPDATE SET response = EXCLUDED.response, responded_at = NOW()
     RETURNING petition_id, user_id, response, responded_at`,
    [petitionId, userId, response]
  );
  return result.rows[0];
};

const getPetitionResponseCounts = async (petitionId) => {
  const result = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE response = 'ACCEPTED') AS accepted_count,
        COUNT(*) FILTER (WHERE response = 'DECLINED') AS declined_count
     FROM petition_responses
     WHERE petition_id = $1`,
    [petitionId]
  );
  return result.rows[0];
};

const updatePetitionStatus = async (petitionId, status) => {
  const result = await pool.query(
    `UPDATE petitions
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
    [petitionId, status]
  );
  return result.rows[0];
};

const deletePetition = async (petitionId) => {
  await pool.query(`DELETE FROM petitions WHERE id = $1`, [petitionId]);
};

const listPetitionsForAvailability = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT p.id, p.group_id, p.created_by_user_id, p.title, p.start_time, p.end_time, p.priority, p.status,
            ARRAY_REMOVE(ARRAY_AGG(pr.user_id) FILTER (WHERE pr.response = 'ACCEPTED'), NULL) AS accepted_user_ids
     FROM petitions p
     LEFT JOIN petition_responses pr
       ON pr.petition_id = p.id
       AND pr.user_id = ANY($1)
     WHERE p.status != 'FAILED'
       AND p.start_time < $3
       AND p.end_time > $2
       AND EXISTS (
         SELECT 1
         FROM petition_responses pr2
         WHERE pr2.petition_id = p.id
           AND pr2.response = 'ACCEPTED'
           AND pr2.user_id = ANY($1)
       )
     GROUP BY p.id
     ORDER BY p.start_time`,
    [userIds, new Date(windowStartMs), new Date(windowEndMs)]
  );
  return result.rows;
};

const getGroupMemberCount = async (groupId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM group_memberships
     WHERE group_id = $1`,
    [groupId]
  );
  return result.rows[0]?.count || 0;
};

const getGroupMemberIds = async (groupId) => {
  const result = await pool.query(
    `SELECT user_id
     FROM group_memberships
     WHERE group_id = $1
     ORDER BY user_id`,
    [groupId]
  );
  return result.rows.map((row) => row.user_id);
};

const createGroupInvite = async ({ groupId, createdByUserId, targetEmail = null, expiresAt }) => {
  const normalizedEmail =
    typeof targetEmail === 'string' && targetEmail.trim() ? targetEmail.trim().toLowerCase() : null;

  const result = await pool.query(
    `INSERT INTO group_invites (
       group_id,
       created_by_user_id,
       target_email,
       status,
       expires_at
     )
     VALUES ($1, $2, $3, 'PENDING', $4)
     RETURNING invite_id,
               group_id,
               created_by_user_id,
               target_email,
               status,
               expires_at,
               accepted_by_user_id,
               accepted_at,
               revoked_by_user_id,
               revoked_at,
               created_at,
               updated_at`,
    [groupId, createdByUserId, normalizedEmail, expiresAt]
  );
  return result.rows[0];
};

const listGroupInvites = async ({ groupId }) => {
  const result = await pool.query(
    `SELECT invite_id,
            group_id,
            created_by_user_id,
            target_email,
            status,
            expires_at,
            accepted_by_user_id,
            accepted_at,
            revoked_by_user_id,
            revoked_at,
            created_at,
            updated_at
     FROM group_invites
     WHERE group_id = $1
     ORDER BY invite_id DESC`,
    [groupId]
  );
  return result.rows;
};

const getGroupInviteById = async (inviteId) => {
  const result = await pool.query(
    `SELECT invite_id,
            group_id,
            created_by_user_id,
            target_email,
            status,
            expires_at,
            accepted_by_user_id,
            accepted_at,
            revoked_by_user_id,
            revoked_at,
            created_at,
            updated_at
     FROM group_invites
     WHERE invite_id = $1`,
    [inviteId]
  );
  return result.rows[0] || null;
};

const revokeGroupInvite = async ({ groupId, inviteId, revokedByUserId }) =>
  withTransaction(async (client) => {
    const lockResult = await client.query(
      `SELECT invite_id,
              group_id,
              created_by_user_id,
              target_email,
              status,
              expires_at,
              accepted_by_user_id,
              accepted_at,
              revoked_by_user_id,
              revoked_at,
              created_at,
              updated_at
       FROM group_invites
       WHERE invite_id = $1
         AND group_id = $2
       FOR UPDATE`,
      [inviteId, groupId]
    );
    const invite = lockResult.rows[0] || null;
    if (!invite) return { status: 'NOT_FOUND', invite: null };

    const nowMs = Date.now();
    const expiresAtMs = invite.expires_at?.getTime?.() || null;
    const isExpired = Number.isFinite(expiresAtMs) && nowMs > expiresAtMs;

    if (invite.status === 'ACCEPTED') return { status: 'CONFLICT_ACCEPTED', invite };
    if (invite.status === 'REVOKED') return { status: 'ALREADY_REVOKED', invite };
    if (invite.status === 'EXPIRED' || isExpired) {
      const expiredUpdate = await client.query(
        `UPDATE group_invites
         SET status = 'EXPIRED',
             updated_at = NOW()
         WHERE invite_id = $1
         RETURNING invite_id,
                   group_id,
                   created_by_user_id,
                   target_email,
                   status,
                   expires_at,
                   accepted_by_user_id,
                   accepted_at,
                   revoked_by_user_id,
                   revoked_at,
                   created_at,
                   updated_at`,
        [inviteId]
      );
      return { status: 'ALREADY_EXPIRED', invite: expiredUpdate.rows[0] || invite };
    }

    const updated = await client.query(
      `UPDATE group_invites
       SET status = 'REVOKED',
           revoked_by_user_id = $2,
           revoked_at = NOW(),
           updated_at = NOW()
       WHERE invite_id = $1
       RETURNING invite_id,
                 group_id,
                 created_by_user_id,
                 target_email,
                 status,
                 expires_at,
                 accepted_by_user_id,
                 accepted_at,
                 revoked_by_user_id,
                 revoked_at,
                 created_at,
                 updated_at`,
      [inviteId, revokedByUserId]
    );

    return { status: 'REVOKED', invite: updated.rows[0] || null };
  });

const acceptGroupInvite = async ({ inviteId, tokenGroupId, userId, maxMembers = 8 }) =>
  withTransaction(async (client) => {
    const inviteResult = await client.query(
      `SELECT invite_id,
              group_id,
              created_by_user_id,
              target_email,
              status,
              expires_at,
              accepted_by_user_id,
              accepted_at,
              revoked_by_user_id,
              revoked_at,
              created_at,
              updated_at
       FROM group_invites
       WHERE invite_id = $1
       FOR UPDATE`,
      [inviteId]
    );
    const invite = inviteResult.rows[0] || null;
    if (!invite) return { status: 'NOT_FOUND', invite: null, memberAdded: false };
    if (Number.isInteger(tokenGroupId) && invite.group_id !== tokenGroupId) {
      return { status: 'TOKEN_GROUP_MISMATCH', invite, memberAdded: false };
    }

    const nowMs = Date.now();
    const expiresAtMs = invite.expires_at?.getTime?.() || null;
    const isExpired = Number.isFinite(expiresAtMs) && nowMs > expiresAtMs;

    if (invite.status === 'REVOKED') return { status: 'REVOKED', invite, memberAdded: false };
    if (invite.status === 'EXPIRED' || isExpired) {
      const expired = await client.query(
        `UPDATE group_invites
         SET status = 'EXPIRED',
             updated_at = NOW()
         WHERE invite_id = $1
         RETURNING invite_id,
                   group_id,
                   created_by_user_id,
                   target_email,
                   status,
                   expires_at,
                   accepted_by_user_id,
                   accepted_at,
                   revoked_by_user_id,
                   revoked_at,
                   created_at,
                   updated_at`,
        [inviteId]
      );
      return { status: 'EXPIRED', invite: expired.rows[0] || invite, memberAdded: false };
    }

    await client.query(`SELECT id FROM groups WHERE id = $1 FOR UPDATE`, [invite.group_id]);

    const membershipBefore = await client.query(
      `SELECT 1
       FROM group_memberships
       WHERE group_id = $1
         AND user_id = $2
       LIMIT 1`,
      [invite.group_id, userId]
    );
    const wasAlreadyMember = membershipBefore.rowCount > 0;

    if (!wasAlreadyMember) {
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM group_memberships
         WHERE group_id = $1`,
        [invite.group_id]
      );
      const count = countResult.rows[0]?.count || 0;
      if (count >= maxMembers) {
        return { status: 'GROUP_MEMBER_LIMIT', invite, memberAdded: false };
      }
    }

    const addResult = await client.query(
      `INSERT INTO group_memberships (group_id, user_id, role)
       VALUES ($1, $2, NULL)
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id, user_id`,
      [invite.group_id, userId]
    );
    const memberAdded = addResult.rowCount > 0;

    if (invite.status === 'PENDING') {
      const updated = await client.query(
        `UPDATE group_invites
         SET status = 'ACCEPTED',
             accepted_by_user_id = COALESCE(accepted_by_user_id, $2),
             accepted_at = COALESCE(accepted_at, NOW()),
             updated_at = NOW()
         WHERE invite_id = $1
         RETURNING invite_id,
                   group_id,
                   created_by_user_id,
                   target_email,
                   status,
                   expires_at,
                   accepted_by_user_id,
                   accepted_at,
                   revoked_by_user_id,
                   revoked_at,
                   created_at,
                   updated_at`,
        [inviteId, userId]
      );
      return {
        status: wasAlreadyMember ? 'ALREADY_MEMBER' : 'ACCEPTED',
        invite: updated.rows[0] || invite,
        memberAdded
      };
    }

    if (invite.status === 'ACCEPTED') {
      return { status: 'ALREADY_ACCEPTED', invite, memberAdded };
    }

    return { status: 'INVALID_STATE', invite, memberAdded: false };
  });

const listNotificationsForUser = async ({ userId, limit = 50, offset = 0 }) => {
  const result = await pool.query(
    `SELECT notification_id,
            recipient_user_id,
            type,
            event_key,
            payload_json,
            is_read,
            read_at,
            created_at,
            updated_at
     FROM notifications
     WHERE recipient_user_id = $1
     ORDER BY notification_id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
};

const markNotificationRead = async ({ userId, notificationId }) => {
  const result = await pool.query(
    `UPDATE notifications
     SET is_read = TRUE,
         read_at = COALESCE(read_at, NOW()),
         updated_at = NOW()
     WHERE notification_id = $1
       AND recipient_user_id = $2
     RETURNING notification_id,
               recipient_user_id,
               type,
               event_key,
               payload_json,
               is_read,
               read_at,
               created_at,
               updated_at`,
    [notificationId, userId]
  );
  return result.rows[0] || null;
};

const markAllNotificationsRead = async ({ userId }) => {
  const result = await pool.query(
    `UPDATE notifications
     SET is_read = TRUE,
         read_at = COALESCE(read_at, NOW()),
         updated_at = NOW()
     WHERE recipient_user_id = $1
       AND is_read = FALSE`,
    [userId]
  );
  return result.rowCount;
};

const deleteNotificationForUser = async ({ userId, notificationId }) => {
  const result = await pool.query(
    `DELETE FROM notifications
     WHERE notification_id = $1
       AND recipient_user_id = $2`,
    [notificationId, userId]
  );
  return result.rowCount;
};

async function insertNotificationAndOutboxTx(client, { recipientUserId, type, payload, eventKey }) {
  const notificationResult = await client.query(
    `INSERT INTO notifications (recipient_user_id, type, event_key, payload_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (recipient_user_id, event_key)
     WHERE event_key IS NOT NULL
     DO UPDATE SET updated_at = NOW()
     RETURNING notification_id,
               recipient_user_id,
               type,
               event_key,
               payload_json,
               is_read,
               read_at,
               created_at,
               updated_at`,
    [recipientUserId, type, eventKey ?? null, JSON.stringify(payload || {})]
  );

  const notification = notificationResult.rows[0];
  const dedupeKey = `${type}:${notification.notification_id}`;

  await client.query(
    `INSERT INTO notification_outbox (
       notification_id,
       channel,
       dedupe_key,
       status,
       attempt_count,
       next_attempt_at
     )
     VALUES ($1, 'EMAIL', $2, 'PENDING', 0, NOW())
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [notification.notification_id, dedupeKey]
  );

  return notification;
}

const createPetitionWithNotifications = async ({
  groupId,
  createdByUserId,
  title,
  startTime,
  endTime,
  priority = 'HIGHEST',
  status = 'OPEN'
}) =>
  withTransaction(async (client) => {
    const petitionResult = await client.query(
      `INSERT INTO petitions (group_id, created_by_user_id, title, start_time, end_time, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
      [groupId, createdByUserId, title, startTime, endTime, priority, status]
    );
    const petition = petitionResult.rows[0];

    await client.query(
      `INSERT INTO petition_responses (petition_id, user_id, response)
       VALUES ($1, $2, 'ACCEPTED')
       ON CONFLICT (petition_id, user_id)
       DO UPDATE SET response = EXCLUDED.response, responded_at = NOW()`,
      [petition.id, createdByUserId]
    );

    const memberIdsResult = await client.query(
      `SELECT user_id
       FROM group_memberships
       WHERE group_id = $1
       ORDER BY user_id`,
      [groupId]
    );
    const memberIds = memberIdsResult.rows.map((row) => row.user_id);

    for (const memberId of memberIds) {
      if (Number(memberId) === Number(createdByUserId)) continue;
      await insertNotificationAndOutboxTx(client, {
        recipientUserId: memberId,
        type: 'PETITION_CREATED',
        payload: {
          petitionId: petition.id,
          groupId,
          createdByUserId,
          title: petition.title,
          startTime: petition.start_time,
          endTime: petition.end_time
        },
        eventKey: `petition:${petition.id}:created:${memberId}`
      });
    }

    return { petition, groupSize: memberIds.length };
  });

const respondToPetitionWithNotifications = async ({
  petitionId,
  userId,
  response,
  nextStatus
}) =>
  withTransaction(async (client) => {
    const petitionResult = await client.query(
      `SELECT id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at
       FROM petitions
       WHERE id = $1
       FOR UPDATE`,
      [petitionId]
    );
    const petition = petitionResult.rows[0] || null;
    if (!petition) {
      const err = new Error('Petition not found');
      err.code = 'PETITION_NOT_FOUND';
      throw err;
    }

    await client.query(
      `INSERT INTO petition_responses (petition_id, user_id, response)
       VALUES ($1, $2, $3)
       ON CONFLICT (petition_id, user_id)
       DO UPDATE SET response = EXCLUDED.response, responded_at = NOW()`,
      [petitionId, userId, response]
    );

    const countsResult = await client.query(
      `SELECT
          COUNT(*) FILTER (WHERE response = 'ACCEPTED') AS accepted_count,
          COUNT(*) FILTER (WHERE response = 'DECLINED') AS declined_count
       FROM petition_responses
       WHERE petition_id = $1`,
      [petitionId]
    );
    const counts = countsResult.rows[0];
    const acceptedCount = Number.parseInt(counts.accepted_count, 10) || 0;
    const declinedCount = Number.parseInt(counts.declined_count, 10) || 0;

    const groupSizeResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM group_memberships
       WHERE group_id = $1`,
      [petition.group_id]
    );
    const groupSize = groupSizeResult.rows[0]?.count || 0;

    let resolvedStatus = nextStatus;
    if (!resolvedStatus) {
      if (declinedCount > 0) resolvedStatus = 'FAILED';
      else if (acceptedCount === groupSize) resolvedStatus = 'ACCEPTED_ALL';
      else resolvedStatus = 'OPEN';
    }

    let updatedPetition = petition;
    if (petition.status !== resolvedStatus) {
      const updateResult = await client.query(
        `UPDATE petitions
         SET status = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, group_id, created_by_user_id, title, start_time, end_time, priority, status, created_at, updated_at`,
        [petitionId, resolvedStatus]
      );
      updatedPetition = updateResult.rows[0];
    }

    if (Number(userId) !== Number(petition.created_by_user_id)) {
      await insertNotificationAndOutboxTx(client, {
        recipientUserId: petition.created_by_user_id,
        type: 'PETITION_RESPONSE',
        payload: {
          petitionId: petition.id,
          groupId: petition.group_id,
          responderUserId: userId,
          response
        },
        eventKey: `petition:${petition.id}:response:${userId}:${response}`
      });
    }

    if (petition.status !== resolvedStatus && ['FAILED', 'ACCEPTED_ALL'].includes(resolvedStatus)) {
      const membersResult = await client.query(
        `SELECT user_id
         FROM group_memberships
         WHERE group_id = $1
         ORDER BY user_id`,
        [petition.group_id]
      );
      for (const member of membersResult.rows) {
        await insertNotificationAndOutboxTx(client, {
          recipientUserId: member.user_id,
          type: 'PETITION_STATUS',
          payload: {
            petitionId: petition.id,
            groupId: petition.group_id,
            status: resolvedStatus
          },
          eventKey: `petition:${petition.id}:status:${resolvedStatus}:${member.user_id}`
        });
      }
    }

    return {
      petition: updatedPetition,
      acceptedCount,
      declinedCount,
      groupSize
    };
  });

const claimOutboxBatch = async ({ limit = 25, now = new Date() } = {}) =>
  withTransaction(async (client) => {
    const claimResult = await client.query(
      `WITH to_claim AS (
         SELECT outbox_id
         FROM notification_outbox
         WHERE status IN ('PENDING', 'FAILED')
           AND COALESCE(next_attempt_at, NOW()) <= $2
         ORDER BY outbox_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_outbox o
       SET status = 'PROCESSING',
           updated_at = NOW()
       FROM to_claim
       WHERE o.outbox_id = to_claim.outbox_id
       RETURNING o.outbox_id,
                 o.notification_id,
                 o.channel,
                 o.dedupe_key,
                 o.status,
                 o.attempt_count,
                 o.next_attempt_at,
                 o.last_error,
                 o.sent_at,
                 o.created_at,
                 o.updated_at`,
      [limit, now]
    );
    return claimResult.rows;
  });

const getNotificationById = async (notificationId) => {
  const result = await pool.query(
    `SELECT notification_id,
            recipient_user_id,
            type,
            event_key,
            payload_json,
            is_read,
            read_at,
            created_at,
            updated_at
     FROM notifications
     WHERE notification_id = $1`,
    [notificationId]
  );
  return result.rows[0] || null;
};

const markOutboxSent = async ({ outboxId }) => {
  const result = await pool.query(
    `UPDATE notification_outbox
     SET status = 'SENT',
         sent_at = NOW(),
         updated_at = NOW(),
         next_attempt_at = NULL,
         last_error = NULL
     WHERE outbox_id = $1
     RETURNING outbox_id,
               notification_id,
               channel,
               dedupe_key,
               status,
               attempt_count,
               next_attempt_at,
               last_error,
               sent_at,
               created_at,
               updated_at`,
    [outboxId]
  );
  return result.rows[0] || null;
};

const markOutboxFailure = async ({
  outboxId,
  lastError,
  nextAttemptAt,
  maxAttempts = 5
}) => {
  const result = await pool.query(
    `UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         status = CASE WHEN attempt_count + 1 >= $4 THEN 'DEAD' ELSE 'FAILED' END,
         next_attempt_at = CASE WHEN attempt_count + 1 >= $4 THEN NULL::timestamptz ELSE $3::timestamptz END,
         last_error = $2,
         updated_at = NOW()
     WHERE outbox_id = $1
     RETURNING outbox_id,
               notification_id,
               channel,
               dedupe_key,
               status,
               attempt_count,
               next_attempt_at,
               last_error,
               sent_at,
               created_at,
               updated_at`,
    [outboxId, lastError || null, nextAttemptAt || null, maxAttempts]
  );
  return result.rows[0] || null;
};

const upsertCalendarForUser = async ({ userId, gcalId = 'primary', calendarName = null }) => {
  const result = await pool.query(
    `INSERT INTO calendar (user_id, gcal_id, calendar_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, gcal_id)
     DO UPDATE SET calendar_name = COALESCE(EXCLUDED.calendar_name, calendar.calendar_name)
     RETURNING calendar_id`,
    [userId, gcalId, calendarName]
  );
  return result.rows[0];
};

const getOrCreateCalendar = upsertCalendarForUser;

const CALENDAR_SYNC_STATE_SELECT_COLUMNS = `
  calendar_id,
  sync_token,
  last_success_sync_token,
  last_synced_at,
  last_succeeded_at,
  last_full_synced_at,
  last_attempted_at,
  last_error,
  last_error_code,
  last_error_details,
  consecutive_failures,
  needs_reauth,
  in_progress,
  in_progress_started_at,
  updated_at
`;

const getCalendarSyncState = async (calendarId) => {
  const result = await pool.query(
    `SELECT ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}
     FROM calendar_sync_state
     WHERE calendar_id = $1`,
    [calendarId]
  );
  return result.rows[0] || null;
};

const getCalendarSyncStateForUpdate = async (client, calendarId) => {
  await client.query(
    `INSERT INTO calendar_sync_state (calendar_id)
     VALUES ($1)
     ON CONFLICT (calendar_id) DO NOTHING`,
    [calendarId]
  );

  const result = await client.query(
    `SELECT ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}
     FROM calendar_sync_state
     WHERE calendar_id = $1
     FOR UPDATE`,
    [calendarId]
  );
  return result.rows[0] || null;
};

const upsertCalendarSyncState = async ({
  calendarId,
  syncToken,
  lastSyncedAt,
  lastFullSyncedAt,
  lastError
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (
       calendar_id,
       sync_token,
       last_success_sync_token,
       last_synced_at,
       last_succeeded_at,
       last_full_synced_at,
       last_attempted_at,
       last_error,
       last_error_code,
       last_error_details,
       consecutive_failures,
       needs_reauth,
       in_progress,
       in_progress_started_at
     )
     VALUES (
       $1,
       $2,
       CASE WHEN $5 IS NULL THEN $2 ELSE NULL END,
       $3,
       CASE WHEN $5 IS NULL THEN $3 ELSE NULL END,
       $4,
       NOW(),
       $5,
       CASE WHEN $5 IS NULL THEN NULL ELSE 'SYNC_FAILED' END,
       NULL,
       CASE WHEN $5 IS NULL THEN 0 ELSE 1 END,
       FALSE,
       FALSE,
       NULL
     )
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       sync_token = EXCLUDED.sync_token,
       last_success_sync_token = CASE
         WHEN EXCLUDED.last_error IS NULL THEN EXCLUDED.sync_token
         ELSE calendar_sync_state.last_success_sync_token
       END,
       last_synced_at = EXCLUDED.last_synced_at,
       last_succeeded_at = CASE
         WHEN EXCLUDED.last_error IS NULL THEN EXCLUDED.last_synced_at
         ELSE calendar_sync_state.last_succeeded_at
       END,
       last_full_synced_at = COALESCE(EXCLUDED.last_full_synced_at, calendar_sync_state.last_full_synced_at),
       last_attempted_at = NOW(),
       last_error = EXCLUDED.last_error,
       last_error_code = CASE
         WHEN EXCLUDED.last_error IS NULL THEN NULL
         ELSE EXCLUDED.last_error_code
       END,
       last_error_details = CASE
         WHEN EXCLUDED.last_error IS NULL THEN NULL
         ELSE EXCLUDED.last_error_details
       END,
       consecutive_failures = CASE
         WHEN EXCLUDED.last_error IS NULL THEN 0
         ELSE calendar_sync_state.consecutive_failures + 1
       END,
       needs_reauth = FALSE,
       in_progress = FALSE,
       in_progress_started_at = NULL,
       updated_at = NOW()
     RETURNING ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}`,
    [calendarId, syncToken ?? null, lastSyncedAt ?? null, lastFullSyncedAt ?? null, lastError ?? null]
  );
  return result.rows[0];
};

const markCalendarSyncStarted = async ({
  calendarId,
  attemptedAt = new Date(),
  startedAt = new Date()
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (
       calendar_id,
       last_attempted_at,
       in_progress,
       in_progress_started_at,
       last_error,
       last_error_code,
       last_error_details
     )
     VALUES ($1, $2, TRUE, $3, NULL, NULL, NULL)
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       last_attempted_at = EXCLUDED.last_attempted_at,
       in_progress = TRUE,
       in_progress_started_at = EXCLUDED.in_progress_started_at,
       last_error = NULL,
       last_error_code = NULL,
       last_error_details = NULL,
       updated_at = NOW()
     RETURNING ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}`,
    [calendarId, attemptedAt, startedAt]
  );
  return result.rows[0] || null;
};

const markCalendarSyncSucceeded = async ({
  calendarId,
  syncToken,
  lastSyncedAt = new Date(),
  lastFullSyncedAt = null
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (
       calendar_id,
       sync_token,
       last_success_sync_token,
       last_synced_at,
       last_succeeded_at,
       last_full_synced_at,
       last_attempted_at,
       last_error,
       last_error_code,
       last_error_details,
       consecutive_failures,
       needs_reauth,
       in_progress,
       in_progress_started_at
     )
     VALUES (
       $1,
       $2,
       $2,
       $3,
       $3,
       $4,
       $3,
       NULL,
       NULL,
       NULL,
       0,
       FALSE,
       FALSE,
       NULL
     )
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       sync_token = EXCLUDED.sync_token,
       last_success_sync_token = EXCLUDED.last_success_sync_token,
       last_synced_at = EXCLUDED.last_synced_at,
       last_succeeded_at = EXCLUDED.last_succeeded_at,
       last_full_synced_at = COALESCE(EXCLUDED.last_full_synced_at, calendar_sync_state.last_full_synced_at),
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_error = NULL,
       last_error_code = NULL,
       last_error_details = NULL,
       consecutive_failures = 0,
       needs_reauth = FALSE,
       in_progress = FALSE,
       in_progress_started_at = NULL,
       updated_at = NOW()
     RETURNING ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}`,
    [calendarId, syncToken ?? null, lastSyncedAt, lastFullSyncedAt]
  );
  return result.rows[0] || null;
};

const markCalendarSyncFailed = async ({
  calendarId,
  lastError = null,
  lastErrorCode = null,
  lastErrorDetails = null,
  needsReauth = false,
  attemptedAt = new Date()
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (
       calendar_id,
       last_attempted_at,
       last_error,
       last_error_code,
       last_error_details,
       consecutive_failures,
       needs_reauth,
       in_progress,
       in_progress_started_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, FALSE, NULL)
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_error = EXCLUDED.last_error,
       last_error_code = EXCLUDED.last_error_code,
       last_error_details = EXCLUDED.last_error_details,
       consecutive_failures = calendar_sync_state.consecutive_failures + 1,
       needs_reauth = EXCLUDED.needs_reauth,
       in_progress = FALSE,
       in_progress_started_at = NULL,
       updated_at = NOW()
     RETURNING ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}`,
    [
      calendarId,
      attemptedAt,
      lastError,
      lastErrorCode,
      lastErrorDetails ? JSON.stringify(lastErrorDetails) : null,
      Boolean(needsReauth)
    ]
  );
  return result.rows[0] || null;
};

const resetCalendarSyncState = async ({ calendarId, clearSyncToken = true }) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_state (
       calendar_id,
       sync_token,
       last_success_sync_token,
       last_error,
       last_error_code,
       last_error_details,
       consecutive_failures,
       needs_reauth,
       in_progress,
       in_progress_started_at,
       last_attempted_at
     )
     VALUES ($1, NULL, NULL, NULL, NULL, NULL, 0, FALSE, FALSE, NULL, NOW())
     ON CONFLICT (calendar_id)
     DO UPDATE SET
       sync_token = CASE WHEN $2 THEN NULL ELSE calendar_sync_state.sync_token END,
       last_success_sync_token = CASE
         WHEN $2 THEN NULL
         ELSE calendar_sync_state.last_success_sync_token
       END,
       last_error = NULL,
       last_error_code = NULL,
       last_error_details = NULL,
       consecutive_failures = 0,
       needs_reauth = FALSE,
       in_progress = FALSE,
       in_progress_started_at = NULL,
       last_attempted_at = NOW(),
       updated_at = NOW()
     RETURNING ${CALENDAR_SYNC_STATE_SELECT_COLUMNS}`,
    [calendarId, Boolean(clearSyncToken)]
  );
  return result.rows[0] || null;
};

const listCalendarSyncStatusForUser = async ({ userId, gcalId = null }) => {
  const result = await pool.query(
    `SELECT c.calendar_id,
            c.gcal_id,
            c.calendar_name,
            s.last_synced_at,
            s.last_succeeded_at,
            s.last_attempted_at,
            s.last_error_code,
            s.last_error_details,
            s.consecutive_failures,
            s.needs_reauth,
            s.in_progress,
            s.in_progress_started_at
     FROM calendar c
     LEFT JOIN calendar_sync_state s ON s.calendar_id = c.calendar_id
     WHERE c.user_id = $1
       AND ($2::text IS NULL OR c.gcal_id = $2)
     ORDER BY c.calendar_id`,
    [userId, gcalId]
  );
  return result.rows;
};

const createCalendarSyncRun = async ({
  calendarId,
  attempt = 1,
  syncTokenIn = null,
  startedAt = new Date()
}) => {
  const result = await pool.query(
    `INSERT INTO calendar_sync_run (calendar_id, started_at, status, attempt, sync_token_in)
     VALUES ($1, $2, 'IN_PROGRESS', $3, $4)
     RETURNING run_id,
               calendar_id,
               started_at,
               finished_at,
               status,
               attempt,
               sync_token_in,
               sync_token_out,
               items_seen,
               items_upserted,
               items_cancelled,
               error_code,
               error_payload`,
    [calendarId, startedAt, attempt, syncTokenIn]
  );
  return result.rows[0] || null;
};

const completeCalendarSyncRun = async ({
  runId,
  status,
  finishedAt = new Date(),
  syncTokenOut = null,
  itemsSeen = 0,
  itemsUpserted = 0,
  itemsCancelled = 0,
  errorCode = null,
  errorPayload = null
}) => {
  const result = await pool.query(
    `UPDATE calendar_sync_run
     SET status = $2,
         finished_at = $3,
         sync_token_out = $4,
         items_seen = $5,
         items_upserted = $6,
         items_cancelled = $7,
         error_code = $8,
         error_payload = $9::jsonb
     WHERE run_id = $1
     RETURNING run_id,
               calendar_id,
               started_at,
               finished_at,
               status,
               attempt,
               sync_token_in,
               sync_token_out,
               items_seen,
               items_upserted,
               items_cancelled,
               error_code,
               error_payload`,
    [
      runId,
      status,
      finishedAt,
      syncTokenOut,
      itemsSeen,
      itemsUpserted,
      itemsCancelled,
      errorCode,
      errorPayload ? JSON.stringify(errorPayload) : null
    ]
  );
  return result.rows[0] || null;
};

const listUserCalendars = async ({ userId, gcalId = null }) => {
  const result = await pool.query(
    `SELECT calendar_id, gcal_id, calendar_name
     FROM calendar
     WHERE user_id = $1
       AND ($2::text IS NULL OR gcal_id = $2)
     ORDER BY calendar_id`,
    [userId, gcalId]
  );
  return result.rows;
};

const upsertCalEvents = async (calendarId, events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let updated = 0;

    for (const event of events) {
      if (!event || !event.providerEventId || !event.start || !event.end) {
        continue;
      }

      const result = await client.query(
        `INSERT INTO cal_event (
           calendar_id,
           provider_event_id,
           ical_uid,
           recurring_event_id,
           original_start_time,
           event_name,
           event_start,
           event_end,
           is_all_day,
           event_timezone,
           status,
           provider_updated_at,
           etag,
           last_synced_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (calendar_id, provider_event_id)
         DO UPDATE SET
           ical_uid = EXCLUDED.ical_uid,
           recurring_event_id = EXCLUDED.recurring_event_id,
           original_start_time = EXCLUDED.original_start_time,
           event_name = EXCLUDED.event_name,
           event_start = EXCLUDED.event_start,
           event_end = EXCLUDED.event_end,
           is_all_day = EXCLUDED.is_all_day,
           event_timezone = EXCLUDED.event_timezone,
           status = EXCLUDED.status,
           provider_updated_at = EXCLUDED.provider_updated_at,
           etag = EXCLUDED.etag,
           last_synced_at = EXCLUDED.last_synced_at
         RETURNING (xmax = 0) AS inserted`,
        [
          calendarId,
          event.providerEventId,
          event.iCalUID ?? null,
          event.recurringEventId ?? null,
          event.originalStartTime ?? null,
          event.title ?? null,
          event.start,
          event.end,
          Boolean(event.isAllDay),
          event.eventTimeZone ?? null,
          event.status ?? 'confirmed',
          event.providerUpdatedAt ?? null,
          event.etag ?? null
        ]
      );

      const wasInserted = result.rows[0]?.inserted === true;
      if (wasInserted) inserted += 1;
      else updated += 1;
    }

    await client.query('COMMIT');
    return { inserted, updated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const markCalEventsCancelled = async (calendarId, providerEventIds) => {
  if (!Array.isArray(providerEventIds) || providerEventIds.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `UPDATE cal_event
     SET status = 'cancelled',
         last_synced_at = NOW()
     WHERE calendar_id = $1
       AND provider_event_id = ANY($2::text[])`,
    [calendarId, providerEventIds]
  );
  return result.rowCount;
};

const listGoogleEventsForUser = async ({ userId, windowStartMs, windowEndMs }) => {
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT e.event_id,
            e.provider_event_id,
            e.ical_uid,
            e.event_name,
            e.event_start,
            e.event_end,
            e.status,
            e.blocking_level
     FROM cal_event e
     INNER JOIN calendar c ON c.calendar_id = e.calendar_id
     WHERE c.user_id = $1
       AND e.status != 'cancelled'
       AND e.event_start < $3
       AND e.event_end > $2
     ORDER BY e.event_start, e.event_id`,
    [userId, start, end]
  );
  return result.rows;
};

const listGoogleEventsForUsers = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);

  const result = await pool.query(
    `SELECT c.user_id,
            e.event_id,
            e.provider_event_id,
            e.event_start,
            e.event_end,
            e.status,
            e.blocking_level
     FROM cal_event e
     INNER JOIN calendar c ON c.calendar_id = e.calendar_id
     WHERE c.user_id = ANY($1)
       AND e.status != 'cancelled'
       AND e.event_start < $3
       AND e.event_end > $2
     ORDER BY c.user_id, e.event_start, e.event_id`,
    [userIds, start, end]
  );

  return result.rows;
};

const updateGoogleEventBlockingLevel = async ({ userId, eventId, blockingLevel }) => {
  const result = await pool.query(
    `UPDATE cal_event e
     SET blocking_level = $1
     FROM calendar c
     WHERE e.event_id = $2
       AND e.calendar_id = c.calendar_id
       AND c.user_id = $3
     RETURNING e.event_id,
               e.provider_event_id,
               e.ical_uid,
               e.event_name,
               e.event_start,
               e.event_end,
               e.status,
               e.blocking_level`,
    [blockingLevel, eventId, userId]
  );
  return result.rows[0] || null;
};

const createUserBusyBlock = async ({
  userId,
  title,
  startTime,
  endTime,
  blockingLevel,
  clientRequestId
}) => {
  const normalizedTitle = title ?? null;
  const normalizedRequestId = clientRequestId ?? null;

  try {
    const result = await pool.query(
      `INSERT INTO user_busy_block (user_id, title, client_request_id, start_time, end_time, blocking_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING busy_block_id,
                 user_id,
                 title,
                 client_request_id,
                 start_time,
                 end_time,
                 blocking_level,
                 created_at,
                 updated_at`,
       [userId, normalizedTitle, normalizedRequestId, startTime, endTime, blockingLevel]
    );
    return { row: result.rows[0], inserted: true };
  } catch (error) {
    if (
      error?.code === '23505' &&
      normalizedRequestId &&
      error?.constraint === 'uniq_user_busy_block_client_request'
    ) {
      const existingResult = await pool.query(
        `SELECT busy_block_id,
                user_id,
                title,
                client_request_id,
                start_time,
                end_time,
                blocking_level,
                created_at,
                updated_at
         FROM user_busy_block
         WHERE user_id = $1
           AND client_request_id = $2
         LIMIT 1`,
        [userId, normalizedRequestId]
      );

      const existing = existingResult.rows[0] || null;
      if (!existing) {
        throw error;
      }

      const sameTitle = (existing.title ?? null) === normalizedTitle;
      const sameLevel = existing.blocking_level === blockingLevel;
      const sameStart = existing.start_time?.getTime?.() === startTime?.getTime?.();
      const sameEnd = existing.end_time?.getTime?.() === endTime?.getTime?.();

      if (sameTitle && sameLevel && sameStart && sameEnd) {
        return { row: existing, inserted: false };
      }

      const err = new Error('Idempotency key reuse with different payload');
      err.code = 'IDEMPOTENCY_KEY_REUSE';
      throw err;
    }

    throw error;
  }
};

const listUserBusyBlocks = async ({ userId, windowStartMs, windowEndMs }) => {
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT busy_block_id, user_id, title, start_time, end_time, blocking_level, created_at, updated_at
     FROM user_busy_block
     WHERE user_id = $1
       AND start_time < $3
       AND end_time > $2
     ORDER BY start_time, busy_block_id`,
    [userId, start, end]
  );
  return result.rows;
};

const listUserBusyBlocksForUsers = async ({ userIds, windowStartMs, windowEndMs }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }
  const start = new Date(windowStartMs);
  const end = new Date(windowEndMs);
  const result = await pool.query(
    `SELECT busy_block_id, user_id, title, start_time, end_time, blocking_level
     FROM user_busy_block
     WHERE user_id = ANY($1)
       AND start_time < $3
       AND end_time > $2
     ORDER BY user_id, start_time, busy_block_id`,
    [userIds, start, end]
  );
  return result.rows;
};

const updateUserBusyBlock = async ({
  userId,
  busyBlockId,
  title,
  startTime,
  endTime,
  blockingLevel
}) => {
  const result = await pool.query(
    `UPDATE user_busy_block
     SET title = COALESCE($3, title),
         start_time = COALESCE($4, start_time),
         end_time = COALESCE($5, end_time),
         blocking_level = COALESCE($6, blocking_level),
         updated_at = NOW()
     WHERE busy_block_id = $2
       AND user_id = $1
     RETURNING busy_block_id, user_id, title, start_time, end_time, blocking_level, created_at, updated_at`,
    [userId, busyBlockId, title ?? null, startTime ?? null, endTime ?? null, blockingLevel ?? null]
  );
  return result.rows[0] || null;
};

const deleteUserBusyBlock = async ({ userId, busyBlockId }) => {
  const result = await pool.query(
    `DELETE FROM user_busy_block
     WHERE busy_block_id = $1
       AND user_id = $2`,
    [busyBlockId, userId]
  );
  return result.rowCount;
};

// Backwards-compatible wrapper (deprecated): insert Google events into cal_event.
const addCalendarEvents = async (calendarId, events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  const normalized = events
    .map((event) => {
      if (!event || !event.gcalEventId || !event.start || !event.end) return null;
      return {
        providerEventId: event.gcalEventId,
        title: event.title ?? null,
        start: event.start,
        end: event.end,
        status: 'confirmed'
      };
    })
    .filter(Boolean);

  const result = await upsertCalEvents(calendarId, normalized);
  return result.inserted;
};

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  withTransaction,
  runSchemaMigrations,
  testConnection,
  upsertUserFromGoogle,
  getUserById,
  getUserByEmail,
  createGroup,
  listGroupsForUser,
  getGroupById,
  isUserInGroup,
  addGroupMember,
  addGroupMemberWithLimit,
  removeGroupMember,
  getGroupMembers,
  getGroupMembersWithTokens,
  deleteGroup,
  createGroupInvite,
  listGroupInvites,
  getGroupInviteById,
  revokeGroupInvite,
  acceptGroupInvite,
  createPetition,
  createPetitionWithNotifications,
  getPetitionById,
  listGroupPetitions,
  listUserPetitions,
  upsertPetitionResponse,
  respondToPetitionWithNotifications,
  getPetitionResponseCounts,
  updatePetitionStatus,
  deletePetition,
  listPetitionsForAvailability,
  getGroupMemberCount,
  getGroupMemberIds,
  listNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotificationForUser,
  claimOutboxBatch,
  getNotificationById,
  markOutboxSent,
  markOutboxFailure,
  upsertCalendarForUser,
  getOrCreateCalendar,
  getCalendarSyncState,
  getCalendarSyncStateForUpdate,
  upsertCalendarSyncState,
  markCalendarSyncStarted,
  markCalendarSyncSucceeded,
  markCalendarSyncFailed,
  resetCalendarSyncState,
  listCalendarSyncStatusForUser,
  createCalendarSyncRun,
  completeCalendarSyncRun,
  listUserCalendars,
  upsertCalEvents,
  markCalEventsCancelled,
  listGoogleEventsForUser,
  listGoogleEventsForUsers,
  updateGoogleEventBlockingLevel,
  createUserBusyBlock,
  listUserBusyBlocks,
  listUserBusyBlocksForUsers,
  updateUserBusyBlock,
  deleteUserBusyBlock,
  addCalendarEvents
};
