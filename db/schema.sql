-- Dental Flow schema
-- Intentionally stores NO patient names, DOB, contact info, insurance, or
-- clinical data. patient_id is an opaque identifier only (e.g. a chart
-- number or short code chosen at front desk check-in).

CREATE TABLE IF NOT EXISTS visits (
  id             SERIAL PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  operatory      TEXT,                 -- e.g. 'OP1' .. 'OP6', NULL until assigned
  status         TEXT NOT NULL DEFAULT 'arrived',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

-- Added after initial launch: staff flag a visit when it's turned into
-- same-day treatment (not just a routine checkup), so everyone knows to
-- expect a longer chair time. ADD COLUMN IF NOT EXISTS makes this safe to
-- apply to an already-running database — just re-run `npm run db:init`.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS treatment_flag BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_visits_status ON visits (status);
CREATE INDEX IF NOT EXISTS idx_visits_started_at ON visits (started_at);

-- One row per gap (1-5) per visit. A new row is inserted when a gap starts;
-- ended_at / duration_seconds are filled in when it stops. Nothing is ever
-- overwritten/deleted, so historical analytics stay accurate.
CREATE TABLE IF NOT EXISTS gap_events (
  id                SERIAL PRIMARY KEY,
  visit_id          INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  gap_number        SMALLINT NOT NULL CHECK (gap_number BETWEEN 1 AND 5),
  waiting_for       TEXT NOT NULL,     -- 'assistant' | 'hygienist' | 'doctor' | 'treatment_coordinator' | 'checkout'
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  duration_seconds  INTEGER,
  started_by_role   TEXT,              -- optional, e.g. 'front_desk', 'hygienist'
  ended_by_role     TEXT
);

CREATE INDEX IF NOT EXISTS idx_gap_events_visit ON gap_events (visit_id);
CREATE INDEX IF NOT EXISTS idx_gap_events_started_at ON gap_events (started_at);
CREATE INDEX IF NOT EXISTS idx_gap_events_open ON gap_events (visit_id) WHERE ended_at IS NULL;

-- Full history of every status transition, for auditing/analytics.
CREATE TABLE IF NOT EXISTS status_events (
  id          SERIAL PRIMARY KEY,
  visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_events_visit ON status_events (visit_id);

-- Human-facing audit trail: one row per button click or manual edit, with
-- which station did it. This is what the Activity Log page reads from.
-- (gap_events/status_events above remain the source of truth for timing
-- analytics; this table exists purely for "who did what, when.")
CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  visit_id    INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  patient_id  TEXT,
  station     TEXT NOT NULL,
  action      TEXT NOT NULL,       -- action key, e.g. 'assign_operatory', 'manual_edit'
  label       TEXT NOT NULL,       -- human-readable action name
  details     TEXT,                -- e.g. "Waiting Room → Pulled Back (OP3)"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log (created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_visit ON activity_log (visit_id);
