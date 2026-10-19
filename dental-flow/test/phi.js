// Unit tests for lib/phi.js — no database needed. Run: node test/phi.js
const assert = require('assert');
const { cleanFirstName, safeErrorSummary } = require('../lib/phi');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (err) { console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`); failed++; }
}

console.log('\nFirst names\n');
test('normal names are accepted and tidied', () => {
  assert.strictEqual(cleanFirstName('  Sarah ').value, 'Sarah');
  assert.strictEqual(cleanFirstName('Mary  Jane').value, 'Mary Jane');
});
test("accents, hyphens and apostrophes are fine (José, Anne-Marie, O'Neil, Siobhán)", () => {
  for (const n of ['José', 'Anne-Marie', "O'Neil", 'Siobhán', 'Zoë']) assert.strictEqual(cleanFirstName(n).value, n);
});
test('blank means no name', () => {
  assert.strictEqual(cleanFirstName('').value, null);
  assert.strictEqual(cleanFirstName(null).value, null);
  assert.strictEqual(cleanFirstName(undefined).value, null);
});
test('numbers, symbols, and overly long values are rejected', () => {
  assert.ok(cleanFirstName('Sarah1').error);
  assert.ok(cleanFirstName('<script>').error);
  assert.ok(cleanFirstName('A'.repeat(41)).error);
});

console.log('\nServer error logs never contain patient data\n');
test('a database error that echoes a name is logged without the name', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint: (patient_first_name)=(Sarah)'), {
    code: '23505', detail: 'Key (patient_first_name)=(Sarah) already exists.', where: "parameter $2 = 'Sarah'", constraint: 'example',
  });
  const line = safeErrorSummary(err);
  assert.ok(!line.includes('Sarah'), line);
  assert.ok(line.includes('23505'));
});
test('ordinary code errors still say what kind of error and where', () => {
  const line = safeErrorSummary(new TypeError('Cannot read properties of undefined (reading Sarah)'));
  assert.ok(!line.includes('Sarah'), line);
  assert.ok(line.includes('TypeError'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
