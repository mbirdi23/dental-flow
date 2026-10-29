// Security tests. Two kinds:
//  1. Attack inputs against the real sign-in rules (lib/auth.js).
//  2. Checks over the source code for mistakes that let people in or let
//     injected code run (so a future edit can't quietly reintroduce them).
// Run with: node test/security.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isPublicPath, verifyPassword, hashPassword, sessionState, lockoutRemainingMs } = require('../lib/auth');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const publicFiles = fs.readdirSync(path.join(root, 'public'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => ['public/' + f, fs.readFileSync(path.join(root, 'public', f), 'utf8')])
  .concat([['public/js/common.js', fs.readFileSync(path.join(root, 'public/js/common.js'), 'utf8')]]);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (err) { console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`); failed++; }
}

console.log('\nGetting past the sign-in page\n');
test('only the sign-in page, sign-in API and the site’s CSS/JS are reachable without signing in', () => {
  for (const p of ['/login', '/login.html', '/api/login', '/css/style.css', '/js/common.js']) assert.strictEqual(isPublicPath(p), true, p);
});
test('every page and data endpoint requires signing in', () => {
  for (const p of ['/', '/index.html', '/admin', '/admin.html', '/operatory', '/my-room', '/dashboard', '/analytics', '/activity-log',
    '/api/visits/active', '/api/users', '/api/access-log', '/api/stream', '/api/config', '/api/me', '/api/visits', '/api/logout']) {
    assert.strictEqual(isPublicPath(p), false, p);
  }
});
test('path tricks don’t sneak past the check ( .. , encoding, backslashes, case, trailing slash)', () => {
  for (const p of ['/css/../api/visits/active', '/js/..%2fapi/users', '/css/%2e%2e/admin.html', '/css\\..\\admin.html',
    '/LOGIN', '/API/login', '/Api/Login', '/login/', '/api/login/', '//api/login', '/login/../api/users',
    '/css/style.css/../../api/users', '/js/', '/css/x.html', '/js/common.js?x=/../api', '/js/common.json']) {
    assert.strictEqual(isPublicPath(p), false, p);
  }
});
test('the sign-in check runs before any page, file or data route', () => {
  const gate = server.indexOf('if (isPublicPath(req.path)) return next();');
  assert.ok(gate > 0, 'sign-in gate not found');
  for (const marker of ["express.static(", "app.get('/api/visits/active'", "app.post('/api/visits'", "app.get('/api/stream'", "app.get('/api/users'"]) {
    const at = server.indexOf(marker);
    assert.ok(at > gate, `${marker} is registered before the sign-in check`);
  }
});
test('staff-account and security-log endpoints are admin-only', () => {
  const routes = server.match(/app\.(get|post)\('\/api\/(users|access-log)[^\n]*/g) || [];
  assert.ok(routes.length >= 5, 'expected the admin routes');
  for (const r of routes) assert.ok(r.includes('requireAdmin'), r);
  assert.ok(/app\.get\('\/admin', requireAdmin/.test(server), 'admin page route must require admin');
});

console.log('\nPasswords and sessions\n');
test('a guessed or empty password never matches', () => {
  const stored = hashPassword('RealPassword2026');
  for (const guess of ['', ' ', 'realpassword2026', 'RealPassword2026 ', 'password', stored]) assert.strictEqual(verifyPassword(guess, stored), false, guess);
});
test('stolen or expired session cookies stop working', () => {
  const now = Date.now();
  assert.strictEqual(sessionState(null, now, { idleMs: 900000, absoluteMs: 43200000 }), 'missing');
  assert.strictEqual(sessionState({ created_at: new Date(now - 13 * 3600000), last_activity_at: new Date(now) }, now, { idleMs: 900000, absoluteMs: 43200000 }), 'expired');
});
test('session cookie can’t be read by page scripts, is HTTPS-only on Render, and isn’t sent from other sites', () => {
  assert.ok(/httpOnly: true/.test(server));
  assert.ok(/secure: IS_PRODUCTION/.test(server));
  assert.ok(/sameSite: 'strict'/.test(server));
});
test('only a hash of each session token is stored', () => {
  assert.ok(/INSERT INTO sessions \(token_hash/.test(server));
  assert.ok(!/INSERT INTO sessions \(token[,\s]/.test(server));
});
test('password hashes are never sent to the browser', () => {
  const listUsers = server.slice(server.indexOf("app.get('/api/users'"), server.indexOf("app.post('/api/users'"));
  assert.ok(!listUsers.includes('password_hash') && !listUsers.includes('SELECT *'), 'GET /api/users must not select password_hash');
});
test('repeated guessing gets locked out, and the lock can be cleared by an admin', () => {
  const now = Date.now();
  assert.ok(lockoutRemainingMs([1, 2, 3, 4, 5].map((m) => now - m * 60000), now, { maxAttempts: 5, windowMs: 900000 }) > 0);
  assert.ok(server.includes("'lockout_cleared'") && server.includes('LOGIN_MAX_FAILURES_PER_NETWORK'));
});

console.log('\nInjected code and database attacks\n');
test('no database query is built by pasting in values (SQL injection)', () => {
  const queries = server.match(/query\(\s*`[^`]*`/g) || [];
  assert.ok(queries.length > 20, 'expected to find the queries');
  const allowed = new Set(["setParts.join(', ')"]);
  for (const q of queries) {
    for (const [, expr] of q.matchAll(/\$\{([^}]*)\}/g)) assert.ok(allowed.has(expr.trim()), `value pasted into SQL: \${${expr}}`);
  }
  for (const part of server.match(/setParts\.push\(`[^`]*`\)/g) || []) {
    assert.ok(/^setParts\.push\(`[a-z_]+ = (\$\$\{idx(\+\+)?\}|\$\{status === 'completed' \? 'now\(\)' : 'NULL'\})`\)$/.test(part), part);
  }
});
test('no patient or staff text is placed inside inline click handlers (cross-site scripting)', () => {
  const allowedInQuotes = new Set(['op', 'next.action', 'skip.action', 'v.tcNextAction.action']);
  for (const [file, src] of publicFiles) {
    for (const [handler] of src.matchAll(/\bon[a-z]+="[^"]*"/g)) {
      for (const [, expr] of handler.matchAll(/'\$\{([^}]*)\}'/g)) {
        assert.ok(allowedInQuotes.has(expr.trim()), `${file}: text inserted into ${handler}`);
      }
    }
  }
});
test('rooms, statuses and station names from the browser are checked against fixed lists', () => {
  assert.ok(server.includes('VALID_OPERATORIES.includes(operatory)') && server.includes('VALID_OPERATORIES.includes(newOp)'));
  assert.ok(server.includes('STATUS_OPTIONS.includes(status)'));
  assert.ok(!/role \|\| /.test(server), 'station name used without checking');
});

console.log('\nOther protections\n');
test('security headers are set on every response', () => {
  for (const h of ['X-Frame-Options', 'X-Content-Type-Options', 'Strict-Transport-Security', 'Content-Security-Policy', 'Referrer-Policy']) assert.ok(server.includes(`'${h}'`), h);
  assert.ok(server.includes("frame-ancestors 'none'") && server.includes("connect-src 'self'"));
});
test('changes sent from another website are refused', () => {
  assert.ok(/originHost !== req\.headers\.host/.test(server));
});
test('errors never send internals or stack traces to the browser', () => {
  assert.ok(server.includes("app.set('env', 'production')"));
  assert.ok(/app\.use\(\(err, req, res, next\)/.test(server));
  assert.ok(!/res\.[a-z]+\([^)]*err\.(message|stack)/.test(server), 'an error message is sent to the browser');
});
test('patient data is never cached by the browser and the server hides its software', () => {
  assert.ok(server.includes("res.set('Cache-Control', 'no-store')"));
  assert.ok(server.includes("app.disable('x-powered-by')"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
