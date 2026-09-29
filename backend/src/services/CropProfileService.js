/**
 * CropProfileService — crop profiles (one active per zone, history kept),
 * growth stage from days after transplant (editable timeline + manual override),
 * per-stage targets and the compact view the AI jobs read.
 *
 * Storage: crop_profiles (1:1 with crop_assignments, which stays the A64Core
 * contract table and the crop row older readers use), crop_stage_targets, and
 * the EXISTING crop_element_targets (crop_assignment_id + growth_stage) for the
 * per-element ppm targets — the planner resolves the same rows.
 *
 * Nothing here touches recipes, dose programs, ratios, tanks or automations.
 */

const { db: defaultDb } = require('../utils/database');
const { getSystemTimezone, localDateStr } = require('../utils/systemTimezone');
const ScaleMath = require('./elementTargetScaling');

const VALID_STAGES = ['seedling', 'vegetative', 'flowering', 'fruiting', 'ripening', 'harvested'];
const TARGET_ELEMENTS = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
const DAY_MS = 86400000;

// Editable profile fields: name -> validator. Numbers: [min, max].
const NUM_FIELDS = {
  plants_per_m2: [0, 100],
  area_m2: [0, 1e7],
  plants_per_section: [0, 1e7],
  substrate_volume_l: [0, 10000],
  dripper_flow_lph: [0, 100],
  drippers_per_plant: [0, 20],
  buffer_tank_l: [0, 1e6],
  source_water_ec: [0, 20],
  source_water_ph: [0, 14],
};
const TEXT_FIELDS = { crop: 80, variety: 80, breeder: 80, planting_type: 60, substrate_type: 80, substrate_notes: 300, notes: 1000, stage_override_note: 300 };

const STAGE_NUM_FIELDS = {
  ec_min: [0, 20], ec_target: [0, 20], ec_max: [0, 20],
  ph_min: [0, 14], ph_max: [0, 14],
  drain_pct_min: [0, 100], drain_pct_target: [0, 100], drain_pct_max: [0, 100],
  drain_ec_delta_max: [-5, 10],
  drain_ph_min: [0, 14], drain_ph_max: [0, 14],
  ml_min: [0, 50000], ml_target: [0, 50000], ml_max: [0, 50000],
};

class ValidationError extends Error {
  constructor(message, field = null) { super(message); this.status = 400; this.field = field; }
}

function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return dflt; }
}

/** Days between two YYYY-MM-DD dates (b - a). */
function dayDiff(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / DAY_MS);
}

function addDays(dateStr, n) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

function normTimeline(tl) {
  const arr = Array.isArray(tl) ? tl : [];
  return arr
    .filter(e => e && VALID_STAGES.includes(e.stage) && Number.isFinite(Number(e.from_day)))
    .map(e => ({ stage: e.stage, from_day: Math.round(Number(e.from_day)), note: e.note ? String(e.note).slice(0, 300) : null }))
    .sort((a, b) => a.from_day - b.from_day);
}

/**
 * Growth stage from the transplant date (day 0 = transplant day, farm-local dates).
 * @returns {{ today, days_after_transplant, auto_stage, effective, source, override, current_entry, next }}
 */
function computeStage(profile, { today }) {
  const timeline = normTimeline(parseJson(profile.stage_timeline, []));
  const dat = profile.transplant_date ? dayDiff(profile.transplant_date, today) : null;
  let current = null;
  let next = null;
  if (dat !== null) {
    for (const e of timeline) {
      if (e.from_day <= dat) current = e;
      else if (!next) next = e;
    }
  }
  const auto = current ? current.stage : null;
  const override = profile.stage_override && VALID_STAGES.includes(profile.stage_override) ? profile.stage_override : null;
  return {
    today,
    days_after_transplant: dat,
    auto_stage: auto,
    effective: override || auto,
    source: override ? 'override' : (auto ? 'auto' : 'none'),
    override: override ? { stage: override, note: profile.stage_override_note || null, at: profile.stage_override_at || null } : null,
    current_entry: current,
    next: next && profile.transplant_date ? {
      stage: next.stage, from_day: next.from_day, date: addDays(profile.transplant_date, next.from_day),
      in_days: dat !== null ? next.from_day - dat : null, note: next.note,
    } : null,
    timeline,
  };
}

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

class CropProfileService {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.now = deps.now || (() => Date.now());
  }

  get db() { return this._db || defaultDb; }

  tz() { return getSystemTimezone(this.db); }

  today(nowMs = this.now()) { return localDateStr(new Date(nowMs), this.tz()); }

  // ---------- reads ----------

  getRow(id) {
    return this.db.prepare('SELECT * FROM crop_profiles WHERE id = ?').get(id) || null;
  }

  activeRow(zoneId = null) {
    if (zoneId) return this.db.prepare('SELECT * FROM crop_profiles WHERE active = 1 AND zone_id = ?').get(zoneId) || null;
    // Primary crop zone first, then any active profile.
    return this.db.prepare(`
      SELECT p.* FROM crop_profiles p LEFT JOIN zones z ON z.id = p.zone_id
      WHERE p.active = 1 ORDER BY COALESCE(z.is_crop_zone, 0) DESC, p.id DESC LIMIT 1
    `).get() || null;
  }

  list({ zoneId = null, includeInactive = false } = {}) {
    const where = [];
    const args = [];
    if (!includeInactive) where.push('p.active = 1');
    if (zoneId) { where.push('p.zone_id = ?'); args.push(zoneId); }
    return this.db.prepare(`
      SELECT p.*, z.name AS zone_name FROM crop_profiles p LEFT JOIN zones z ON z.id = p.zone_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.active DESC, p.id DESC
    `).all(...args).map(r => this.resolve(r, { light: true }));
  }

  protocolRow(id) {
    if (!id) return null;
    const r = this.db.prepare('SELECT * FROM crop_protocols WHERE id = ?').get(id);
    return r ? { ...r, data: parseJson(r.data, {}) } : null;
  }

  listProtocols() {
    return this.db.prepare('SELECT id, key, name, source, source_date, author, crop, variety, breeder, created_at FROM crop_protocols ORDER BY id').all();
  }

  stageTargets(profileId) {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM crop_stage_targets WHERE profile_id = ? ORDER BY id').all(profileId)) out[r.stage] = r;
    return out;
  }

  /**
   * Element targets per stage. Each row carries its basis (the last value SenseHub
   * wrote: protocol prefill or scale-to-EC) and `manual` = hand-edited since.
   */
  elementTargets(cropAssignmentId) {
    const out = {};
    if (!cropAssignmentId) return out;
    const rows = this.db.prepare(`
      SELECT id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes, updated_at,
        basis_hard_min, basis_soft_target, basis_hard_max, basis_source, basis_ec, basis_factor
      FROM crop_element_targets WHERE crop_assignment_id = ? AND growth_stage IS NOT NULL
      ORDER BY growth_stage, element
    `).all(cropAssignmentId);
    for (const r of rows) {
      if (!TARGET_ELEMENTS.includes(r.element)) continue;
      (out[r.growth_stage] = out[r.growth_stage] || []).push({ ...r, manual: ScaleMath.isManuallyEdited(r) });
    }
    return out;
  }

  _library() {
    const lib = this.db.prepare('SELECT composition FROM fertigation_ingredients WHERE name = ?');
    return (n) => { try { return lib.get(n) || null; } catch (_) { return null; } };
  }

  /** Irrigation sections (zone valves) from the dose-controller config. */
  sections() {
    try {
      const { doseConfig } = require('./FeedCalculator');
      const ch = doseConfig(this.db).nutrients?.zone_channels;
      return Array.isArray(ch) && ch.length ? ch.length : null;
    } catch (_) { return null; }
  }

  /** Median whole-run flow (L/h) of automated runs in the last 7 days (irrigation monitor). */
  measuredZoneFlowLph(nowMs = this.now()) {
    try {
      const since = new Date(nowMs - 7 * DAY_MS).toISOString();
      const rows = this.db.prepare(`
        SELECT detail_json FROM irrigation_runs WHERE type = 'automated' AND started_at >= ? AND water_l >= 200 ORDER BY started_at DESC LIMIT 60
      `).all(since);
      return median(rows.map(r => Number(parseJson(r.detail_json, {}).avg_flow_lph)).filter(v => v > 0));
    } catch (_) { return null; }
  }

  /**
   * Plants: entered per section → density × area → estimated from measured flow ÷ dripper flow.
   * @returns {{ total, per_section, sections, source, basis }}
   */
  plants(p, nowMs = this.now()) {
    const sections = this.sections();
    const out = { total: null, per_section: null, sections, source: null, basis: null };
    if (p.plants_per_section > 0) {
      out.per_section = Math.round(p.plants_per_section);
      out.total = sections ? out.per_section * sections : null;
      out.source = 'entered';
    } else if (p.plants_per_m2 > 0 && p.area_m2 > 0) {
      out.total = Math.round(p.plants_per_m2 * p.area_m2);
      out.per_section = sections ? Math.round(out.total / sections) : null;
      out.source = 'density_area';
    } else if (p.dripper_flow_lph > 0) {
      const flow = this.measuredZoneFlowLph(nowMs);
      const perPlant = p.dripper_flow_lph * (p.drippers_per_plant > 0 ? p.drippers_per_plant : 1);
      if (flow > 0) {
        out.per_section = Math.round(flow / perPlant);
        out.total = sections ? out.per_section * sections : null;
        out.source = 'estimated_from_flow';
        out.basis = { zone_flow_lph: Math.round(flow), dripper_flow_lph: p.dripper_flow_lph, drippers_per_plant: p.drippers_per_plant || 1 };
      }
    }
    return out;
  }

  /** Profile row → API object (stage, targets, plants, protocol reference). */
  resolve(row, { light = false, nowMs = this.now() } = {}) {
    if (!row) return null;
    const today = this.today(nowMs);
    const stage = computeStage(row, { today });
    const zone = row.zone_id ? this.db.prepare('SELECT id, name FROM zones WHERE id = ?').get(row.zone_id) : null;
    const base = {
      id: row.id,
      zone_id: row.zone_id,
      zone_name: zone ? zone.name : (row.zone_name || null),
      crop_assignment_id: row.crop_assignment_id,
      protocol_id: row.protocol_id,
      active: row.active === 1,
      crop: row.crop,
      variety: row.variety,
      breeder: row.breeder,
      planting_type: row.planting_type,
      plants_per_m2: row.plants_per_m2,
      area_m2: row.area_m2,
      plants_per_section: row.plants_per_section,
      transplant_date: row.transplant_date,
      substrate_type: row.substrate_type,
      substrate_volume_l: row.substrate_volume_l,
      substrate_notes: row.substrate_notes,
      dripper_flow_lph: row.dripper_flow_lph,
      drippers_per_plant: row.drippers_per_plant,
      buffer_tank_l: row.buffer_tank_l,
      source_water_ec: row.source_water_ec,
      source_water_ph: row.source_water_ph,
      stage_timeline: stage.timeline,
      stage_override: row.stage_override,
      stage_override_note: row.stage_override_note,
      stage_override_at: row.stage_override_at,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ended_at: row.ended_at,
      stage,
    };
    if (light) return base;
    const protocol = this.protocolRow(row.protocol_id);
    // The protocol's recipe per stage as feed ppm at its design dilution (same analyses as the calculator).
    let protocolPpm = null;
    const stagePpm = {};
    if (protocol && protocol.data && protocol.data.stage_recipe) {
      try {
        const FC = require('./FeedCalculator');
        const library = this._library();
        protocolPpm = { design_dilution: Number(protocol.data.senseHub_design_dilution) || 150, by_stage: {} };
        for (const stage of Object.keys(protocol.data.stage_recipe)) {
          const sp = ScaleMath.protocolStagePpm(protocol.data, stage, library);
          if (!sp) continue;
          stagePpm[stage] = sp;
          protocolPpm.by_stage[stage] = { recipe: sp.recipe, ppm: sp.ppm, ec_ms_cm: FC.ecEstimate(sp.ppm).ec_ms_cm };
        }
      } catch (_) { protocolPpm = null; }
    }
    const stageTargets = this.stageTargets(row.id);
    const elementTargets = this.elementTargets(row.crop_assignment_id);
    // Which input EC the stored ppm correspond to (fertilizers + source water), per stage.
    const elementTargetsEc = {};
    for (const [stage, rows] of Object.entries(elementTargets)) {
      const c = ScaleMath.targetsCorrespondence({ rows, stagePpm: stagePpm[stage] || null, sourceWaterEc: row.source_water_ec, ecTarget: stageTargets[stage] ? stageTargets[stage].ec_target : null });
      if (c) elementTargetsEc[stage] = { ...c, manual_elements: rows.filter(r => r.manual).map(r => r.element) };
    }
    return {
      ...base,
      plants: this.plants(row, nowMs),
      stage_targets: stageTargets,
      element_targets: elementTargets,
      element_targets_ec: elementTargetsEc,
      protocol: protocol ? { id: protocol.id, name: protocol.name, source: protocol.source, source_date: protocol.source_date, author: protocol.author, crop: protocol.crop, variety: protocol.variety, breeder: protocol.breeder, data: protocol.data } : null,
      protocol_ppm: protocolPpm,
    };
  }

  getProfile(id, opts) { return this.resolve(this.getRow(id), opts); }

  getActive(zoneId = null, opts) { return this.resolve(this.activeRow(zoneId), opts); }

  // ---------- validation ----------

  _cleanFields(input, { requireCrop = false } = {}) {
    const b = input || {};
    const out = {};
    for (const [k, max] of Object.entries(TEXT_FIELDS)) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { out[k] = null; continue; }
      if (typeof b[k] !== 'string') throw new ValidationError(`${k} must be text`, k);
      out[k] = b[k].trim().slice(0, max) || null;
    }
    for (const [k, [lo, hi]] of Object.entries(NUM_FIELDS)) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { out[k] = null; continue; }
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new ValidationError(`${k} must be a number between ${lo} and ${hi}`, k);
      out[k] = n;
    }
    if (b.transplant_date !== undefined) {
      if (b.transplant_date === null || b.transplant_date === '') out.transplant_date = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.transplant_date)) || !Number.isFinite(Date.parse(`${b.transplant_date}T00:00:00Z`))) {
        throw new ValidationError('transplant_date must be YYYY-MM-DD', 'transplant_date');
      } else out.transplant_date = String(b.transplant_date);
    }
    if (b.stage_override !== undefined) {
      if (b.stage_override === null || b.stage_override === '') out.stage_override = null;
      else if (!VALID_STAGES.includes(b.stage_override)) throw new ValidationError(`stage_override must be one of ${VALID_STAGES.join(', ')}`, 'stage_override');
      else out.stage_override = b.stage_override;
    }
    if (b.stage_timeline !== undefined) {
      if (b.stage_timeline === null) out.stage_timeline = null;
      else {
        if (!Array.isArray(b.stage_timeline) || b.stage_timeline.length > 12) throw new ValidationError('stage_timeline must be an array (max 12 entries)', 'stage_timeline');
        const seen = new Set();
        for (const e of b.stage_timeline) {
          if (!e || !VALID_STAGES.includes(e.stage)) throw new ValidationError(`timeline stage must be one of ${VALID_STAGES.join(', ')}`, 'stage_timeline');
          const d = Number(e.from_day);
          if (!Number.isInteger(d) || d < 0 || d > 1000) throw new ValidationError('timeline from_day must be a whole number 0-1000', 'stage_timeline');
          if (seen.has(d)) throw new ValidationError('timeline from_day values must be unique', 'stage_timeline');
          seen.add(d);
        }
        out.stage_timeline = JSON.stringify(normTimeline(b.stage_timeline));
      }
    }
    if (b.zone_id !== undefined && b.zone_id !== null) {
      const z = this.db.prepare('SELECT id FROM zones WHERE id = ?').get(parseInt(b.zone_id, 10));
      if (!z) throw new ValidationError('zone not found', 'zone_id');
      out.zone_id = z.id;
    }
    if (requireCrop && !out.crop) throw new ValidationError('crop is required', 'crop');
    if (b.crop !== undefined && !out.crop) throw new ValidationError('crop is required', 'crop');
    return out;
  }

  // ---------- writes ----------

  /** Mirror the profile onto its crop_assignments row (legacy readers, A64Core). */
  _syncCropAssignment(profileId) {
    const p = this.getRow(profileId);
    if (!p || !p.crop_assignment_id) return;
    const stage = computeStage(p, { today: this.today() });
    const planted = p.transplant_date ? `${p.transplant_date}T00:00:00Z` : null;
    const plants = this.plants(p);
    this.db.prepare(`
      UPDATE crop_assignments SET crop_name = ?, variety = ?, planted_date = COALESCE(?, planted_date),
        current_stage = COALESCE(?, current_stage), soil_type = ?, plant_count = COALESCE(?, plant_count),
        substrate_volume_l_per_plant = COALESCE(?, substrate_volume_l_per_plant), updated_at = datetime('now')
      WHERE id = ?
    `).run(p.crop, p.variety, planted, stage.effective, p.substrate_type, plants.source === 'entered' || plants.source === 'density_area' ? plants.total : null, p.substrate_volume_l, p.crop_assignment_id);
  }

  /** Keep crop_assignments.current_stage in step with the effective stage. Returns true when it changed. */
  syncStage(profileId, nowMs = this.now()) {
    const p = this.getRow(profileId);
    if (!p || !p.crop_assignment_id) return false;
    const stage = computeStage(p, { today: this.today(nowMs) });
    if (!stage.effective) return false;
    const ca = this.db.prepare('SELECT current_stage FROM crop_assignments WHERE id = ?').get(p.crop_assignment_id);
    if (!ca || ca.current_stage === stage.effective) return false;
    this.db.prepare("UPDATE crop_assignments SET current_stage = ?, last_stage_update_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(stage.effective, p.crop_assignment_id);
    return true;
  }

  /**
   * New crop cycle for a zone: the previous active profile (and its crop row) is
   * closed, history kept. Creates the crop_assignments row the profile links to.
   * Optional protocol_id pre-fills its stage + element targets.
   */
  create(input, { userId = null } = {}) {
    const f = this._cleanFields(input, { requireCrop: true });
    const zoneId = f.zone_id || (this.db.prepare('SELECT id FROM zones WHERE is_crop_zone = 1 LIMIT 1').get() || {}).id;
    if (!zoneId) throw new ValidationError('zone_id is required (no primary crop zone configured)', 'zone_id');
    let protocol = null;
    if (input && input.protocol_id) {
      protocol = this.protocolRow(parseInt(input.protocol_id, 10));
      if (!protocol) throw new ValidationError('protocol not found', 'protocol_id');
    }
    const zone = this.db.prepare('SELECT id, block_id FROM zones WHERE id = ?').get(zoneId);
    const blockId = zone.block_id || `zone-${zoneId}`;
    const now = new Date(this.now()).toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE crop_profiles SET active = 0, ended_at = ?, updated_at = ? WHERE zone_id = ? AND active = 1").run(now, now, zoneId);
      this.db.prepare('UPDATE crop_assignments SET active = 0, updated_at = ? WHERE (block_id = ? OR zone_id = ?) AND active = 1').run(now, blockId, zoneId);
      const ca = this.db.prepare(`
        INSERT INTO crop_assignments (block_id, zone_id, crop_name, variety, planted_date, current_stage, soil_type,
          received_at, last_stage_update_at, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'seedling', ?, ?, ?, 1, ?, ?)
      `).run(blockId, zoneId, f.crop, f.variety || null, f.transplant_date ? `${f.transplant_date}T00:00:00Z` : null, f.substrate_type || null, now, now, now, now);
      const caId = Number(ca.lastInsertRowid);
      const timeline = f.stage_timeline || (protocol ? JSON.stringify(protocol.data.stage_timeline || []) : null);
      const cols = { ...f, zone_id: zoneId, crop_assignment_id: caId, protocol_id: protocol ? protocol.id : null, active: 1, stage_timeline: timeline, created_by: userId, updated_by: userId };
      if (f.stage_override) cols.stage_override_at = now;
      const keys = Object.keys(cols);
      const r = this.db.prepare(`INSERT INTO crop_profiles (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => cols[k]));
      const id = Number(r.lastInsertRowid);
      if (protocol) require('../utils/cropNutritionSchema').seedProfileTargets(this.db, id, caId, protocol.data);
      return id;
    });
    const id = tx();
    this._syncCropAssignment(id);
    return this.getProfile(id);
  }

  update(id, input, { userId = null } = {}) {
    const row = this.getRow(id);
    if (!row) { const e = new Error('Crop profile not found'); e.status = 404; throw e; }
    const f = this._cleanFields(input);
    delete f.zone_id; // a profile does not move between zones; start a new cycle instead
    if (input && input.protocol_id !== undefined) {
      if (input.protocol_id === null) f.protocol_id = null;
      else {
        const p = this.protocolRow(parseInt(input.protocol_id, 10));
        if (!p) throw new ValidationError('protocol not found', 'protocol_id');
        f.protocol_id = p.id;
      }
    }
    if ('stage_override' in f) {
      f.stage_override_at = f.stage_override ? new Date(this.now()).toISOString() : null;
      if (!f.stage_override && !('stage_override_note' in f)) f.stage_override_note = null;
    }
    const keys = Object.keys(f);
    if (keys.length) {
      this.db.prepare(`UPDATE crop_profiles SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map(k => f[k]), userId, id);
    }
    this._syncCropAssignment(id);
    return this.getProfile(id);
  }

  /**
   * Upsert stage targets and element targets.
   * body: { stage_targets: [{ stage, ec_min, … }], element_targets: [{ stage, element, hard_min, soft_target, hard_max, priority? }] }
   */
  setTargets(id, body, { userId = null } = {}) {
    const row = this.getRow(id);
    if (!row) { const e = new Error('Crop profile not found'); e.status = 404; throw e; }
    const st = Array.isArray(body && body.stage_targets) ? body.stage_targets : [];
    const et = Array.isArray(body && body.element_targets) ? body.element_targets : [];
    if (st.length > 12 || et.length > 12 * TARGET_ELEMENTS.length) throw new ValidationError('too many targets');
    const cleanStage = st.map(t => {
      if (!t || !VALID_STAGES.includes(t.stage)) throw new ValidationError(`stage must be one of ${VALID_STAGES.join(', ')}`, 'stage');
      const o = { stage: t.stage };
      for (const [k, [lo, hi]] of Object.entries(STAGE_NUM_FIELDS)) {
        const v = t[k];
        if (v === undefined || v === null || v === '') { o[k] = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw new ValidationError(`${t.stage}.${k} must be between ${lo} and ${hi}`, k);
        o[k] = n;
      }
      for (const [a, b] of [['ec_min', 'ec_max'], ['ph_min', 'ph_max'], ['drain_pct_min', 'drain_pct_max'], ['drain_ph_min', 'drain_ph_max'], ['ml_min', 'ml_max'], ['ec_min', 'ec_target'], ['ec_target', 'ec_max'], ['ml_min', 'ml_target'], ['ml_target', 'ml_max'], ['drain_pct_min', 'drain_pct_target'], ['drain_pct_target', 'drain_pct_max']]) {
        if (o[a] != null && o[b] != null && o[a] > o[b]) throw new ValidationError(`${t.stage}: ${a} must not exceed ${b}`, a);
      }
      o.notes = t.notes ? String(t.notes).slice(0, 300) : null;
      return o;
    });
    const cleanEl = et.map(t => {
      if (!t || !VALID_STAGES.includes(t.stage)) throw new ValidationError('element target stage invalid', 'stage');
      if (!TARGET_ELEMENTS.includes(t.element)) throw new ValidationError(`element must be one of ${TARGET_ELEMENTS.join(', ')}`, 'element');
      const o = { stage: t.stage, element: t.element };
      for (const k of ['hard_min', 'soft_target', 'hard_max']) {
        const v = t[k];
        if (v === undefined || v === null || v === '') { o[k] = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 5000) throw new ValidationError(`${t.stage}.${t.element}.${k} must be between 0 and 5000`, k);
        o[k] = n;
      }
      if (o.hard_min != null && o.soft_target != null && o.hard_min > o.soft_target) throw new ValidationError(`${t.stage}.${t.element}: min above target`, 'hard_min');
      if (o.soft_target != null && o.hard_max != null && o.soft_target > o.hard_max) throw new ValidationError(`${t.stage}.${t.element}: target above max`, 'hard_max');
      if (o.hard_min != null && o.hard_max != null && o.hard_min > o.hard_max) throw new ValidationError(`${t.stage}.${t.element}: min above max`, 'hard_min');
      o.priority = t.priority === undefined || t.priority === null || t.priority === '' ? null : Math.max(1, Math.min(5, parseInt(t.priority, 10) || 3));
      o.notes = t.notes ? String(t.notes).slice(0, 300) : null;
      return o;
    });
    if (cleanEl.length && !row.crop_assignment_id) throw new ValidationError('profile has no crop link for element targets');
    const upStage = this.db.prepare(`
      INSERT INTO crop_stage_targets (profile_id, stage, ${Object.keys(STAGE_NUM_FIELDS).join(', ')}, source, notes, updated_at)
      VALUES (@profile_id, @stage, ${Object.keys(STAGE_NUM_FIELDS).map(k => '@' + k).join(', ')}, 'operator', @notes, datetime('now'))
      ON CONFLICT(profile_id, stage) DO UPDATE SET ${Object.keys(STAGE_NUM_FIELDS).map(k => `${k} = excluded.${k}`).join(', ')},
        source = 'operator', notes = excluded.notes, updated_at = excluded.updated_at
    `);
    const findEl = this.db.prepare('SELECT id FROM crop_element_targets WHERE crop_assignment_id = ? AND growth_stage = ? AND element = ?');
    const insEl = this.db.prepare('INSERT INTO crop_element_targets (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const updEl = this.db.prepare('UPDATE crop_element_targets SET hard_min = ?, soft_target = ?, hard_max = ?, priority = COALESCE(?, priority), notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const o of cleanStage) upStage.run({ profile_id: id, ...o });
      for (const o of cleanEl) {
        const ex = findEl.get(row.crop_assignment_id, o.stage, o.element);
        if (ex) updEl.run(o.hard_min, o.soft_target, o.hard_max, o.priority, o.notes, ex.id);
        else insEl.run(row.crop_assignment_id, o.stage, o.element, o.hard_min, o.soft_target, o.hard_max, o.priority ?? 3, o.notes);
      }
      this.db.prepare("UPDATE crop_profiles SET updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(userId, id);
    });
    tx();
    return this.getProfile(id);
  }

  /** Replace the stage + element targets with the linked protocol's defaults. */
  resetTargetsToProtocol(id, { userId = null } = {}) {
    const row = this.getRow(id);
    if (!row) { const e = new Error('Crop profile not found'); e.status = 404; throw e; }
    const protocol = this.protocolRow(row.protocol_id);
    if (!protocol) throw new ValidationError('profile has no protocol baseline');
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM crop_stage_targets WHERE profile_id = ?').run(id);
      if (row.crop_assignment_id) {
        const stages = Object.keys(protocol.data.stage_targets || {});
        if (stages.length) {
          this.db.prepare(`DELETE FROM crop_element_targets WHERE crop_assignment_id = ? AND growth_stage IN (${stages.map(() => '?').join(',')})`).run(row.crop_assignment_id, ...stages);
        }
      }
      require('../utils/cropNutritionSchema').seedProfileTargets(this.db, id, row.crop_assignment_id, protocol.data);
      this.db.prepare("UPDATE crop_profiles SET updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(userId, id);
    });
    tx();
    return this.getProfile(id);
  }

  /**
   * Scale a stage's element targets to its input EC target (protocol ratios kept).
   * Preview (default) writes nothing. Apply writes every row whose action is
   * update / insert and records the new basis; hand-edited rows are kept unless
   * named in `include` (element list, or true for all).
   * @returns {{ stage, ok, reason?, factor, math, rows, kept_manual, applied, written, profile? }}
   */
  scaleTargetsToEc(id, { stage, preview = true, include = [] } = {}, { userId = null } = {}) {
    const row = this.getRow(id);
    if (!row) { const e = new Error('Crop profile not found'); e.status = 404; throw e; }
    if (!VALID_STAGES.includes(stage)) throw new ValidationError(`stage must be one of ${VALID_STAGES.join(', ')}`, 'stage');
    if (!row.crop_assignment_id) throw new ValidationError('profile has no crop link for element targets');
    if (include !== true && (!Array.isArray(include) || include.some(el => !TARGET_ELEMENTS.includes(el)))) {
      throw new ValidationError(`include must be true or a list of ${TARGET_ELEMENTS.join(', ')}`, 'include');
    }
    const protocol = this.protocolRow(row.protocol_id);
    const stagePpm = protocol ? ScaleMath.protocolStagePpm(protocol.data, stage, this._library()) : null;
    const st = this.stageTargets(id)[stage] || null;
    const current = (this.elementTargets(row.crop_assignment_id)[stage]) || [];
    const r = ScaleMath.scaleElementTargets({
      stagePpm, ecTarget: st ? st.ec_target : null, sourceWaterEc: row.source_water_ec, current, include,
    });
    const reason = !protocol ? 'no_protocol' : r.reason;
    const out = { stage, ok: r.ok, ...(r.ok ? {} : { reason }), factor: r.ok ? r.math.factor : null, math: r.math, rows: r.rows, kept_manual: r.kept_manual, applied: false, written: 0 };
    if (preview) return out;
    if (!r.ok) {
      const e = new ValidationError(`element targets not scaled: ${reason}`, 'stage');
      e.status = 409; e.code = 'SCALE_NOT_POSSIBLE'; e.reason = reason;
      throw e;
    }
    const byEl = new Map(current.map(c => [c.element, c]));
    const upd = this.db.prepare(`
      UPDATE crop_element_targets SET hard_min = ?, soft_target = ?, hard_max = ?, priority = ?, notes = ?,
        basis_hard_min = ?, basis_soft_target = ?, basis_hard_max = ?, basis_source = 'scaled', basis_ec = ?, basis_factor = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    const ins = this.db.prepare(`
      INSERT INTO crop_element_targets (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes,
        basis_hard_min, basis_soft_target, basis_hard_max, basis_source, basis_ec, basis_factor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scaled', ?, ?)
    `);
    let written = 0;
    const tx = this.db.transaction(() => {
      for (const x of r.rows) {
        if (x.action === 'kept_manual') continue;
        const n = x.new;
        if (x.action === 'insert') {
          ins.run(row.crop_assignment_id, stage, x.element, n.hard_min, n.soft_target, n.hard_max, x.priority, x.notes, n.hard_min, n.soft_target, n.hard_max, r.math.ec_target, r.math.factor);
        } else {
          // 'unchanged' rows are re-based too, so they follow the next EC change
          upd.run(n.hard_min, n.soft_target, n.hard_max, x.priority, x.notes, n.hard_min, n.soft_target, n.hard_max, r.math.ec_target, r.math.factor, byEl.get(x.element).id);
        }
        if (x.action !== 'unchanged') written++;
      }
      this.db.prepare("UPDATE crop_profiles SET updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(userId, id);
    });
    tx();
    return { ...out, applied: true, written, profile: this.getProfile(id) };
  }

  // ---------- AI readers ----------

  /**
   * Compact profile facts for the agronomist / planner crop rows, keyed by
   * crop_assignment_id. Omits nothing that is set; unknowns are null.
   */
  compactForCrop(cropAssignmentId, nowMs = this.now()) {
    const row = this.db.prepare('SELECT * FROM crop_profiles WHERE crop_assignment_id = ? ORDER BY active DESC, id DESC LIMIT 1').get(cropAssignmentId);
    if (!row) return null;
    const p = this.resolve(row, { nowMs });
    const st = p.stage_targets[p.stage.effective] || null;
    return {
      profile_id: p.id,
      variety: p.variety,
      breeder: p.breeder,
      transplant_date: p.transplant_date,
      days_after_transplant: p.stage.days_after_transplant,
      stage: p.stage.effective,
      stage_source: p.stage.source,
      next_stage: p.stage.next ? { stage: p.stage.next.stage, date: p.stage.next.date } : null,
      substrate: p.substrate_type,
      plants: p.plants.total ? { total: p.plants.total, per_section: p.plants.per_section, source: p.plants.source } : null,
      stage_targets: st ? {
        input_ec: [st.ec_min, st.ec_target, st.ec_max], input_ph: [st.ph_min, st.ph_max],
        drain_pct: [st.drain_pct_min, st.drain_pct_target, st.drain_pct_max], drain_ec_delta_max: st.drain_ec_delta_max,
        ml_per_plant_day: [st.ml_min, st.ml_target, st.ml_max],
      } : null,
      protocol: p.protocol ? p.protocol.name : null,
    };
  }

  /** crop rows (crop_assignments shape) → same rows + `profile` when one exists. */
  enrichCropRows(rows, nowMs = this.now()) {
    return (rows || []).map(c => {
      let profile = null;
      try { profile = c && c.id ? this.compactForCrop(c.id, nowMs) : null; } catch (_) { profile = null; }
      if (!profile) return c;
      return { ...c, current_stage: profile.stage || c.current_stage, profile };
    });
  }
}

const cropProfileService = new CropProfileService();

module.exports = {
  cropProfileService,
  CropProfileService,
  computeStage,
  normTimeline,
  dayDiff,
  addDays,
  VALID_STAGES,
  TARGET_ELEMENTS,
  ValidationError,
};
