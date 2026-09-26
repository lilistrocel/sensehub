/**
 * Schema for the irrigation flow watch (services/IrrigationFlowWatchService.js).
 *
 * irrigation_flow_episodes  one row per detected flow anomaly, so Reports / the
 *   agronomist can ask "which zones ran dry, when, for how long, did it recover".
 *   - kind 'valve_no_flow' rows are written for EVERY no-flow period longer than
 *     episode_min_seconds while pump + zone were ON (alarmed or not — a valve
 *     that opens 25 s late is recorded without raising an alarm).
 *   - every other rule writes a row only when it actually raised an alert.
 *   The row is inserted while the episode is still running (ended_at NULL) and
 *   completed when it ends; rows left open by a restart are closed with
 *   end_reason 'interrupted' on the next start.
 *   Times are ISO 8601 UTC. recovered: 1 = the condition cleared by itself
 *   (water came back), 0 = it ended because the run / dosing stopped, NULL = unknown.
 */
const FLOW_WATCH_SQL = `
  CREATE TABLE IF NOT EXISTS irrigation_flow_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    equipment_id INTEGER,
    channel INTEGER,
    zone_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_s REAL,
    expected_lph REAL,
    min_flow_lph REAL,
    max_flow_lph REAL,
    recovered INTEGER,
    end_reason TEXT,
    alarmed INTEGER NOT NULL DEFAULT 0,
    severity TEXT,
    alert_id INTEGER,
    dosing_aborted INTEGER NOT NULL DEFAULT 0,
    detail_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_flow_episodes_started ON irrigation_flow_episodes(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_flow_episodes_kind ON irrigation_flow_episodes(kind, started_at DESC);
`;

function ensureFlowWatchSchema(db) {
  db.exec(FLOW_WATCH_SQL);
}

module.exports = { FLOW_WATCH_SQL, ensureFlowWatchSchema };
