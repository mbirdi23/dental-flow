require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const { TRANSITIONS, NEXT_ACTION, TC_NEXT_ACTION, FULL_NEXT_ACTION, STATIONS, STATUS_LABEL, ACTION_LABEL, GAP_FOR_STATUS } = require('./lib/flow');

const app = express();
app.use(express.json());
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
  res.json({ yellowSeconds: WAIT_YELLOW_SECONDS, redSeconds: WAIT_RED_SECONDS, stations: STATIONS });
});

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

// Create a new visit (front desk: patient checks in / paperwork complete).
app.post('/api/visits', async (req, res) => {
  const raw = req.body.patient_id;
  const patientId = raw == null ? '' : String(raw).trim();
  if (!patientId) {
    return res.status(400).json({ error: 'patient_id is required' });
  }
  if (patientId.length > 40) {
    return res.status(400).json({ error: 'Patient ID is too long (max 40 characters)' });
  }
  try {
    // Guard against double-checking in the same patient (fat-fingered
    // duplicate entry, or a second staff member checking them in again
    // without noticing the first). If they already have an active visit,
    // point staff at editing that one instead of creating a duplicate.
    const { rows: existingRows } = await pool.query(
      `SELECT id, status FROM visits WHERE patient_id = $1 AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
      [patientId]
    );
    if (existingRows[0]) {
      return res.status(409).json({
        error: `Patient ${patientId} already has an active visit (${STATUS_LABEL[existingRows[0].status] || existingRows[0].status}). Use the edit button to fix it instead of checking in again.`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO visits (patient_id, status) VALUES ($1, 'arrived') RETURNING *`,
      [patientId]
    );
    const visit = rows[0];
    await pool.query(
      `INSERT INTO status_events (visit_id, status) VALUES ($1, $2)`,
      [visit.id, visit.status]
    );
    broadcast('visits-changed', { reason: 'created', visitId: visit.id });
    res.status(201).json(visit);
  } catch (err) {
    console.error(err);
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
        `SELECT id FROM visits WHERE id != $1 AND operatory = $2 AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
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
          [openGapRows[0].id, role || null]
        );
      }
    }

    // Start a new gap timer, if this transition opens one.
    if (transition.startsGap) {
      await client.query(
        `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, started_by_role)
         VALUES ($1, $2, $3, now(), $4)`,
        [visitId, transition.startsGap.number, transition.startsGap.waitingFor, role || null]
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

    const details = `${STATUS_LABEL[visit.status]} → ${STATUS_LABEL[transition.to]}${operatory ? ` (${operatory})` : ''}`;
    await client.query(
      `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [visitId, updatedRows[0].patient_id, role || 'Unknown', action, ACTION_LABEL[action] || action, details]
    );

    await client.query('COMMIT');
    broadcast('visits-changed', { reason: action, visitId });
    res.json(updatedRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
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
  const { patientId, status, operatory, treatmentFlag, role } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: visitRows } = await client.query('SELECT * FROM visits WHERE id = $1 FOR UPDATE', [visitId]);
    const visit = visitRows[0];
    if (!visit) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Visit not found' });
    }

    const changes = [];
    const setParts = [];
    const params = [visitId];
    let idx = 2;

    if (patientId !== undefined && patientId.trim() && patientId.trim() !== visit.patient_id) {
      const cleanId = patientId.trim();
      if (cleanId.length > 40) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Patient ID is too long (max 40 characters)' });
      }
      const { rows: dupeRows } = await client.query(
        `SELECT id FROM visits WHERE id != $1 AND patient_id = $2 AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
        [visitId, cleanId]
      );
      if (dupeRows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Patient ${cleanId} already has another active visit — check the ID and try again` });
      }
      changes.push(`Patient ID ${visit.patient_id} → ${cleanId}`);
      setParts.push(`patient_id = $${idx++}`);
      params.push(cleanId);
    }

    if (operatory !== undefined) {
      const newOp = operatory || null;
      if (newOp !== visit.operatory) {
        if (newOp) {
          const { rows: occupiedRows } = await client.query(
            `SELECT id FROM visits WHERE id != $1 AND operatory = $2 AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
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

    if (status !== undefined && status !== visit.status) {
      const { rows: openGapRows } = await client.query(
        `SELECT * FROM gap_events WHERE visit_id = $1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
        [visitId]
      );
      if (openGapRows[0]) {
        await client.query(
          `UPDATE gap_events SET ended_at = now(), duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int, ended_by_role = $2 WHERE id = $1`,
          [openGapRows[0].id, role || 'Unknown']
        );
      }
      const gapInfo = GAP_FOR_STATUS[status];
      if (gapInfo) {
        await client.query(
          `INSERT INTO gap_events (visit_id, gap_number, waiting_for, started_at, started_by_role) VALUES ($1, $2, $3, now(), $4)`,
          [visitId, gapInfo.number, gapInfo.waitingFor, role || 'Unknown']
        );
      }
      changes.push(`Status ${STATUS_LABEL[visit.status] || visit.status} → ${STATUS_LABEL[status] || status}`);
      setParts.push(`status = $${idx++}`);
      params.push(status);
      setParts.push(`completed_at = ${status === 'completed' ? 'now()' : 'NULL'}`);
    }

    if (typeof treatmentFlag === 'boolean' && treatmentFlag !== visit.treatment_flag) {
      changes.push(treatmentFlag ? 'Flagged for treatment (longer visit expected)' : 'Treatment flag removed');
      setParts.push(`treatment_flag = $${idx++}`);
      params.push(treatmentFlag);
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
      const isFlagOnly = !isCancel && changes.length === 1 && typeof treatmentFlag === 'boolean';
      const action = isCancel ? 'cancel_visit' : isFlagOnly ? 'toggle_flag' : 'manual_edit';
      const label = isCancel
        ? ACTION_LABEL.cancel_visit
        : isFlagOnly
        ? (treatmentFlag ? 'Flagged for Treatment' : 'Treatment Flag Removed')
        : ACTION_LABEL.manual_edit;
      await client.query(
        `INSERT INTO activity_log (visit_id, patient_id, station, action, label, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [visitId, updatedVisit.patient_id, role || 'Unknown', action, label, changes.join('; ')]
      );
    }

    await client.query('COMMIT');
    broadcast('visits-changed', { reason: 'manual_edit', visitId });
    res.json(updatedVisit);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
});

app.get('/api/visits/:id(\\d+)', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM visits WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load visit' });
  }
});

// All non-completed visits, with live wait/idle time computed server-side
// so every screen (front desk, operatory, dashboard, doctor queue) shares
// one source of truth.
async function fetchActiveVisits() {
  const { rows } = await pool.query(`
    SELECT
      v.id, v.patient_id, v.operatory, v.status, v.started_at, v.treatment_flag,
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
    WHERE v.status NOT IN ('completed', 'cancelled')
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
      waitingFor: r.open_waiting_for, // null if currently with a staff member
      currentWaitSeconds,
      totalIdleSeconds: r.closed_idle_seconds + currentWaitSeconds,
      nextAction: NEXT_ACTION[r.status] || null,
      tcNextAction: TC_NEXT_ACTION[r.status] || null,
      fullNextAction: FULL_NEXT_ACTION[r.status] || null,
    };
  });
}

app.get('/api/visits/active', async (req, res) => {
  try {
    res.json(await fetchActiveVisits());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load active visits' });
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
    console.error(err);
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
    console.error(err);
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
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status != 'cancelled'
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
           WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.status != 'cancelled'
           GROUP BY ge.visit_id
         ) t`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT ge.visit_id) AS n
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2
           AND v.status != 'cancelled' AND ge.duration_seconds > 600`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2`,
        [start, end]
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM visits WHERE started_at BETWEEN $1 AND $2 AND status != 'cancelled'`,
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
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.status != 'cancelled'
         ORDER BY ge.duration_seconds DESC LIMIT 1`,
        [start, end]
      ),
      pool.query(
        `SELECT EXTRACT(DOW FROM ge.started_at)::int AS dow, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status != 'cancelled'
         GROUP BY dow ORDER BY dow`,
        [start, end]
      ),
      pool.query(
        `SELECT EXTRACT(HOUR FROM ge.started_at)::int AS hour, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND ge.started_at BETWEEN $1 AND $2 AND v.status != 'cancelled'
         GROUP BY hour ORDER BY hour`,
        [start, end]
      ),
      pool.query(
        `SELECT v.operatory, AVG(ge.duration_seconds)::numeric(10,1) AS avg_seconds
         FROM gap_events ge
         JOIN visits v ON v.id = ge.visit_id
         WHERE ge.ended_at IS NOT NULL AND v.started_at BETWEEN $1 AND $2 AND v.operatory IS NOT NULL AND v.status != 'cancelled'
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
      cancelledRate: allVisits > 0 ? Number(((cancelled / allVisits) * 100).toFixed(1)) : 0,
      worstGap: worstGap.rows[0] || null,
      averageByDayOfWeek: byDow.rows,
      averageByHourOfDay: byHour.rows,
      averageByOperatory: byOperatory.rows,
    });
  } catch (err) {
    console.error(err);
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
        WHERE v.status != 'cancelled'
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
    console.error(err);
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
  res.redirect('/operatory');
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

app.listen(PORT, () => {
  console.log(`Dental Flow running at http://localhost:${PORT}`);
});
