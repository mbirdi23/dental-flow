require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const { TRANSITIONS, NEXT_ACTION, TC_NEXT_ACTION, FULL_NEXT_ACTION, SKIP_ACTION, STATIONS, STATUS_LABEL, ACTION_LABEL, GAP_FOR_STATUS, STATUS_OPTIONS } = require('./lib/flow');
const { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePassword, normalizeUsername, validateUsername, sessionState, lockoutRemainingMs, isPublicPath } = require('./lib/auth');
const { cleanFirstName, logError } = require('./lib/phi');

const app = express();

// ---------------------------------------------------------------------------
// Security settings (all adjustable with environment variables on Render).
// ---------------------------------------------------------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
// Informational only: set HIPAA_HOSTING=true once the app runs in a
// HIPAA-enabled hosting workspace with a signed BAA.
const HIPAA_HOSTING = process.env.HIPAA_HOSTING === 'true';
const SESSION_IDLE_MINUTES = parseInt(process.env.SESSION_IDLE_MINUTES || '15', 10);
const SESSION_MAX_HOURS = parseInt(process.env.SESSION_MAX_HOURS || '12', 10);
const SESSION_IDLE_MS = SESSION_IDLE_MINUTES * 60 * 1000;
const SESSION_ABSOLUTE_MS = SESSION_MAX_HOURS * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
// The whole office usually shares one internet address, so this is generous.
const LOGIN_MAX_FAILURES_PER_NETWORK = 30;
// Visits still open this long after check-in were forgotten; they're closed
// automatically and left out of wait-time stats.
const AUTO_CLOSE_AFTER_HOURS = parseInt(process.env.AUTO_CLOSE_AFTER_HOURS || '12', 10);
const NAME_RETENTION_HOURS = parseInt(process.env.NAME_RETENTION_HOURS || '24', 10);
// Used so a sign-in attempt for a username that doesn't exist takes the
// same time as a wrong password (doesn't reveal which usernames exist).
const DUMMY_PASSWORD_HASH = hashPassword(generateSessionToken());

if (IS_PRODUCTION) app.set('env', 'production');
app.set('trust proxy', 1); // Render sits behind a proxy that terminates HTTPS
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

app.use((req, res, next) => {
  if (IS_PRODUCTION && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  // Patient data must never sit in a browser or proxy cache.
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch (e) { /* malformed origin */ }
    if (originHost !== req.headers.host) return res.status(403).json({ error: 'Request blocked' });
  }
  next();
});

// A room is taken from when the patient is pulled back until the visit is
// completed (or cancelled). Cleaning starts at completion.
const IN_ROOM_STATUSES = ['with_assistant', 'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc'];
const VALID_OPERATORIES = STATIONS.filter((s) => /^OP\d+$/.test(s));
// Station names come from the browser; only accept real ones.
function cleanRole(role) {
  return STATIONS.includes(role) ? role : 'Unknown';
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

async function logAccess(req, event, opts = {}) {
  const user = opts.user || req.user || null;
  try {
    await pool.query(
      `INSERT INTO access_log (user_id, username, event, detail, path, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user ? user.id : null,
        opts.username || (user ? user.username : null),
        event,
        opts.detail ? String(opts.detail).slice(0, 200) : null,
        String(req.path || '').slice(0, 200),
        String(req.ip || '').slice(0, 64),
      ]
    );
  } catch (err) {
    logError('access log', err);
  }
}

async function loadSession(req) {
  const token = getCookie(req, 'session');
  if (!token) return { status: 'missing' };
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT s.created_at, s.last_activity_at,
            u.id, u.username, u.display_name, u.is_admin, u.active, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row || !row.active) return { status: 'missing' };
  const state = sessionState(row, Date.now(), { idleMs: SESSION_IDLE_MS, absoluteMs: SESSION_ABSOLUTE_MS });
  if (state !== 'valid') {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    await logAccess(req, state === 'idle' ? 'auto_logout_idle' : 'session_expired', { user: row });
    return { status: state };
  }
  return {
    status: 'valid',
    tokenHash,
    user: {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      is_admin: row.is_admin,
      must_change_password: row.must_change_password,
    },
  };
}

function deny(req, res, reason) {
  res.clearCookie('session', { path: '/' });
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in', code: 'NOT_SIGNED_IN', reason: reason || 'signed-out' });
  }
  return res.redirect(reason ? `/login?reason=${reason}` : '/login');
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
    return res.redirect('/station');
  }
  next();
}

// Every page and API call requires a valid, signed-in session except the
// sign-in page itself and the CSS/JS it needs to render.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/api/login']);
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/change-password', '/change-password.html', '/api/change-password', '/api/logout', '/api/me', '/api/heartbeat',
]);
function isPublicAsset(p) {
  return p.startsWith('/css/') || p.startsWith('/js/') || p === '/favicon.ico';
}

app.use(async (req, res, next) => {
  if (isPublicPath(req.path)) return next();
  try {
    const session = await loadSession(req);
    if (session.status !== 'valid') return deny(req, res, session.status === 'missing' ? null : session.status);
    req.user = session.user;
    req.sessionTokenHash = session.tokenHash;
    const isApi = req.path.startsWith('/api/');

    if (req.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
      if (isApi) return res.status(403).json({ error: 'Please set a new password first', code: 'PASSWORD_CHANGE_REQUIRED' });
      return res.redirect('/change-password');
    }
    if (req.path === '/admin.html' && !req.user.is_admin) return res.redirect('/station');

    // Background polling (GET /api/...) deliberately does NOT count as
    // activity — otherwise a screen left open would never log out. Page
    // loads, button clicks and the activity heartbeat do.
    if (!isApi || req.method !== 'GET') {
      await pool.query('UPDATE sessions SET last_activity_at = now() WHERE token_hash = $1', [session.tokenHash]);
    }
    if (!isApi && req.method === 'GET') await logAccess(req, 'page_view');
    next();
  } catch (err) {
    logError('auth check', err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Could not verify sign-in' });
    res.status(500).send('Could not verify sign-in. Please try again.');
  }
});

// --- Sign in / sign out ------------------------------------------------------

app.post('/api/login', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const { rows: fails } = await pool.query(
      `SELECT created_at FROM access_log
       WHERE username = $1 AND event = 'login_failed' AND created_at > now() - ($2::int * interval '1 minutes')
         AND created_at > COALESCE((SELECT MAX(created_at) FROM access_log WHERE username = $1 AND event IN ('lockout_cleared', 'login_success')), '-infinity'::timestamptz)`,
      [username, LOGIN_LOCKOUT_MINUTES]
    );
    const lockedMs = lockoutRemainingMs(
      fails.map((r) => new Date(r.created_at).getTime()),
      Date.now(),
      { maxAttempts: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_LOCKOUT_MINUTES * 60 * 1000 }
    );
    if (lockedMs > 0) {
      await logAccess(req, 'login_blocked_locked', { username });
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 60000)} minute(s), or ask an admin to reset your password.` });
    }

    const { rows: networkFails } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM access_log WHERE ip = $1 AND event = 'login_failed' AND created_at > now() - interval '15 minutes'`,
      [String(req.ip || '').slice(0, 64)]
    );
    if (networkFails[0].n >= LOGIN_MAX_FAILURES_PER_NETWORK) {
      await logAccess(req, 'login_blocked_network', { username });
      return res.status(429).json({ error: 'Too many failed sign-in attempts from this network. Try again in 15 minutes.' });
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!user || !user.active || !passwordOk) {
      await logAccess(req, 'login_failed', { username, user: user || null });
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const token = generateSessionToken();
    await pool.query(
      'INSERT INTO sessions (token_hash, user_id, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [hashToken(token), user.id, String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 200)]
    );
    await logAccess(req, 'login_success', { user });
    res.cookie('session', token, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: 'strict',
      maxAge: SESSION_ABSOLUTE_MS,
      path: '/',
    });
    res.json({ displayName: user.display_name, isAdmin: user.is_admin, mustChangePassword: user.must_change_password });
  } catch (err) {
    logError('login', err);
    res.status(500).json({ error: 'Sign in failed' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
    await logAccess(req, 'logout');
  } catch (err) {
    logError('logout', err);
  }
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

// Sent by the browser when someone actually uses the screen (click, key,
// touch), which is what keeps a session from timing out.
app.post('/api/heartbeat', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    displayName: req.user.display_name,
    isAdmin: req.user.is_admin,
    mustChangePassword: req.user.must_change_password,
  });
});

app.post('/api/change-password', async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const problem = validatePassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'New password must be different from the current one' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0] || !verifyPassword(currentPassword, rows[0].password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hashPassword(newPassword), req.user.id]);
    // Sign out this person's other devices; keep this one signed in.
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2', [req.user.id, req.sessionTokenHash]);
    await logAccess(req, 'password_changed');
    res.json({ ok: true });
  } catch (err) {
    logError('change password', err);
    res.status(500).json({ error: 'Could not change password' });
  }
});

// --- Admin: staff accounts and the security log ------------------------------

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, is_admin, active, must_change_password, created_at FROM users ORDER BY active DESC, display_name`
    );
    res.json(rows);
  } catch (err) {
    logError('list users', err);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');
  const usernameProblem = validateUsername(username);
  if (usernameProblem) return res.status(400).json({ error: usernameProblem });
  if (!displayName || displayName.length > 60) return res.status(400).json({ error: 'Full name is required (max 60 characters)' });
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return res.status(400).json({ error: passwordProblem });
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, display_name, is_admin, must_change_password)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, username, display_name, is_admin, active, must_change_password, created_at`,
      [username, hashPassword(password), displayName, !!req.body.isAdmin]
    );
    await logAccess(req, 'admin_create_user', { detail: `${username}${req.body.isAdmin ? ' (admin)' : ''}` });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    logError('create user', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/users/:id(\\d+)/toggle-active', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: "You can't deactivate your own account" });
  try {
    const { rows: targetRows } = await pool.query('SELECT id, username, is_admin, active FROM users WHERE id = $1', [id]);
    const target = targetRows[0];
    if (!target) return res.status(404).json({ error: 'Account not found' });
    if (target.active && target.is_admin) {
      const { rows: others } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE is_admin AND active AND id != $1', [id]);
      if (others[0].n === 0) return res.status(400).json({ error: 'At least one active admin account is required' });
    }
    const { rows } = await pool.query('UPDATE users SET active = NOT active WHERE id = $1 RETURNING id, active', [id]);
    if (!rows[0].active) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]); // signed out everywhere, immediately
    await logAccess(req, rows[0].active ? 'admin_reactivate_user' : 'admin_deactivate_user', { detail: target.username });
    res.json(rows[0]);
  } catch (err) {
    logError('toggle user', err);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.post('/api/users/:id(\\d+)/reset-password', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = String(req.body.password || '');
  const problem = validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { rows } = await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2 RETURNING username',
      [hashPassword(password), id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await logAccess(req, 'admin_reset_password', { detail: rows[0].username });
    await logAccess(req, 'lockout_cleared', { username: rows[0].username, detail: 'unlocked by password reset' });
    res.json({ ok: true });
  } catch (err) {
    logError('reset password', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

app.get('/api/access-log', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const { rows } = await pool.query(
      `SELECT username, event, detail, path, ip, created_at FROM access_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    logError('access log list', err);
    res.status(500).json({ error: 'Failed to load security log' });
  }
});

// Static files are served only AFTER the sign-in check above.
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const WAIT_YELLOW_SECONDS = parseInt(process.env.WAIT_YELLOW_SECONDS || '300', 10);
const WAIT_RED_SECONDS = parseInt(process.env.WAIT_RED_SECONDS || '600', 10);

// ---------------------------------------------------------------------------
// Realtime: plain Server-Sent Events. No extra dependency, works from any
// browser via EventSource, and is one-directional which is all these
// screens need (server -> browser push on every change).
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/config', (req, res) => {
  res.json({ yellowSeconds: WAIT_YELLOW_SECONDS, redSeconds: WAIT_RED_SECONDS, stations: STATIONS, hipaaHosting: HIPAA_HOSTING, idleMinutes: SESSION_IDLE_MINUTES });
});

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

// Create a new visit (front desk: patient checks in / paperwork complete).
app.post('/api/visits', async (req, res) => {
  const raw = req.body.patient_id;
  const patientId = raw == null ? '' : String(raw).trim();
  if (patientId.length > 40) {
    return res.status(400).json({ error: 'Patient ID is too long (max 40 characters)' });
  }
  const firstNameCheck = cleanFirstName(req.body.patient_first_name);
  if (firstNameCheck.error) return res.status(400).json({ error: firstNameCheck.error });
  if (!patientId && !firstNameCheck.value) {
    return res.status(400).json({ error: 'Enter a first name or a Patient ID' });
  }
  try {
    // Guard against double-checking in the same patient (fat-fingered
    // duplicate entry, or a second staff member checking them in again
    // without noticing the first). If they already have an active visit,
    // point staff at editing that one instead of creating a duplicate.
    const { rows: existingRows } = !patientId ? { rows: [] } : await pool.query(
      `SELECT id, status FROM visits WHERE patient_id = $1 AND status NOT IN ('completed', 'cancelled', 'auto_closed') LIMIT 1`,
      [patientId]
    );
    if (existingRows[0]) {
      return res.status(409).json({
        error: `Patient ${patientId} already has an active visit (${STATUS_LABEL[existingRows[0].status] || existingRows[0].status}). Use the edit button to fix it instead of checking in again.`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO visits (patient_id, patient_first_name, status) VALUES ($1, $2, 'arrived') RETURNING *`,
      [patientId || null, firstNameCheck.value]
    );
    const visit = rows[0];
    await pool.query(
      `INSERT INTO status_events (visit_id, status) VALUES ($1, $2)`,
      [visit.id, visit.status]
    );
    broadcast('visits-changed', { reason: 'created', visitId: visit.id });
    res.status(201).json(visit);
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to create visit' });
  }
});

// The single generic transition endpoint. Every button in the app (front
// desk and operatory screens) calls this with an `action` name from
// lib/flow.js.
app.post('/api/visits/:id/transition', async (req, res) => {
  const visitId = parseInt(req.params.id, 10);
  const { action, operatory, role } = req.body;
  const transition = TRANSITIONS[action];

  if (!transition) {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  if (operatory && !VALID_OPERATORIES.includes(operatory)) {
    return res.status(400).json({ error: 'Unknown room' });
  }
  if (transition.requiresOperatory && !operatory) {
    return res.status(400).json({ error: 'operatory is required for this action' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: visitRows } = await client.query(
      'SELECT * FROM visits WHERE id = $1 FOR UPDATE',
      [visitId]
    );
    const visit = visitRows[0];
    if (!visit) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Visit not found' });
    }
    if (!transition.from.includes(visit.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Action "${action}" is not valid from status "${visit.status}"`,
      });
    }

    // No two active patients in the same operatory at once.
    if (action === 'assign_operatory') {
      const { rows: occupiedRows } = await client.query(
        `SELECT id FROM visits WHERE id != $1 AND operatory = $2 AND status IN ('with_assistant', 'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc') LIMIT 1`,
        [visitId, operatory]
      );
      if (occupiedRows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `${operatory} already has a patient in it` });
      }
    }

    // Stop a gap timer, if this transition closes one.
    if (transition.stopsGap) {
      const { rows: openGapRows } = await client.query(
        `SELECT * FROM gap_events
         WHERE visit_id = $1 AND gap_number = $2 AND ended_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [visitId, transition.stopsGap]
      );
      if (openGapRows[0]) {
        await client.query(
          `UPDATE gap_events
           SET ended_at = now(),
               duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int,
               ended_by_role = $2
           WHERE id = $1`,
          [openGapRows[0].id, cleanRole(role)]
        );
      }
    }

    // Start a new gap timer, if this transition opens one.
    if (transition.startsGap) {
      await client.query(
        `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, started_by_role)
         VALUES ($1, $2, $3, now(), $4)`,
        [visitId, transition.startsGap.number, transition.startsGap.waitingFor, cleanRole(role)]
      );
    }

    // Update visit status (+ operatory, + completed_at where relevant).
    const setParts = ['status = $2'];
    const params = [visitId, transition.to];
    let idx = 3;
    if (operatory) {
      setParts.push(`operatory = $${idx}`);
      params.push(operatory);
      idx += 1;
    }
    if (transition.completesVisit) {
      setParts.push('completed_at = now()');
    }
    const { rows: updatedRows } = await client.query(
      `UPDATE visits SET ${setParts.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );

    await client.query(
      `INSERT INTO status_events (visit_id, status) VALUES ($1, $2)`,
      [visitId, transition.to]
    );

    // Room turnover: the room needs cleaning once the visit is completed;
    // seating the next patient there clears the reminder.
    if (transition.to === 'completed' && visit.operatory) {
      await client.query(`INSERT INTO rooms (operatory, cleaning_since) VALUES ($1, now()) ON CONFLICT (operatory) DO UPDATE SET cleaning_since = now()`, [visit.operatory]);
    }
    if (action === 'assign_operatory') {
      await client.query(`UPDATE rooms SET cleaning_since = NULL WHERE operatory = $1`, [operatory]);
    }

    const details = `${STATUS_LABEL[visit.status]} → ${STATUS_LABEL[transition.to]}${operatory ? ` (${operatory})` : ''}`;
    await client.query(
      `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [visitId, updatedRows[0].patient_id, cleanRole(role), action, ACTION_LABEL[action] || action, details, req.user.display_name]
    );

    await client.query('COMMIT');
    broadcast('visits-changed', { reason: action, visitId });
    res.json(updatedRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Transition failed' });
  } finally {
    client.release();
  }
});

// Manual correction: fix a fat-fingered patient ID, jump the status
// directly, or reassign the operatory. Unlike /transition, this doesn't
// check the normal state-machine rules (staff are explicitly overriding),
// but it still closes/opens gap timers correctly and always writes an
// activity_log entry so it's clear who changed what.
app.post('/api/visits/:id/override', async (req, res) => {
  const visitId = parseInt(req.params.id, 10);
  let { patientId, status, operatory, treatmentFlag, firstName, role } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: visitRows } = await client.query('SELECT * FROM visits WHERE id = $1 FOR UPDATE', [visitId]);
    const visit = visitRows[0];
    if (!visit) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Visit not found' });
    }

    // Putting a patient who hasn't been pulled back yet into a room from the
    // edit panel means they've been pulled back: move them to "Pulled Back" so
    // the waiting clock stops, the room's screen shows them, and the room is
    // taken -- exactly what the Front Desk room buttons do.
    const PRE_ROOM_STATUSES = ['arrived', 'doing_paperwork', 'waiting_assistant'];
    const targetOp = operatory !== undefined ? (operatory || null) : visit.operatory;
    if (operatory !== undefined && targetOp && targetOp !== visit.operatory
        && PRE_ROOM_STATUSES.includes(status !== undefined ? status : visit.status)) {
      status = 'with_assistant';
    }
    if (status !== undefined && status !== visit.status && IN_ROOM_STATUSES.includes(status) && !targetOp) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pick a room for this patient first' });
    }
    if (targetOp && targetOp !== visit.operatory && IN_ROOM_STATUSES.includes(status !== undefined ? status : visit.status)) {
      await client.query(`UPDATE rooms SET cleaning_since = NULL WHERE operatory = $1`, [targetOp]);
    }

    const changes = [];
    let flagChanged = false;
    const setParts = [];
    const params = [visitId];
    let idx = 2;

    if (patientId !== undefined && (String(patientId).trim() || null) !== (visit.patient_id || null)) {
      const cleanId = String(patientId).trim() || null;
      if (cleanId && cleanId.length > 40) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Patient ID is too long (max 40 characters)' });
      }
      const { rows: dupeRows } = !cleanId ? { rows: [] } : await client.query(
        `SELECT id FROM visits WHERE id != $1 AND patient_id = $2 AND status NOT IN ('completed', 'cancelled', 'auto_closed') LIMIT 1`,
        [visitId, cleanId]
      );
      if (dupeRows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Patient ${cleanId} already has another active visit — check the ID and try again` });
      }
      changes.push(`Patient ID ${visit.patient_id || 'none'} → ${cleanId || 'none'}`);
      setParts.push(`patient_id = $${idx++}`);
      params.push(cleanId);
    }

    if (operatory !== undefined) {
      const newOp = operatory || null;
      if (newOp && !VALID_OPERATORIES.includes(newOp)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unknown room' });
      }
      if (newOp !== visit.operatory) {
        if (newOp) {
          const { rows: occupiedRows } = await client.query(
            `SELECT id FROM visits WHERE id != $1 AND operatory = $2 AND status IN ('with_assistant', 'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc') LIMIT 1`,
            [visitId, newOp]
          );
          if (occupiedRows[0]) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `${newOp} already has a patient in it` });
          }
        }
        changes.push(`Operatory ${visit.operatory || 'none'} → ${newOp || 'none'}`);
        setParts.push(`operatory = $${idx++}`);
        params.push(newOp);
      }
    }

    if (status !== undefined && !STATUS_OPTIONS.includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown status' });
    }
    // A patient leaving the chair any other way (cancelled, moved on) also
    // means the room needs cleaning.
    if (status !== undefined && status !== visit.status && visit.operatory
        && IN_ROOM_STATUSES.includes(visit.status) && !IN_ROOM_STATUSES.includes(status)) {
      await client.query(`INSERT INTO rooms (operatory, cleaning_since) VALUES ($1, now()) ON CONFLICT (operatory) DO UPDATE SET cleaning_since = now()`, [visit.operatory]);
    }
    if (status !== undefined && status !== visit.status) {
      const { rows: openGapRows } = await client.query(
        `SELECT * FROM gap_events WHERE visit_id = $1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
        [visitId]
      );
      if (openGapRows[0]) {
        await client.query(
          `UPDATE gap_events SET ended_at = now(), duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int, ended_by_role = $2 WHERE id = $1`,
          [openGapRows[0].id, cleanRole(role)]
        );
      }
      const gapInfo = GAP_FOR_STATUS[status];
      if (gapInfo) {
        await client.query(
          `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, started_by_role) VALUES ($1, $2, $3, now(), $4)`,
          [visitId, gapInfo.number, gapInfo.waitingFor, cleanRole(role)]
        );
      }
      changes.push(`Status ${STATUS_LABEL[visit.status] || visit.status} → ${STATUS_LABEL[status] || status}`);
      setParts.push(`status = $${idx++}`);
      params.push(status);
      setParts.push(`completed_at = ${status === 'completed' ? 'now()' : 'NULL'}`);
    }

    if (typeof treatmentFlag === 'boolean' && treatmentFlag !== visit.treatment_flag) {
      flagChanged = true;
      changes.push(treatmentFlag ? 'Flagged for treatment (longer visit expected)' : 'Treatment flag removed');
      setParts.push(`treatment_flag = $${idx++}`);
      params.push(treatmentFlag);
    }

    // The name itself is never written to the activity log — only that it changed.
    if (firstName !== undefined) {
      const cleaned = cleanFirstName(firstName);
      if (cleaned.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: cleaned.error });
      }
      if ((cleaned.value || null) !== (visit.patient_first_name || null)) {
        changes.push(cleaned.value ? 'First name updated' : 'First name removed');
        setParts.push(`patient_first_name = $${idx++}`);
        params.push(cleaned.value);
      }
    }

    const finalId = patientId !== undefined ? (String(patientId).trim() || null) : visit.patient_id;
    const finalName = firstName !== undefined ? (cleanFirstName(firstName).value || null) : visit.patient_first_name;
    if (!finalId && !finalName) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A patient needs a first name or a Patient ID' });
    }

    let updatedVisit = visit;
    if (setParts.length) {
      const { rows: updatedRows } = await client.query(
        `UPDATE visits SET ${setParts.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      updatedVisit = updatedRows[0];
    }

    if (changes.length) {
      const isCancel = status === 'cancelled';
      const isFlagOnly = !isCancel && changes.length === 1 && flagChanged;
      const action = isCancel ? 'cancel_visit' : isFlagOnly ? 'toggle_flag' : 'manual_edit';
      const label = isCancel
        ? ACTION_LABEL.cancel_visit
        : isFlagOnly
        ? (treatmentFlag ? 'Flagged for Treatment' : 'Treatment Flag Removed')
        : ACTION_LABEL.manual_edit;
      await client.query(
        `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [visitId, updatedVisit.patient_id, cleanRole(role), action, label, changes.join('; '), req.user.display_name]
      );
    }

    await client.query('COMMIT');
    broadcast('visits-changed', { reason: 'manual_edit', visitId });
    res.json(updatedVisit);
  } catch (err) {
    await client.query('ROLLBACK');
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Edit failed' });
  } finally {
    client.release();
  }
});

app.get('/api/activity-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { rows } = await pool.query(
      `SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
});

app.get('/api/visits/:id(\\d+)', async (req, res) => {
  try {
    await logAccess(req, 'view_visit', { detail: `visit ${req.params.id}` });
    const { rows } = await pool.query('SELECT * FROM visits WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load visit' });
  }
});

// All non-completed visits, with live wait/idle time computed server-side
// so every screen (front desk, operatory, dashboard, doctor queue) shares
// one source of truth.
async function fetchActiveVisits() {
  const { rows } = await pool.query(`
    SELECT
      v.id, v.patient_id, v.patient_first_name, v.operatory, v.status, v.started_at, v.treatment_flag,
      COALESCE(closed.total_seconds, 0)::int AS closed_idle_seconds,
      open.gap_number AS open_gap_number,
      open.waiting_for AS open_waiting_for,
      open.started_at AS open_started_at
    FROM visits v
    LEFT JOIN (
      SELECT visit_id, SUM(duration_seconds) AS total_seconds
      FROM gap_events
      WHERE ended_at IS NOT NULL
      GROUP BY visit_id
    ) closed ON closed.visit_id = v.id
    LEFT JOIN gap_events open
      ON open.visit_id = v.id AND open.ended_at IS NULL
    WHERE v.status NOT IN ('completed', 'cancelled', 'auto_closed')
    ORDER BY v.started_at ASC
  `);

  const now = Date.now();
  return rows.map((r) => {
    const currentWaitSeconds = r.open_started_at
      ? Math.max(0, Math.floor((now - new Date(r.open_started_at).getTime()) / 1000))
      : 0;
    return {
      id: r.id,
      patientId: r.patient_id,
      operatory: r.operatory,
      status: r.status,
      startedAt: r.started_at,
      treatmentFlag: r.treatment_flag,
      firstName: r.patient_first_name,
      inRoom: IN_ROOM_STATUSES.includes(r.status),
      waitingFor: r.open_waiting_for, // null if currently with a staff member
      currentWaitSeconds,
      totalIdleSeconds: r.closed_idle_seconds + currentWaitSeconds,
      nextAction: NEXT_ACTION[r.status] || null,
      tcNextAction: TC_NEXT_ACTION[r.status] || null,
      fullNextAction: FULL_NEXT_ACTION[r.status] || null,
      skipAction: SKIP_ACTION[r.status] || null,
    };
  });
}

app.get('/api/visits/active', async (req, res) => {
  try {
    res.json(await fetchActiveVisits());
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load active visits' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT operatory, cleaning_since FROM rooms WHERE cleaning_since IS NOT NULL`);
    res.json(rows.map((r) => ({ operatory: r.operatory, cleaningSince: r.cleaning_since })));
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

app.post('/api/rooms/:op/ready', async (req, res) => {
  const op = req.params.op;
  if (!VALID_OPERATORIES.includes(op)) return res.status(400).json({ error: 'Unknown room' });
  try {
    await pool.query(`UPDATE rooms SET cleaning_since = NULL WHERE operatory = $1`, [op]);
    await pool.query(
      `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details, performed_by)
       VALUES (NULL, NULL, $1, 'room_ready', 'Room Ready', $2, $3)`,
      [cleanRole(req.body.role), `${op} broken down and ready`, req.user.display_name]
    );
    broadcast('visits-changed', { reason: 'room_ready' });
    res.json({ ok: true });
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

app.get('/api/doctor-queue', async (req, res) => {
  try {
    const visits = await fetchActiveVisits();
    const queue = visits
      .filter((v) => v.status === 'waiting_doctor')
      .sort((a, b) => b.currentWaitSeconds - a.currentWaitSeconds);
    res.json(queue);
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load doctor queue' });
  }
});

app.get('/api/tc-queue', async (req, res) => {
  try {
    const visits = await fetchActiveVisits();
    const queue = visits
      .filter((v) => v.status === 'waiting_tc' || v.status === 'with_tc')
      .sort((a, b) => b.currentWaitSeconds - a.currentWaitSeconds);
    res.json(queue);
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to load TC queue' });
  }
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

function resolveRange(query) {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  switch (query.range) {
    case 'yesterday': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 1);
      return { start, end: startOfToday };
    }
    case 'last7': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 7);
      return { start, end: now };
    }
    case 'last30': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 30);
      return { start, end: now };
    }
    case 'custom': {
      const start = query.start ? new Date(query.start) : startOfToday;
      const end = query.end ? new Date(query.end) : now;
      return { start, end };
    }
    case 'today':
    default:
      return { start: startOfToday, end: now };
  }
}

app.get('/api/analytics', async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);

    const [
      byGap,
      overall,
      byGapOver10,
      allVisitsCount,
      nonCancelledCount,
      cancelledCount,
      worstGap,
      byDow,
      byHour,
      byOperatory,
    ] = await Promise.all([
      pool.query(
        `SELECT ge.gap_number, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds, COUNT(*) AS n
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status NOT IN ('cancelled', 'auto_closed')
         GROUP BY ge.gap_number ORDER BY ge.gap_number`,
        [start, end]
      ),
      pool.query(
        `SELECT
           AVG(total)::numeric(10,1) AS avg_total,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY total)::numeric(10,1) AS median_total,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY total)::numeric(10,1) AS p90_total,
           COUNT(*) AS visit_count
         FROM (
           SELECT ge.visit_id, SUM(ge.duration_seconds) AS total
           FROM gap_events ge
           JOIN visits v ON v.id = ge.visit_id
           WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.status NOT IN ('cancelled', 'auto_closed')
           GROUP BY ge.visit_id
         ) t`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT ge.visit_id) AS n
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2
           AND v.status NOT IN ('cancelled', 'auto_closed') AND ge.duration_seconds > 600`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2 AND status NOT IN ('cancelled', 'auto_closed')`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2 AND status = 'cancelled'`,
        [start, end]
      ),
      pool.query(
        `SELECT ge.visit_id, v.patient_id, v.operatory, ge.gap_number, ge.waiting_for, ge.duration_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.status NOT IN ('cancelled', 'auto_closed')
         ORDER BY ge.duration_seconds DESC LIMIT 1`,
        [start, end]
      ),
      pool.query(
        `SELECT EXTRACT(DOW FROM ge.started_at)::int AS dow, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status NOT IN ('cancelled', 'auto_closed')
         GROUP BY dow ORDER BY dow`,
        [start, end]
      ),
      pool.query(
        `SELECT EXTRACT(HOUR FROM ge.started_at)::int AS hour, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status NOT IN ('cancelled', 'auto_closed')
         GROUP BY hour ORDER BY hour`,
        [start, end]
      ),
      pool.query(
        `SELECT v.operatory, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.operatory IS NOT NULL AND v.status NOT IN ('cancelled', 'auto_closed')
         GROUP BY v.operatory ORDER BY v.operatory`,
        [start, end]
      ),
    ]);

    // "Visits" for the >10min-gap percentage means visits that actually had
    // timed gaps to judge (cancelled/no-show visits are reported on
    // separately below, not blended into wait-time stats).
    const totalVisits = parseInt(nonCancelledCount.rows[0]?.n || '0', 10);
    const visitsOver10 = parseInt(byGapOver10.rows[0]?.n || '0', 10);
    const allVisits = parseInt(allVisitsCount.rows[0]?.n || '0', 10);
    const cancelled = parseInt(cancelledCount.rows[0]?.n || '0', 10);
    const { rows: autoRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2 AND status = 'auto_closed'`,
      [start, end]
    );
    const autoClosed = parseInt(autoRows[0]?.n || '0', 10);

    res.json({
      range: { start, end },
      averageByGap: byGap.rows,
      overall: {
        averageTotalIdleSeconds: overall.rows[0]?.avg_total || null,
        medianIdleSeconds: overall.rows[0]?.median_total || null,
        p90IdleSeconds: overall.rows[0]?.p90_total || null,
        visitsWithCompletedGaps: parseInt(overall.rows[0]?.visit_count || '0', 10),
      },
      totalVisits,
      visitsWithAnyGapOver10Min: visitsOver10,
      percentVisitsWithGapOver10Min:
        totalVisits > 0 ? Number(((visitsOver10 / totalVisits) * 100).toFixed(1)) : 0,
      // No-show / cancellation tracking — a real practice-performance metric
      // in its own right, kept separate from the wait-time stats above.
      allVisitsStarted: allVisits,
      cancelledVisits: cancelled,
      autoClosedVisits: autoClosed,
      cancelledRate: allVisits > 0 ? Number(((cancelled / allVisits) * 100).toFixed(1)) : 0,
      worstGap: worstGap.rows[0] || null,
      averageByDayOfWeek: byDow.rows,
      averageByHourOfDay: byHour.rows,
      averageByOperatory: byOperatory.rows,
    });
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// Daily/weekly/monthly look-back, so the practice can see whether wait
// times are trending better or worse over time (not just a single range).
app.get('/api/analytics/trend', async (req, res) => {
  const granularity = ['daily', 'weekly', 'monthly'].includes(req.query.granularity)
    ? req.query.granularity
    : 'daily';
  const truncUnit = granularity === 'daily' ? 'day' : granularity === 'weekly' ? 'week' : 'month';
  const periodsBack = granularity === 'daily' ? 14 : 12;
  const stepInterval = granularity === 'daily' ? '1 day' : granularity === 'weekly' ? '1 week' : '1 month';

  try {
    const { rows } = await pool.query(
      `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($1, now()) - ($3::interval * ($2 - 1)),
          date_trunc($1, now()),
          $3::interval
        ) AS period_start
      ),
      visit_totals AS (
        SELECT v.id AS visit_id, v.started_at, SUM(ge.duration_seconds) AS total_seconds
        FROM visits v
        JOIN gap_events ge ON ge.visit_id = v.id AND ge.ended_at IS NOT NULL
        WHERE v.status NOT IN ('cancelled', 'auto_closed')
        GROUP BY v.id, v.started_at
      )
      SELECT
        p.period_start,
        COUNT(vt.visit_id) AS visit_count,
        AVG(vt.total_seconds)::numeric(10,1) AS avg_seconds
      FROM periods p
      LEFT JOIN visit_totals vt
        ON date_trunc($1, vt.started_at) = p.period_start
      GROUP BY p.period_start
      ORDER BY p.period_start
      `,
      [truncUnit, periodsBack, stepInterval]
    );

    res.json({
      granularity,
      periods: rows.map((r) => ({
        periodStart: r.period_start,
        avgTotalIdleSeconds: r.avg_seconds,
        visitCount: parseInt(r.visit_count, 10),
      })),
    });
  } catch (err) {
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Failed to compute trend' });
  }
});

// ---------------------------------------------------------------------------
// Page routes.
// ---------------------------------------------------------------------------
app.get('/operatory', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'operatory.html'));
});
app.get('/my-room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-room.html'));
});
// Old per-room bookmarks (/op/1 .. /op/6) still work, just land on the
// shared board that shows all six at once.
app.get('/op/:num', (req, res) => {
  res.redirect(`/operatory?room=OP${parseInt(req.params.num, 10) || 1}`);
});
app.get('/tc-queue', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tc-queue.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/doctor-queue', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'doctor-queue.html'));
});
app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});
app.get('/activity-log', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'activity-log.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/station', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'station.html'));
});
app.get('/change-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Last-resort error handler (e.g. malformed or oversized requests): log the
// type only, and never send stack traces or internals to the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logError(`${req.method} ${req.path}`, err);
  const message = status === 400 ? 'Bad request' : status === 413 ? 'Request too large' : 'Something went wrong';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

// End-of-day close-out: a visit nobody completed (forgotten Complete tap)
// is closed AUTO_CLOSE_AFTER_HOURS after check-in, marked auto_closed, and
// left out of every wait-time statistic so a runaway timer can't skew them.
async function autoCloseForgottenVisits() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, patient_id FROM visits
       WHERE status NOT IN ('completed', 'cancelled', 'auto_closed')
         AND started_at < now() - ($1::int * interval '1 hours')
       FOR UPDATE`,
      [AUTO_CLOSE_AFTER_HOURS]
    );
    for (const v of rows) {
      await client.query(
        `UPDATE gap_events SET ended_at = now(), duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int, ended_by_role = 'System'
         WHERE visit_id = $1 AND ended_at IS NULL`,
        [v.id]
      );
      await client.query(`UPDATE visits SET status = 'auto_closed', completed_at = now() WHERE id = $1`, [v.id]);
      await client.query(`INSERT INTO status_events (visit_id, status) VALUES ($1, 'auto_closed')`, [v.id]);
      await client.query(
        `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details, performed_by)
         VALUES ($1, $2, 'System', 'auto_close', 'Auto-Closed', $3, 'Automatic close-out')`,
        [v.id, v.patient_id, `Not completed within ${AUTO_CLOSE_AFTER_HOURS} hours; left out of wait-time stats`]
      );
    }
    await client.query('COMMIT');
    if (rows.length) {
      console.log(`[auto-close] Closed ${rows.length} forgotten visit(s).`);
      broadcast('visits-changed', { reason: 'auto_close' });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logError('auto-close', err);
  } finally {
    client.release();
  }
}

// Minimum-necessary data: first names are only needed while the patient is
// in the building, so they're cleared from finished visits after
// NAME_RETENTION_HOURS (and from any visit older than 3 days, in case one
// was never closed out). Wait-time analytics are unaffected.
async function runHousekeeping() {
  await autoCloseForgottenVisits();
  try {
    const { rowCount } = await pool.query(
      `UPDATE visits SET patient_first_name = NULL
       WHERE patient_first_name IS NOT NULL
         AND (
           (status IN ('completed', 'cancelled', 'auto_closed') AND COALESCE(completed_at, started_at) < now() - ($1::int * interval '1 hours'))
           OR started_at < now() - interval '3 days'
         )`,
      [NAME_RETENTION_HOURS]
    );
    if (rowCount) console.log(`[retention] Cleared first names from ${rowCount} finished visit(s).`);
    await pool.query(
      `DELETE FROM sessions
       WHERE last_activity_at < now() - ($1::int * interval '1 minutes')
          OR created_at < now() - ($2::int * interval '1 hours')`,
      [SESSION_IDLE_MINUTES, SESSION_MAX_HOURS]
    );
  } catch (err) {
    logError('housekeeping', err);
  }
}
setInterval(runHousekeeping, 60 * 60 * 1000);
runHousekeeping();

app.listen(PORT, () => {
  console.log(`Dental Flow running at http://localhost:${PORT}`);
});
