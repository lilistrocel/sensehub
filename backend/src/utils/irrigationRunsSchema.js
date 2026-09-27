/**
 * Schema for irrigation runs (services/IrrigationRunsService.js,
 * services/IrrigationRunBuilder.js).
 *
 * irrigation_runs  one row per irrigation RUN: monitor cycles + relay events
 *   grouped and classified (automated / manual_app / manual_panel). Derived
 *   data — rebuilt idempotently from irrigation_cycles + relay_events +
 *   dose_controller_runs (backfill of the last 7 days on start, then on every
 *   new cycle report). run_key is stable across rebuilds (automated:
 *   automation id + first relay event; manual: first cycle id), so ids stay put.
 *   Times ISO 8601 UTC; local_date = YYYY-MM-DD in the system timezone.
 *   detail_json  the full run object as served by /api/irrigation/runs
 *                (zone_visits, zone_totals, tanks, cycles, notes, …).
 */
const IRRIGATION_RUNS_SQL = `
  CREATE TABLE IF NOT EXISTS irrigation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    status TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    local_date TEXT,
    duration_s REAL,
    water_l REAL,
    automation_id INTEGER,
    dose_controller_run_id INTEGER,
    operators TEXT,
    uncontrolled_dosing INTEGER NOT NULL DEFAULT 0,
    provisional INTEGER NOT NULL DEFAULT 0,
    detail_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_irrigation_runs_started ON irrigation_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_irrigation_runs_date ON irrigation_runs(local_date);
`;

function ensureIrrigationRunsSchema(db) {
  db.exec(IRRIGATION_RUNS_SQL);
}

module.exports = { IRRIGATION_RUNS_SQL, ensureIrrigationRunsSchema };
