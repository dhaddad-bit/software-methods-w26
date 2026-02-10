// requirements
const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
const path = require('path');
const db = require('./db/index');
const session = require('express-session');
const url = require('url');
const pgSession = require('connect-pg-simple')(session);
const { computeAvailabilityBlocks } = require('./algorithm/index.cjs');
const { syncGoogleEvents } = require('./services/googleCalendar');

// .env config
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development'
});
console.log('Database URL Check:', process.env.DATABASE_URL ? 'Found it!' : 'It is UNDEFINED');

console.log('ENV:', process.env.NODE_ENV);
console.log('Frontend URL:', process.env.FRONTEND_URL);

const frontend = process.env.FRONTEND_URL;
const app = express();

const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());
app.set('trust proxy', 1);

app.use(
  session({
    store: new pgSession({
      pool: db.pool,
      tableName: 'session',
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    }
  })
);

app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: false }));

const defaultRedirectUri = isProduction
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'YOUR-APP-NAME.onrender.com'}/oauth2callback`
  : 'http://localhost:3000/oauth2callback';
const redirectUri = process.env.GOOGLE_REDIRECT_URI || defaultRedirectUri;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

const scopes = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const PORT = process.env.PORT || 3000;

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  return next();
}

async function requireGroupMember(req, res, next) {
  const groupId = Number.parseInt(req.params.groupId, 10);
  if (!Number.isInteger(groupId)) {
    return res.status(400).json({ error: 'Invalid groupId' });
  }

  const group = await db.getGroupById(groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const isMember = await db.isUserInGroup(groupId, req.session.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.group = group;
  req.groupId = groupId;
  return next();
}

function parseTimeParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && String(value).match(/^\d+$/)) {
    return numeric;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function toEpochMs(value) {
  if (!value) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeGoogleDateString(value) {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
    // Date-only events: treat as midnight UTC (MVP behavior).
    return `${value}T00:00:00Z`;
  }
  return value;
}

const VALID_BLOCKING_LEVELS = new Set(['B1', 'B2', 'B3']);
const VALID_AVAILABILITY_LEVELS = new Set(['AVAILABLE', 'FLEXIBLE', 'MAYBE']);

function normalizeAvailabilityLevel(raw) {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (VALID_AVAILABILITY_LEVELS.has(value)) return value;
  return 'MAYBE';
}

function availabilityLevelToMinBlockingLevel(level) {
  const normalized = normalizeAvailabilityLevel(level);
  if (normalized === 'AVAILABLE') return 'B3';
  if (normalized === 'FLEXIBLE') return 'B2';
  return 'B1'; // MAYBE (strict)
}

const PETITION_GRANULARITY_MINUTES = 15;
const PETITION_PRIORITY_DEFAULT = 'HIGHEST';

const CALENDAR_SYNC_TTL_MS = 5 * 60 * 1000;

async function syncCalendarForUser({ userId, refreshToken, gcalId = 'primary', force = false }) {
  if (!refreshToken) {
    const err = new Error('No refresh token for user');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }

  const calendarRecord = await db.getOrCreateCalendar({
    userId,
    gcalId,
    calendarName: gcalId
  });

  const calendarDbId = calendarRecord?.calendar_id;
  if (!calendarDbId) {
    throw new Error('Failed to create calendar record');
  }

  const existingState = await db.getCalendarSyncState(calendarDbId);
  const lastSyncedMs = toEpochMs(existingState?.last_synced_at);

  if (
    !force &&
    process.env.NODE_ENV !== 'test' &&
    Number.isFinite(lastSyncedMs) &&
    Date.now() - lastSyncedMs < CALENDAR_SYNC_TTL_MS
  ) {
    return {
      calendarDbId,
      skipped: true,
      inserted: 0,
      updated: 0,
      cancelled: 0,
      fullSync: false,
      syncTokenUpdated: false
    };
  }

  const startingSyncToken = existingState?.sync_token || null;
  let syncToken = startingSyncToken;

  let syncResult;
  try {
    syncResult = await syncGoogleEvents({ refreshToken, calendarId: gcalId, syncToken });
  } catch (error) {
    if (error?.code === 'SYNC_TOKEN_EXPIRED') {
      syncToken = null;
      syncResult = await syncGoogleEvents({ refreshToken, calendarId: gcalId, syncToken: null });
    } else {
      throw error;
    }
  }

  const items = Array.isArray(syncResult?.items) ? syncResult.items : [];
  const cancelledProviderEventIds = [];
  const eventsForDb = [];

  for (const item of items) {
    const providerEventId = item?.id;
    if (!providerEventId) continue;

    const status = typeof item.status === 'string' ? item.status : 'confirmed';
    if (status === 'cancelled') {
      cancelledProviderEventIds.push(providerEventId);
      continue;
    }

    const start = normalizeGoogleDateString(item?.start?.dateTime || item?.start?.date);
    const end = normalizeGoogleDateString(item?.end?.dateTime || item?.end?.date);
    if (!start || !end) continue;

    const originalStartTime = normalizeGoogleDateString(
      item?.originalStartTime?.dateTime || item?.originalStartTime?.date
    );

    eventsForDb.push({
      providerEventId,
      iCalUID: item.iCalUID || null,
      recurringEventId: item.recurringEventId || null,
      originalStartTime: originalStartTime || null,
      title: item.summary || null,
      start,
      end,
      status,
      providerUpdatedAt: item.updated || null,
      etag: item.etag || null
    });
  }

  const { inserted, updated } = await db.upsertCalEvents(calendarDbId, eventsForDb);
  const cancelled = await db.markCalEventsCancelled(calendarDbId, cancelledProviderEventIds);

  const now = new Date();
  const nextSyncToken = syncResult?.nextSyncToken ?? syncToken ?? null;
  const nextState = {
    calendarId: calendarDbId,
    syncToken: nextSyncToken,
    lastSyncedAt: now,
    lastFullSyncedAt: syncResult?.fullSync ? now : existingState?.last_full_synced_at || null,
    lastError: null
  };
  await db.upsertCalendarSyncState(nextState);

  return {
    calendarDbId,
    skipped: false,
    inserted,
    updated,
    cancelled,
    fullSync: Boolean(syncResult?.fullSync),
    syncTokenUpdated: nextSyncToken !== startingSyncToken
  };
}

async function buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs) {
  const members = await db.getGroupMembersWithTokens(groupId);
  const memberIds = members.map((member) => member.id);

  if (process.env.NODE_ENV !== 'test') {
    await Promise.all(
      members.map((member) =>
        syncCalendarForUser({
          userId: member.id,
          refreshToken: member.google_refresh_token,
          gcalId: 'primary',
          force: false
        })
      )
    );
  }

  const participantsById = new Map(
    memberIds.map((id) => [String(id), { userId: String(id), events: [] }])
  );

  const [googleRows, busyRows] = await Promise.all([
    db.listGoogleEventsForUsers({ userIds: memberIds, windowStartMs, windowEndMs }),
    db.listUserBusyBlocksForUsers({ userIds: memberIds, windowStartMs, windowEndMs })
  ]);

  googleRows.forEach((row) => {
    const userId = String(row.user_id);
    const participant = participantsById.get(userId);
    if (!participant) return;

    const startMs = toEpochMs(row.event_start);
    const endMs = toEpochMs(row.event_end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    participant.events.push({
      eventRef: `google-${row.provider_event_id}`,
      userId,
      startMs,
      endMs,
      source: 'google',
      blockingLevel: row.blocking_level
    });
  });

  busyRows.forEach((row) => {
    const userId = String(row.user_id);
    const participant = participantsById.get(userId);
    if (!participant) return;

    const startMs = toEpochMs(row.start_time);
    const endMs = toEpochMs(row.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    participant.events.push({
      eventRef: `busy-${row.busy_block_id}`,
      userId,
      startMs,
      endMs,
      source: 'manual',
      blockingLevel: row.blocking_level
    });
  });

  const petitions = await db.listPetitionsForAvailability({
    userIds: memberIds,
    windowStartMs,
    windowEndMs
  });

  petitions.forEach((petition) => {
    if (petition.status === 'FAILED') return;
    const startMs = toEpochMs(petition.start_time);
    const endMs = toEpochMs(petition.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

    const acceptedIds = Array.isArray(petition.accepted_user_ids) ? petition.accepted_user_ids : [];

    acceptedIds.forEach((acceptedUserId) => {
      const participant = participantsById.get(String(acceptedUserId));
      if (!participant) return;
      participant.events.push({
        eventRef: `petition-${petition.id}`,
        userId: String(acceptedUserId),
        startMs,
        endMs,
        source: 'petition',
        blockingLevel: 'B3'
      });
    });
  });

  return [...participantsById.values()];
}

async function computeGroupAvailability({
  groupId,
  windowStartMs,
  windowEndMs,
  granularityMinutes,
  level
}) {
  const participants = await buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs);
  const minBlockingLevel = availabilityLevelToMinBlockingLevel(level);
  return computeAvailabilityBlocks({
    windowStartMs,
    windowEndMs,
    participants,
    granularityMinutes,
    priority: minBlockingLevel
  });
}

// ===================PAGES========================

app.get('/', (req, res) => {
  if (typeof req.session.userId !== 'undefined') {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html'));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  const user = await db.getUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  return res.json({ id: user.id, email: user.email, name: user.name });
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return console.log(err);
    }
    res.redirect('/login');
  });
});

// Database test route
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await db.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/auth/google', async (req, res) => {
  const username = req.query.username;
  const state = crypto.randomBytes(32).toString('hex');
  req.session.state = state;
  req.session.pending_username = username;

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    include_granted_scopes: true,
    state: state,
    prompt: 'consent'
  });
  res.redirect(authorizationUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const q = url.parse(req.url, true).query;

  if (q.error) {
    console.log(q);
    return res.redirect(frontend + '/error.html');
  }

  try {
    const { tokens } = await oauth2Client.getToken(q.code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const displayName = userInfo.name || `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim();
    const refreshToken = tokens.refresh_token || null;

    const user = await db.upsertUserFromGoogle(
      userInfo.id,
      userInfo.email,
      displayName,
      refreshToken
    );

    req.session.userId = user.id;
    req.session.isAuthenticated = true;

    delete req.session.state;
    delete req.session.pending_username;

    await new Promise((resolve, reject) => {
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session Save Error:', saveErr);
          reject(saveErr);
        } else {
          resolve();
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    res.redirect('/');
  } catch (authErr) {
    console.error('Login failed', authErr);
    res.redirect('/login fail');
  }
});

// ===================GROUPS========================

app.post('/api/groups', requireAuth, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  const group = await db.createGroup(name, req.session.userId);
  await db.addGroupMember(group.id, req.session.userId, 'owner');

  return res.status(201).json(group);
});

app.get('/api/groups', requireAuth, async (req, res) => {
  const groups = await db.listGroupsForUser(req.session.userId);
  return res.json(groups);
});

app.get('/api/groups/:groupId/members', requireAuth, requireGroupMember, async (req, res) => {
  const members = await db.getGroupMembers(req.groupId);
  return res.json(members);
});

app.post('/api/groups/:groupId/members', requireAuth, requireGroupMember, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = await db.getUserByEmail(email);
  if (!user) {
    // MVP: no invites; user must have logged in before
    return res.status(404).json({ error: 'User not found. User must log in first.' });
  }

  await db.addGroupMember(req.groupId, user.id, null);
  return res.status(200).json({ id: user.id, email: user.email, name: user.name });
});

// ===================PETITIONS========================

app.post('/api/groups/:groupId/petitions', requireAuth, requireGroupMember, async (req, res) => {
  const startMs = parseTimeParam(req.body?.start);
  const endMs = parseTimeParam(req.body?.end);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const level = normalizeAvailabilityLevel(req.body?.level);
  let priority =
    typeof req.body?.priority === 'string' && req.body.priority.trim()
      ? req.body.priority.trim().toUpperCase()
      : PETITION_PRIORITY_DEFAULT;
  if (!['HIGHEST', 'HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
    priority = PETITION_PRIORITY_DEFAULT;
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
  }
  if (endMs <= startMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  const blockMs = PETITION_GRANULARITY_MINUTES * 60 * 1000;
  if (startMs % blockMs !== 0 || endMs % blockMs !== 0) {
    return res.status(400).json({ error: 'start and end must align to 15-minute blocks' });
  }

  try {
    const blocks = await computeGroupAvailability({
      groupId: req.groupId,
      windowStartMs: startMs,
      windowEndMs: endMs,
      granularityMinutes: PETITION_GRANULARITY_MINUTES,
      level
    });

    const windowBlocks = blocks.filter(
      (block) => block.startMs >= startMs && block.endMs <= endMs
    );
    if (windowBlocks.length === 0) {
      return res.status(400).json({ error: 'Invalid petition window' });
    }

    const allFree = windowBlocks.every((block) => block.availableCount === block.totalCount);
    if (!allFree) {
      return res
        .status(400)
        .json({ error: 'Selected window is not fully available for all members' });
    }

    const petition = await db.createPetition({
      groupId: req.groupId,
      createdByUserId: req.session.userId,
      title: title || 'Petitioned Meeting',
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      priority: priority || PETITION_PRIORITY_DEFAULT,
      status: 'OPEN'
    });

    await db.upsertPetitionResponse({
      petitionId: petition.id,
      userId: req.session.userId,
      response: 'ACCEPTED'
    });

    const groupSize = await db.getGroupMemberCount(req.groupId);

    return res.status(201).json({
      ...petition,
      group_name: req.group.name,
      acceptedCount: 1,
      declinedCount: 0,
      groupSize,
      currentUserResponse: 'ACCEPTED'
    });
  } catch (error) {
    if (error.code === 'NO_REFRESH_TOKEN') {
      return res.status(400).json({ error: 'One or more members need to re-authenticate.' });
    }
    console.error('Error creating petition', error);
    return res.status(500).json({ error: 'Failed to create petition' });
  }
});

app.get('/api/groups/:groupId/petitions', requireAuth, requireGroupMember, async (req, res) => {
  const petitions = await db.listGroupPetitions({
    groupId: req.groupId,
    userId: req.session.userId
  });
  return res.json(petitions);
});

app.get('/api/petitions', requireAuth, async (req, res) => {
  const petitions = await db.listUserPetitions({ userId: req.session.userId });
  return res.json(petitions);
});

app.post('/api/petitions/:petitionId/respond', requireAuth, async (req, res) => {
  const petitionId = Number.parseInt(req.params.petitionId, 10);
  if (!Number.isInteger(petitionId)) {
    return res.status(400).json({ error: 'Invalid petitionId' });
  }

  const responseValue = typeof req.body?.response === 'string' ? req.body.response.trim() : '';
  if (!['ACCEPT', 'DECLINE'].includes(responseValue.toUpperCase())) {
    return res.status(400).json({ error: 'response must be ACCEPT or DECLINE' });
  }
  const normalizedResponse = responseValue.toUpperCase() === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';

  const petition = await db.getPetitionById(petitionId);
  if (!petition) {
    return res.status(404).json({ error: 'Petition not found' });
  }

  const isMember = await db.isUserInGroup(petition.group_id, req.session.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await db.upsertPetitionResponse({
    petitionId,
    userId: req.session.userId,
    response: normalizedResponse
  });

  const counts = await db.getPetitionResponseCounts(petitionId);
  const acceptedCount = Number.parseInt(counts.accepted_count, 10) || 0;
  const declinedCount = Number.parseInt(counts.declined_count, 10) || 0;
  const groupSize = await db.getGroupMemberCount(petition.group_id);

  let nextStatus = 'OPEN';
  if (declinedCount > 0) {
    nextStatus = 'FAILED';
  } else if (acceptedCount === groupSize) {
    nextStatus = 'ACCEPTED_ALL';
  }

  let updatedPetition = petition;
  if (petition.status !== nextStatus) {
    updatedPetition = await db.updatePetitionStatus(petitionId, nextStatus);
  }

  return res.json({
    ...updatedPetition,
    acceptedCount,
    declinedCount,
    groupSize,
    currentUserResponse: normalizedResponse
  });
});

app.delete('/api/petitions/:petitionId', requireAuth, async (req, res) => {
  const petitionId = Number.parseInt(req.params.petitionId, 10);
  if (!Number.isInteger(petitionId)) {
    return res.status(400).json({ error: 'Invalid petitionId' });
  }

  const petition = await db.getPetitionById(petitionId);
  if (!petition) {
    return res.status(404).json({ error: 'Petition not found' });
  }

  if (petition.created_by_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (petition.status !== 'FAILED') {
    return res.status(400).json({ error: 'Only FAILED petitions can be deleted' });
  }

  await db.deletePetition(petitionId);
  return res.json({ ok: true });
});

// ===================AVAILABILITY========================

app.get('/api/groups/:groupId/availability', requireAuth, requireGroupMember, async (req, res) => {
  const windowStartMs = parseTimeParam(req.query.start);
  const windowEndMs = parseTimeParam(req.query.end);
  const granularityRaw = req.query.granularity;
  const level = normalizeAvailabilityLevel(req.query.level);

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
  }
  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  let granularityMinutes;
  if (granularityRaw !== undefined) {
    granularityMinutes = Number.parseInt(granularityRaw, 10);
    if (!Number.isInteger(granularityMinutes) || granularityMinutes <= 0) {
      return res.status(400).json({ error: 'granularity must be a positive integer (minutes)' });
    }
  }

  try {
    const blocks = await computeGroupAvailability({
      groupId: req.groupId,
      windowStartMs,
      windowEndMs,
      granularityMinutes: granularityMinutes || undefined,
      level
    });
    return res.json(blocks);
  } catch (error) {
    if (error.code === 'NO_REFRESH_TOKEN') {
      return res.status(400).json({ error: 'One or more members need to re-authenticate.' });
    }
    console.error('Error computing availability', error);
    return res.status(500).json({ error: 'Failed to compute availability' });
  }
});

// ===================CALENDAR EVENTS========================

app.post('/api/google/sync', requireAuth, async (req, res) => {
  const calendarId =
    typeof req.body?.calendarId === 'string' && req.body.calendarId.trim()
      ? req.body.calendarId.trim()
      : 'primary';
  const force = Boolean(req.body?.force);

  try {
    const user = await db.getUserById(req.session.userId);
    if (!user || !user.google_refresh_token) {
      return res.status(401).json({ error: 'No tokens found. Please re-authenticate.' });
    }

    const result = await syncCalendarForUser({
      userId: req.session.userId,
      refreshToken: user.google_refresh_token,
      gcalId: calendarId,
      force
    });

    return res.json({
      calendarId,
      calendarDbId: result.calendarDbId,
      fullSync: result.fullSync,
      skipped: result.skipped,
      syncedAt: new Date().toISOString(),
      inserted: result.inserted,
      updated: result.updated,
      cancelled: result.cancelled,
      syncTokenUpdated: result.syncTokenUpdated
    });
  } catch (error) {
    console.error('Error syncing Google calendar', error);

    if (error.code === 401 || error.code === 403) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Authentication expired. Please log in again.' });
    }

    return res.status(500).json({ error: 'Failed to sync Google calendar' });
  }
});

app.get('/api/events', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.query.start);
  const endMs = parseTimeParam(req.query.end);

  let windowStartMs = startMs;
  let windowEndMs = endMs;

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    if (startMs === null && endMs === null) {
      const now = Date.now();
      windowEndMs = now;
      windowStartMs = now - 14 * 24 * 60 * 60 * 1000;
    } else {
      return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
    }
  }

  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  try {
    const rows = await db.listGoogleEventsForUser({
      userId: req.session.userId,
      windowStartMs,
      windowEndMs
    });

    const out = rows.map((row) => ({
      eventId: row.event_id,
      providerEventId: row.provider_event_id,
      iCalUID: row.ical_uid,
      title: row.event_name || 'No Title',
      start: row.event_start,
      end: row.event_end,
      status: row.status,
      blockingLevel: row.blocking_level,
      source: 'google'
    }));

    return res.json(out);
  } catch (error) {
    console.error('Error listing events', error);
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/events/:eventId/priority', requireAuth, async (req, res) => {
  const eventId = Number.parseInt(req.params.eventId, 10);
  if (!Number.isInteger(eventId)) {
    return res.status(400).json({ error: 'Invalid eventId' });
  }

  const levelRaw = typeof req.body?.blockingLevel === 'string' ? req.body.blockingLevel : '';
  const blockingLevel = levelRaw.trim().toUpperCase();
  if (!VALID_BLOCKING_LEVELS.has(blockingLevel)) {
    return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
  }

  try {
    const updated = await db.updateGoogleEventBlockingLevel({
      userId: req.session.userId,
      eventId,
      blockingLevel
    });

    if (!updated) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.json({
      eventId: updated.event_id,
      providerEventId: updated.provider_event_id,
      iCalUID: updated.ical_uid,
      title: updated.event_name || 'No Title',
      start: updated.event_start,
      end: updated.event_end,
      status: updated.status,
      blockingLevel: updated.blocking_level,
      source: 'google'
    });
  } catch (error) {
    console.error('Error updating event priority', error);
    return res.status(500).json({ error: 'Failed to update event priority' });
  }
});

// ===================USER BUSY BLOCKS========================

app.get('/api/busy-blocks', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.query.start);
  const endMs = parseTimeParam(req.query.end);

  let windowStartMs = startMs;
  let windowEndMs = endMs;

  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    if (startMs === null && endMs === null) {
      const now = Date.now();
      windowEndMs = now;
      windowStartMs = now - 14 * 24 * 60 * 60 * 1000;
    } else {
      return res.status(400).json({ error: 'start and end are required (ISO or epoch ms)' });
    }
  }

  if (windowEndMs <= windowStartMs) {
    return res.status(400).json({ error: 'end must be greater than start' });
  }

  try {
    const rows = await db.listUserBusyBlocks({
      userId: req.session.userId,
      windowStartMs,
      windowEndMs
    });

    const out = rows.map((row) => ({
      busyBlockId: row.busy_block_id,
      title: row.title || 'Busy',
      start: row.start_time,
      end: row.end_time,
      blockingLevel: row.blocking_level,
      source: 'manual'
    }));

    return res.json(out);
  } catch (error) {
    console.error('Error listing busy blocks', error);
    return res.status(500).json({ error: 'Failed to fetch busy blocks' });
  }
});

app.post('/api/busy-blocks', requireAuth, async (req, res) => {
  const startMs = parseTimeParam(req.body?.startMs);
  const endMs = parseTimeParam(req.body?.endMs);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';

  const levelRaw = typeof req.body?.blockingLevel === 'string' ? req.body.blockingLevel : 'B3';
  const blockingLevel = levelRaw.trim().toUpperCase() || 'B3';
  if (!VALID_BLOCKING_LEVELS.has(blockingLevel)) {
    return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return res.status(400).json({ error: 'startMs and endMs are required (ISO or epoch ms)' });
  }
  if (endMs <= startMs) {
    return res.status(400).json({ error: 'endMs must be greater than startMs' });
  }

  try {
    const row = await db.createUserBusyBlock({
      userId: req.session.userId,
      title: title || null,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      blockingLevel
    });

    return res.status(201).json({
      busyBlockId: row.busy_block_id,
      title: row.title || 'Busy',
      start: row.start_time,
      end: row.end_time,
      blockingLevel: row.blocking_level,
      source: 'manual'
    });
  } catch (error) {
    console.error('Error creating busy block', error);
    return res.status(500).json({ error: 'Failed to create busy block' });
  }
});

app.post('/api/busy-blocks/:busyBlockId', requireAuth, async (req, res) => {
  const busyBlockId = Number.parseInt(req.params.busyBlockId, 10);
  if (!Number.isInteger(busyBlockId)) {
    return res.status(400).json({ error: 'Invalid busyBlockId' });
  }

  const startMs = parseTimeParam(req.body?.startMs);
  const endMs = parseTimeParam(req.body?.endMs);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : null;

  let blockingLevel = null;
  if (typeof req.body?.blockingLevel === 'string') {
    const candidate = req.body.blockingLevel.trim().toUpperCase();
    if (!VALID_BLOCKING_LEVELS.has(candidate)) {
      return res.status(400).json({ error: 'blockingLevel must be B1, B2, or B3' });
    }
    blockingLevel = candidate;
  }

  if (startMs !== null && endMs !== null && Number.isFinite(startMs) && Number.isFinite(endMs)) {
    if (endMs <= startMs) {
      return res.status(400).json({ error: 'endMs must be greater than startMs' });
    }
  }

  try {
    const updated = await db.updateUserBusyBlock({
      userId: req.session.userId,
      busyBlockId,
      title,
      startTime: Number.isFinite(startMs) ? new Date(startMs) : null,
      endTime: Number.isFinite(endMs) ? new Date(endMs) : null,
      blockingLevel
    });

    if (!updated) {
      return res.status(404).json({ error: 'Busy block not found' });
    }

    return res.json({
      busyBlockId: updated.busy_block_id,
      title: updated.title || 'Busy',
      start: updated.start_time,
      end: updated.end_time,
      blockingLevel: updated.blocking_level,
      source: 'manual'
    });
  } catch (error) {
    console.error('Error updating busy block', error);
    return res.status(500).json({ error: 'Failed to update busy block' });
  }
});

app.delete('/api/busy-blocks/:busyBlockId', requireAuth, async (req, res) => {
  const busyBlockId = Number.parseInt(req.params.busyBlockId, 10);
  if (!Number.isInteger(busyBlockId)) {
    return res.status(400).json({ error: 'Invalid busyBlockId' });
  }

  try {
    const deleted = await db.deleteUserBusyBlock({
      userId: req.session.userId,
      busyBlockId
    });

    if (deleted === 0) {
      return res.status(404).json({ error: 'Busy block not found' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting busy block', error);
    return res.status(500).json({ error: 'Failed to delete busy block' });
  }
});

if (process.env.NODE_ENV === 'test') {
  app.post('/test/login', (req, res) => {
    const userId = req.body?.userId;
    req.session.userId = userId;
    req.session.isAuthenticated = true;
    res.json({ ok: true });
  });
}

app.get('/test-session', (req, res) => {
  res.json({
    sessionID: req.sessionID,
    userId: req.session.userId,
    isAuthenticated: req.session.isAuthenticated,
    fullSession: req.session
  });
});

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { app };
