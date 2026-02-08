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
const { fetchBusyIntervalsForUser, listGoogleEvents } = require('./services/googleCalendar');

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

const PETITION_GRANULARITY_MINUTES = 15;
const PETITION_PRIORITY_DEFAULT = 'HIGHEST';

async function buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs) {
  const members = await db.getGroupMembersWithTokens(groupId);

  const participants = await Promise.all(
    members.map(async (member) => {
      const intervals = await fetchBusyIntervalsForUser({
        userId: String(member.id),
        refreshToken: member.google_refresh_token,
        windowStartMs,
        windowEndMs
      });
      return { userId: String(member.id), events: intervals };
    })
  );

  const participantsById = new Map(participants.map((p) => [p.userId, p]));

  const memberIds = members.map((member) => member.id);
  const petitions = await db.listPetitionsForAvailability({
    userIds: memberIds,
    windowStartMs,
    windowEndMs
  });

  petitions.forEach((petition) => {
    if (petition.status === 'FAILED') return;
    const startMs = Date.parse(petition.start_time);
    const endMs = Date.parse(petition.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

    const acceptedIds = Array.isArray(petition.accepted_user_ids)
      ? petition.accepted_user_ids
      : [];

    acceptedIds.forEach((userId) => {
      const participant = participantsById.get(String(userId));
      if (!participant) return;

      participant.events.push({
        eventRef: `petition-${petition.id}`,
        userId: String(userId),
        startMs,
        endMs,
        source: 'petition',
        blockingLevel: petition.priority || PETITION_PRIORITY_DEFAULT
      });
    });
  });

  return participants;
}

async function computeGroupAvailability({ groupId, windowStartMs, windowEndMs, granularityMinutes }) {
  const participants = await buildParticipantsWithPetitions(groupId, windowStartMs, windowEndMs);
  return computeAvailabilityBlocks({
    windowStartMs,
    windowEndMs,
    participants,
    granularityMinutes
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
      granularityMinutes: PETITION_GRANULARITY_MINUTES
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
      granularityMinutes: granularityMinutes || undefined
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

app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user || !user.google_refresh_token) {
      return res.status(401).json({ error: 'No tokens found. Please re-authenticate.' });
    }

    const calendarStart = new Date();
    calendarStart.setDate(calendarStart.getDate() - 14);

    const events = await listGoogleEvents({
      refreshToken: user.google_refresh_token,
      timeMin: calendarStart
    });

    if (!events || events.length === 0) {
      return res.json([]);
    }

    const formattedEvents = events.map((event) => {
      const start = event.start.dateTime || event.start.date;
      const end = event.end.dateTime || event.end.date;

      return {
        title: event.summary || 'No Title',
        start: start,
        end: end
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    console.error('Error fetching calendar', error);

    if (error.code === 401 || error.code === 403) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Authentication expired. Please log in again.' });
    }

    res.status(500).json({ error: 'Failed to fetch events' });
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
