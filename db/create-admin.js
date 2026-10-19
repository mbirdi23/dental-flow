// Creates (or resets) the first admin account. Run once from Render's Shell
// after `npm run db:init`. Every other account is created from the Admin
// page inside the app.
//
// Usage:   npm run create-admin -- <username> "<password>" "<Full Name>"
// Example: npm run create-admin -- drbirdi "a strong password 2026" "Dr Birdi"
const pool = require('./pool');
const { hashPassword, validatePassword, normalizeUsername, validateUsername } = require('../lib/auth');

async function main() {
  const [rawUsername, password, ...nameParts] = process.argv.slice(2);
  const username = normalizeUsername(rawUsername);
  const displayName = nameParts.join(' ').trim();

  if (!rawUsername || !password || !displayName) {
    console.error('Usage: npm run create-admin -- <username> "<password>" "<Full Name>"');
    process.exit(1);
  }
  const usernameProblem = validateUsername(username);
  if (usernameProblem) { console.error(usernameProblem); process.exit(1); }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) { console.error(passwordProblem); process.exit(1); }

  await pool.query(
    `INSERT INTO users (username, password_hash, display_name, is_admin, active, must_change_password)
     VALUES ($1, $2, $3, true, true, false)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           is_admin = true,
           active = true,
           must_change_password = false`,
    [username, hashPassword(password), displayName]
  );
  await pool.query(
    `INSERT INTO access_log (username, event, detail) VALUES ($1, 'lockout_cleared', 'create-admin command')`,
    [username]
  );
  console.log(`Admin account "${username}" is ready. Sign in at /login.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to create admin account. Did you run `npm run db:init` first? Error code:', err.code || err.name);
  process.exit(1);
});
