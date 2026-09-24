/**
 * AiDataSources — operator-controlled list of what the AI jobs may look at.
 *
 * One shared setting `ai_data_sources` (system_settings, JSON) consumed by BOTH
 * AgronomistService (daily report) and OperationalPlannerService (nightly plan).
 *
 * Why: parts of the farm are sometimes broken and cannot be fixed yet (the AMIC
 * analyser at 192.168.1.103 is unreachable "for the foreseeable future"). The
 * agronomist otherwise keeps reasoning about stale readings and keeps asking for
 * calibrations and samples the operator cannot perform. Disabling a source
 * OMITS its section from the snapshot (no null placeholders that invite
 * speculation) and adds an OUT OF SERVICE paragraph to the prompt.
 *
 * Shape:
 *   {
 *     sources: { <key>: { enabled: bool, reason: string|null, until: 'YYYY-MM-DD'|null } },
 *     excluded_equipment_ids: [int]
 *   }
 * Defaults: every source enabled. Unknown keys are rejected by validateConfig().
 * `until` in the past = source is enabled again (logged once per key).
 *
 * The filter helpers at the bottom are pure (no DB) so they are unit-testable
 * and the dry-run script replays the exact production code.
 */

const SETTING_KEY = 'ai_data_sources';

/** Source catalogue — derived from what the two snapshot builders actually include. */
const SOURCES = [
  {
    key: 'amic',
    label: 'AMIC nutrient analyser',
    feeds: 'Ion samples (NO3, NH4, K, Ca, Mg, Na, pH) the analyser writes into the lab section, with their 90-day trends. Feed/drain nutrient status.',
    template_keywords: /\bamic\b|analy[sz]er/i,
  },
  {
    key: 'lab',
    label: 'Manual lab readings',
    feeds: 'Hand-entered lab results (irrigation / drain / other), latest per nutrient and trends.',
    template_keywords: null,
  },
  {
    key: 'water_controller',
    label: 'SEKO Kontrol 800 water controller',
    feeds: 'pH, ORP, free chlorine, water EC and water temperature of the fertigation water (equipment 17).',
    template_keywords: /\bseko\b|kontrol/i,
  },
  {
    key: 'canopy_capture',
    label: 'Canopy camera capture',
    feeds: 'The noon greenhouse photo attached to the daily report (canopy colour, wilting, pests).',
    template_keywords: /camera|canopy|capture/i,
  },
  {
    key: 'energy',
    label: 'Energy meters',
    feeds: 'Circutor CEM-C31 meters (equipment 13, 14): power, current, voltage and consumption.',
    template_keywords: /\benergy\b|kwh|power consumption/i,
  },
  {
    key: 'fertigation',
    label: 'Fertigation system',
    feeds: 'Dispensing logs, stock tanks, dose programs, element targets, ingredient library and the daily delivery estimate.',
    template_keywords: /fertigation|dose program|dosing|mixing pump/i,
  },
  {
    key: 'substrate_sensors',
    label: 'Substrate sensors',
    feeds: 'Seeed substrate probes (equipment 7, 12): moisture, pore EC, substrate temperature, and the per-zone drainage diagnostics.',
    template_keywords: /substrate|\bvwc\b|moisture/i,
  },
  {
    key: 'climate_sensors',
    label: 'Climate sensors',
    feeds: 'SHT20 temperature / humidity / VPD sensors (equipment 8, 9) and the reference temperature and humidity blocks.',
    template_keywords: /temperature|humidity|\bvpd\b/i,
  },
  {
    key: 'alerts',
    label: 'Alerts',
    feeds: "The day's alerts (severity, message, equipment, zone).",
    template_keywords: null,
  },
  {
    key: 'operator_tasks',
    label: 'Operator tasks',
    feeds: 'Open and snoozed operator tasks from the last 7 days (task feedback loop).',
    template_keywords: null,
  },
  {
    key: 'automations_state',
    label: 'Automation run stats',
    feeds: 'Runs, failures and relay drift counts for the day. The planner always keeps its automation list — it needs it to write the apply manifest.',
    template_keywords: null,
  },
];

const SOURCE_KEYS = SOURCES.map(s => s.key);
const SOURCE_BY_KEY = Object.fromEntries(SOURCES.map(s => [s.key, s]));

function defaultConfig() {
  const sources = {};
  for (const k of SOURCE_KEYS) sources[k] = { enabled: true, reason: null, until: null };
  return { sources, excluded_equipment_ids: [] };
}

// ---------------------------------------------------------------------------
// Validation / normalisation (pure)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a full or partial config. Throws on unknown top-level keys, unknown
 * source keys, unknown fields inside a source, bad `until` dates, non-integer
 * equipment ids. Returns a normalised deep copy of the patch.
 */
function validateConfig(patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('ai_data_sources: config must be an object');
  }
  const out = {};
  for (const key of Object.keys(patch)) {
    if (key === 'sources') {
      const src = patch.sources;
      if (src == null || typeof src !== 'object' || Array.isArray(src)) throw new Error('ai_data_sources: sources must be an object');
      out.sources = {};
      for (const [k, v] of Object.entries(src)) {
        if (!SOURCE_BY_KEY[k]) throw new Error(`ai_data_sources: unknown source "${k}"`);
        if (v == null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`ai_data_sources: source "${k}" must be an object`);
        const entry = {};
        for (const [f, val] of Object.entries(v)) {
          if (f === 'enabled') {
            if (typeof val !== 'boolean') throw new Error(`ai_data_sources: ${k}.enabled must be boolean`);
            entry.enabled = val;
          } else if (f === 'reason') {
            if (val != null && typeof val !== 'string') throw new Error(`ai_data_sources: ${k}.reason must be a string or null`);
            entry.reason = val ? String(val).trim().slice(0, 300) || null : null;
          } else if (f === 'until') {
            if (val != null && val !== '') {
              const s = String(val).slice(0, 10);
              if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
                throw new Error(`ai_data_sources: ${k}.until must be an ISO date (YYYY-MM-DD) or null`);
              }
              entry.until = s;
            } else {
              entry.until = null;
            }
          } else if (f === 'effective_enabled' || f === 'expired' || f === 'label' || f === 'feeds') {
            // Read-only fields echoed back by the GET route; ignore silently on PUT.
          } else {
            throw new Error(`ai_data_sources: unknown field "${f}" on source "${k}"`);
          }
        }
        out.sources[k] = entry;
      }
    } else if (key === 'excluded_equipment_ids') {
      const ids = patch.excluded_equipment_ids;
      if (!Array.isArray(ids)) throw new Error('ai_data_sources: excluded_equipment_ids must be an array');
      const clean = [];
      for (const id of ids) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`ai_data_sources: bad equipment id "${id}"`);
        if (!clean.includes(n)) clean.push(n);
      }
      out.excluded_equipment_ids = clean.sort((a, b) => a - b);
    } else {
      throw new Error(`ai_data_sources: unknown key "${key}"`);
    }
  }
  return out;
}

/** Deep-merge a validated patch onto a full config. */
function mergeConfig(base, patch) {
  const merged = { sources: {}, excluded_equipment_ids: [...(base.excluded_equipment_ids || [])] };
  for (const k of SOURCE_KEYS) merged.sources[k] = { ...(base.sources?.[k] || { enabled: true, reason: null, until: null }) };
  if (patch.sources) {
    for (const [k, v] of Object.entries(patch.sources)) merged.sources[k] = { ...merged.sources[k], ...v };
  }
  if (patch.excluded_equipment_ids) merged.excluded_equipment_ids = patch.excluded_equipment_ids;
  // A re-enabled source drops its reason/until so it does not resurface stale text later.
  for (const k of SOURCE_KEYS) {
    if (merged.sources[k].enabled) { merged.sources[k].reason = null; merged.sources[k].until = null; }
  }
  return merged;
}

/** 'YYYY-MM-DD' of `now` in UTC-agnostic local terms (date only). */
function dateOnly(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Effective view of a config: `effective_enabled` per source honours `until`
 * (a source whose until date is strictly before today is back in use).
 * Also returns `disabled` (keys), and a `summary` suitable for snapshot_stats.
 */
function effectiveConfig(cfg, now = new Date()) {
  const base = mergeConfig(defaultConfig(), cfg && cfg.sources ? { sources: cfg.sources, excluded_equipment_ids: cfg.excluded_equipment_ids } : {});
  if (cfg && Array.isArray(cfg.excluded_equipment_ids)) base.excluded_equipment_ids = [...cfg.excluded_equipment_ids];
  const today = dateOnly(now);
  const sources = {};
  const disabled = [];
  const expired = [];
  for (const s of SOURCES) {
    const e = base.sources[s.key];
    const isExpired = !e.enabled && !!e.until && e.until < today;
    const effective = e.enabled || isExpired;
    sources[s.key] = {
      enabled: e.enabled,
      reason: e.reason || null,
      until: e.until || null,
      effective_enabled: effective,
      expired: isExpired,
      label: s.label,
      feeds: s.feeds,
    };
    if (!effective) disabled.push(s.key);
    if (isExpired) expired.push(s.key);
  }
  const excluded = [...base.excluded_equipment_ids];
  return {
    sources,
    excluded_equipment_ids: excluded,
    disabled,
    expired,
    isEnabled: key => !disabled.includes(key),
    isEquipmentExcluded: id => excluded.includes(Number(id)),
    summary: {
      disabled: disabled.map(k => ({ key: k, label: SOURCE_BY_KEY[k].label, reason: sources[k].reason, until: sources[k].until })),
      excluded_equipment_ids: excluded,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt text (pure)
// ---------------------------------------------------------------------------

/** One static line for the system prompt (keeps the cached system block stable). */
const SYSTEM_PROMPT_LINE = 'Out-of-service systems: the operator may take farm systems out of service (broken, awaiting parts, offline). Each run lists them in an "OUT OF SERVICE" paragraph after the JSON; their data is omitted from the snapshot on purpose. Ignore those systems completely unless the operator asks about them.';

/**
 * The paragraph appended to the user message when something is disabled.
 * @param eff  effectiveConfig() result
 * @param opts.equipmentNames { [id]: name } for excluded equipment
 * @param opts.audience 'agronomist' | 'planner'
 */
function outOfServiceNote(eff, opts = {}) {
  if (!eff) return null;
  const items = eff.disabled.map(k => {
    const s = eff.sources[k];
    const bits = [];
    if (s.reason) bits.push(`reason: ${s.reason}`);
    if (s.until) bits.push(`expected back on ${s.until}`);
    return `${s.label}${bits.length ? ` (${bits.join('; ')})` : ''}`;
  });
  const names = opts.equipmentNames || {};
  for (const id of eff.excluded_equipment_ids) {
    items.push(`equipment #${id}${names[id] ? ` ${names[id]}` : ''}`);
  }
  if (items.length === 0) return null;
  let note = `OUT OF SERVICE — the following systems are unavailable and MUST be ignored: ${items.join('; ')}. ` +
    'Their data has been removed from the snapshot on purpose. Do not reason about their readings, do not describe them as missing or stale, ' +
    'do not recommend calibrating, sampling or repairing them unless the operator asks, and do not create tasks that depend on them.';
  if (opts.audience === 'planner') {
    note += ' Do not propose plan steps, targets or automations that read from or actuate these systems, and do not pick templates that depend on them.';
  }
  return note;
}

// ---------------------------------------------------------------------------
// Equipment classification (pure)
// ---------------------------------------------------------------------------

/**
 * Which source governs a piece of equipment (by name/type). Returns a source key or null.
 * Order matters: the SEKO name contains "Fertigation" and the substrate probes are sensors.
 */
function classifyEquipment(eq) {
  if (!eq) return null;
  const name = String(eq.name || eq.equipment_name || '');
  const type = String(eq.type || eq.equipment_type || '').toLowerCase();
  if (/\bseko\b|kontrol/i.test(name)) return 'water_controller';
  if (type === 'meter' || /circutor|cem-c|energy meter|power meter/i.test(name)) return 'energy';
  if (/substrate|\bsoil\b|seeed/i.test(name)) return 'substrate_sensors';
  if (/sht\d|temp|humid|climate|\bvpd\b/i.test(name)) return 'climate_sensors';
  return null;
}

/** AMIC writes lab rows with notes "AMIC CHn (...)". Manual rows are anything else. */
function isAmicLabRow(row) {
  return /^\s*amic\b/i.test(String(row?.notes || ''));
}

/** Keep only the lab rows whose origin is still in service. */
function filterLabRows(rows, eff) {
  const amicOk = eff.isEnabled('amic');
  const labOk = eff.isEnabled('lab');
  return (rows || []).filter(r => (isAmicLabRow(r) ? amicOk : labOk));
}

// ---------------------------------------------------------------------------
// Snapshot filters (pure)
// ---------------------------------------------------------------------------

/**
 * Apply the data-source policy to an agronomist daily snapshot (the output of
 * aggregateDailyData). Returns a NEW object; disabled sections are omitted,
 * excluded equipment rows are dropped. Idempotent.
 */
function applyToAgronomistSnapshot(snapshot, eff) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const out = { ...snapshot };
  const excluded = id => eff.isEquipmentExcluded(id);
  const sourceOff = eq => { const k = classifyEquipment(eq); return k ? !eff.isEnabled(k) : false; };

  // sensors[] — per (equipment, metric) rows
  if (Array.isArray(out.sensors)) {
    out.sensors = out.sensors.filter(r => !excluded(r.equipment_id) && !sourceOff({ name: r.equipment_name, type: r.type }));
  }

  // reference_sensors — drop blocks by source or by excluded id; omit the key when nothing is left
  if (out.reference_sensors && typeof out.reference_sensors === 'object') {
    const ref = { ...out.reference_sensors };
    const dropBlock = (slot, srcKey) => {
      const b = ref[slot];
      if (!b) return;
      if (!eff.isEnabled(srcKey) || (b.equipment_id != null && excluded(b.equipment_id))) delete ref[slot];
    };
    dropBlock('temperature', 'climate_sensors');
    dropBlock('humidity', 'climate_sensors');
    dropBlock('soil', 'substrate_sensors');
    if (Object.keys(ref).length === 0) delete out.reference_sensors; else out.reference_sensors = ref;
  }

  // substrate_diagnostics — whole section by source, per-sensor rows by exclusion
  if (!eff.isEnabled('substrate_sensors')) {
    delete out.substrate_diagnostics;
  } else if (Array.isArray(out.substrate_diagnostics)) {
    out.substrate_diagnostics = out.substrate_diagnostics
      .map(z => ({ ...z, sensors: (z.sensors || []).filter(s => !excluded(s.equipment_id)) }))
      .filter(z => z.sensors.length > 0)
      .map(z => (z.sensor_count !== z.sensors.length ? { ...z, sensor_count: z.sensors.length } : z));
  }

  // lab — the row-level AMIC/manual split happens in filterLabRows() before
  // aggregation; here we only omit the whole section when both origins are off.
  if (!eff.isEnabled('amic') && !eff.isEnabled('lab')) delete out.lab;

  // dispensing — fertigation
  if (!eff.isEnabled('fertigation')) delete out.dispensing;
  else if (Array.isArray(out.dispensing)) out.dispensing = out.dispensing.filter(d => !excluded(d.equipment_id));

  // alerts
  if (!eff.isEnabled('alerts')) delete out.alerts;
  else if (Array.isArray(out.alerts)) out.alerts = out.alerts.filter(a => a.equipment_id == null || !excluded(a.equipment_id));

  if (!eff.isEnabled('operator_tasks')) delete out.operator_tasks;
  if (!eff.isEnabled('automations_state')) delete out.automations;

  return out;
}

/**
 * Apply the policy to the planner context (output of buildPlanningContext).
 * today_snapshot is expected to be filtered already (it comes from
 * aggregateDailyData) but is filtered again — idempotent. Mutates and returns ctx.
 */
function applyToPlannerContext(ctx, eff) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  if (ctx.today_snapshot) ctx.today_snapshot = applyToAgronomistSnapshot(ctx.today_snapshot, eff);

  if (!eff.isEnabled('fertigation')) {
    for (const k of ['fertigation_tanks', 'dose_programs', 'element_targets', 'ingredients_library', 'daily_delivery_estimate', 'water_pump_lpm', 'ionic_equivalence']) {
      delete ctx[k];
    }
  }
  if (!eff.isEnabled('operator_tasks')) delete ctx.operator_tasks;

  // Excluded equipment: out of the inventory the planner may actuate.
  if (Array.isArray(ctx.equipment)) ctx.equipment = ctx.equipment.filter(e => !eff.isEquipmentExcluded(e.id));
  if (Array.isArray(ctx.fertigation_tanks)) {
    ctx.fertigation_tanks = ctx.fertigation_tanks.filter(t => t.equipment_id == null || !eff.isEquipmentExcluded(t.equipment_id));
  }
  return ctx;
}

/**
 * Template ids whose text references a disabled source. Used by the planner's
 * consistency warnings when a proposed automation instantiates one of them.
 * @returns [{ template_id, template_name, source }]
 */
function templatesReferencingDisabled(templates, eff) {
  const hits = [];
  for (const t of templates || []) {
    const text = [t.name, t.description, t.agent_usage_notes].filter(Boolean).join(' ');
    for (const k of eff.disabled) {
      const re = SOURCE_BY_KEY[k].template_keywords;
      if (re && re.test(text)) hits.push({ template_id: t.id, template_name: t.name, source: k });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Service (DB-backed)
// ---------------------------------------------------------------------------

class AiDataSources {
  /** @param dbOverride better-sqlite3 handle (tests); defaults to the app DB, resolved lazily. */
  constructor(dbOverride = null) {
    this._db = dbOverride;
    this._expiryLogged = new Set();
  }

  get db() {
    if (!this._db) this._db = require('../utils/database').db;
    return this._db;
  }

  /** Stored config merged onto defaults (raw `enabled`, no `until` evaluation). */
  getConfig() {
    let stored = null;
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(SETTING_KEY);
      if (row?.value) stored = JSON.parse(row.value);
    } catch (err) {
      if (!/no such table/i.test(String(err?.message))) console.warn('[AiDataSources] read failed:', err.message);
    }
    if (!stored) return defaultConfig();
    try {
      return mergeConfig(defaultConfig(), validateConfig(stored));
    } catch (err) {
      console.warn('[AiDataSources] stored config invalid, using defaults:', err.message);
      return defaultConfig();
    }
  }

  /** Validate + merge + persist a partial config. Returns the stored (raw) config. */
  setConfig(patch) {
    const clean = validateConfig(patch || {});
    const merged = mergeConfig(this.getConfig(), clean);
    this.db.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
    ).run(SETTING_KEY, JSON.stringify(merged));
    return merged;
  }

  /** Effective config (honours `until`); logs each expiry once per process. */
  effective(now = new Date()) {
    const eff = effectiveConfig(this.getConfig(), now);
    for (const k of eff.expired) {
      if (this._expiryLogged.has(k)) continue;
      this._expiryLogged.add(k);
      console.log(`[AiDataSources] "${k}" was out of service until ${eff.sources[k].until}; that date has passed, treating it as in service again.`);
    }
    return eff;
  }

  isEnabled(key) {
    if (!SOURCE_BY_KEY[key]) throw new Error(`ai_data_sources: unknown source "${key}"`);
    return this.effective().isEnabled(key);
  }

  /** Out-of-service paragraph for the current config, with equipment names resolved. */
  outOfServiceNote(opts = {}) {
    const eff = opts.effective || this.effective();
    const names = {};
    if (eff.excluded_equipment_ids.length) {
      try {
        const rows = this.db.prepare(
          `SELECT id, name FROM equipment WHERE id IN (${eff.excluded_equipment_ids.map(() => '?').join(',')})`
        ).all(...eff.excluded_equipment_ids);
        for (const r of rows) names[r.id] = r.name;
      } catch {}
    }
    return outOfServiceNote(eff, { equipmentNames: names, audience: opts.audience });
  }
}

const aiDataSources = new AiDataSources();

module.exports = {
  aiDataSources,
  AiDataSources,
  SETTING_KEY,
  SOURCES,
  SOURCE_KEYS,
  SYSTEM_PROMPT_LINE,
  defaultConfig,
  validateConfig,
  mergeConfig,
  effectiveConfig,
  outOfServiceNote,
  classifyEquipment,
  isAmicLabRow,
  filterLabRows,
  applyToAgronomistSnapshot,
  applyToPlannerContext,
  templatesReferencingDisabled,
};
