# MVP Deploy / Run Guide (Render + Google Cloud)

## 1) Google Cloud Console (OAuth)
In your existing Google Cloud project:

1. Go to **APIs & Services → Credentials**.
2. Open your OAuth 2.0 Client ID.
3. Add the following:

**Authorized JavaScript Origins**
- `http://localhost:3000`
- `https://<YOUR-APP-NAME>.onrender.com`

**Authorized Redirect URIs**
- `http://localhost:3000/oauth2callback`
- `https://<YOUR-APP-NAME>.onrender.com/oauth2callback`

> Note: Replace `<YOUR-APP-NAME>` with your Render service name (e.g. `my-mvp.onrender.com`).

## 2) Render Dashboard (Postgres)
1. Create a **PostgreSQL** instance in Render.
2. After creation, open the database page:
   - **Internal Connection String**: use this for the Render Web Service `DATABASE_URL`.
   - **External Connection String**: use this for local SQL tools (psql, DBeaver, etc.).

## 3) Render Dashboard (Web Service)
### Connect GitHub
1. Create a **Web Service** from your GitHub repo/branch.
2. Set **Root Directory** to `backend`.

### Build & Start
- **Build Command**: `npm install`
- **Start Command**: `node server.js`

### Required Environment Variables (copy/paste)
Set **exactly these 6** in Render:
1. `DATABASE_URL` = *Internal Connection String from Render Postgres*
2. `GOOGLE_CLIENT_ID` = *OAuth Client ID*
3. `GOOGLE_CLIENT_SECRET` = *OAuth Client Secret*
4. `GOOGLE_REDIRECT_URI` = `https://<YOUR-APP-NAME>.onrender.com/oauth2callback`
5. `SESSION_SECRET` = *random long string*
6. `FRONTEND_URL` = `https://<YOUR-APP-NAME>.onrender.com`

Optional (recommended for better calendar coverage):
- `GOOGLE_SYNC_ALLOW_ALL_CALENDARS` = `false` (default safety: only sync `primary`)
- `GOOGLE_SYNC_ALL_CALENDARS_DEFAULT` = `false` (only used when allow flag is true)

> Render typically sets `NODE_ENV=production`. If not, add it manually.

## 4) Local Development
1. Install dependencies:
   - `cd backend`
   - `npm install`
2. Create the schema:
   - Run the SQL in `db/table_initialization.sql` against your local DB.
3. Start the server:
   - `npm run dev`

## 5) Migrations / Schema Updates
- The MVP schema lives in `db/table_initialization.sql`.
- Tables for MVP:
  - `users`, `groups`, `group_memberships` (core auth + groups)
  - `petitions`, `petition_responses` (petitioned meeting blocks)
  - plus the `session` table used by `connect-pg-simple`
- No Google Calendar events are stored in DB (petitions are first‑class records).

## 6) Verify End-to-End
1. Navigate to `/login` and sign in with Google OAuth.
2. Confirm `/api/me` returns your user object.
3. Create a group:
   - `POST /api/groups` with `{ "name": "My Group" }`
4. Add a member (must have logged in at least once):
   - `POST /api/groups/:groupId/members` with `{ "email": "member@example.com" }`
5. Fetch group availability:
   - `GET /api/groups/:groupId/availability?start=...&end=...&granularity=...`
6. Petition flow:
   - Select darkest‑green blocks in Group View and create petition.
   - Second user logs in and Accepts/Declines.
   - Decline → petition FAILED, creator can delete.
   - Accept‑all → petition ACCEPTED_ALL and persists.

## 7) Proof That Calendar Events Are Not Persisted
- The only persisted tables are `users`, `groups`, `group_memberships` (plus the session table for server sessions).
- Petitions are stored in DB; Google Calendar events are fetched on-demand and discarded.
- There are **no** Google event or calendar snapshot tables in the MVP schema.
