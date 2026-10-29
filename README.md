# Dental Flow — Patient Idle Time Tracker

Tracks only how long a patient waits **unattended** between staff handoffs.
It does not store names, DOB, contact info, diagnoses, treatment, or
insurance — only an opaque Patient ID plus timing data.

## What's included

- PostgreSQL schema (`db/schema.sql`)
- Express server + REST API (`server.js`)
- Station login screen (`/login`) — Upfront, OP1–OP6, Lab, TC Room, Back Office. No password; each is a physical screen, not a person.
- Front Desk screen (`/`) — check-in, attended paperwork, operatory assignment (blocks double-booking a room), and a final Complete Visit step once TC is done
- Operatories board (`/operatory`) — all six rooms visible and actionable at once, on one screen
- TC Room screen (`/tc-queue`) — its own queue, since the treatment coordinator isn't at a chairside PC
- Live Practice Dashboard (`/dashboard`)
- Doctor Queue (`/doctor-queue`)
- Analytics (`/analytics`), including a Daily/Weekly/Monthly performance-over-time trend, and separate Cancelled/No-Show tracking so those visits never skew wait-time averages
- Activity Log (`/activity-log`) — full audit trail of every check-in, hand-off, cancellation, and manual edit, with which station did it
- An edit (pencil) button on every patient card — fix a mistyped Patient ID, jump the status, or reassign the operatory, without breaking the timers
- A "Cancel / No-show" link wherever it matters (Waiting Room, Operatories, TC Room) for patients who leave or never get picked up — frees the room immediately and excludes that visit from wait-time analytics
- Guardrails: can't check in a Patient ID that already has an active visit, can't rename onto an ID someone else is actively using, and both are enforced on the server, not just the UI
- A red "X Patients in Waiting Room" badge in the header on every screen, and the Waiting Room list itself is sorted longest-wait-first
- Real-time updates via Server-Sent Events (no page refresh needed)
- An automated test suite (`test/simulate.js`) covering the happy path plus no-shows, mid-treatment walkouts, double-booking, duplicate patient IDs, and analytics correctness — see "Testing" below
- Seed script with demo data

No build step, no frontend framework — plain HTML/CSS/JS served by
Express, so there's nothing to compile.

---

## 1. How to run it locally

**Requirements:** Node.js 18+, PostgreSQL 13+.

```bash
# 1. Install dependencies
npm install

# 2. Create a database and user (adjust as you like)
createdb dentalflow
psql dentalflow -c "CREATE USER dentalflow WITH PASSWORD 'dentalflow';"
psql dentalflow -c "GRANT ALL PRIVILEGES ON DATABASE dentalflow TO dentalflow;"

# 3. Configure environment
cp .env.example .env
# edit .env if your Postgres credentials differ

# 4. Create the tables
npm run db:init

# 5. (optional) Load demo data — 7 days of history + a few live patients
npm run db:seed

# 6. Create your first admin account
npm run create-admin -- admin "choose a strong password 1" "Your Name"

# 7. Start the app, then sign in at http://localhost:3000/login
npm start
```

Then open:
- `http://localhost:3000/` — Front Desk
- `http://localhost:3000/operatory` — all six operatories on one screen
- `http://localhost:3000/tc-queue` — TC Room
- `http://localhost:3000/dashboard` — Live Dashboard
- `http://localhost:3000/doctor-queue` — Doctor Queue
- `http://localhost:3000/analytics` — Analytics
- `http://localhost:3000/activity-log` — Activity Log

Open a few of these in different browser tabs and click through a
patient's flow on one screen — the others update within a second or two,
with no manual refresh.

---

## 2. Database schema

**`visits`** — one row per patient visit.
| column | meaning |
|---|---|
| `id` | primary key |
| `patient_id` | opaque ID entered at check-in (not a real name) |
| `operatory` | `OP1`–`OP6`, set once the assistant takes the patient back |
| `status` | current state, e.g. `waiting_doctor`, `with_doctor` |
| `started_at` | when the visit began (check-in) |
| `completed_at` | when the visit finished, null while in progress |

**`gap_events`** — one row per gap *instance*. A new row is inserted the
moment a gap starts; `ended_at`/`duration_seconds` are filled in when it
stops. Rows are never overwritten, so historical analytics stay accurate
even as the schema/usage evolves.
| column | meaning |
|---|---|
| `gap_number` | 1–4, see mapping below |
| `waiting_for` | `assistant` / `hygienist` / `doctor` / `treatment_coordinator` |
| `started_at` / `ended_at` | when the wait began/ended |
| `duration_seconds` | filled in when the gap ends |
| `started_by_role` / `ended_by_role` | optional, who clicked the button |

**`status_events`** — append-only log of every status change, useful for
audits or building new reports without touching the app.

**`activity_log`** — the human-facing audit trail behind the Activity Log
page: one row per button click or manual edit, with the station that did
it, a readable label, and details (e.g. "Patient ID 8472 → 8427"). This
is what answers "who made this change."

The flow, start to finish:
1. **Check-in** → **Doing Paperwork** (attended, at Front Desk — no timer)
2. Paperwork done → **Gap 1**: waiting for **assistant/hygienist**
3. Assistant/X-ray done → **Gap 2**: waiting for **hygienist**
4. Hygienist leaves → **Gap 3**: waiting for **doctor**
5. Doctor leaves → **Gap 4**: waiting for **treatment coordinator**
6. TC finishes → **Complete Visit** (at Front Desk, TC Room, or the
   patient's operatory — whichever's fastest)

There used to be a 5th gap for checkout. It's been retired — checkout is
now a direct "Complete Visit" click once TC is done, no separate waiting
stage. Old completed visits that still have `waiting_checkout`/
`with_checkout` in the database display fine (their labels are still
defined), they just aren't reachable in the live app anymore.

The state machine and every valid transition live in one place:
`lib/flow.js`. That's the file to read (or edit) to understand exactly
when a timer starts or stops.

**If you already deployed before this update:** no database migration is
needed this time (no new columns or tables) — but this changed the flow
itself, so any visit already sitting in `waiting_checkout` or
`with_checkout` on your live database won't have a button to move it
forward anymore (those stages no longer exist). Complete or cancel any
such visits manually via the edit panel *before* deploying this update,
so nothing gets stuck.

---

## 3. Sign-in, stations, and HIPAA readiness

### Two layers of sign-in

1. **Staff accounts (`/login`)** — every person has their own username and
   password. Nothing in the app (pages or data) is reachable without signing
   in. New accounts start with a temporary password and must choose their
   own the first time they sign in.
2. **Stations (`/station`)** — after signing in, each screen picks which
   room or desk it is (Upfront, OP1–OP6, Lab, TC Room, Back Office). This is
   remembered on that computer; "Switch" changes it without signing out.

The Activity Log records both *who* did something and *from which station*.

### Creating the first admin

The Admin page needs an admin to be signed in, so the very first admin is
created once from Render's Shell (after `npm run db:init`):

```bash
npm run create-admin -- <username> "<password>" "<Full Name>"
```

After that, sign in and use **Admin** in the top menu to add everyone else,
deactivate accounts, reset passwords, and review the Security Log.

### Safeguards built in

| Safeguard | How it works | Setting |
|---|---|---|
| Unique user logins | Individual accounts, passwords hashed with scrypt + per-user salt | — |
| Password rules | 10+ characters with a letter and a number; temporary passwords must be changed at first sign-in | — |
| Failed sign-in lockout | 5 failures in 15 minutes locks that username for up to 15 minutes | — |
| Automatic logoff | A screen with no clicks, typing, or touch is signed out | `SESSION_IDLE_MINUTES` (default 15) |
| Maximum session length | Everyone is signed out after this long regardless | `SESSION_MAX_HOURS` (default 12) |
| Revocable sessions | Only a hash of each session token is stored; deactivating someone or resetting their password signs them out everywhere immediately | — |
| Audit controls | Security Log (sign-ins, failures, logoffs, page and record views, account changes) plus the Activity Log (every workflow action, with the staff member's name) | — |
| Minimum necessary | First names are optional and cleared automatically from finished visits; analytics never use names; names never appear in the Activity Log | `NAME_RETENTION_HOURS` (default 24) |
| No names in server logs | Errors are logged by type and code location only, never by value | — |
| Encryption in transit | HTTPS enforced, HSTS header, secure + httpOnly + SameSite=strict session cookie | — |
| No caching of patient data | `Cache-Control: no-store` on all data requests; name fields have autofill turned off | — |
| Screen privacy | "Hide Names" button shows first initials only on that screen | per screen |

### Security testing

`npm test` includes `test/security.js`, which attacks the sign-in rules
directly and checks the code for the mistakes that most often let outsiders
in:

- Getting past the sign-in page with path tricks (`..`, encoded characters,
  backslashes, different capitalisation, trailing slashes)
- Routes registered before the sign-in check, or admin pages and APIs
  reachable by non-admins
- SQL injection (every query must use placeholders, never pasted-in values)
- Cross-site scripting through patient or staff text in click handlers
- Unchecked rooms, statuses and station names sent from the browser
- Missing security headers, cookie flags, cross-site request blocking,
  caching rules, or error pages that leak internals

**Brute-force protection:** 5 wrong passwords for one username locks it for
up to 15 minutes (a successful sign-in, an admin password reset, or running
`create-admin` clears it). 30 failed sign-ins from one internet address in
15 minutes blocks further attempts from that address. Because the whole
office usually shares one address, check the Security Log if staff report
being blocked.

What these tests can't cover: attacks against the running server and
Render's network. Run the manual checks in the deployment notes after each
deploy, and consider a professional penetration test before storing real
patient names.

### Before storing real patient names

The first-name fields are always available. For HIPAA compliance, real
patient names should only be stored once **all** of these are done:

1. The app and database are running in a HIPAA-enabled hosting workspace
   (on Render, this needs an Organization or Enterprise plan), and the
   Business Associate Agreement (BAA) is signed.
2. The practice has done (or updated) its HIPAA risk assessment to include
   this app, with written policies and staff training on using it.
3. Screens showing names face away from patients and other visitors.
4. Database backups are on and you've confirmed a restore works.

The software safeguards above are necessary but not sufficient on their
own — HIPAA compliance also depends on the hosting agreement and the
practice's own policies. Have whoever handles your HIPAA compliance review
the setup before going live.

### Skipping a stage, and forgotten visits

- **Skip:** when a stage doesn't happen (no hygiene, no doctor, or no TC),
  the room screen shows a smaller "No hygiene: send to Doctor" style button
  under the main one. A skipped stage records no wait at all, so it never
  drags the averages down. If the patient had already been waiting for that
  person, that real wait is kept.
- **Auto-close:** any visit still open `AUTO_CLOSE_AFTER_HOURS` after check-in
  (default 12) is closed automatically, frees its room, shows as
  **Auto-Closed** in the Activity Log, and is left out of every wait-time
  statistic. Analytics shows how many visits were auto-closed, which tells
  you how often Complete is being forgotten.

## 4. Where data is stored

Everything lives in the PostgreSQL database you point `DATABASE_URL` (or
the `PG*` variables) at in `.env`. The app itself is stateless — it holds
no patient data in memory beyond what's needed to serve the current
request, so you can restart the Node process anytime without losing
anything. Back up the Postgres database the same way you'd back up any
other practice-management data.

---

## 5. Changing the green / yellow / red thresholds

Set these in `.env` (seconds):

```
WAIT_YELLOW_SECONDS=300   # default 5 minutes
WAIT_RED_SECONDS=600      # default 10 minutes
```

Restart the server after changing them. The frontend reads these values
from `/api/config` on load, so all screens (dashboard, doctor queue,
operatory) update automatically — no code changes needed.

---

## 6. Adding more operatories

Add the new operatory codes (e.g. `OP7`, `OP8`) in two places:
1. The `OPERATORIES` array in `public/js/common.js` (used by the Operatories
   board and the Front Desk assignment buttons).
2. `lib/flow.js` if you want them in the login station list too (optional —
   Upfront/TC Room/etc. don't need to change).

No database changes needed — `operatory` is a free-text column, not a
fixed list.

---

## 7. Deploying it publicly (Render — recommended, no Claude/Anthropic involved)

This app has no dependency on Claude or any Anthropic product — it's a
plain Node.js website. **Render** is the easiest host for it: one place
for both the web app and the database, a free tier to test with, and a
single URL every device at the practice can bookmark.

**Cost:** the free tier works for testing, but for daily use go with the
paid Starter tier — the free web service sleeps after 15 minutes of
inactivity (30-60s to wake back up) and the free database is deleted
after 30 days. Starter is **~$14/month total** ($7 web service + $7
database), always-on, persistent.

Steps:
1. **Put the code on GitHub.** Create a free GitHub account if you don't
   have one, make a new repository, and upload this project's files.
2. **Create a Render account** at render.com (free), then create a new
   **PostgreSQL** instance from the dashboard. Copy the connection
   string it gives you (`DATABASE_URL`) — you'll need it next.
3. **Create a Web Service** in Render, connect it to your GitHub repo,
   and set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable `DATABASE_URL` = the connection string from step 2
   - (Optional) `WAIT_YELLOW_SECONDS` / `WAIT_RED_SECONDS` if you want
     different thresholds than the 5/10 minute default
4. **Initialize the database.** Using Render's built-in shell/console for
   your web service, run `npm run db:init` once (and `npm run db:seed`
   if you want demo data to try it with first).
5. **Share the URL.** Render gives you a permanent public link once
   deployed (e.g. `dentalflow.onrender.com`). Bookmark it on the front
   desk PC and each operatory PC — everyone hits the same live app and
   sees the same data. No login screen beyond the station picker
   described below, and nobody needs a Claude account or any other
   account to use it.

### Other hosts

Any host that runs Node.js + PostgreSQL works the same way — Railway
and Fly.io are similar alternatives to Render. Running it on your own
server (or Azure, if your practice already has an Azure subscription
separate from Microsoft 365) is also fine; see the general VM
instructions below.

**B. Your own VM (e.g. a small cloud server)**:
1. Install Node.js 18+ and PostgreSQL, or point `DATABASE_URL` at a
   managed Postgres instance.
2. Copy this project to the server, `npm install`, configure `.env`,
   `npm run db:init`.
3. Run the app under a process manager, e.g. `pm2 start server.js` or a
   `systemd` service, so it restarts automatically.
4. Put a reverse proxy (Nginx/Caddy) in front for HTTPS. Caddy in
   particular is a one-line config for automatic HTTPS on a domain.
5. Since operatory PCs and the front desk keep tabs open all day, make
   sure the proxy doesn't time out long-lived SSE connections (Nginx:
   set `proxy_read_timeout` to a large value, e.g. `1h`, on the
   `/api/stream` location).

Either way, this app has no patient-identifying data in it by design,
which simplifies whatever compliance review your practice does before
putting a new tool on the network — but you should still restrict
network access (e.g. VPN or IP allowlist) since it's internal
operational data.

---

## 8. Testing

```bash
npm test
```

This runs `test/simulate.js` — an automated suite that imports the actual
`lib/flow.js` state machine (the same module `server.js` runs) and
exercises it against an in-memory model of the database. It's not a
replacement for testing against real Postgres, but it does verify the
business rules themselves are correct: timers start/stop at the right
moments, no two patients can occupy one room, cancelled visits free up
their room and don't skew the analytics, a Patient ID can't collide with
another active patient's, and so on. Scenarios covered:

1. **Happy path** — full visit, check-in through completion, verifying
   total idle time is exactly the sum of the 4 gaps and nothing else
   (paperwork time is attended and correctly excluded).
2. **No-show** — patient checked in, never picked up, cancelled from the
   Waiting Room.
3. **Mid-treatment walkout** — patient cancels while waiting for the
   doctor; the gap closes at its real elapsed time and the room frees up.
4. **Duplicate check-in** — the same Patient ID can't be checked in twice
   while active, but can be reused once that visit is done.
5. **Double-booking** — two patients can't be assigned the same room,
   whether via the normal flow or a manual edit.
6. **Fat-fingered ID / wrong button** — fixing a Patient ID mid-visit
   doesn't touch the running timer; correcting a status closes the wrong
   gap honestly and opens the right one.
7. **Analytics correctness** — a cancelled visit's abnormally long gap is
   proven to skew a naive average, and proven excluded by the actual
   filter the real endpoint uses.
8. **Waiting Room ordering** — confirms sorting by elapsed wait puts the
   longest-waiting patient first.
9. **Patient ID collisions on edit** — renaming a Patient ID can't collide
   with another active visit's ID.

If you add a new scenario or change the flow rules, add a case here —
it runs in under a second and needs no database.

---

## 9. What's tracked vs. what isn't (design decisions worth knowing)

- **Cancelled / no-show visits are excluded from every wait-time stat**
  (averages, percentiles, trend, worst-gap) but counted separately as
  their own metric, since blending an abandoned wait into "average time
  for the doctor" would understate how long patients who *do* get seen
  actually wait.
- **A room only frees up when its visit is completed or cancelled** — the
  `operatory` field is set once by the front desk and doesn't change for
  the rest of the visit's stages. If your practice physically moves
  patients through multiple different rooms mid-visit (not just to TC
  Room, which already has its own screen), that's a design change, not a
  config change — worth flagging if it doesn't match how your practice
  actually operates.
- **Doing Paperwork is deliberately untimed.** It's attended (front desk
  staff is helping), so no gap timer runs during it — same logic as any
  other "with staff" stage. If paperwork ever becomes something patients
  do unattended, that would need to become a real tracked gap, not a
  quick relabel.
- **Editing a status via the pencil icon always closes whatever timer is
  currently open and starts the correct one for the new status** — so a
  correction never leaves a gap silently running forever.
- **Patient IDs are unique only while active.** Once a visit is completed
  or cancelled, that ID is free to reuse (e.g. the same patient's next
  appointment) — active-only uniqueness is enforced server-side on both
  check-in and edit.
- **The treatment flag is purely visual.** Marking a visit "Flagged for
  Treatment" (e.g. a routine checkup turns into same-day work) shows a
  badge everywhere that patient appears, but deliberately does **not**
  change the green/yellow/red wait thresholds — a flagged patient waiting
  a long time is still worth surfacing as a long wait. Staff can toggle it
  from My Room, the Operatories board, the Dashboard, or the edit panel on
  any screen.

**If you already deployed before this update:** the `treatment_flag`
column won't exist on your database yet. Just re-run `npm run db:init` —
it uses `ADD COLUMN IF NOT EXISTS`, so it adds the new column without
touching any existing data.

---

## 10. API reference (for building custom reports/integrations)

| Method & path | Purpose |
|---|---|
| `POST /api/login` | `{ username, password }` — the only endpoint usable without signing in |
| `POST /api/logout` | Ends the current session |
| `POST /api/heartbeat` | Marks the session active (sent automatically on clicks/typing) |
| `GET /api/me` | The signed-in staff member |
| `POST /api/change-password` | `{ currentPassword, newPassword }` |
| `GET/POST /api/users`, `POST /api/users/:id/toggle-active`, `POST /api/users/:id/reset-password` | Admin only — staff accounts |
| `GET /api/access-log` | Admin only — Security Log |
| `POST /api/visits` | Create a visit: `{ patient_id }` |
| `POST /api/visits/:id/transition` | Advance a visit: `{ action, operatory?, role? }` — actions are the keys in `lib/flow.js` |
| `POST /api/visits/:id/override` | Manual correction: `{ patientId?, status?, operatory?, role? }` — fixes timers correctly and logs to `activity_log` |
| `GET /api/visits/active` | All non-completed visits with live wait/idle times |
| `GET /api/visits/:id` | One visit |
| `GET /api/doctor-queue` | Active visits currently waiting for the doctor |
| `GET /api/tc-queue` | Active visits currently with/waiting for the treatment coordinator |
| `GET /api/activity-log?limit=200` | Recent audit trail entries, most recent first |
| `GET /api/analytics?range=today\|yesterday\|last7\|last30\|custom&start=&end=` | Aggregated metrics for a date range |
| `GET /api/analytics/trend?granularity=daily\|weekly\|monthly` | Look-back trend (avg idle time per period) |
| `GET /api/stream` | Server-Sent Events feed; fires `visits-changed` on every change |
| `GET /api/config` | Current yellow/red thresholds + station list |
