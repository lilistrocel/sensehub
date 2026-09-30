/**
 * "Follow crop targets" link between the crop stage targets and the fertigation
 * dose controller (operator decision 2026-09-30) — additive and idempotent.
 *
 * crop_profiles.controller_link_mode   'manual' (default: nothing changes) |
 *                                      'follow_crop_targets' (changes create PENDING proposals)
 *
 * controller_link_proposals   one row per proposal. The controller keeps its values
 *   until an admin / operator approves; an approved proposal is applied at the
 *   START of the next dose cycle (DoseController.beginCycle), never mid-cycle.
 *   status   pending | approved | applied | rejected | superseded | cancelled | failed
 *   trigger  link_enabled | targets_changed | source_water_changed | stage_changed |
 *            controller_changed | protocol_changed
 *   inputs_json    what the proposal was computed from (stage, stage targets, source
 *                  water EC, protocol recipe EC, bounds) + provenance
 *   update_json    the partial controller config it writes (validated again at apply)
 *   diff_json      [{ field, current, proposed, reason: { code, params } }]
 *   blocked_json   [{ part: 'ph' | 'ec', reason, ... }] parts that could not be proposed
 *   hash           sha1 of stage + update (dedupe: an identical proposal is never re-raised)
 *   decided_* / applied_*   audit (who / when); applied_config_version_id = the config version it produced
 *
 * dose_controller_config_versions   every controller config write (PUT config, a
 *   proposal applied, EC fine-tuning on/off) and any stored config first seen at a
 *   cycle start: id, hash, source, proposal_id, who, config_json. Each dose run
 *   records the version it ran with (dose_controller_runs.config_version_id) and the
 *   crop-link proposal its targets came from (dose_controller_runs.link_proposal_id).
 *
 * dose_controller_ec_trim_checks   the recorded verification behind every EC
 *   fine-tuning (ec_trim) enable / disable: SEKO EC vs a handheld meter, who / when.
 */

const CONTROLLER_LINK_SQL = `
  CREATE TABLE IF NOT EXISTS controller_link_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    stage TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    trigger TEXT,
    hash TEXT,
    inputs_json TEXT,
    update_json TEXT,
    diff_json TEXT,
    blocked_json TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by INTEGER,
    decided_by_email TEXT,
    decided_role TEXT,
    decision_note TEXT,
    applied_at TEXT,
    applied_run_id INTEGER,
    applied_config_version_id INTEGER,
    failure TEXT,
    superseded_by INTEGER,
    FOREIGN KEY (profile_id) REFERENCES crop_profiles(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_controller_link_proposals_profile ON controller_link_proposals(profile_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_controller_link_proposals_status ON controller_link_proposals(status);

  CREATE TABLE IF NOT EXISTS dose_controller_config_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    source TEXT NOT NULL,
    proposal_id INTEGER,
    user_id INTEGER,
    user_email TEXT,
    changed_json TEXT,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dose_controller_config_versions_hash ON dose_controller_config_versions(hash, id DESC);

  CREATE TABLE IF NOT EXISTS dose_controller_ec_trim_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER,
    action TEXT NOT NULL,
    handheld_ec_ms REAL,
    seko_ec_ms REAL,
    deviation_pct REAL,
    measured_at TEXT,
    note TEXT,
    user_id INTEGER,
    user_email TEXT,
    user_role TEXT,
    config_version_id INTEGER,
    created_at TEXT NOT NULL
  );
`;

function ensureControllerLinkSchema(db) {
  db.exec(CONTROLLER_LINK_SQL);
  const pcols = db.pragma('table_info(crop_profiles)').map(c => c.name);
  if (pcols.length && !pcols.includes('controller_link_mode')) {
    db.exec("ALTER TABLE crop_profiles ADD COLUMN controller_link_mode TEXT NOT NULL DEFAULT 'manual'");
  }
  const rcols = db.pragma('table_info(dose_controller_runs)').map(c => c.name);
  if (rcols.length) {
    if (!rcols.includes('config_version_id')) db.exec('ALTER TABLE dose_controller_runs ADD COLUMN config_version_id INTEGER');
    if (!rcols.includes('link_proposal_id')) db.exec('ALTER TABLE dose_controller_runs ADD COLUMN link_proposal_id INTEGER');
  }
}

module.exports = { CONTROLLER_LINK_SQL, ensureControllerLinkSchema };
