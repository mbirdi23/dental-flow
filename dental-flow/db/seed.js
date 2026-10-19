// Generates demo data so every screen has something to show immediately:
//   - ~35 completed visits spread across the last 7 days (for Analytics)
//   - a handful of in-progress visits (for Front Desk / Operatories /
//     Live Dashboard / Doctor Queue)
//
// Run with: npm run db:seed
const pool = require('./pool');

const WAITING_FOR = ['assistant', 'hygienist', 'doctor', 'treatment_coordinator'];
const OPERATORIES = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6'];
// Made-up names for demo data only.
const DEMO_FIRST_NAMES = ['Ava', 'Liam', 'Maya', 'Noah', 'Zara', 'Leo', 'Priya', 'Owen', 'Isla', 'Theo'];
function demoName() {
  return DEMO_FIRST_NAMES[randInt(0, DEMO_FIRST_NAMES.length - 1)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Most gaps are short; occasionally one runs long, to give the >10min
// analytics something real to show.
function randomGapSeconds() {
  const roll = Math.random();
  if (roll < 0.08) return randInt(600, 1500); // long outlier
  if (roll < 0.35) return randInt(300, 599); // yellow zone
  return randInt(20, 299); // green zone
}

async function seedCompletedVisit(client, daysAgo) {
  const patientId = String(randInt(1000, 9999));
  const operatory = OPERATORIES[randInt(0, OPERATORIES.length - 1)];

  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() - daysAgo);
  dayStart.setHours(randInt(8, 16), randInt(0, 59), 0, 0);

  let cursor = new Date(dayStart);

  const { rows } = await client.query(
    `INSERT INTO visits (patient_id, operatory, status, started_at)
     VALUES ($1, $2, 'completed', $3) RETURNING id`,
    [patientId, operatory, cursor]
  );
  const visitId = rows[0].id;

  // Doing Paperwork — attended, untracked, so just advance the clock
  // before the first real (idle) gap starts.
  const paperworkSeconds = randInt(60, 240);
  cursor = new Date(cursor.getTime() + paperworkSeconds * 1000);

  for (let gapNumber = 1; gapNumber <= 4; gapNumber++) {
    const gapSeconds = randomGapSeconds();
    const startedAt = new Date(cursor);
    const endedAt = new Date(startedAt.getTime() + gapSeconds * 1000);

    await client.query(
      `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, ended_at, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [visitId, gapNumber, WAITING_FOR[gapNumber - 1], startedAt, endedAt, gapSeconds]
    );

    // Time "with staff" between gaps — not tracked as idle, just advances the clock.
    const withStaffSeconds = randInt(180, 900);
    cursor = new Date(endedAt.getTime() + withStaffSeconds * 1000);
  }

  await client.query(
    `UPDATE visits SET completed_at = $2 WHERE id = $1`,
    [visitId, cursor]
  );
}

async function seedInProgressVisit(client, status, waitStartedSecondsAgo) {
  const patientId = String(randInt(1000, 9999));
  const operatory = OPERATORIES[randInt(0, OPERATORIES.length - 1)];
  const gapMap = {
    waiting_assistant: null, // no operatory yet
    waiting_hygiene: 2,
    waiting_doctor: 3,
    waiting_tc: 4,
  };

  const { rows } = await client.query(
    `INSERT INTO visits (patient_id, operatory, status, started_at, patient_first_name)
     VALUES ($1, $2, $3, now() - interval '20 minutes', $4) RETURNING id`,
    [patientId, gapMap[status] === null ? null : operatory, status, demoName()]
  );
  const visitId = rows[0].id;

  const gapNumber = gapMap[status];
  if (gapNumber) {
    await client.query(
      `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at)
       VALUES ($1, $2, $3, now() - ($4 || ' seconds')::interval)`,
      [visitId, gapNumber, WAITING_FOR[gapNumber - 1], waitStartedSecondsAgo]
    );
  } else {
    await client.query(
      `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at)
       VALUES ($1, 1, 'assistant', now() - ($2 || ' seconds')::interval)`,
      [visitId, waitStartedSecondsAgo]
    );
  }

  await client.query(
    `INSERT INTO status_events (visit_id, status) VALUES ($1, $2)`,
    [visitId, status]
  );
}

// Doing Paperwork — attended, no gap timer at all, so this is a much
// simpler seed than seedInProgressVisit above.
async function seedPaperworkVisit(client) {
  const patientId = String(randInt(1000, 9999));
  const { rows } = await client.query(
    `INSERT INTO visits (patient_id, status, started_at, patient_first_name)
     VALUES ($1, 'doing_paperwork', now() - interval '3 minutes', $2) RETURNING id`,
    [patientId, demoName()]
  );
  await client.query(
    `INSERT INTO status_events (visit_id, status) VALUES ($1, 'doing_paperwork')`,
    [rows[0].id]
  );
}

// A patient who checked in but was never picked up (or left partway
// through), yesterday — so Analytics has a non-zero cancellation rate to
// show right away.
async function seedCancelledVisit(client) {
  const patientId = String(randInt(1000, 9999));
  const startedAt = new Date();
  startedAt.setDate(startedAt.getDate() - 1);
  startedAt.setHours(10, 15, 0, 0);
  const waitedSeconds = randInt(600, 1400);
  const endedAt = new Date(startedAt.getTime() + waitedSeconds * 1000);

  const { rows } = await client.query(
    `INSERT INTO visits (patient_id, status, started_at) VALUES ($1, 'cancelled', $2) RETURNING id`,
    [patientId, startedAt]
  );
  await client.query(
    `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, ended_at, duration_seconds)
     VALUES ($1, 1, 'assistant', $2, $3, $4)`,
    [rows[0].id, startedAt, endedAt, waitedSeconds]
  );
  await client.query(
    `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details)
     VALUES ($1, $2, 'Upfront', 'cancel_visit', 'Cancelled / No-Show', 'Status Waiting Room → Cancelled / No-Show')`,
    [rows[0].id, patientId]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 7 days of history, ~5 visits/day
    for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
      for (let i = 0; i < 5; i++) {
        await seedCompletedVisit(client, daysAgo);
      }
    }

    // A few patients live right now, at different stages
    await seedPaperworkVisit(client);
    await seedInProgressVisit(client, 'waiting_assistant', 90);
    await seedInProgressVisit(client, 'waiting_hygiene', 240);
    await seedInProgressVisit(client, 'waiting_doctor', 770); // red
    await seedInProgressVisit(client, 'waiting_doctor', 120); // green
    await seedInProgressVisit(client, 'waiting_tc', 340); // amber

    // One no-show, so Analytics has something to show in the cancellation
    // stats right away.
    await seedCancelledVisit(client);

    await client.query('COMMIT');
    console.log('Seed data inserted.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
