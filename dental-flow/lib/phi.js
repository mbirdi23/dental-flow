// Helpers for handling the one piece of patient-identifying information the
// app stores (an optional first name), plus error logging that never prints
// data values — so a patient name can't end up in Render's server logs.

// Returns { value } (null when blank) or { error }.
function cleanFirstName(raw) {
  if (raw === undefined || raw === null) return { value: null };
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return { value: null };
  if (s.length > 40) return { error: 'First name is too long (max 40 characters)' };
  if (!/^[\p{L}][\p{L}\p{M} '’.-]*$/u.test(s)) {
    return { error: 'First name can only contain letters, spaces, hyphens, apostrophes and periods' };
  }
  return { value: s };
}

// Database errors often echo the values involved (e.g. "Key (name)=(Sarah)
// already exists"), so this keeps only the error *type* and the code
// location — never err.message, err.detail or err.where.
function safeErrorSummary(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.routine) parts.push(`routine=${err.routine}`);
  if (err.table) parts.push(`table=${err.table}`);
  if (err.column) parts.push(`column=${err.column}`);
  if (err.constraint) parts.push(`constraint=${err.constraint}`);
  if (!err.code && err.name) parts.push(`type=${err.name}`);
  // Skip the first stack line: it repeats the message.
  const frames = String(err.stack || '')
    .split('\n')
    .slice(1, 4)
    .map((line) => line.trim())
    .filter(Boolean);
  if (frames.length) parts.push(`at ${frames.join(' | ')}`);
  return parts.join(' ') || 'unknown error';
}

function logError(context, err) {
  console.error(`[error] ${context} — ${safeErrorSummary(err)}`);
}

module.exports = { cleanFirstName, safeErrorSummary, logError };
