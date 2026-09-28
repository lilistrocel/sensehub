/**
 * FertilizerAdvisorService — AI second opinion on what the plants are fed
 * (operator request 2026-09-28).
 *
 * ADVISORY ONLY. Nothing here (or anything reading its output) changes recipes,
 * dose programs, dosing ratios, tanks or automations. The human agronomist's
 * protocol (crop_protocols) stays authoritative; every recommendation says
 * whether it agrees with, extends or differs from it.
 *
 * Flow: snapshot (crop profile + stage, human protocol, profile targets, live
 * fertigation system, deterministic feed calculation today / 7 days, recipes,
 * feed EC/pH trend, water per plant, drain = not measured, lab / climate /
 * substrate / alerts per the AI data-source policy) → Claude (model + effort
 * from the agronomist config, structured output, streaming) → stop_reason +
 * JSON + content validation, one retry → fertilizer_advice row (every run is its
 * own row: a failure never replaces a good advice) → tr / ar translation in
 * the background (AgronomistTranslationService helpers).
 *
 * Triggers: manual (admin / operator), weekly (default Sunday 19:30, before the
 * agronomist weekly rollup) and automatic — debounced, at most once per 24 h —
 * when the crop stage changes, a tank mixture / refill changes or the dosing
 * ratio config changes (FertilizerAdvisorScheduler).
 */

const { db: defaultDb } = require('../utils/database');
const { getSystemTimezone, localDateStr } = require('../utils/systemTimezone');
const FC = require('./FeedCalculator');
const F = require('./fertilizerAdviceFormat');
const T = require('./AgronomistTranslationService');
const { CropProfileService } = require('./CropProfileService');
const { FertigationSystemView } = require('./FertigationSystemView');
const AiDS = require('./AiDataSources');

const CONFIG_KEY = 'fertilizer_advisor_config';
const STATE_KEY = 'fertilizer_advisor_state';
const MAX_TOKENS = 24000;
const MAX_ATTEMPTS = 2;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HARD_ERRORS = ['billing', 'auth'];
const ALERT_CLASSES = ['billing', 'auth', 'rate_limit', 'truncated_output', 'max_tokens', 'refusal'];
const ALERT_FINGERPRINT = 'fertilizer_advisor_provider_error';
const TRANSLATION_SUBJECT = 'a fertilizer advice (second opinion on a cucumber fertigation program) for a soilless greenhouse in the UAE';
const DAY_MS = 86400000;
const AGRONOMIST_ADVICE_MAX_AGE_DAYS = 14;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  weekly_enabled: true,
  weekly_day: 0,          // Sunday
  weekly_hour: 19,
  weekly_minute: 30,      // before the agronomist weekly rollup (20:30)
  auto_enabled: true,
  auto_min_interval_hours: 24,
  auto_debounce_minutes: 10,
});

const r1 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return dflt; }
}

function clampInt(v, lo, hi, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }

function sqliteTsToMs(s) {
  if (!s) return NaN;
  const str = String(s);
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(' ', 'T') + 'Z' : str).getTime();
}

const DTF_CACHE = new Map();
function localParts(ms, tz) {
  const zone = tz || 'UTC';
  let dtf = DTF_CACHE.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    DTF_CACHE.set(zone, dtf);
  }
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10), dow };
}

/** "A: Calcium Nitrate 100 kg" lines of a recipe / tank. */
function contentsLine(items) {
  return (items || []).map(i => `${i.label || i.name} ${i.amount} ${i.unit || 'kg'}`).join(' + ');
}

class FertilizerAdvisorService {
  /**
   * @param deps.db, deps.now, deps.log
   * @param deps.getClient   () => Anthropic client (throws without a key)
   * @param deps.getAgronomistConfig () => { model, effort, translation_enabled, translation_languages }
   * @param deps.getAgronomistHealth  () => { paused }
   * @param deps.createAlert
   * @param deps.dataSources () => effectiveConfig
   */
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || console;
    this._getClient = deps.getClient || (() => require('./AgronomistService').agronomistService._client_or_throw());
    this._getAgronomistConfig = deps.getAgronomistConfig || (() => require('./AgronomistService').agronomistService.getConfig());
    this._getAgronomistHealth = deps.getAgronomistHealth || (() => require('./AgronomistService').agronomistService.getHealth());
    this._classify = deps.classifyProviderError || ((err) => require('./AgronomistService').agronomistService.classifyProviderError(err));
    this._createAlert = deps.createAlert || ((o) => require('../utils/alertBroadcast').createAlert(o));
    this._dataSources = deps.dataSources || (() => new AiDS.AiDataSources(this.db).effective(new Date(this.now())));
    this.profiles = deps.profiles || new CropProfileService({ db: this._db, now: () => this.now() });
    this.systemView = deps.systemView || new FertigationSystemView({ db: this._db, now: () => this.now() });
    this._inflight = new Set();
    this._running = null; // advice id being generated
  }

  get db() { return this._db || defaultDb; }

  tz() { return getSystemTimezone(this.db); }

  // ---------- config / state ----------

  getConfig() {
    let stored = {};
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      stored = row && row.value ? JSON.parse(row.value) : {};
    } catch (_) { stored = {}; }
    return { ...DEFAULT_CONFIG, ...stored };
  }

  saveConfig(updates = {}) {
    const cur = this.getConfig();
    const u = updates || {};
    const bool = (k) => (u[k] === undefined ? cur[k] : !!u[k]);
    const next = {
      enabled: bool('enabled'),
      weekly_enabled: bool('weekly_enabled'),
      weekly_day: u.weekly_day === undefined ? cur.weekly_day : clampInt(u.weekly_day, 0, 6, cur.weekly_day),
      weekly_hour: u.weekly_hour === undefined ? cur.weekly_hour : clampInt(u.weekly_hour, 0, 23, cur.weekly_hour),
      weekly_minute: u.weekly_minute === undefined ? cur.weekly_minute : clampInt(u.weekly_minute, 0, 59, cur.weekly_minute),
      auto_enabled: bool('auto_enabled'),
      auto_min_interval_hours: u.auto_min_interval_hours === undefined ? cur.auto_min_interval_hours : clampInt(u.auto_min_interval_hours, 24, 24 * 14, cur.auto_min_interval_hours),
      auto_debounce_minutes: u.auto_debounce_minutes === undefined ? cur.auto_debounce_minutes : clampInt(u.auto_debounce_minutes, 1, 240, cur.auto_debounce_minutes),
    };
    this.db.prepare(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(CONFIG_KEY, JSON.stringify(next), this._sqlNow());
    return next;
  }

  /** Injected clock as ISO (fertilizer_advice times) / SQLite 'YYYY-MM-DD HH:MM:SS' (system_settings). */
  _isoNow() { return new Date(this.now()).toISOString(); }

  _sqlNow() { return this._isoNow().replace('T', ' ').slice(0, 19); }

  _configUpdatedAtMs() {
    try { return sqliteTsToMs((this.db.prepare('SELECT updated_at FROM system_settings WHERE key = ?').get(CONFIG_KEY) || {}).updated_at); } catch (_) { return NaN; }
  }

  getState() {
    try { return parseJson((this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(STATE_KEY) || {}).value, null); } catch (_) { return null; }
  }

  setState(state) {
    this.db.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).run(STATE_KEY, JSON.stringify(state));
  }

  _agronomistConfig() {
    try { return this._getAgronomistConfig() || {}; } catch (_) { return {}; }
  }

  model() { return this._agronomistConfig().model || 'claude-sonnet-5'; }

  effort(model = this.model()) {
    if (/haiku/i.test(model)) return null;
    const e = this._agronomistConfig().effort;
    if (e === 'default') return null;
    return EFFORT_LEVELS.includes(e) ? e : 'medium';
  }

  // ---------- health ----------

  getHealth() {
    const out = { consecutive_failures: 0, last_error_class: null, last_error: null, last_failure_at: null, last_success_at: null, paused: false, pause_reason: null, running_id: this._running };
    try {
      const recent = this.db.prepare("SELECT status, error, error_class, created_at FROM fertilizer_advice WHERE status <> 'running' ORDER BY created_at DESC, id DESC LIMIT 20").all();
      const lastOk = recent.find(r => r.status === 'success');
      out.last_success_at = lastOk ? lastOk.created_at : (this.db.prepare("SELECT created_at FROM fertilizer_advice WHERE status = 'success' ORDER BY id DESC LIMIT 1").get() || {}).created_at || null;
      let n = 0;
      for (const r of recent) { if (r.status !== 'failure') break; n++; }
      out.consecutive_failures = n;
      const lastFail = recent.find(r => r.status === 'failure');
      if (lastFail) { out.last_error_class = lastFail.error_class; out.last_error = lastFail.error; out.last_failure_at = lastFail.created_at; }
      const three = recent.slice(0, 3);
      if (three.length === 3 && three.every(r => r.status === 'failure' && HARD_ERRORS.includes(r.error_class))) {
        const cfgAt = this._configUpdatedAtMs();
        if (!(cfgAt > sqliteTsToMs(out.last_failure_at))) { out.paused = true; out.pause_reason = `${n} consecutive ${out.last_error_class} failures`; }
      }
    } catch (_) { /* table missing */ }
    if (!out.paused) {
      try {
        const ag = this._getAgronomistHealth();
        if (ag && ag.paused) { out.paused = true; out.pause_reason = 'agronomist runs are paused (same Anthropic account)'; }
      } catch (_) { /* ignore */ }
    }
    return out;
  }

  // ---------- snapshot ----------

  _library() {
    const stmt = this.db.prepare('SELECT name, composition, notes FROM fertigation_ingredients WHERE name = ?');
    return (name) => { try { return stmt.get(name) || null; } catch (_) { return null; } };
  }

  /** Climate day/night summary of the reference sensors, last `days` local days. */
  /** ISO start of the local day `days - 1` days before today (whole local days). */
  _localDaysStartIso(nowMs, tz, days) {
    const today = localParts(nowMs, tz).date;
    const first = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS);
    // local midnight = UTC midnight minus the zone offset at that instant
    const probe = localParts(first.getTime(), tz);
    const offsetMs = Date.parse(`${probe.date}T${String(probe.hour).padStart(2, '0')}:${String(probe.minute).padStart(2, '0')}:00Z`) - first.getTime();
    return new Date(first.getTime() - offsetMs).toISOString();
  }

  /** Minutes east of UTC for `tz` at `ms` (SQLite strftime modifier). */
  _offsetModifier(ms, tz) {
    const p = localParts(ms, tz);
    const local = Date.parse(`${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`);
    const off = Math.round((local - Math.floor(ms / 60000) * 60000) / 60000);
    return `${off >= 0 ? '+' : ''}${off} minutes`;
  }

  /** Per local day (and day 06-18 / night part) stats of one metric, aggregated in SQLite. */
  _dailyStats(equipmentId, metric, since, mod, { split = false } = {}) {
    const rows = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', timestamp, @mod) AS d,
             ${split ? "CASE WHEN CAST(strftime('%H', timestamp, @mod) AS INTEGER) BETWEEN 6 AND 17 THEN 'day' ELSE 'night' END" : "'all'"} AS part,
             AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
      FROM readings WHERE equipment_id = @eq AND name = @metric AND timestamp >= @since
      GROUP BY d, part
    `).all({ mod, eq: equipmentId, metric, since });
    const out = {};
    for (const r of rows) (out[r.d] = out[r.d] || {})[r.part] = { avg: r1(r.avg), min: r1(r.min), max: r1(r.max), n: r.n };
    return out;
  }

  /** Climate day/night summary of the reference sensors, last `days` local days. */
  _climate(ds, nowMs, tz, days = 3) {
    if (!ds.isEnabled('climate_sensors')) return undefined;
    const cfg = this._agronomistConfig();
    const tId = cfg.reference_temperature_equipment_id; const hId = cfg.reference_humidity_equipment_id || tId;
    const ok = (id) => id && !ds.isEquipmentExcluded(id);
    if (!ok(tId) && !ok(hId)) return { note: 'no reference climate sensor configured' };
    const since = this._localDaysStartIso(nowMs, tz, days);
    const mod = this._offsetModifier(nowMs, tz);
    const temp = ok(tId) ? this._dailyStats(tId, 'Temperature', since, mod, { split: true }) : {};
    const rh = ok(hId) ? this._dailyStats(hId, 'Humidity', since, mod, { split: true }) : {};
    const vpd = ok(tId) ? this._dailyStats(tId, 'VPD Air', since, mod, { split: true }) : {};
    const eq = this.db.prepare('SELECT name FROM equipment WHERE id = ?').get(ok(tId) ? tId : hId);
    const dates = [...new Set([...Object.keys(temp), ...Object.keys(rh)])].sort();
    return {
      sensor: eq ? eq.name : null,
      day_hours: '06:00-18:00 local',
      days: dates.map(date => ({
        date,
        day_temp_c: (temp[date] || {}).day || null, night_temp_c: (temp[date] || {}).night || null,
        day_rh_pct: (rh[date] || {}).day || null, night_rh_pct: (rh[date] || {}).night || null,
        day_vpd_air_kpa: (vpd[date] || {}).day || null,
      })),
    };
  }

  /** Substrate probes (moisture, pore EC, temperature) per local day. */
  _substrate(ds, nowMs, tz, days = 3) {
    if (!ds.isEnabled('substrate_sensors')) return undefined;
    const since = this._localDaysStartIso(nowMs, tz, days);
    const mod = this._offsetModifier(nowMs, tz);
    const probes = this.db.prepare('SELECT id, name, type FROM equipment').all()
      .filter(e => AiDS.classifyEquipment(e) === 'substrate_sensors' && !ds.isEquipmentExcluded(e.id));
    const out = [];
    for (const e of probes) {
      const m = this._dailyStats(e.id, 'Substrate Moisture', since, mod);
      const ec = this._dailyStats(e.id, 'Pore EC', since, mod);
      const t = this._dailyStats(e.id, 'Substrate Temperature', since, mod);
      for (const date of [...new Set([...Object.keys(m), ...Object.keys(ec)])].sort()) {
        out.push({ sensor: e.name, date, moisture_pct: (m[date] || {}).all || null, pore_ec_us_cm: (ec[date] || {}).all || null, substrate_temp_c: (t[date] || {}).all || null });
      }
    }
    return out;
  }

  _lab(ds, nowMs) {
    if (!ds.isEnabled('amic') && !ds.isEnabled('lab')) return undefined;
    const since = new Date(nowMs - 30 * DAY_MS).toISOString().slice(0, 10);
    const rows = AiDS.filterLabRows(this.db.prepare(`
      SELECT lr.sample_date, lr.nutrient, lr.value, lr.unit, lr.notes, z.name AS zone_name FROM lab_readings lr
      LEFT JOIN zones z ON z.id = lr.zone_id WHERE date(lr.sample_date) >= ? ORDER BY lr.sample_date DESC
    `).all(since), ds);
    const latest = {};
    for (const r of rows) {
      const k = `${r.zone_name || 'unassigned'}|${r.nutrient}`;
      if (!latest[k]) latest[k] = { zone: r.zone_name || null, nutrient: r.nutrient, value: r.value, unit: r.unit, sample_date: r.sample_date };
    }
    const list = Object.values(latest).slice(0, 40);
    return list.length ? { latest_30d: list } : { latest_30d: [], note: 'no lab or analyser sample in the last 30 days' };
  }

  _alerts(ds, nowMs) {
    if (!ds.isEnabled('alerts')) return undefined;
    const since = new Date(nowMs - 7 * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
    return this.db.prepare(`
      SELECT severity, source, message, created_at, occurrence_count, equipment_id FROM alerts
      WHERE created_at >= ? AND source IN ('dose_controller', 'flow_watch', 'fertigation')
      ORDER BY id DESC LIMIT 60
    `).all(since).filter(a => a.equipment_id == null || !ds.isEquipmentExcluded(a.equipment_id)).slice(0, 15).map(a => ({
      at: a.created_at, severity: a.severity, source: a.source, count: a.occurrence_count || 1, message: String(a.message || '').slice(0, 180),
    }));
  }

  /** Dose-controller trips of the last 7 days, counted per kind (and per tank for cant_reach / overdose). */
  _trips(nowMs) {
    const since = new Date(nowMs - 7 * DAY_MS).toISOString();
    const out = {};
    try {
      for (const r of this.db.prepare('SELECT trips_json FROM dose_controller_runs WHERE started_at >= ?').all(since)) {
        for (const t of parseJson(r.trips_json, [])) {
          if (!t || !t.kind) continue;
          const tank = /Tank\s+([A-Z])/.exec(String(t.detail || ''));
          const k = tank && ['cant_reach', 'overdose'].includes(t.kind) ? `${t.kind}:${tank[1]}` : t.kind;
          out[k] = (out[k] || 0) + 1;
        }
      }
    } catch (_) { /* table missing */ }
    return out;
  }

  _compactDelivered(rep, ds) {
    if (!rep) return null;
    const seko = ds.isEnabled('water_controller');
    return {
      period_dates: rep.period_dates,
      calc_basis: rep.basis,
      runs: rep.runs_count,
      water_l: rep.water_l,
      per_tank: rep.tanks.map(t => ({ tank: t.letter, dosed_l: t.dosed_l, achieved_ratio: t.achieved_ratio, configured_ratio: t.configured_ratio })),
      ppm: rep.ppm,
      ratios: rep.ratios,
      ec_recipe_calc_ms_cm: rep.ec.calc.ec_ms_cm,
      ion_balance: { cations_meq_l: rep.ec.calc.cations_meq_l, anions_meq_l: rep.ec.calc.anions_meq_l },
      ...(seko ? {
        ec_measured_ms_cm: rep.ec.measured_ms_cm,
        ec_measured_minus_calc_ms_cm: rep.ec.measured_minus_calc_ms_cm,
        ph_measured: rep.ph_measured,
      } : {}),
      acid_s: rep.acid_s,
      acid_est_l: rep.acid_est_l,
      ml_per_plant_day: rep.ml_per_plant_day,
      ...(rep.period === 'today' ? { partial_day: true } : {}),
    };
  }

  /**
   * Everything the advisor looks at. Facts only — no pre-written conclusions
   * (operator decision 2026-09-28: the advisor discovers deviations itself).
   * @returns {{ snapshot, calc, profile, dataSources }}
   */
  buildSnapshot({ profileId = null, nowMs = this.now() } = {}) {
    const ds = this._dataSources();
    const tz = this.tz();
    const profile = profileId ? this.profiles.getProfile(profileId, { nowMs }) : this.profiles.getActive(null, { nowMs });
    if (!profile) { const e = new Error('No active crop profile'); e.status = 409; e.code = 'NO_PROFILE'; throw e; }
    if (!ds.isEnabled('fertigation')) { const e = new Error('The fertigation data source is out of service (AI data sources): nothing to advise on'); e.status = 409; e.code = 'FERTIGATION_OUT_OF_SERVICE'; throw e; }
    const library = this._library();
    const protocolData = profile.protocol ? profile.protocol.data : null;
    const calc = {
      today: FC.buildFeedReport(this.db, { profile, period: 'today', nowMs, tz, protocolData, library }),
      week: FC.buildFeedReport(this.db, { profile, period: '7d', nowMs, tz, protocolData, library }),
    };
    const system = this.systemView.build({ profile, nowMs });
    const stage = profile.stage;
    const st = (s) => {
      const t = s && profile.stage_targets[s];
      if (!t) return null;
      return {
        input_ec_ms_cm: { min: t.ec_min, target: t.ec_target, max: t.ec_max },
        input_ph: { min: t.ph_min, max: t.ph_max },
        drain_pct: { min: t.drain_pct_min, target: t.drain_pct_target, max: t.drain_pct_max },
        drain_ec_above_input_max: t.drain_ec_delta_max,
        drain_ph_alarm: { min: t.drain_ph_min, max: t.drain_ph_max },
        ml_per_plant_day: { min: t.ml_min, target: t.ml_target, max: t.ml_max },
        source: t.source,
      };
    };
    const els = (s) => {
      const rows = (s && profile.element_targets[s]) || [];
      return rows.length ? Object.fromEntries(rows.map(r => [r.element, [r.hard_min, r.soft_target, r.hard_max]])) : null;
    };
    const nextStage = stage.next ? stage.next.stage : null;

    // Human protocol (facts as written) + its recipe ppm computed with the same analyses
    let humanProtocol = null;
    if (profile.protocol) {
      const pd = profile.protocol.data || {};
      const recipes = {};
      for (const [k, rec] of Object.entries(pd.recipes || {})) {
        const tanks = require('./cropProtocol').recipeTanks(pd, k, library);
        recipes[k] = {
          per_liters: rec.per_liters,
          tanks: Object.fromEntries(tanks.map(t => [t.letter, contentsLine(t.items)])),
          ppm_at_1_to_design: FC.mixPpm(tanks.map(t => ({ tank: t, fraction: 1 / (Number(pd.senseHub_design_dilution) || 150) }))).ppm,
        };
      }
      humanProtocol = {
        name: profile.protocol.name,
        source: profile.protocol.source,
        date: profile.protocol.source_date,
        author: profile.protocol.author,
        authoritative: true,
        crop: profile.protocol.crop,
        variety: profile.protocol.variety,
        breeder: profile.protocol.breeder,
        planting: pd.planting,
        stage_targets: pd.stage_targets,
        stage_recipe: pd.stage_recipe,
        recipes,
        recipe_ppm_note: `ppm_at_1_to_design = the recipe diluted 1:${pd.senseHub_design_dilution || 150} per tank (${pd.senseHub_design_dilution_note || 'SenseHub assumption'})`,
        daily_program: pd.daily_program,
        climate: pd.climate,
        timeline: pd.timeline,
      };
    }

    const seko = ds.isEnabled('water_controller');
    const plantsPer = profile.plants && profile.plants.total > 0 ? profile.plants.total : null;
    const waterByDay = {};
    for (const r of calc.week.runs) {
      const d = localParts(Date.parse(r.started_at), tz).date;
      waterByDay[d] = (waterByDay[d] || 0) + (Number(r.water_l) || 0);
    }
    const missing = [];
    missing.push('drain: no drain %, drain EC or drain pH is measured or entered in SenseHub');
    if (profile.source_water_ec == null) missing.push('source water EC not entered');
    if (profile.source_water_ph == null) missing.push('source water pH not entered');
    if (!ds.isEnabled('amic') && !ds.isEnabled('lab')) missing.push('lab / analyser data: out of service');
    if (!profile.plants || profile.plants.source !== 'entered') missing.push(`plant count not entered (${profile.plants && profile.plants.source ? `using ${profile.plants.source}` : 'unknown'})`);
    if (profile.buffer_tank_l == null) missing.push('buffer tank volume not entered');
    if (profile.substrate_volume_l == null) missing.push('substrate slab/bag volume not entered');
    const acidTank = system.tanks.find(t => t.role === 'ph_down');
    if (acidTank && !(acidTank.items || []).some(i => Object.keys(i.composition || {}).length)) missing.push('pH Down acid type and strength not recorded: its N / P contribution is not counted');

    const tankFacts = system.tanks.map(t => ({
      tank: t.letter, name: t.name, role: t.role, contents: contentsLine(t.items), per_liters: t.per_liters,
      analyses: Object.fromEntries((t.items || []).map(i => [i.name, i.composition])),
      analysis_notes: (t.items || []).filter(i => i.notes && /verify|confirm/i.test(i.notes)).map(i => `${i.name}: ${String(i.notes).slice(0, 200)}`),
      last_refill_at: t.last_refill_at, stock_l: t.stock_l, target_ratio: t.target_ratio,
      venturi_draw_lpm: { configured: t.configured_draw_lpm, measured_median_7d: t.measured_draw_lpm },
    }));

    const snapshot = {
      today: stage.today,
      farm_timezone: tz,
      advisory_only: 'SenseHub never applies this advice automatically; recipes, dose programs, ratios, tanks and automations are changed only by people.',
      crop_profile: {
        crop: profile.crop, variety: profile.variety, breeder: profile.breeder, planting_type: profile.planting_type,
        zone: profile.zone_name, transplant_date: profile.transplant_date,
        days_after_transplant: stage.days_after_transplant,
        stage: stage.effective, stage_source: stage.source,
        ...(stage.override ? { stage_override_note: stage.override.note } : {}),
        next_stage: stage.next ? { stage: stage.next.stage, date: stage.next.date, in_days: stage.next.in_days } : null,
        stage_timeline: stage.timeline,
        plants: profile.plants,
        plants_per_m2: profile.plants_per_m2, area_m2: profile.area_m2,
        substrate: { type: profile.substrate_type, slab_or_bag_volume_l: profile.substrate_volume_l, notes: profile.substrate_notes },
        not_measured_by_sensehub: {
          dripper_flow_lph: profile.dripper_flow_lph, drippers_per_plant: profile.drippers_per_plant,
          buffer_tank_l: profile.buffer_tank_l, source_water_ec_ms_cm: profile.source_water_ec, source_water_ph: profile.source_water_ph,
        },
      },
      human_protocol: humanProtocol,
      profile_targets: {
        note: 'Operator-editable targets in SenseHub (prefilled from the human protocol).',
        current_stage: { stage: stage.effective, ...st(stage.effective), elements_ppm_min_target_max: els(stage.effective) },
        ...(nextStage ? { next_stage: { stage: nextStage, ...st(nextStage), elements_ppm_min_target_max: els(nextStage) } } : {}),
      },
      fertigation_system: {
        source: 'derived live from SenseHub config and records',
        injection: system.injection,
        tanks: tankFacts,
        ph_line: system.ph_line,
        dosing_control: system.dosing,
        sections: system.sections.map(s => ({ name: s.name, measured_flow_lph: s.measured_flow_lph, scheduled_minutes_per_day: s.scheduled_minutes_per_day })),
        schedule: {
          runs: system.schedule.runs.map(r => ({ time: r.time, minutes_per_section: r.minutes_per_section, soft_switch_lead_s: r.zones[0] ? r.zones[0].lead_s : null, soft_switch_lag_s: r.zones[0] ? r.zones[0].lag_s : null })),
          runs_per_day: system.schedule.runs_per_day,
          minutes_per_section_per_day: system.schedule.minutes_per_section_per_day,
          ml_per_plant_day_from_dripper_flow: system.schedule.ml_per_plant_day_from_dripper,
        },
        protection_7d: { episodes: system.protection.episodes_7d, by_kind: system.protection.episodes_by_kind },
      },
      delivered: {
        method: 'ppm = stock mg/L (ingredient analyses) x measured concentrate L / measured water L; EC calc = recipe cations meq/L / 10, source water not included',
        today: this._compactDelivered(calc.today, ds),
        last_7_days: this._compactDelivered(calc.week, ds),
        assumptions: calc.week.assumptions,
      },
      current_tanks_at_configured_ratio_ppm: calc.today.configured_ratio_ppm,
      feed_runs_7d: calc.week.runs.map(r => {
        const lp = localParts(Date.parse(r.started_at), tz);
        return [
          `${lp.date.slice(5)} ${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`,
          r.type !== 'automated' ? r.type : null,
          r.status !== 'ok' ? r.status : null,
          `${Math.round(r.water_l)} L`,
          r.achieved_ratio ? `1:${r.achieved_ratio}` : null,
          seko && r.ec_ms != null ? `EC ${r.ec_ms}` : null,
          seko && r.ph != null ? `pH ${r.ph}` : null,
          r.acid_s ? `acid ${Math.round(r.acid_s)} s` : null,
          r.uncontrolled_dosing ? 'dosing outside SenseHub control' : null,
        ].filter(Boolean).join(' ');
      }).slice(-45),
      water_per_day_7d: Object.keys(waterByDay).sort().map(d => ({ date: d, water_l: Math.round(waterByDay[d]), ml_per_plant: plantsPer ? Math.round(waterByDay[d] / plantsPer * 1000) : null })),
      dose_controller_trips_7d: this._trips(nowMs),
      drain: { measured: false, note: 'SenseHub has no drain measurement: no drain %, drain EC or drain pH.' },
      lab: this._lab(ds, nowMs),
      climate: this._climate(ds, nowMs, tz),
      substrate_sensors: this._substrate(ds, nowMs, tz),
      alerts_7d: this._alerts(ds, nowMs),
      missing_data: missing,
    };
    for (const k of Object.keys(snapshot)) if (snapshot[k] === undefined) delete snapshot[k];
    return { snapshot, calc, profile, dataSources: ds };
  }

  buildRequest({ snapshot, dataSources }) {
    const ds = dataSources || this._dataSources();
    const model = this.model();
    const effort = this.effort(model);
    const system = `${F.SYSTEM_PROMPT}\n\n${AiDS.SYSTEM_PROMPT_LINE}`;
    let outOfService = null;
    try { outOfService = new AiDS.AiDataSources(this.db).outOfServiceNote({ effective: ds, audience: 'agronomist' }); } catch (_) { outOfService = null; }
    const userText = [
      `Today is ${snapshot.today} (timezone: ${snapshot.farm_timezone}). Crop: ${snapshot.crop_profile.crop}, day ${snapshot.crop_profile.days_after_transplant} after transplant, stage ${snapshot.crop_profile.stage}.`,
      '',
      'Here is the fertigation snapshot from the SenseHub edge controller:',
      '',
      '```json',
      JSON.stringify(snapshot),
      '```',
      '',
      'Give your second opinion on the fertilizer program: analysis, per-element verdicts, warnings, recommendations (each with vs_protocol) and questions. Base every number on the snapshot; say what is missing.',
      ...(outOfService ? ['', outOfService] : []),
    ].join('\n');
    const requestBody = {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: system }],
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema: F.OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    };
    return { requestBody, stats: { system_chars: system.length, user_chars: userText.length, snapshot_chars: JSON.stringify(snapshot).length, model, effort } };
  }

  /**
   * Cost estimate of one run from the snapshot size (no API call).
   * Output = thinking + JSON (~8k tokens at effort medium, observed range 5-12k);
   * translations ≈ 2 × (payload in + ~1.3× out).
   */
  estimate({ profileId = null } = {}) {
    const { snapshot, dataSources } = this.buildSnapshot({ profileId });
    const { stats } = this.buildRequest({ snapshot, dataSources });
    const model = stats.model;
    const inputTokens = Math.ceil((stats.system_chars + stats.user_chars) / 3.5);
    const expectedOutput = 8000;
    const langs = this._translationLangs();
    const trIn = 1500; const trOut = 3500;
    const main = T.estimateCost(model, { input: inputTokens, output: expectedOutput });
    const translations = langs.length * T.estimateCost(model, { input: trIn, output: trOut });
    const high = T.estimateCost(model, { input: inputTokens, output: 16000 }) + langs.length * T.estimateCost(model, { input: trIn * 1.5, output: trOut * 1.5 });
    return {
      model,
      effort: stats.effort,
      snapshot_chars: stats.snapshot_chars,
      input_tokens_est: inputTokens,
      output_tokens_est: expectedOutput,
      translation_languages: langs,
      usd_est: Math.round((main + translations) * 1000) / 1000,
      usd_high: Math.round(high * 1000) / 1000,
    };
  }

  // ---------- model call ----------

  async _callModel(client, body) {
    if (typeof client.messages.stream === 'function') {
      const stream = client.messages.stream(body);
      let stopDetails = null;
      if (stream && typeof stream.on === 'function') {
        stream.on('streamEvent', (ev) => { if (ev && ev.type === 'message_delta' && ev.delta && ev.delta.stop_details) stopDetails = ev.delta.stop_details; });
      }
      const msg = await stream.finalMessage();
      if (stopDetails && !msg.stop_details) msg.stop_details = stopDetails;
      return msg;
    }
    return client.messages.create(body);
  }

  _check(response) {
    const stop = response && response.stop_reason;
    if (stop === 'max_tokens') return { ok: false, errorClass: 'max_tokens', message: `output hit max_tokens (${(response.usage || {}).output_tokens ?? '?'} tokens)` };
    if (stop === 'refusal') {
      const d = response.stop_details;
      return { ok: false, errorClass: 'refusal', message: `model declined${d && d.category ? ` (${d.category})` : ''}` };
    }
    if (stop !== 'end_turn') return { ok: false, errorClass: 'truncated_output', message: `unexpected stop_reason '${stop}'` };
    const tb = (response.content || []).find(b => b.type === 'text');
    if (!tb || !tb.text) return { ok: false, errorClass: 'truncated_output', message: 'no text block in the response' };
    let parsed;
    try { parsed = JSON.parse(tb.text); } catch (e) { return { ok: false, errorClass: 'truncated_output', message: `invalid JSON: ${e.message}` }; }
    const v = F.validateAdviceOutput(parsed);
    if (!v.ok) return { ok: false, errorClass: 'truncated_output', message: v.problems.slice(0, 6).join('; ') };
    return { ok: true, parsed: F.normaliseAdvice(parsed), warnings: v.warnings };
  }

  _alert(errorClass, message) {
    if (!ALERT_CLASSES.includes(errorClass)) return;
    try {
      const { M } = require('../i18n');
      const health = this.getHealth();
      this._createAlert({
        severity: health.paused ? 'critical' : 'warning',
        source: 'fertilizer_advisor',
        fingerprint: ALERT_FINGERPRINT,
        messageKey: health.paused ? 'fertilizer_advisor.provider_alert_paused' : 'fertilizer_advisor.provider_alert',
        messageParams: { label: M(`agronomist_jobs.label.${errorClass}`), count: `${health.consecutive_failures}`, error: String(message || '').slice(0, 300) },
      });
    } catch (e) {
      this.log.error(`[FertilizerAdvisor] could not raise alert: ${e.message}`);
    }
  }

  /** True while a run is being generated. */
  isRunning() { return this._running !== null; }

  /**
   * Start a run: inserts the 'running' row and generates in the background.
   * @returns {{ id, promise }}  promise resolves to the final advice (never rejects)
   */
  start({ trigger = 'manual', triggerDetail = null, userId = null, profileId = null } = {}) {
    if (this._running !== null) { const e = new Error('An advisor run is already in progress'); e.status = 409; e.code = 'RUNNING'; e.running_id = this._running; throw e; }
    // Build the snapshot synchronously so data problems are reported to the caller at once.
    const nowMs = this.now();
    const built = this.buildSnapshot({ profileId, nowMs });
    const r = this.db.prepare(`
      INSERT INTO fertilizer_advice (profile_id, trigger, trigger_detail, status, snapshot, calc, model, created_by, created_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `).run(built.profile.id, trigger, triggerDetail ? JSON.stringify(triggerDetail) : null, JSON.stringify(built.snapshot),
      JSON.stringify({ today: built.calc.today, week: built.calc.week }), this.model(), userId, this._isoNow());
    const id = Number(r.lastInsertRowid);
    this._running = id;
    const p = this._generate(id, built)
      .catch(e => { this.log.error(`[FertilizerAdvisor] run ${id} crashed: ${e.message}`); return this.get(id); })
      .finally(() => { if (this._running === id) this._running = null; this._inflight.delete(p); });
    this._inflight.add(p);
    return { id, promise: p };
  }

  /** Run and wait (tests / scheduler). */
  async run(opts = {}) {
    const { promise } = this.start(opts);
    return promise;
  }

  async _generate(id, built) {
    const { requestBody, stats } = this.buildRequest({ snapshot: built.snapshot, dataSources: built.dataSources });
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = requestBody.model;
    const fail = (errorClass, message, stopReason, attempts) => {
      const cost = T.estimateCost(model, totals);
      this.db.prepare(`
        UPDATE fertilizer_advice SET status = 'failure', error = ?, error_class = ?, stop_reason = ?, attempts = ?,
          input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_estimate = ?,
          completed_at = ?
        WHERE id = ?
      `).run(String(message).slice(0, 2000), errorClass, stopReason || null, attempts, totals.input, totals.output, totals.cacheRead, totals.cacheWrite, cost, this._isoNow(), id);
      this.log.error(`[FertilizerAdvisor] run ${id} failed (${errorClass}) after ${attempts} attempt(s): ${message}`);
      this._alert(errorClass, message);
      return this.get(id);
    };
    let client;
    try { client = this._getClient(); } catch (e) { return fail('auth', e.message, null, 0); }
    let lastBad = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this._callModel(client, requestBody);
      } catch (err) {
        let cls = 'other';
        try { cls = this._classify(err); } catch (_) { cls = 'other'; }
        return fail(cls, String((err && err.message) || err), null, attempt);
      }
      const u = response.usage || {};
      totals.input += u.input_tokens || 0;
      totals.output += u.output_tokens || 0;
      totals.cacheRead += u.cache_read_input_tokens || 0;
      totals.cacheWrite += u.cache_creation_input_tokens || 0;
      this.log.log(`[FertilizerAdvisor] run ${id} attempt ${attempt}/${MAX_ATTEMPTS}: stop_reason=${response.stop_reason} in=${u.input_tokens || 0} out=${u.output_tokens || 0}/${requestBody.max_tokens} snapshot=${stats.snapshot_chars} chars`);
      const check = this._check(response);
      if (check.ok) {
        const cost = T.estimateCost(response.model || model, totals);
        this.db.prepare(`
          UPDATE fertilizer_advice SET status = 'success', output = ?, model = ?, stop_reason = ?, attempts = ?, error = NULL, error_class = NULL,
            input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, cost_estimate = ?,
            completed_at = ?
          WHERE id = ?
        `).run(JSON.stringify(check.parsed), response.model || model, response.stop_reason, attempt, totals.input, totals.output, totals.cacheRead, totals.cacheWrite, cost, this._isoNow(), id);
        if (check.warnings.length) this.log.warn(`[FertilizerAdvisor] run ${id} output warnings: ${check.warnings.join('; ')}`);
        this.enqueueTranslations(id);
        return this.get(id);
      }
      lastBad = { ...check, stopReason: response.stop_reason };
      this.log.error(`[FertilizerAdvisor] run ${id} attempt ${attempt} rejected (${check.errorClass}): ${check.message}`);
    }
    return fail(lastBad.errorClass, `Advice output rejected after ${MAX_ATTEMPTS} attempts (${lastBad.errorClass}): ${lastBad.message}`, lastBad.stopReason, MAX_ATTEMPTS);
  }

  /** Tests / shutdown: resolves when every run and translation finished. */
  async whenIdle() {
    while (this._inflight.size) await Promise.allSettled([...this._inflight]);
  }

  // ---------- translations ----------

  _translationLangs() {
    if (/^(0|off|false|no)$/i.test(String(process.env.AGRONOMIST_TRANSLATION || ''))) return [];
    const cfg = this._agronomistConfig();
    if (cfg.translation_enabled === false) return [];
    const langs = Array.isArray(cfg.translation_languages) ? cfg.translation_languages : T.TRANSLATION_LANGS;
    return langs.filter(l => T.TRANSLATION_LANGS.includes(l));
  }

  _translationRow(adviceId, lang) {
    try { return this.db.prepare('SELECT * FROM fertilizer_advice_translations WHERE advice_id = ? AND lang = ?').get(adviceId, lang) || null; } catch (_) { return null; }
  }

  _saveTranslation(adviceId, lang, r) {
    this.db.prepare(`
      INSERT INTO fertilizer_advice_translations (advice_id, lang, fields, status, source_hash, model, input_tokens, output_tokens, cost_estimate, attempts, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(advice_id, lang) DO UPDATE SET fields = COALESCE(excluded.fields, fertilizer_advice_translations.fields),
        status = excluded.status, source_hash = COALESCE(excluded.source_hash, fertilizer_advice_translations.source_hash),
        model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cost_estimate = excluded.cost_estimate, attempts = excluded.attempts, error = excluded.error, updated_at = excluded.updated_at
    `).run(adviceId, lang, r.fields ? JSON.stringify(r.fields) : null, r.status, r.sourceHash || null, r.model || null,
      r.input ?? null, r.output ?? null, r.cost ?? null, r.attempts ?? 0, r.error || null);
  }

  _hash(payload) { return require('crypto').createHash('sha1').update(JSON.stringify(payload)).digest('hex'); }

  async translate(adviceId, lang, { force = false } = {}) {
    try {
      if (!T.TRANSLATION_LANGS.includes(lang)) return { status: 'skipped' };
      const row = this.db.prepare("SELECT id, status, output FROM fertilizer_advice WHERE id = ?").get(adviceId);
      if (!row || row.status !== 'success') return { status: 'skipped' };
      const payload = F.translatablePayload(parseJson(row.output, {}));
      const hash = this._hash(payload);
      const ex = this._translationRow(adviceId, lang);
      if (!force && ex && ex.status === 'ready' && ex.source_hash === hash) return { status: 'ready', cached: true };
      let client;
      try { client = this._getClient(); } catch (e) {
        this._saveTranslation(adviceId, lang, { status: 'failed', error: e.message, model: this.model(), attempts: 0 });
        return { status: 'failed', error: e.message };
      }
      const r = await T.translatePayload({ client, lang, payload, model: this.model(), subject: TRANSLATION_SUBJECT, log: this.log });
      this._saveTranslation(adviceId, lang, { ...r, sourceHash: hash });
      this.log.log(`[FertilizerAdvisor] advice ${adviceId} ${lang}: ${r.status} in=${r.input} out=${r.output} ~$${(r.cost || 0).toFixed(4)}`);
      return r;
    } catch (e) {
      this.log.error(`[FertilizerAdvisor] translation ${adviceId} ${lang} crashed: ${e.message}`);
      try { this._saveTranslation(adviceId, lang, { status: 'failed', error: e.message, attempts: 0 }); } catch (_) { /* db gone */ }
      return { status: 'failed', error: e.message };
    }
  }

  /** Mark pending now, translate in the background (never throws, never awaited by the run). */
  enqueueTranslations(adviceId, { langs = null, force = false } = {}) {
    const list = (langs || this._translationLangs()).filter(l => T.TRANSLATION_LANGS.includes(l));
    if (!list.length) return [];
    for (const lang of list) {
      this.db.prepare(`
        INSERT INTO fertilizer_advice_translations (advice_id, lang, status, updated_at) VALUES (?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(advice_id, lang) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(adviceId, lang);
    }
    const p = new Promise(resolve => setImmediate(resolve))
      .then(async () => { for (const lang of list) await this.translate(adviceId, lang, { force }); })
      .catch(e => this.log.error(`[FertilizerAdvisor] translation queue ${adviceId} failed: ${e.message}`))
      .finally(() => this._inflight.delete(p));
    this._inflight.add(p);
    return list;
  }

  // ---------- read side ----------

  _format(row, { full = true } = {}) {
    if (!row) return null;
    const out = {
      id: row.id, profile_id: row.profile_id, trigger: row.trigger, trigger_detail: parseJson(row.trigger_detail, null),
      status: row.status, model: row.model, stop_reason: row.stop_reason, attempts: row.attempts,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens, cost_estimate: row.cost_estimate,
      error: row.error, error_class: row.error_class, created_by: row.created_by, created_at: row.created_at, completed_at: row.completed_at,
      advice: parseJson(row.output, null),
    };
    if (full) {
      out.snapshot = parseJson(row.snapshot, null);
      out.calc = parseJson(row.calc, null);
    }
    return out;
  }

  get(id, { full = true } = {}) {
    return this._format(this.db.prepare('SELECT * FROM fertilizer_advice WHERE id = ?').get(id), { full });
  }

  list({ limit = 30, offset = 0 } = {}) {
    const rows = this.db.prepare('SELECT id, profile_id, trigger, trigger_detail, status, model, stop_reason, attempts, input_tokens, output_tokens, cost_estimate, error, error_class, created_by, created_at, completed_at, output FROM fertilizer_advice ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200), Math.max(parseInt(offset, 10) || 0, 0));
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n;
    return {
      total,
      items: rows.map(r => {
        const f = this._format(r, { full: false });
        const a = f.advice;
        delete f.advice;
        return { ...f, advice_status: a ? a.status : null, summary: a ? a.summary : null, warnings_count: a ? a.warnings.length : 0 };
      }),
    };
  }

  /** Latest success + the newest row when it is newer (running / failed), for the page header. */
  latest() {
    const ok = this.db.prepare("SELECT * FROM fertilizer_advice WHERE status = 'success' ORDER BY created_at DESC, id DESC LIMIT 1").get();
    const newest = this.db.prepare('SELECT * FROM fertilizer_advice ORDER BY created_at DESC, id DESC LIMIT 1').get();
    return {
      advice: this._format(ok),
      newer: newest && (!ok || (newest.id !== ok.id && newest.created_at >= ok.created_at)) ? this._format(newest, { full: false }) : null,
    };
  }

  /**
   * An advice in `lang`: translated text fields merged over the English output.
   * translation_status: ready | pending | failed | original.
   */
  localize(advice, lang, { original = false } = {}) {
    if (!advice) return advice;
    const i18n = require('../i18n');
    const L = i18n.normalizeLang(lang) || 'en';
    if (L === 'en' || original || !T.TRANSLATION_LANGS.includes(L) || advice.status !== 'success' || !advice.advice) {
      return { ...advice, translation_status: 'original', translation_note: null, translation_language: 'en' };
    }
    const row = this._translationRow(advice.id, L);
    let status = row ? row.status : 'original';
    if (row && row.status === 'ready' && row.source_hash !== this._hash(F.translatablePayload(advice.advice))) status = 'pending';
    if (status !== 'ready') {
      const note = status === 'pending' ? i18n.t(L, 'fertilizer_advisor.translation_pending_note') : (status === 'failed' ? i18n.t(L, 'common.translation_failed_note') : null);
      return { ...advice, translation_status: status, translation_note: note, translation_language: 'en' };
    }
    return {
      ...advice,
      advice: F.mergeTranslation(advice.advice, parseJson(row.fields, {})),
      translation_status: 'ready', translation_note: null, translation_language: L, translation_model: row.model, translated_at: row.updated_at,
    };
  }

  /** Compact latest advice for the daily agronomist snapshot (null when none within 14 days). */
  compactForAgronomist(nowMs = this.now()) {
    let row;
    try { row = this.db.prepare("SELECT id, trigger, created_at, output FROM fertilizer_advice WHERE status = 'success' ORDER BY created_at DESC, id DESC LIMIT 1").get(); } catch (_) { return null; }
    if (!row) return null;
    const ageDays = (nowMs - Date.parse(row.created_at)) / DAY_MS;
    if (!(ageDays <= AGRONOMIST_ADVICE_MAX_AGE_DAYS)) return null;
    const a = parseJson(row.output, null);
    if (!a) return null;
    return {
      advice_id: row.id,
      generated_at: row.created_at,
      age_days: r1(ageDays),
      trigger: row.trigger,
      status: a.status,
      summary: String(a.summary || '').slice(0, 400),
      warnings: (a.warnings || []).slice(0, 5).map(w => `${w.severity}: ${String(w.message).slice(0, 200)}`),
      note: 'AI fertilizer advisor (second opinion on the human protocol; advisory only)',
    };
  }

  // ---------- automatic triggers ----------

  /** Signatures of what should re-trigger the advisor. */
  signatures(nowMs = this.now()) {
    const out = { stage: null, tanks: null, ratio: null };
    try {
      const p = this.profiles.getActive(null, { light: true, nowMs });
      out.stage = p ? `${p.id}:${p.stage.effective || 'none'}` : null;
    } catch (_) { out.stage = null; }
    try {
      const tanks = this.db.prepare('SELECT id, mixture_id, pending_mixture_id FROM fertigation_tanks WHERE COALESCE(active, 1) = 1 ORDER BY id').all();
      const mixIds = tanks.map(t => t.mixture_id).filter(Boolean);
      const items = mixIds.length ? this.db.prepare(`SELECT mixture_id, ingredient_id, amount, unit FROM fertigation_mixture_items WHERE mixture_id IN (${mixIds.map(() => '?').join(',')}) ORDER BY mixture_id, ingredient_id`).all(...mixIds) : [];
      const refill = this.db.prepare('SELECT MAX(id) AS id FROM fertigation_tank_refills').get();
      out.tanks = this._hash({ tanks, items, refill: refill ? refill.id : null });
    } catch (_) { out.tanks = null; }
    try {
      const cfg = FC.doseConfig(this.db);
      out.ratio = this._hash((cfg.nutrients && cfg.nutrients.ratio) || {});
    } catch (_) { out.ratio = null; }
    return out;
  }

  /**
   * Called every minute by the scheduler. Records changes as a pending trigger;
   * fires once the changes have settled for auto_debounce_minutes and at most
   * once per auto_min_interval_hours. A manual / weekly run after the change
   * covers it. Returns the started advice id or null.
   */
  checkAutoTriggers(nowMs = this.now()) {
    const cfg = this.getConfig();
    const sig = this.signatures(nowMs);
    let state = this.getState();
    if (!state || !state.sig) {
      this.setState({ sig, pending: null, last_auto_at: null });
      return null;
    }
    const reasons = [];
    if (sig.stage && state.sig.stage && sig.stage !== state.sig.stage) reasons.push('stage_change');
    if (sig.tanks && state.sig.tanks && sig.tanks !== state.sig.tanks) reasons.push('tank_change');
    if (sig.ratio && state.sig.ratio && sig.ratio !== state.sig.ratio) reasons.push('ratio_change');
    let changed = false;
    if (reasons.length) {
      const pend = state.pending || { reasons: [], first_at: nowMs };
      for (const r of reasons) if (!pend.reasons.includes(r)) pend.reasons.push(r);
      pend.last_change_at = nowMs;
      state = { ...state, sig: { ...state.sig, ...Object.fromEntries(Object.entries(sig).filter(([, v]) => v)) }, pending: pend };
      changed = true;
    }
    if (state.pending) {
      // a run that started after the change already covers it
      const covered = this.db.prepare("SELECT id FROM fertilizer_advice WHERE status IN ('running','success') AND created_at >= ? ORDER BY id DESC LIMIT 1")
        .get(new Date(state.pending.first_at).toISOString());
      if (covered) { state = { ...state, pending: null }; changed = true; }
    }
    let started = null;
    if (state.pending && cfg.enabled && cfg.auto_enabled) {
      const settled = nowMs - state.pending.last_change_at >= cfg.auto_debounce_minutes * 60000;
      const spaced = !state.last_auto_at || nowMs - state.last_auto_at >= cfg.auto_min_interval_hours * 3600000;
      if (settled && spaced && this._canRunScheduled()) {
        try {
          const trigger = state.pending.reasons[0];
          const { id } = this.start({ trigger, triggerDetail: { reasons: state.pending.reasons, first_change_at: new Date(state.pending.first_at).toISOString() } });
          started = id;
          state = { ...state, pending: null, last_auto_at: nowMs };
          changed = true;
        } catch (e) {
          if (e.code !== 'RUNNING') {
            this.log.warn(`[FertilizerAdvisor] automatic run not started: ${e.message}`);
            // data problem (no profile / out of service): drop the trigger, it would fail every minute
            if (e.code === 'NO_PROFILE' || e.code === 'FERTIGATION_OUT_OF_SERVICE') { state = { ...state, pending: null }; changed = true; }
          }
        }
      }
    }
    if (changed) this.setState(state);
    return started;
  }

  /** A closed-loop dose cycle is running right now (irrigation in progress). */
  _doseCycleRunning() {
    try { return !!this.db.prepare("SELECT 1 FROM dose_controller_runs WHERE status = 'running' LIMIT 1").get(); } catch (_) { return false; }
  }

  _canRunScheduled() {
    if (!process.env.ANTHROPIC_API_KEY) return false;
    // never build a snapshot in the middle of a dose cycle (keeps the event loop free for the controller)
    if (this._doseCycleRunning()) return false;
    const h = this.getHealth();
    if (h.paused) { this.log.warn(`[FertilizerAdvisor] scheduled/automatic run skipped: ${h.pause_reason}`); return false; }
    return true;
  }

  /** Weekly run at weekly_day weekly_hour:weekly_minute local, 30-min grace, once per local date. */
  checkWeekly(nowMs = this.now()) {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.weekly_enabled) return null;
    const lp = localParts(nowMs, this.tz());
    if (lp.dow !== cfg.weekly_day) return null;
    const minute = lp.hour * 60 + lp.minute;
    const target = cfg.weekly_hour * 60 + cfg.weekly_minute;
    if (minute < target || minute >= target + 30) return null;
    const state = this.getState() || {};
    if (state.last_weekly_date === lp.date) return null;
    if (!this._canRunScheduled()) return null;
    try {
      const { id } = this.start({ trigger: 'weekly', triggerDetail: { local_date: lp.date } });
      this.setState({ ...(this.getState() || {}), last_weekly_date: lp.date });
      return id;
    } catch (e) {
      if (e.code !== 'RUNNING') this.log.warn(`[FertilizerAdvisor] weekly run not started: ${e.message}`);
      if (e.code === 'NO_PROFILE' || e.code === 'FERTIGATION_OUT_OF_SERVICE') this.setState({ ...(this.getState() || {}), last_weekly_date: lp.date });
      return null;
    }
  }

  /** Keep crop_assignments.current_stage in step with the active profile(s). */
  syncStages(nowMs = this.now()) {
    let n = 0;
    try {
      for (const p of this.db.prepare('SELECT id FROM crop_profiles WHERE active = 1').all()) if (this.profiles.syncStage(p.id, nowMs)) n++;
    } catch (_) { /* table missing */ }
    return n;
  }
}

let singleton = null;
function getFertilizerAdvisor() {
  if (!singleton) singleton = new FertilizerAdvisorService();
  return singleton;
}

module.exports = {
  FertilizerAdvisorService,
  getFertilizerAdvisor,
  DEFAULT_CONFIG,
  CONFIG_KEY,
  STATE_KEY,
  MAX_TOKENS,
  TRANSLATION_SUBJECT,
  localParts,
};
