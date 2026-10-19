// Unit tests for lib/auth.js — no database needed. Run: node test/auth.js
const assert = require('assert');
const a = require('../lib/auth');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (err) { console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`); failed++; }
}

console.log('\nPasswords\n');
test('correct password verifies, wrong one does not', () => {
  const stored = a.hashPassword('brushTwice2026');
  assert.strictEqual(a.verifyPassword('brushTwice2026', stored), true);
  assert.strictEqual(a.verifyPassword('brushtwice2026', stored), false);
});
test('passwords are never stored in plain text, and salting works', () => {
  const x = a.hashPassword('samePassword1');
  const y = a.hashPassword('samePassword1');
  assert.ok(!x.includes('samePassword1'));
  assert.notStrictEqual(x, y);
});
test('malformed stored values fail safely', () => {
  for (const bad of ['', null, undefined, 'nocolon', 'salt:zz-not-hex']) assert.strictEqual(a.verifyPassword('x', bad), false);
});
test('password rules: 10+ characters with a letter and a number', () => {
  assert.ok(a.validatePassword('short1'));
  assert.ok(a.validatePassword('allletterslong'));
  assert.ok(a.validatePassword('1234567890'));
  assert.strictEqual(a.validatePassword('flossdaily99'), null);
});
test('usernames are normalised and validated', () => {
  assert.strictEqual(a.normalizeUsername('  JSmith '), 'jsmith');
  assert.strictEqual(a.validateUsername('jsmith'), null);
  assert.ok(a.validateUsername('j'));
  assert.ok(a.validateUsername('has space'));
});

console.log('\nSessions\n');
test('session tokens are random, and only their hash is stored', () => {
  const t1 = a.generateSessionToken();
  const t2 = a.generateSessionToken();
  assert.strictEqual(t1.length, 64);
  assert.notStrictEqual(t1, t2);
  assert.strictEqual(a.hashToken(t1), a.hashToken(t1));
  assert.notStrictEqual(a.hashToken(t1), t1);
});
const opts = { idleMs: 15 * 60000, absoluteMs: 12 * 3600000 };
const now = Date.parse('2026-10-19T12:00:00Z');
test('a recently active session is valid', () => {
  assert.strictEqual(a.sessionState({ created_at: new Date(now - 3600000), last_activity_at: new Date(now - 60000) }, now, opts), 'valid');
});
test('16 minutes without activity triggers automatic logoff', () => {
  assert.strictEqual(a.sessionState({ created_at: new Date(now - 3600000), last_activity_at: new Date(now - 16 * 60000) }, now, opts), 'idle');
});
test('sessions end after 12 hours even if active', () => {
  assert.strictEqual(a.sessionState({ created_at: new Date(now - 13 * 3600000), last_activity_at: new Date(now) }, now, opts), 'expired');
});

console.log('\nFailed sign-in lockout\n');
const lock = { maxAttempts: 5, windowMs: 15 * 60000 };
test('4 failures do not lock the account', () => {
  assert.strictEqual(a.lockoutRemainingMs([1, 2, 3, 4].map((m) => now - m * 60000), now, lock), 0);
});
test('5 failures within 15 minutes lock it', () => {
  const remaining = a.lockoutRemainingMs([1, 2, 3, 4, 5].map((m) => now - m * 60000), now, lock);
  assert.strictEqual(remaining, 10 * 60000);
});
test('old failures outside the window do not count', () => {
  assert.strictEqual(a.lockoutRemainingMs([20, 21, 22, 23, 24].map((m) => now - m * 60000), now, lock), 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
