// Simulates the SQL layer server.js wraps around lib/flow.js, using an
// in-memory "database" with the same shape as the Postgres tables. This
// imports the REAL lib/flow.js (the same module server.js uses) so the
// state-machine rules under test are the actual production rules, not a
// re-implementation of them. What this can't verify is raw SQL syntax —
// that was checked by careful manual review of server.js instead, since
// this sandbox has no network access to install `pg` / run Postgres.
//
// Run with: node test/simulate.js

const assert = require('assert');
const { TRANSITIONS, NEXT_ACTION, TC_NEXT_ACTION, FULL_NEXT_ACTION, STATUS_LABEL, ACTION_LABEL, GAP_FOR_STATUS } = require('../lib/flow');
const IN_ROOM = ['with_assistant', 'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc'];

let now = 1000000; // fake clock, in ms, advanced manually so tests are deterministic
function clockNow() { return now; }
function advance(seconds) { now += seconds * 1000; }

function freshDb() {
  return { visits: new Map(), gapEvents: new Map(), activityLog: [], nextVisitId: 1, nextGapId: 1, nextLogId: 1 };
}

function findOpenGap(db, visitId) {
  for (const g of db.gapEvents.values()) {
    if (g.visitId === visitId && g.endedAt == null) return g;
  }
  return null;
}

function isOperatoryOccupied(db, visitId, operatory) {
  for (const v of db.visits.values()) {
    if (v.id !== visitId && v.operatory === operatory && IN_ROOM.includes(v.status)) return true;
  }
  return false;
}

function isPatientAlreadyActive(db, patientId) {
  for (const v of db.visits.values()) {
    if (v.patientId === patientId && v.status !== 'completed' && v.status !== 'cancelled') return true;
  }
  return false;
}

// Check-in only gets a patient to "Doing Paperwork" — attended, no timer.
// This matches the real app exactly: Front Desk's check-in button calls
// `start_paperwork`, and a separate "Done — Send to Waiting Room" button
// calls `ready_for_assistant` once paperwork's finished.
function checkIn(db, patientId, role) {
  if (isPatientAlreadyActive(db, patientId)) {
    throw new Error(`Patient ${patientId} already has an active visit`);
  }
  const id = db.nextVisitId++;
  const visit = { id, patientId, operatory: null, status: 'arrived', startedAt: clockNow(), completedAt: null, treatmentFlag: false };
  db.visits.set(id, visit);
  transition(db, id, 'start_paperwork', { role });
  return visit;
}

// Convenience for tests that don't care about the paperwork stage itself
// and just want a patient sitting in the Waiting Room with Gap 1 running.
function checkInAndReachWaitingRoom(db, patientId, role) {
  const v = checkIn(db, patientId, role);
  transition(db, v.id, 'ready_for_assistant', { role });
  return v;
}

function transition(db, visitId, action, extra = {}) {
  const t = TRANSITIONS[action];
  if (!t) throw new Error(`Unknown action: ${action}`);
  const visit = db.visits.get(visitId);
  if (!visit) throw new Error('Visit not found');
  if (!t.from.includes(visit.status)) {
    throw new Error(`Action "${action}" is not valid from status "${visit.status}"`);
  }
  if (t.requiresOperatory && !extra.operatory) throw new Error('operatory is required for this action');
  if (action === 'assign_operatory' && isOperatoryOccupied(db, visitId, extra.operatory)) {
    throw new Error(`${extra.operatory} already has a patient in it`);
  }

  if (t.stopsGap) {
    const open = findOpenGap(db, visitId);
    if (open && open.gapNumber === t.stopsGap) {
      open.endedAt = clockNow();
      open.durationSeconds = Math.round((open.endedAt - open.startedAt) / 1000);
      open.endedByRole = extra.role || null;
    }
  }
  if (t.startsGap) {
    const id = db.nextGapId++;
    db.gapEvents.set(id, {
      id, visitId, gapNumber: t.startsGap.number, waitingFor: t.startsGap.waitingFor,
      startedAt: clockNow(), endedAt: null, durationSeconds: null, startedByRole: extra.role || null,
    });
  }

  visit.status = t.to;
  if (extra.operatory) visit.operatory = extra.operatory;
  if (t.completesVisit) visit.completedAt = clockNow();

  const details = `${STATUS_LABEL[visit.status] || visit.status}`;
  db.activityLog.push({
    id: db.nextLogId++, visitId, patientId: visit.patientId, station: extra.role || 'Unknown',
    action, label: ACTION_LABEL[action] || action, details, createdAt: clockNow(),
  });
  return visit;
}

function override(db, visitId, updates, role) {
  const visit = db.visits.get(visitId);
  if (!visit) throw new Error('Visit not found');
  const targetOp = updates.operatory !== undefined ? (updates.operatory || null) : visit.operatory;
  if (updates.operatory !== undefined && targetOp && targetOp !== visit.operatory
      && ['arrived', 'doing_paperwork', 'waiting_assistant'].includes(updates.status !== undefined ? updates.status : visit.status)) {
    updates = { ...updates, status: 'with_assistant' };
  }
  if (updates.status !== undefined && updates.status !== visit.status && IN_ROOM.includes(updates.status) && !targetOp) {
    throw new Error('Pick a room for this patient first');
  }
  const changes = [];
  let flagChanged = false;

  if (updates.patientId !== undefined && updates.patientId.trim() && updates.patientId.trim() !== visit.patientId) {
    const cleanId = updates.patientId.trim();
    if (isPatientAlreadyActive(db, cleanId)) {
      throw new Error(`Patient ${cleanId} already has another active visit`);
    }
    changes.push(`Patient ID ${visit.patientId} → ${cleanId}`);
    visit.patientId = cleanId;
  }

  if (updates.operatory !== undefined) {
    const newOp = updates.operatory || null;
    if (newOp && newOp !== visit.operatory && isOperatoryOccupied(db, visitId, newOp)) {
      throw new Error(`${newOp} already has a patient in it`);
    }
    if (newOp !== visit.operatory) {
      changes.push(`Operatory ${visit.operatory || 'none'} → ${newOp || 'none'}`);
      visit.operatory = newOp;
    }
  }

  if (updates.status !== undefined && updates.status !== visit.status) {
    const open = findOpenGap(db, visitId);
    if (open) {
      open.endedAt = clockNow();
      open.durationSeconds = Math.round((open.endedAt - open.startedAt) / 1000);
      open.endedByRole = role || 'Unknown';
    }
    const gapInfo = GAP_FOR_STATUS[updates.status];
    if (gapInfo) {
      const id = db.nextGapId++;
      db.gapEvents.set(id, {
        id, visitId, gapNumber: gapInfo.number, waitingFor: gapInfo.waitingFor,
        startedAt: clockNow(), endedAt: null, durationSeconds: null, startedByRole: role || 'Unknown',
      });
    }
    changes.push(`Status ${STATUS_LABEL[visit.status] || visit.status} → ${STATUS_LABEL[updates.status] || updates.status}`);
    visit.status = updates.status;
    visit.completedAt = updates.status === 'completed' ? clockNow() : null;
  }

  if (typeof updates.treatmentFlag === 'boolean' && updates.treatmentFlag !== visit.treatmentFlag) {
    flagChanged = true;
    changes.push(updates.treatmentFlag ? 'Flagged for treatment' : 'Treatment flag removed');
    visit.treatmentFlag = updates.treatmentFlag;
  }

  if (changes.length) {
    const isCancel = updates.status === 'cancelled';
    const isFlagOnly = !isCancel && changes.length === 1 && flagChanged;
    db.activityLog.push({
      id: db.nextLogId++, visitId, patientId: visit.patientId, station: role || 'Unknown',
      action: isCancel ? 'cancel_visit' : isFlagOnly ? 'toggle_flag' : 'manual_edit',
      label: isCancel ? ACTION_LABEL.cancel_visit : isFlagOnly ? (updates.treatmentFlag ? 'Flagged for Treatment' : 'Treatment Flag Removed') : ACTION_LABEL.manual_edit,
      details: changes.join('; '), createdAt: clockNow(),
    });
  }
  return visit;
}

function activeVisits(db) {
  return [...db.visits.values()].filter((v) => v.status !== 'completed' && v.status !== 'cancelled');
}

function totalIdleSeconds(db, visitId) {
  let total = 0;
  for (const g of db.gapEvents.values()) {
    if (g.visitId === visitId && g.durationSeconds != null) total += g.durationSeconds;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

console.log('\n1. Happy path: full visit start to finish\n');
{
  const db = freshDb();
  const v = checkIn(db, '1001', 'Upfront');

  test('check-in lands in Doing Paperwork — attended, no timer running yet', () => {
    assert.strictEqual(v.status, 'doing_paperwork');
    assert.strictEqual(findOpenGap(db, v.id), null);
  });

  transition(db, v.id, 'ready_for_assistant', { role: 'Upfront' });

  test('finishing paperwork starts Gap 1 (assistant/hygienist)', () => {
    assert.strictEqual(v.status, 'waiting_assistant');
    const open = findOpenGap(db, v.id);
    assert.strictEqual(open.gapNumber, 1);
    assert.strictEqual(open.waitingFor, 'assistant');
  });

  advance(90); // patient waits 90s in the waiting room
  transition(db, v.id, 'assign_operatory', { operatory: 'OP1', role: 'Upfront' });

  test('assigning an operatory stops Gap 1 at the correct duration', () => {
    const gap1 = [...db.gapEvents.values()].find((g) => g.gapNumber === 1);
    assert.strictEqual(gap1.durationSeconds, 90);
    assert.strictEqual(v.status, 'with_assistant');
    assert.strictEqual(v.operatory, 'OP1');
  });

  transition(db, v.id, 'waiting_hygiene', { role: 'OP1' });
  advance(60);
  transition(db, v.id, 'with_hygiene', { role: 'OP1' });
  transition(db, v.id, 'waiting_doctor', { role: 'OP1' });
  advance(400); // long doctor wait — should trip the red threshold in the UI
  transition(db, v.id, 'with_doctor', { role: 'OP1' });
  transition(db, v.id, 'waiting_tc', { role: 'OP1' });

  test('TC actions are excluded from the operatory NEXT_ACTION map', () => {
    assert.strictEqual(NEXT_ACTION['waiting_tc'], undefined);
    assert.strictEqual(NEXT_ACTION['with_tc'], undefined);
    assert.ok(TC_NEXT_ACTION['waiting_tc']);
    assert.ok(TC_NEXT_ACTION['with_tc']);
  });

  advance(30);
  transition(db, v.id, 'with_tc', { role: 'TC Room' });

  test('finishing with TC completes the visit directly — no checkout stage anymore', () => {
    assert.ok(TC_NEXT_ACTION['with_tc'].action === 'complete');
  });

  transition(db, v.id, 'complete', { role: 'Upfront' });

  test('visit completes and total idle time is the sum of all 4 gaps only', () => {
    assert.strictEqual(v.status, 'completed');
    // 90 (assistant) + 60 (hygienist) + 400 (doctor) + 30 (tc) = 580
    assert.strictEqual(totalIdleSeconds(db, v.id), 580);
  });

  test('a completed visit no longer appears in active views', () => {
    assert.strictEqual(activeVisits(db).find((x) => x.id === v.id), undefined);
  });

  test('every step was logged to the activity log with the right station', () => {
    const stations = db.activityLog.filter((e) => e.visitId === v.id).map((e) => e.station);
    assert.deepStrictEqual(stations, ['Upfront', 'Upfront', 'Upfront', 'OP1', 'OP1', 'OP1', 'OP1', 'OP1', 'TC Room', 'Upfront']);
  });
}

console.log('\n2. Patient leaves during paperwork, before ever waiting\n');
{
  const db = freshDb();
  const v = checkIn(db, '2000', 'Upfront');

  test('cancelling straight out of Doing Paperwork needs no gap to close', () => {
    override(db, v.id, { status: 'cancelled' }, 'Upfront');
    assert.strictEqual(v.status, 'cancelled');
    assert.strictEqual([...db.gapEvents.values()].filter((g) => g.visitId === v.id).length, 0);
  });
}

console.log('\n3. Patient never gets pulled back (no-show from the Waiting Room)\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '2002', 'Upfront');
  advance(1200); // 20 minutes, nobody ever comes

  test('cancelling from the Waiting Room closes Gap 1 without starting a new gap', () => {
    override(db, v.id, { status: 'cancelled' }, 'Upfront');
    assert.strictEqual(v.status, 'cancelled');
    const gap1 = [...db.gapEvents.values()].find((g) => g.visitId === v.id && g.gapNumber === 1);
    assert.strictEqual(gap1.durationSeconds, 1200);
    assert.strictEqual(findOpenGap(db, v.id), null);
  });

  test('a cancelled visit disappears from active views immediately', () => {
    assert.strictEqual(activeVisits(db).find((x) => x.id === v.id), undefined);
  });

  test('cancellation is logged distinctly from a manual edit', () => {
    const entry = db.activityLog[db.activityLog.length - 1];
    assert.strictEqual(entry.action, 'cancel_visit');
    assert.strictEqual(entry.label, 'Cancelled / No-Show');
  });
}

console.log('\n4. Patient walks out mid-treatment (leaves while waiting for the doctor)\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '3003', 'Upfront');
  transition(db, v.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' });
  transition(db, v.id, 'waiting_hygiene', { role: 'OP2' });
  transition(db, v.id, 'with_hygiene', { role: 'OP2' });
  transition(db, v.id, 'waiting_doctor', { role: 'OP2' });
  advance(500);

  test('cancelling mid-gap closes that gap at its actual elapsed time', () => {
    override(db, v.id, { status: 'cancelled' }, 'OP2');
    const gap3 = [...db.gapEvents.values()].find((g) => g.visitId === v.id && g.gapNumber === 3);
    assert.strictEqual(gap3.durationSeconds, 500);
  });

  test('OP2 immediately becomes available for the next patient', () => {
    assert.strictEqual(isOperatoryOccupied(db, 999, 'OP2'), false);
  });
}

console.log('\n5. Front-desk data-entry guards\n');
{
  const db = freshDb();
  checkIn(db, '4004', 'Upfront');

  test('checking in the same active patient ID twice is rejected, even mid-paperwork', () => {
    assert.throws(() => checkIn(db, '4004', 'Upfront'), /already has an active visit/);
  });

  test('a second, unrelated patient ID checks in fine', () => {
    assert.doesNotThrow(() => checkIn(db, '4005', 'Upfront'));
  });

  test('once the first patient completes, the ID can be reused', () => {
    const first = [...db.visits.values()].find((v) => v.patientId === '4004');
    transition(db, first.id, 'ready_for_assistant', { role: 'Upfront' });
    transition(db, first.id, 'assign_operatory', { operatory: 'OP3', role: 'Upfront' });
    transition(db, first.id, 'waiting_hygiene', { role: 'OP3' });
    transition(db, first.id, 'with_hygiene', { role: 'OP3' });
    transition(db, first.id, 'waiting_doctor', { role: 'OP3' });
    transition(db, first.id, 'with_doctor', { role: 'OP3' });
    transition(db, first.id, 'waiting_tc', { role: 'OP3' });
    transition(db, first.id, 'with_tc', { role: 'TC Room' });
    transition(db, first.id, 'complete', { role: 'Upfront' });
    assert.doesNotThrow(() => checkIn(db, '4004', 'Upfront'));
  });
}

console.log('\n6. Two rooms, one mistake: double-booking an operatory\n');
{
  const db = freshDb();
  const a = checkInAndReachWaitingRoom(db, '5005', 'Upfront');
  const b = checkInAndReachWaitingRoom(db, '5006', 'Upfront');
  transition(db, a.id, 'assign_operatory', { operatory: 'OP4', role: 'Upfront' });

  test('assigning a second patient to an already-occupied room is rejected', () => {
    assert.throws(() => transition(db, b.id, 'assign_operatory', { operatory: 'OP4', role: 'Upfront' }), /already has a patient/);
  });

  test('the same override protection applies to a manual room reassignment', () => {
    assert.throws(() => override(db, b.id, { operatory: 'OP4' }, 'Upfront'), /already has a patient/);
  });

  test('assigning to a free room works fine', () => {
    assert.doesNotThrow(() => transition(db, b.id, 'assign_operatory', { operatory: 'OP5', role: 'Upfront' }));
  });
}

console.log('\n7. Fixing a fat-fingered Patient ID and a wrong button press\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '60O1', 'Upfront'); // typo: letter O instead of zero
  transition(db, v.id, 'assign_operatory', { operatory: 'OP6', role: 'Upfront' });
  transition(db, v.id, 'waiting_hygiene', { role: 'OP6' });
  advance(50);

  test('fixing the patient ID does not disturb the running timer', () => {
    const gap2Before = findOpenGap(db, v.id);
    const startedAtBefore = gap2Before.startedAt;
    override(db, v.id, { patientId: '6001' }, 'OP6');
    assert.strictEqual(v.patientId, '6001');
    const open = findOpenGap(db, v.id);
    assert.strictEqual(open.gapNumber, 2);
    assert.strictEqual(open.startedAt, startedAtBefore); // the ID edit must not touch the timer
  });

  test('staff clicked "with_hygiene" by mistake — jumping status back via override closes the wrong gap and opens the right one', () => {
    override(db, v.id, { status: 'with_hygiene' }, 'OP6');
    const gap2 = [...db.gapEvents.values()].find((g) => g.visitId === v.id && g.gapNumber === 2);
    assert.strictEqual(gap2.durationSeconds, 50); // closed honestly at the real elapsed time
    assert.strictEqual(v.status, 'with_hygiene');
    assert.strictEqual(findOpenGap(db, v.id), null); // with_hygiene has no gap of its own
  });
}

console.log('\n8. Analytics correctness: cancelled visits must not pollute wait-time stats\n');
{
  const db = freshDb();

  // One clean completed visit with a known 100s doctor wait.
  const good = checkInAndReachWaitingRoom(db, '7001', 'Upfront');
  transition(db, good.id, 'assign_operatory', { operatory: 'OP1', role: 'Upfront' });
  transition(db, good.id, 'waiting_hygiene', { role: 'OP1' });
  transition(db, good.id, 'with_hygiene', { role: 'OP1' });
  transition(db, good.id, 'waiting_doctor', { role: 'OP1' });
  advance(100);
  transition(db, good.id, 'with_doctor', { role: 'OP1' });
  transition(db, good.id, 'waiting_tc', { role: 'OP1' });
  transition(db, good.id, 'with_tc', { role: 'TC Room' });
  transition(db, good.id, 'complete', { role: 'Upfront' });

  // One cancelled visit with a huge 5000s doctor wait that must NOT drag the average up.
  const bad = checkInAndReachWaitingRoom(db, '7002', 'Upfront');
  transition(db, bad.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' });
  transition(db, bad.id, 'waiting_hygiene', { role: 'OP2' });
  transition(db, bad.id, 'with_hygiene', { role: 'OP2' });
  transition(db, bad.id, 'waiting_doctor', { role: 'OP2' });
  advance(5000);
  override(db, bad.id, { status: 'cancelled' }, 'OP2');

  test('a naive average (no cancellation filter) would be skewed', () => {
    const doctorGaps = [...db.gapEvents.values()].filter((g) => g.gapNumber === 3 && g.durationSeconds != null);
    const naiveAvg = doctorGaps.reduce((s, g) => s + g.durationSeconds, 0) / doctorGaps.length;
    assert.strictEqual(naiveAvg, (100 + 5000) / 2); // this is the bug the real endpoint avoids
  });

  test('filtering by visit.status != cancelled (what the real /api/analytics query does) gives the true average', () => {
    const nonCancelledVisitIds = new Set([...db.visits.values()].filter((v) => v.status !== 'cancelled').map((v) => v.id));
    const doctorGaps = [...db.gapEvents.values()].filter((g) => g.gapNumber === 3 && g.durationSeconds != null && nonCancelledVisitIds.has(g.visitId));
    const correctAvg = doctorGaps.reduce((s, g) => s + g.durationSeconds, 0) / doctorGaps.length;
    assert.strictEqual(correctAvg, 100);
  });

  test('cancellation rate is computed correctly (1 of 2 visits)', () => {
    const all = db.visits.size;
    const cancelled = [...db.visits.values()].filter((v) => v.status === 'cancelled').length;
    assert.strictEqual(all, 2);
    assert.strictEqual(cancelled, 1);
    assert.strictEqual(Number(((cancelled / all) * 100).toFixed(1)), 50);
  });
}

console.log('\n9. Waiting Room badge / sort order reflects reality\n');
{
  const db = freshDb();
  const a = checkInAndReachWaitingRoom(db, '8001', 'Upfront');
  advance(30);
  const b = checkInAndReachWaitingRoom(db, '8002', 'Upfront');
  advance(30); // a has now waited 60s, b has waited 30s

  test('the waiting room count only includes patients actually in that stage', () => {
    const waitingRoom = activeVisits(db).filter((v) => v.status === 'waiting_assistant');
    assert.strictEqual(waitingRoom.length, 2);
  });

  test('sorting by elapsed wait puts the longest-waiting patient first (matches the UI fix)', () => {
    const waitingRoom = activeVisits(db).filter((v) => v.status === 'waiting_assistant');
    const withWait = waitingRoom.map((v) => ({ id: v.id, wait: (clockNow() - findOpenGap(db, v.id).startedAt) / 1000 }));
    withWait.sort((x, y) => y.wait - x.wait);
    assert.strictEqual(withWait[0].id, a.id);
    assert.strictEqual(withWait[1].id, b.id);
  });
}

console.log('\n10. Editing a Patient ID must not collide with another active patient\n');
{
  const db = freshDb();
  const a = checkIn(db, '9001', 'Upfront');
  const b = checkIn(db, '9002', 'Upfront');

  test('renaming patient B onto patient A\'s ID is rejected while A is still active', () => {
    assert.throws(() => override(db, b.id, { patientId: '9001' }, 'Upfront'), /already has another active visit/);
  });

  test('renaming to a genuinely free ID works', () => {
    assert.doesNotThrow(() => override(db, b.id, { patientId: '9003' }, 'Upfront'));
    assert.strictEqual(b.patientId, '9003');
  });

  test('once A completes, its old ID frees up for reuse via edit', () => {
    override(db, a.id, { status: 'cancelled' }, 'Upfront');
    assert.doesNotThrow(() => override(db, b.id, { patientId: '9001' }, 'Upfront'));
  });
}

console.log('\n11. My Room (a single OP station) can carry a visit all the way to completion\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '10001', 'Upfront');
  transition(db, v.id, 'assign_operatory', { operatory: 'OP1', role: 'Upfront' });

  test('FULL_NEXT_ACTION has an entry for every status from with_assistant through with_tc, and no checkout stages', () => {
    const expectedStatuses = ['with_assistant', 'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc'];
    for (const s of expectedStatuses) {
      assert.ok(FULL_NEXT_ACTION[s], `missing FULL_NEXT_ACTION entry for ${s}`);
    }
    assert.strictEqual(FULL_NEXT_ACTION['waiting_checkout'], undefined);
    assert.strictEqual(FULL_NEXT_ACTION['with_checkout'], undefined);
  });

  test('driving the visit using only FULL_NEXT_ACTION actions reaches "completed"', () => {
    // Simulates OP1 staff clicking through every stage themselves, never
    // touching the TC Room or Front Desk screens.
    let guard = 0;
    while (v.status !== 'completed' && guard < 20) {
      const next = FULL_NEXT_ACTION[v.status];
      if (!next) break;
      transition(db, v.id, next.action, { role: 'OP1' });
      guard++;
    }
    assert.strictEqual(v.status, 'completed');
  });

  test('the room is free again once complete', () => {
    assert.strictEqual(isOperatoryOccupied(db, 999, 'OP1'), false);
  });
}

console.log('\n12. Treatment flag: visual only, never touches timers or thresholds\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '11001', 'Upfront');
  transition(db, v.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' });
  transition(db, v.id, 'waiting_hygiene', { role: 'OP2' });
  advance(45);

  test('a new visit starts with no treatment flag', () => {
    assert.strictEqual(v.treatmentFlag, false);
  });

  test('flagging a visit does not touch the running timer', () => {
    const openBefore = findOpenGap(db, v.id);
    const startedAtBefore = openBefore.startedAt;
    override(db, v.id, { treatmentFlag: true }, 'OP2');
    assert.strictEqual(v.treatmentFlag, true);
    const openAfter = findOpenGap(db, v.id);
    assert.strictEqual(openAfter.startedAt, startedAtBefore);
    assert.strictEqual(openAfter.id, openBefore.id); // same gap, not closed/reopened
  });

  test('a flag-only change is logged distinctly as toggle_flag, not manual_edit', () => {
    const entry = db.activityLog[db.activityLog.length - 1];
    assert.strictEqual(entry.action, 'toggle_flag');
    assert.strictEqual(entry.label, 'Flagged for Treatment');
  });

  test('the flag can be toggled back off', () => {
    override(db, v.id, { treatmentFlag: false }, 'OP2');
    assert.strictEqual(v.treatmentFlag, false);
    const entry = db.activityLog[db.activityLog.length - 1];
    assert.strictEqual(entry.label, 'Treatment Flag Removed');
  });

  test('flagging alongside a status change is logged as a combined manual edit, not a flag toggle', () => {
    override(db, v.id, { status: 'with_hygiene', treatmentFlag: true }, 'OP2');
    const entry = db.activityLog[db.activityLog.length - 1];
    assert.strictEqual(entry.action, 'manual_edit');
    assert.ok(entry.details.includes('Flagged for treatment'));
    assert.ok(entry.details.includes('Status'));
  });

  test('the flag survives through to completion and is a plain boolean throughout', () => {
    transition(db, v.id, 'waiting_doctor', { role: 'OP2' });
    transition(db, v.id, 'with_doctor', { role: 'OP2' });
    transition(db, v.id, 'waiting_tc', { role: 'OP2' });
    transition(db, v.id, 'with_tc', { role: 'TC Room' });
    transition(db, v.id, 'complete', { role: 'Upfront' });
    assert.strictEqual(v.treatmentFlag, true);
    assert.strictEqual(v.status, 'completed');
  });
}

console.log('\n13. Edit panel sends every field — only real changes should be labelled\n');
{
  const db = freshDb();
  const v = checkIn(db, '12001', 'Upfront');

  test('fixing only the Patient ID (with the unchanged flag also sent) is logged as a manual edit, not a flag change', () => {
    override(db, v.id, { patientId: '12002', treatmentFlag: false }, 'Upfront');
    const entry = db.activityLog[db.activityLog.length - 1];
    assert.strictEqual(entry.action, 'manual_edit');
  });
}

console.log('\n14. Room turnover: a room stays taken until the visit is completed\n');
{
  const db = freshDb();
  const a = checkInAndReachWaitingRoom(db, '14001', 'Upfront');
  const b = checkInAndReachWaitingRoom(db, '14002', 'Upfront');
  transition(db, a.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' });
  for (const s of ['waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor', 'waiting_tc', 'with_tc']) transition(db, a.id, s, { role: 'OP2' });

  test('while the patient is with the treatment coordinator, OP2 is still taken', () => {
    assert.throws(() => transition(db, b.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' }), /already has a patient/);
  });
  test('once the visit is completed, the next patient can be seated in OP2', () => {
    transition(db, a.id, 'complete', { role: 'OP2' });
    assert.doesNotThrow(() => transition(db, b.id, 'assign_operatory', { operatory: 'OP2', role: 'Upfront' }));
  });
}

console.log('\n15. Putting a waiting patient into a room from the edit panel pulls them back\n');
{
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '15001', 'Upfront');
  advance(120);
  override(db, v.id, { status: 'waiting_assistant', operatory: 'OP3' }, 'Lab');

  test('status becomes Pulled Back and the waiting clock stops at the right time', () => {
    assert.strictEqual(v.status, 'with_assistant');
    assert.strictEqual(findOpenGap(db, v.id), null);
    const gap1 = [...db.gapEvents.values()].find((g) => g.visitId === v.id && g.gapNumber === 1);
    assert.strictEqual(gap1.durationSeconds, 120);
  });
  test('the room now counts as taken', () => {
    assert.strictEqual(isOperatoryOccupied(db, 999, 'OP3'), true);
  });
  test('setting an in-the-chair status with no room is refused', () => {
    const w = checkInAndReachWaitingRoom(db, '15002', 'Upfront');
    assert.throws(() => override(db, w.id, { status: 'with_hygiene', operatory: '' }, 'Lab'), /Pick a room/);
  });
}

console.log('\n16. Skipping a stage that doesn\u2019t happen records no fake wait\n');
{
  const { SKIP_ACTION } = require('../lib/flow');
  const db = freshDb();
  const v = checkInAndReachWaitingRoom(db, '16001', 'Upfront');
  transition(db, v.id, 'assign_operatory', { operatory: 'OP1', role: 'Upfront' });

  test('assistant can skip hygiene straight to waiting for the doctor', () => {
    assert.strictEqual(SKIP_ACTION.with_assistant.action, 'skip_hygiene');
    transition(db, v.id, 'skip_hygiene', { role: 'OP1' });
    assert.strictEqual(v.status, 'waiting_doctor');
    assert.strictEqual([...db.gapEvents.values()].filter((g) => g.visitId === v.id && g.gapNumber === 2).length, 0);
  });
  test('if the patient was already waiting, that real wait is kept when the stage is skipped', () => {
    advance(200);
    transition(db, v.id, 'skip_doctor', { role: 'OP1' });
    const gap3 = [...db.gapEvents.values()].find((g) => g.visitId === v.id && g.gapNumber === 3);
    assert.strictEqual(gap3.durationSeconds, 200);
    assert.strictEqual(v.status, 'waiting_tc');
  });
  test('skipping the TC completes the visit and frees the room', () => {
    transition(db, v.id, 'skip_tc', { role: 'OP1' });
    assert.strictEqual(v.status, 'completed');
    assert.strictEqual(findOpenGap(db, v.id), null);
    assert.strictEqual(isOperatoryOccupied(db, 999, 'OP1'), false);
  });
  test('skip is refused from a stage it doesn\u2019t apply to', () => {
    const w = checkInAndReachWaitingRoom(db, '16002', 'Upfront');
    assert.throws(() => transition(db, w.id, 'skip_doctor', { role: 'Upfront' }), /not valid/);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
