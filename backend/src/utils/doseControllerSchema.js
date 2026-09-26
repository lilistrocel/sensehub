/**
 * Schema for the closed-loop fertigation dose controller (services/DoseController.js).
 *
 * fertigation_dose_programs.control_mode
 *   'open_loop'   (default) the program's fixed duty schedule drives the valves
 *                 (FertigationDoseScheduler, unchanged behaviour).
 *   'closed_loop' DoseController tracks MEASURED concentrate volume vs MEASURED
 *                 water per tank (and runs the pH Down valve on the feed pH),
 *                 falling back to the fixed schedule when the monitor is blind.
 *   One-shot: when the column is first added, the 7-run daily program
 *   ("Full Strength Permissive — nutrients only", id 7) is set to closed_loop.
 *   It never runs again, so an operator's later change sticks.
 *
 * dose_controller_runs  one row per closed-loop dose cycle (inserted at start,
 *   checkpointed every ~15 s, completed at the end; rows left 'running' by a
 *   restart are closed 'interrupted' on the next start). Times ISO 8601 UTC;
 *   local_date = YYYY-MM-DD in the system timezone (daily acid cap).
 *   tanks_json   [{tank_id, name, ratio_target, target_l, dosed_l, achieved_ratio,
 *                  switches, open_s, open_pct, limited_s, physics_limited, overdose_trips}]
 *   modes_json   {closed_loop_s, fallback_s, hold_s, waiting_s, fallback_periods:[{from,to,reason}]}
 *   trips_json   [{kind, at, detail}]  (limit trips: ph_floor, acid caps, overdose, sensor faults…)
 *   ph_* / ec_*  feed pH and feed EC (µS/cm, SEKO auto-range decoded) over valid samples
 *                taken while water flowed, after the start delay (cup flushed).
 *   zones_json   per zone (segment) per tank: target/dosed L, carry in/out, open/close time,
 *                closed_by ('target' | 'no water' | …), reopens, cant_reach
 *   trim_json    optional EC trim applied at the start {applied, factor, ratios, from_run, reason}
 */
const DOSE_CONTROLLER_SQL = `
  CREATE TABLE IF NOT EXISTS dose_controller_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_log_id INTEGER,
    program_id INTEGER,
    automation_id INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    local_date TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    end_reason TEXT,
    duration_s REAL,
    water_l REAL,
    tanks_json TEXT,
    modes_json TEXT,
    ph_min REAL,
    ph_avg REAL,
    ph_max REAL,
    ph_last REAL,
    ph_samples INTEGER,
    ec_min REAL,
    ec_avg REAL,
    ec_max REAL,
    ec_last REAL,
    ec_samples INTEGER,
    trim_json TEXT,
    zones_json TEXT,
    acid_s REAL NOT NULL DEFAULT 0,
    acid_est_l REAL,
    acid_pulses INTEGER NOT NULL DEFAULT 0,
    trips_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dose_controller_runs_started ON dose_controller_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dose_controller_runs_date ON dose_controller_runs(local_date);
`;

function ensureDoseControllerSchema(db) {
  db.exec(DOSE_CONTROLLER_SQL);
  const cols = db.pragma('table_info(fertigation_dose_programs)').map(c => c.name);
  if (cols.length && !cols.includes('control_mode')) {
    db.exec("ALTER TABLE fertigation_dose_programs ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'open_loop'");
    // One-shot, only on the migration that adds the column (requirement 2026-09-26:
    // closed-loop ratio control for the daily runs 95-101, which use program 7).
    const r = db.prepare(
      "UPDATE fertigation_dose_programs SET control_mode = 'closed_loop' WHERE id = 7 AND name LIKE 'Full Strength Permissive%nutrients only%'"
    ).run();
    console.log(`Added control_mode to fertigation_dose_programs${r.changes ? ' (program 7 -> closed_loop)' : ''}`);
  }
}

module.exports = { DOSE_CONTROLLER_SQL, ensureDoseControllerSchema };
