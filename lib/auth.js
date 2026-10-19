// Authentication helpers. Built only on Node's built-in `crypto` module,
// so there's no new npm dependency that could fail to install on deploy.

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD_LENGTH = 10;

// Returns "saltHex:hashHex". A fresh random salt every time, so two staff
// members with the same password never produce the same stored value.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

// Timing-safe comparison; never throws on malformed stored values.
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  } catch (e) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Only a SHA-256 of each session token is stored in the database, so a
// copy of the database can't be used to sign in as a staff member.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Returns an error message, or null if the password is acceptable.
function validatePassword(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must include at least one letter and one number';
  return null;
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function validateUsername(u) {
  if (!u) return 'Username is required';
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) {
    return 'Username must be 3–40 characters using letters, numbers, dots, dashes or underscores';
  }
  return null;
}

// A session ends after `idleMs` with no real user activity (automatic
// logoff) or after `absoluteMs` no matter what. Returns 'valid', 'idle',
// 'expired' or 'missing'.
function sessionState(session, nowMs, { idleMs, absoluteMs }) {
  if (!session) return 'missing';
  const created = new Date(session.created_at).getTime();
  const lastActive = new Date(session.last_activity_at).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(lastActive)) return 'missing';
  if (nowMs - created > absoluteMs) return 'expired';
  if (nowMs - lastActive > idleMs) return 'idle';
  return 'valid';
}

// After `maxAttempts` failed sign-ins within `windowMs`, the username is
// locked until the oldest of those failures ages out of the window.
// Returns how many milliseconds remain on the lock (0 = not locked).
function lockoutRemainingMs(failureTimesMs, nowMs, { maxAttempts, windowMs }) {
  const recent = failureTimesMs.filter((t) => nowMs - t < windowMs).sort((a, b) => a - b);
  if (recent.length < maxAttempts) return 0;
  const oldestCounted = recent[recent.length - maxAttempts];
  return Math.max(0, oldestCounted + windowMs - nowMs);
}

// The only paths reachable without signing in: the sign-in page/API and the
// site's own CSS/JS. Anything odd ("..", encoded characters, backslashes,
// different capitalisation, trailing slashes) is NOT public, so it falls
// through to the sign-in check.
const PUBLIC_EXACT = new Set(['/login', '/login.html', '/api/login', '/favicon.ico']);
function isPublicPath(p) {
  if (typeof p !== 'string' || p.includes('..') || p.includes('%') || p.includes('\\')) return false;
  if (PUBLIC_EXACT.has(p)) return true;
  return /^\/(css|js)\/[A-Za-z0-9._-]+\.(css|js)$/.test(p);
}

module.exports = {
  isPublicPath,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  validatePassword,
  normalizeUsername,
  validateUsername,
  sessionState,
  lockoutRemainingMs,
};
