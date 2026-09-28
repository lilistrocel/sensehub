/**
 * Crop profile + fertilizer advisor schema (operator request 2026-09-28) —
 * additive and idempotent.
 *
 * crop_protocols      named, read-only baselines from a HUMAN agronomist (the
 *                     authoritative protocol the AI advisor gives a second opinion on).
 *                     data = JSON (planting, stage targets, stock recipes, daily
 *                     program, climate, timeline). A changed protocol is a NEW row.
 * crop_profiles       one per crop cycle; one ACTIVE per zone (partial unique index),
 *                     older cycles kept (active = 0, ended_at). 1:1 link to the
 *                     crop_assignments row (A64Core contract) so existing readers and
 *                     per-stage element targets (crop_element_targets keyed by
 *                     crop_assignment_id + growth_stage) keep working. Only facts
 *                     SenseHub cannot measure live here; the fertigation system is
 *                     derived live (services/FertigationSystemView.js).
 * crop_stage_targets  per profile per stage: input EC, pH range, drain % range,
 *                     drain EC delta, drain pH limits, mL/plant/day.
 *                     Element (ppm) targets: crop_element_targets (existing table).
 * fertilizer_advice   one row per advisor run (never overwritten; a failure is its own
 *                     row, the UI keeps showing the last success). ADVISORY ONLY.
 * fertilizer_advice_translations  tr / ar text of an advice (AgronomistTranslationService helpers).
 *
 * Seed (first run only, code-only): the human agronomist protocol row, and — when no
 * profile exists yet — one profile per zone with an active crop_assignments row; a
 * cucumber crop gets the protocol defaults (variety, density, dripper, stage
 * timeline, stage targets and the element-target prefill at 1:150).
 */

const CROP_NUTRITION_SQL = `
  CREATE TABLE IF NOT EXISTS crop_protocols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    name TEXT NOT NULL UNIQUE,
    source TEXT,
    source_date TEXT,
    author TEXT,
    crop TEXT,
    variety TEXT,
    breeder TEXT,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS crop_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER,
    crop_assignment_id INTEGER,
    protocol_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    crop TEXT NOT NULL,
    variety TEXT,
    breeder TEXT,
    planting_type TEXT,
    plants_per_m2 REAL,
    area_m2 REAL,
    plants_per_section REAL,
    transplant_date TEXT,
    substrate_type TEXT,
    substrate_volume_l REAL,
    substrate_notes TEXT,
    dripper_flow_lph REAL,
    drippers_per_plant REAL,
    buffer_tank_l REAL,
    source_water_ec REAL,
    source_water_ph REAL,
    stage_timeline TEXT,
    stage_override TEXT,
    stage_override_note TEXT,
    stage_override_at TEXT,
    notes TEXT,
    created_by INTEGER,
    updated_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL,
    FOREIGN KEY (crop_assignment_id) REFERENCES crop_assignments(id) ON DELETE SET NULL,
    FOREIGN KEY (protocol_id) REFERENCES crop_protocols(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_crop_profiles_active_zone ON crop_profiles(zone_id) WHERE active = 1;
  CREATE INDEX IF NOT EXISTS idx_crop_profiles_crop ON crop_profiles(crop_assignment_id);

  CREATE TABLE IF NOT EXISTS crop_stage_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    ec_min REAL, ec_target REAL, ec_max REAL,
    ph_min REAL, ph_max REAL,
    drain_pct_min REAL, drain_pct_target REAL, drain_pct_max REAL,
    drain_ec_delta_max REAL,
    drain_ph_min REAL, drain_ph_max REAL,
    ml_min REAL, ml_target REAL, ml_max REAL,
    source TEXT DEFAULT 'operator',
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_id, stage),
    FOREIGN KEY (profile_id) REFERENCES crop_profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fertilizer_advice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER,
    trigger TEXT NOT NULL,
    trigger_detail TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failure')),
    snapshot TEXT,
    calc TEXT,
    output TEXT,
    model TEXT,
    stop_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cost_estimate REAL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_class TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT,
    FOREIGN KEY (profile_id) REFERENCES crop_profiles(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fertilizer_advice_created ON fertilizer_advice(created_at DESC);

  CREATE TABLE IF NOT EXISTS fertilizer_advice_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advice_id INTEGER NOT NULL,
    lang TEXT NOT NULL CHECK(lang IN ('tr','ar')),
    fields TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
    source_hash TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_estimate REAL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT,
    UNIQUE(advice_id, lang),
    FOREIGN KEY (advice_id) REFERENCES fertilizer_advice(id) ON DELETE CASCADE
  );
`;

// Element-target band around the protocol prefill (SenseHub default, operator-editable).
const MACRO_BAND = { lo: 0.85, hi: 1.15 };
const MICRO_BAND = { lo: 0.7, hi: 1.5 };
// Never priority 1 here: the planner turns every priority-1 target into an automatic guardrail.
const ELEMENT_PRIORITY = { N: 2, K: 2, Ca: 2, P: 3, Mg: 3, S: 4, Fe: 3, Mn: 4, Zn: 4, B: 4, Cu: 5, Mo: 5 };

const round = (v, dp) => { const f = Math.pow(10, dp); return Math.round(v * f) / f; };

/** Stage-target row from the protocol's stage targets. */
function stageTargetFromProtocol(t) {
  if (!t) return null;
  return {
    ec_min: t.input_ec?.min ?? null, ec_target: t.input_ec?.target ?? null, ec_max: t.input_ec?.max ?? null,
    ph_min: t.input_ph?.min ?? null, ph_max: t.input_ph?.max ?? null,
    drain_pct_min: t.drain_pct?.min ?? null, drain_pct_target: t.drain_pct?.target ?? null, drain_pct_max: t.drain_pct?.max ?? null,
    drain_ec_delta_max: t.drain_ec_delta_max ?? null,
    drain_ph_min: t.drain_ph_alarm?.min ?? null, drain_ph_max: t.drain_ph_alarm?.max ?? null,
    ml_min: t.ml_per_plant_day?.min ?? null, ml_target: t.ml_per_plant_day?.target ?? null, ml_max: t.ml_per_plant_day?.max ?? null,
  };
}

/** Element targets (ppm) prefill for a stage: protocol recipe at the design dilution. */
function elementTargetsFromProtocol(db, protocolData, stage) {
  const P = require('../services/cropProtocol');
  const F = require('../services/FeedCalculator');
  const recipeKey = (protocolData.stage_recipe || {})[stage];
  if (!recipeKey) return [];
  const library = (name) => { try { return db.prepare('SELECT composition FROM fertigation_ingredients WHERE name = ?').get(name) || null; } catch (_) { return null; } };
  const tanks = P.recipeTanks(protocolData, recipeKey, library);
  const design = Number(protocolData.senseHub_design_dilution) || 150;
  const { ppm } = F.mixPpm(tanks.map(t => ({ tank: t, fraction: 1 / design })));
  return F.TARGET_ELEMENTS.filter(el => ppm[el] > 0).map(el => {
    const micro = F.MICROS.includes(el);
    const band = micro ? MICRO_BAND : MACRO_BAND;
    const dp = micro ? 3 : 1;
    return {
      element: el,
      hard_min: round(ppm[el] * band.lo, dp),
      soft_target: round(ppm[el], dp),
      hard_max: round(ppm[el] * band.hi, dp),
      priority: ELEMENT_PRIORITY[el] || 3,
      notes: `Prefill: human agronomist protocol ${recipeKey} recipe at 1:${design} (SenseHub design assumption); band ${micro ? '-30/+50' : '±15'} %`,
    };
  });
}

/** INSERT OR IGNORE the protocol defaults for a profile (operator edits survive). */
function seedProfileTargets(db, profileId, cropAssignmentId, protocolData) {
  const insStage = db.prepare(`
    INSERT OR IGNORE INTO crop_stage_targets
      (profile_id, stage, ec_min, ec_target, ec_max, ph_min, ph_max, drain_pct_min, drain_pct_target, drain_pct_max,
       drain_ec_delta_max, drain_ph_min, drain_ph_max, ml_min, ml_target, ml_max, source, notes)
    VALUES (@profile_id, @stage, @ec_min, @ec_target, @ec_max, @ph_min, @ph_max, @drain_pct_min, @drain_pct_target, @drain_pct_max,
       @drain_ec_delta_max, @drain_ph_min, @drain_ph_max, @ml_min, @ml_target, @ml_max, 'protocol', @notes)
  `);
  const insEl = db.prepare(`
    INSERT OR IGNORE INTO crop_element_targets (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let stages = 0; let elements = 0;
  for (const [stage, t] of Object.entries(protocolData.stage_targets || {})) {
    const row = stageTargetFromProtocol(t);
    stages += insStage.run({ profile_id: profileId, stage, ...row, notes: t.ml_per_plant_day?.note || null }).changes;
    if (cropAssignmentId) {
      for (const e of elementTargetsFromProtocol(db, protocolData, stage)) {
        elements += insEl.run(cropAssignmentId, stage, e.element, e.hard_min, e.soft_target, e.hard_max, e.priority, e.notes).changes;
      }
    }
  }
  return { stages, elements };
}

function ensureProtocol(db) {
  const { PROTOCOL } = require('../services/cropProtocol');
  db.prepare(`
    INSERT OR IGNORE INTO crop_protocols (key, name, source, source_date, author, crop, variety, breeder, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(PROTOCOL.key, PROTOCOL.name, PROTOCOL.source, PROTOCOL.source_date, PROTOCOL.author, PROTOCOL.crop, PROTOCOL.variety, PROTOCOL.breeder, JSON.stringify(PROTOCOL.data));
  return db.prepare('SELECT * FROM crop_protocols WHERE key = ?').get(PROTOCOL.key);
}

/** YYYY-MM-DD of a planted_date in the farm timezone. */
function localDate(iso, tz) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const ms = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso).getTime();
  if (!Number.isFinite(ms)) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * First-run seed: one profile per zone with an active crop. Idempotent: does nothing
 * once any profile exists.
 * @returns {{ protocol_id, profiles: number }}
 */
function seedCropNutrition(db, { log = console } = {}) {
  const protocol = ensureProtocol(db);
  const count = db.prepare('SELECT COUNT(*) AS n FROM crop_profiles').get().n;
  if (count > 0) return { protocol_id: protocol.id, profiles: 0 };
  let tz = 'UTC';
  try { tz = require('./systemTimezone').getSystemTimezone(db); } catch (_) { /* default */ }
  const crops = db.prepare(`
    SELECT * FROM crop_assignments WHERE active = 1 AND zone_id IS NOT NULL ORDER BY updated_at DESC, id DESC
  `).all();
  const seenZones = new Set();
  const data = JSON.parse(protocol.data);
  let made = 0;
  const tx = db.transaction(() => {
    for (const c of crops) {
      if (seenZones.has(c.zone_id)) continue;
      seenZones.add(c.zone_id);
      const isProtocolCrop = String(c.crop_name || '').toLowerCase().includes(String(protocol.crop || '').toLowerCase());
      const p = isProtocolCrop ? data.planting : {};
      const r = db.prepare(`
        INSERT INTO crop_profiles
          (zone_id, crop_assignment_id, protocol_id, active, crop, variety, breeder, planting_type, plants_per_m2,
           transplant_date, substrate_type, substrate_volume_l, dripper_flow_lph, drippers_per_plant, stage_timeline, notes)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        c.zone_id, c.id, isProtocolCrop ? protocol.id : null,
        c.crop_name,
        c.variety || (isProtocolCrop ? protocol.variety : null),
        isProtocolCrop ? protocol.breeder : null,
        isProtocolCrop ? 'transplant' : null,
        isProtocolCrop ? p.plants_per_m2 : null,
        localDate(c.planted_date, tz),
        c.soil_type || (isProtocolCrop ? p.substrate : null),
        c.substrate_volume_l_per_plant || null,
        isProtocolCrop ? p.dripper_flow_lph : null,
        isProtocolCrop ? p.drippers_per_plant : null,
        isProtocolCrop ? JSON.stringify(data.stage_timeline) : null,
        `Seeded ${new Date().toISOString().slice(0, 10)} from crop #${c.id}${isProtocolCrop ? ` + ${protocol.name}` : ''}.`,
      );
      const profileId = Number(r.lastInsertRowid);
      if (isProtocolCrop) seedProfileTargets(db, profileId, c.id, data);
      made++;
    }
  });
  tx();
  if (made) log.log(`[CropNutrition] seeded ${made} crop profile(s) (protocol: ${protocol.name})`);
  return { protocol_id: protocol.id, profiles: made };
}

function ensureCropNutritionSchema(db, opts = {}) {
  db.exec(CROP_NUTRITION_SQL);
  return seedCropNutrition(db, opts);
}

module.exports = {
  CROP_NUTRITION_SQL,
  ensureCropNutritionSchema,
  seedCropNutrition,
  seedProfileTargets,
  ensureProtocol,
  stageTargetFromProtocol,
  elementTargetsFromProtocol,
  MACRO_BAND,
  MICRO_BAND,
};
