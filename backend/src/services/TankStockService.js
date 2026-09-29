'use strict';
/**
 * TankStockService — fertigation tank stock countdown (requirement 2026-09-29).
 *
 * WHY: fertigation_tanks.current_stock_liters never decreased (every tank still read
 * 1000 L four days after the 2026-09-25 remix), so nobody could see a tank running
 * empty — and a dry Tank D looks exactly like the 2026-09-29 07:30 "not drawing" run.
 *
 * WHAT: every change of a tank's stock is a row of tank_stock_ledger
 * (utils/tankStockSchema.js), and the level is REBUILT from it, never decremented in
 * place:  level = latest anchor (refill / manual adjust / first-seen) + the draws after it.
 *   - metered tanks (the irrigation monitor's tank map, role nutrient): the monitor's
 *     measured litres per irrigation cycle (irrigation_cycles.dosing_json) — every run
 *     type (automated, manual app, manual panel), one ledger row per cycle and tank
 *     (ref cycle:<farm>:<cycle_id>; a re-reported cycle updates its row).
 *   - pH Down (role ph_down, not metered): each ON->OFF pair of its valve's relay
 *     events x the dose controller's acid_lpm_estimate (ref acid:<ON event id>),
 *     flagged ESTIMATED everywhere (API, UI, alerts). An estimate raises a caution at
 *     most, never an alarm.
 *   - refills (fertigation_tank_refills) are anchors: their total_volume_after.
 * Idempotent: UNIQUE(tank_id, ref) — re-processing a cycle or relay event never
 * counts it twice; the level is recomputed from the ledger each time.
 *
 * Days left = level / average daily use over the last avg_days (3) days (or the
 * monitor's coverage if shorter, >= 12 h). Low stock: caution below caution_pct (20 %),
 * ALARM below alarm_pct (10 %) or with < alarm_days (1) of use left; per-tank
 * overrides in the 'tank_stock' setting. Fingerprinted alerts (tank_stock:<id>),
 * Telegram on a worsening transition, resolved (info) when the level recovers.
 *
 * READ-ONLY for the plant: no relay, coil or setpoint is ever touched.
 */

const i18n = require('../i18n');
const { M } = i18n;

const CONFIG_KEY = 'tank_stock';
const STATE_KEY = 'tank_stock_alert_state';
const DAY_MS = 86400000;
const DEBOUNCE_MS = 3000;
const TICK_MS = 5 * 60000;
const START_DELAY_MS = 8000;
const RECENT_MS = 2 * DAY_MS;          // periodic re-sync window
const MIN_AVG_SPAN_MS = 12 * 3600000;  // "days left" needs >= 12 h of use history

const DEFAULTS = Object.freeze({
  enabled: true,
  caution_pct: 20,
  alarm_pct: 10,
  alarm_days: 1,
  avg_days: 3,
  telegram: true,
  acid_max_open_s: 1500,   // an acid pulse longer than the relay safety max-on is capped (missing OFF event)
  per_tank: Object.freeze({}),
});

const RANK = { unknown: 0, ok: 0, caution: 1, alarm: 2 };

const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const isoOf = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** 'YYYY-MM-DD HH:MM:SS' (UTC, SQLite) or ISO 8601 with/without offset -> epoch ms. */
function toMs(s) {
  if (s === null || s === undefined || s === '') return null;
  const str = String(s);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** "Tank D — Fe EDDHA + Fetrilon Combi 2" -> "Tank D (Fe EDDHA + Fetrilon Combi 2)" (data, never translated). */
function tankLabel(name, id) {
  const parts = String(name || `Tank ${id}`).split(' — ');
  return parts.length > 1 && parts[1].trim() ? `${parts[0]} (${parts.slice(1).join(' — ').trim()})` : parts[0];
}

function validateConfig(upd) {
  if (!upd || typeof upd !== 'object' || Array.isArray(upd)) return { error: 'body must be a JSON object' };
  const out = {};
  const num = (k, v, min, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return `${k} must be a number between ${min} and ${max}`;
    return null;
  };
  const LIMITS = { caution_pct: [1, 90], alarm_pct: [0, 90], alarm_days: [0, 30], avg_days: [1, 14], acid_max_open_s: [10, 7200] };
  for (const [k, v] of Object.entries(upd)) {
    if (k === 'enabled' || k === 'telegram') {
      if (typeof v !== 'boolean') return { error: `${k} must be true or false` };
      out[k] = v;
    } else if (LIMITS[k]) {
      const e = num(k, v, ...LIMITS[k]);
      if (e) return { error: e };
      out[k] = v;
    } else if (k === 'per_tank') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'per_tank must be an object {tank_id: {caution_pct, alarm_pct, alarm_days}}' };
      const pt = {};
      for (const [tid, o] of Object.entries(v)) {
        if (!/^\d+$/.test(tid)) return { error: `per_tank: "${tid}" is not a tank id` };
        if (o === null) { pt[tid] = null; continue; }
        if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: `per_tank.${tid} must be an object or null` };
        const x = {};
        for (const [kk, vv] of Object.entries(o)) {
          if (!['caution_pct', 'alarm_pct', 'alarm_days'].includes(kk)) return { error: `unknown setting "per_tank.${tid}.${kk}"` };
          const e = num(`per_tank.${tid}.${kk}`, vv, ...LIMITS[kk]);
          if (e) return { error: e };
          x[kk] = vv;
        }
        pt[tid] = x;
      }
      out.per_tank = pt;
    } else {
      return { error: `unknown setting "${k}"` };
    }
  }
  return { value: out };
}

function mergeConfig(base, upd) {
  const out = { ...base, per_tank: { ...(base.per_tank || {}) } };
  if (!upd) return out;
  for (const [k, v] of Object.entries(upd)) {
    if (k === 'per_tank') {
      for (const [tid, o] of Object.entries(v || {})) {
        if (o === null) delete out.per_tank[tid];
        else out.per_tank[tid] = { ...(out.per_tank[tid] || {}), ...o };
      }
    } else out[k] = v;
  }
  return out;
}

/** Thresholds of one tank (global + per-tank override); caution is never below alarm. */
function thresholdsFor(cfg, tankId) {
  const o = (cfg.per_tank && (cfg.per_tank[tankId] || cfg.per_tank[String(tankId)])) || {};
  const alarm = o.alarm_pct ?? cfg.alarm_pct;
  return { caution_pct: Math.max(o.caution_pct ?? cfg.caution_pct, alarm), alarm_pct: alarm, alarm_days: o.alarm_days ?? cfg.alarm_days };
}

/**
 * Stock state from level / capacity / days left. Estimated levels (acid) are capped
 * at 'caution': an unverified estimate never raises an alarm.
 */
function stockState({ level, capacity, daysLeft, estimated = false, source }, th) {
  if (source === 'manual' || level === null || !(capacity > 0)) return 'unknown';
  const pct = (level / capacity) * 100;
  let state = 'ok';
  if (pct < th.caution_pct) state = 'caution';
  if (pct < th.alarm_pct || (daysLeft !== null && daysLeft !== undefined && daysLeft < th.alarm_days)) state = 'alarm';
  if (estimated && state === 'alarm') state = 'caution';
  return state;
}

class TankStockService {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {Function} [deps.now]
   * @param {object}   [deps.mqtt]             { onCycle(fn) } — MqttIngestService
   * @param {Function} [deps.createAlert]
   * @param {Function} [deps.updateOpenAlert]
   * @param {Function} [deps.notify]           (titleEn, bodyEn, severity, specs) — tests; default TelegramService
   * @param {Function} [deps.setTimer]         (fn, ms) => handle (tests)
   * @param {object}   [deps.logger]
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.now = deps.now || (() => Date.now());
    this.mqtt = deps.mqtt || null;
    this._createAlert = deps.createAlert || (() => null);
    this._updateOpenAlert = deps.updateOpenAlert || (() => null);
    this._notifyFn = deps.notify || null;
    this.log = deps.logger || console;
    this._setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    this._unsub = null;
    this.timer = null;
    this._debounce = null;
    this._pendingFrom = null;
    this._stmts = null;
    this.lastSync = null;
  }

  get stmts() {
    if (this._stmts) return this._stmts;
    const db = this.db;
    this._stmts = {
      upsertDraw: db.prepare(`
        INSERT INTO tank_stock_ledger (tank_id, kind, ref, litres, stock_after, estimated, occurred_at, detail_json, created_at, updated_at)
        VALUES (@tank_id, @kind, @ref, @litres, NULL, @estimated, @occurred_at, @detail_json, @now, @now)
        ON CONFLICT(tank_id, ref) DO UPDATE SET litres = excluded.litres, occurred_at = excluded.occurred_at,
          estimated = excluded.estimated, detail_json = excluded.detail_json, updated_at = excluded.updated_at
        WHERE tank_stock_ledger.litres IS NOT excluded.litres OR tank_stock_ledger.occurred_at IS NOT excluded.occurred_at
          OR tank_stock_ledger.detail_json IS NOT excluded.detail_json
      `),
      upsertAnchor: db.prepare(`
        INSERT INTO tank_stock_ledger (tank_id, kind, ref, litres, stock_after, estimated, occurred_at, detail_json, created_at, updated_at)
        VALUES (@tank_id, @kind, @ref, @litres, @stock_after, 0, @occurred_at, @detail_json, @now, @now)
        ON CONFLICT(tank_id, ref) DO UPDATE SET litres = excluded.litres, stock_after = excluded.stock_after,
          occurred_at = excluded.occurred_at, detail_json = excluded.detail_json, updated_at = excluded.updated_at
        WHERE tank_stock_ledger.stock_after IS NOT excluded.stock_after OR tank_stock_ledger.occurred_at IS NOT excluded.occurred_at
          OR tank_stock_ledger.litres IS NOT excluded.litres
      `),
      exists: db.prepare('SELECT id FROM tank_stock_ledger WHERE tank_id = ? AND ref = ?'),
      anchor: db.prepare('SELECT * FROM tank_stock_ledger WHERE tank_id = ? AND stock_after IS NOT NULL ORDER BY occurred_at DESC, id DESC LIMIT 1'),
      anyAnchor: db.prepare('SELECT 1 FROM tank_stock_ledger WHERE tank_id = ? AND stock_after IS NOT NULL LIMIT 1'),
      drawsAfter: db.prepare(`
        SELECT COALESCE(SUM(litres), 0) AS litres, COALESCE(SUM(CASE WHEN estimated = 1 THEN litres ELSE 0 END), 0) AS est,
               COUNT(*) AS n, MAX(occurred_at) AS last
        FROM tank_stock_ledger WHERE tank_id = ? AND stock_after IS NULL AND occurred_at > ?
      `),
      useSince: db.prepare("SELECT COALESCE(SUM(litres), 0) AS litres FROM tank_stock_ledger WHERE tank_id = ? AND kind IN ('cycle', 'acid') AND occurred_at >= ?"),
      setLevel: db.prepare('UPDATE fertigation_tanks SET current_stock_liters = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (current_stock_liters IS NULL OR ABS(current_stock_liters - ?) >= 0.005)'),
    };
    return this._stmts;
  }

  // ─── config ───────────────────────────────────────────────────────────────

  getConfig() {
    let stored = {};
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      if (row && row.value) {
        const { value, error } = validateConfig(JSON.parse(row.value));
        if (error) throw new Error(error);
        stored = value;
      }
    } catch (e) {
      this.log.error(`[TankStock] bad ${CONFIG_KEY} setting, using defaults: ${e.message}`);
    }
    return mergeConfig(DEFAULTS, stored);
  }

  saveConfig(updates) {
    const { value, error } = validateConfig(updates);
    if (error) { const e = new Error(error); e.status = 400; throw e; }
    const merged = mergeConfig(this.getConfig(), value);
    this.db.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(CONFIG_KEY, JSON.stringify(merged));
    try { this.evaluateAlerts(); } catch (e) { this.log.error(`[TankStock] alert evaluation failed: ${e.message}`); }
    return this.getConfig();
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.mqtt && typeof this.mqtt.onCycle === 'function' && !this._unsub) {
      this._unsub = this.mqtt.onCycle((cycle) => this.onCycle(cycle));
    }
    this._setTimer(() => {
      try {
        const r = this.sync({ backfill: true });
        this.log.log(`[TankStock] backfill: ${r.cycles} cycle rows, ${r.acid} acid rows, ${r.refills} refills; levels ${r.tanks.map(t => `${t.tank_id}=${t.level_l ?? '—'} L`).join(', ')}`);
      } catch (e) { this.log.error(`[TankStock] backfill failed: ${e.message}`); }
    }, START_DELAY_MS);
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.sync(); } catch (e) { this.log.error(`[TankStock] sync failed: ${e.message}`); }
      }, TICK_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /** A cycle report landed (MqttIngestService.onCycle): sync around it (debounced). */
  onCycle(cycle) {
    const s = cycle && cycle.start ? toMs(cycle.start) : null;
    const from = s !== null ? s - 3600000 : this.now() - RECENT_MS;
    this._pendingFrom = this._pendingFrom === null ? from : Math.min(this._pendingFrom, from);
    if (this._debounce) return;
    this._debounce = this._setTimer(() => {
      const f = this._pendingFrom;
      this._debounce = null;
      this._pendingFrom = null;
      try { this.sync({ fromMs: f }); } catch (e) { this.log.error(`[TankStock] sync failed: ${e.message}`); }
    }, DEBOUNCE_MS);
  }

  // ─── sync ─────────────────────────────────────────────────────────────────

  _tanks() {
    return this.db.prepare('SELECT id, name, role, equipment_id, channel, capacity_liters, current_stock_liters, active FROM fertigation_tanks ORDER BY id').all();
  }

  /** Monitor tank n -> fertigation tank id per farm (the same map the daily report uses). */
  _tankMap(farmId, activeIds) {
    const DR = require('./DailyReportService');
    return DR.loadTankMap(this.db, farmId, activeIds).map;
  }

  _acidLpm() {
    try {
      const DC = require('./DoseController');
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(DC.CONFIG_KEY);
      const stored = row && row.value ? (DC.validateConfigUpdate(JSON.parse(row.value)).value || {}) : {};
      const v = DC.mergeConfig(DC.DEFAULT_CONFIG, stored).ph.acid_lpm_estimate;
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch (_) { return null; }
  }

  /** Metering of a tank: 'measured' (monitor), 'estimated' (acid valve time), 'manual' (neither). */
  _sourceOf(tank, meteredIds) {
    if (tank.role === 'ph_down' && tank.equipment_id && tank.channel != null) return 'estimated';
    return meteredIds.has(tank.id) ? 'measured' : 'manual';
  }

  _meteredIds(tanks) {
    const ids = new Set();
    const active = new Set(tanks.filter(t => t.active !== 0).map(t => t.id));
    let farms = [];
    try { farms = this.db.prepare('SELECT DISTINCT farm_id FROM irrigation_cycles').all().map(r => r.farm_id); } catch (_) { farms = []; }
    for (const f of farms) {
      const map = this._tankMap(f, active);
      for (const id of Object.values(map)) {
        const t = tanks.find(x => x.id === id);
        if (t && (t.role || 'nutrient') === 'nutrient') ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Bring the ledger up to date and recompute every level. Idempotent.
   * { backfill: true } processes everything since each tank's anchor (as far as the
   * monitor cycles / relay events go back — see unmetered_gap);
   * { fromMs } re-processes cycles / relay events since then; default: the last 2 days.
   */
  sync({ backfill = false, fromMs = null } = {}) {
    const nowMs = this.now();
    const out = { cycles: 0, acid: 0, refills: 0, tanks: [] };
    const tx = this.db.transaction(() => {
      out.refills = this._importRefills(nowMs);
      const tanks = this._tanks();
      this._ensureAnchors(tanks, nowMs);
      let from = fromMs !== null && fromMs !== undefined ? fromMs : nowMs - RECENT_MS;
      if (backfill) {
        const anchors = tanks.map(t => toMs((this.stmts.anchor.get(t.id) || {}).occurred_at)).filter(x => x !== null);
        from = Math.min(nowMs - RECENT_MS, ...anchors);
      }
      out.cycles = this._importCycles(tanks, from, nowMs);
      out.acid = this._importAcid(tanks, from, nowMs);
      for (const t of tanks) this.recompute(t.id);
    });
    tx();
    try { this.evaluateAlerts(); } catch (e) { this.log.error(`[TankStock] alert evaluation failed: ${e.message}`); }
    out.tanks = this.viewAll();
    this.lastSync = { at: isoOf(nowMs), cycles: out.cycles, acid: out.acid };
    return out;
  }

  _importRefills(nowMs) {
    let n = 0;
    const rows = this.db.prepare('SELECT id, tank_id, refilled_at, water_liters_added, total_volume_after, mixture_id FROM fertigation_tank_refills ORDER BY id').all();
    for (const r of rows) {
      const at = toMs(r.refilled_at);
      if (at === null) continue;
      const level = r.total_volume_after ?? r.water_liters_added;
      const info = this.stmts.upsertAnchor.run({
        tank_id: r.tank_id, kind: 'refill', ref: `refill:${r.id}`, litres: r.water_liters_added || 0, stock_after: level,
        occurred_at: isoOf(at), detail_json: JSON.stringify({ refill_id: r.id, water_liters_added: r.water_liters_added, mixture_id: r.mixture_id }), now: isoOf(nowMs),
      });
      n += info.changes;
    }
    return n;
  }

  /** A tank with no refill / adjust record: counting starts now at its stored level. */
  _ensureAnchors(tanks, nowMs) {
    for (const t of tanks) {
      if (this.stmts.anyAnchor.get(t.id)) continue;
      this.stmts.upsertAnchor.run({
        tank_id: t.id, kind: 'anchor', ref: `anchor:${t.id}`, litres: 0, stock_after: t.current_stock_liters ?? 0,
        occurred_at: isoOf(nowMs), detail_json: JSON.stringify({ reason: 'no refill record: counting starts at the stored level' }), now: isoOf(nowMs),
      });
    }
  }

  /** Monitor-measured litres per cycle and tank -> 'cycle' rows (every run type). */
  _importCycles(tanks, fromMs, nowMs) {
    let n = 0;
    const active = new Set(tanks.filter(t => t.active !== 0).map(t => t.id));
    const byId = new Map(tanks.map(t => [t.id, t]));
    let rows = [];
    try {
      rows = this.db.prepare('SELECT farm_id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json FROM irrigation_cycles WHERE received_at >= ? ORDER BY id')
        .all(isoOf(fromMs - DAY_MS));
    } catch (_) { return 0; }
    const maps = {};
    for (const c of rows) {
      const endMs = toMs(c.end_time) ?? toMs(c.start_time);
      if (endMs === null || endMs < fromMs) continue;
      if (!maps[c.farm_id]) maps[c.farm_id] = this._tankMap(c.farm_id, active);
      let dosing = [];
      try { dosing = JSON.parse(c.dosing_json) || []; } catch (_) { dosing = []; }
      for (const d of dosing) {
        if (!d || !Number.isInteger(d.id) || typeof d.consumed_l !== 'number' || !Number.isFinite(d.consumed_l)) continue;
        const tankId = maps[c.farm_id][d.id];
        const tank = tankId !== null && tankId !== undefined ? byId.get(tankId) : null;
        if (!tank || (tank.role || 'nutrient') !== 'nutrient') continue; // pH Down: estimated from its valve instead
        const litres = Math.max(0, d.consumed_l);
        const ref = `cycle:${c.farm_id}:${c.cycle_id}`;
        if (litres === 0 && !this.stmts.exists.get(tankId, ref)) continue;
        const info = this.stmts.upsertDraw.run({
          tank_id: tankId, kind: 'cycle', ref, litres: -litres, estimated: 0, occurred_at: isoOf(endMs),
          detail_json: JSON.stringify({ farm_id: c.farm_id, cycle_id: c.cycle_id, monitor_tank: d.id, start: c.start_time, end: c.end_time, water_m3: c.water_m3 }),
          now: isoOf(nowMs),
        });
        n += info.changes;
      }
    }
    return n;
  }

  /** pH Down: open seconds of each ON->OFF pair of its valve x acid_lpm_estimate -> 'acid' rows (estimated). */
  _importAcid(tanks, fromMs, nowMs) {
    const lpm = this._acidLpm();
    if (!lpm) return 0;
    const cfg = this.getConfig();
    let n = 0;
    for (const t of tanks) {
      if (t.role !== 'ph_down' || !t.equipment_id || t.channel == null) continue;
      let rows = [];
      try {
        rows = this.db.prepare('SELECT id, state, source, created_at FROM relay_events WHERE equipment_id = ? AND channel = ? AND created_at >= ? ORDER BY id')
          .all(t.equipment_id, t.channel, dbTs(fromMs - 3600000));
      } catch (_) { rows = []; }
      let on = null;
      for (const r of rows) {
        if (r.state === 1) { if (!on) on = r; continue; }
        if (!on) continue;
        const onMs = toMs(on.created_at); const offMs = toMs(r.created_at);
        const pair = on; on = null;
        if (onMs === null || offMs === null || offMs < fromMs) continue;
        const openS = Math.min(cfg.acid_max_open_s, Math.max(0, (offMs - onMs) / 1000));
        const litres = r2((openS / 60) * lpm);
        const info = this.stmts.upsertDraw.run({
          tank_id: t.id, kind: 'acid', ref: `acid:${pair.id}`, litres: -litres, estimated: 1, occurred_at: isoOf(offMs),
          detail_json: JSON.stringify({ on_event: pair.id, off_event: r.id, open_s: openS, lpm, on_source: pair.source, off_source: r.source }),
          now: isoOf(nowMs),
        });
        n += info.changes;
      }
    }
    return n;
  }

  /** Level of one tank from its ledger; writes current_stock_liters when it changed. */
  recompute(tankId) {
    const a = this.stmts.anchor.get(tankId);
    if (!a) return null;
    const d = this.stmts.drawsAfter.get(tankId, a.occurred_at);
    const level = r2(Math.max(0, a.stock_after + d.litres));
    this.stmts.setLevel.run(level, tankId, level);
    return level;
  }

  // ─── writes from the API ──────────────────────────────────────────────────

  /** A refill was logged (POST /tanks/:id/refill): anchor + recompute + alerts. */
  recordRefill(refillId) {
    const nowMs = this.now();
    const r = this.db.prepare('SELECT tank_id FROM fertigation_tank_refills WHERE id = ?').get(refillId);
    if (!r) return null;
    this.db.transaction(() => { this._importRefills(nowMs); this.recompute(r.tank_id); })();
    try { this.evaluateAlerts(); } catch (e) { this.log.error(`[TankStock] alert evaluation failed: ${e.message}`); }
    return this.view(r.tank_id);
  }

  /** An operator set the level by hand (PUT /tanks/:id current_stock_liters): new anchor. */
  recordAdjust(tankId, level, { userId = null, previous = null } = {}) {
    const nowMs = this.now();
    this.db.transaction(() => {
      this.stmts.upsertAnchor.run({
        tank_id: tankId, kind: 'adjust', ref: `adjust:${nowMs}`, litres: previous !== null ? r2(level - previous) : 0, stock_after: level,
        occurred_at: isoOf(nowMs), detail_json: JSON.stringify({ user_id: userId, previous }), now: isoOf(nowMs),
      });
      this.recompute(tankId);
    })();
    try { this.evaluateAlerts(); } catch (e) { this.log.error(`[TankStock] alert evaluation failed: ${e.message}`); }
    return this.view(tankId);
  }

  // ─── read ─────────────────────────────────────────────────────────────────

  /**
   * Where the history behind the countdown starts: the first monitor cycle (measured
   * tanks) / the oldest relay event still kept (relay_events retention, acid) — or an
   * older ledger row. Usage before that is unknown (unmetered_gap).
   */
  _monitorCoverage() {
    const out = { first: null, last: null, relayFirst: null };
    try {
      for (const r of this.db.prepare('SELECT start_time, end_time FROM irrigation_cycles').all()) {
        const s = toMs(r.start_time); const e = toMs(r.end_time) ?? s;
        if (s !== null && (out.first === null || s < out.first)) out.first = s;
        if (e !== null && (out.last === null || e > out.last)) out.last = e;
      }
      const led = this.db.prepare("SELECT kind, MIN(occurred_at) AS first FROM tank_stock_ledger WHERE kind IN ('cycle', 'acid') GROUP BY kind").all();
      const lc = led.find(x => x.kind === 'cycle');
      if (lc && toMs(lc.first) !== null && (out.first === null || toMs(lc.first) < out.first)) out.first = toMs(lc.first);
      const re = this.db.prepare('SELECT MIN(created_at) AS first FROM relay_events').get();
      out.relayFirst = re ? toMs(re.first) : null;
      const la = led.find(x => x.kind === 'acid');
      if (la && toMs(la.first) !== null && (out.relayFirst === null || toMs(la.first) < out.relayFirst)) out.relayFirst = toMs(la.first);
    } catch (_) { /* no history */ }
    return out;
  }

  /** Stock view of every tank (API: tanks tab, dashboard, nutrition system view). */
  viewAll() {
    const tanks = this._tanks();
    const cfg = this.getConfig();
    const ctx = { cfg, metered: this._meteredIds(tanks), coverage: this._monitorCoverage(), nowMs: this.now() };
    return tanks.map(t => this._view(t, ctx));
  }

  view(tankId) {
    const t = this._tanks().find(x => x.id === Number(tankId));
    if (!t) return null;
    const tanks = this._tanks();
    return this._view(t, { cfg: this.getConfig(), metered: this._meteredIds(tanks), coverage: this._monitorCoverage(), nowMs: this.now() });
  }

  _view(t, { cfg, metered, coverage, nowMs }) {
    const source = this._sourceOf(t, metered);
    const a = this.stmts.anchor.get(t.id);
    const d = a ? this.stmts.drawsAfter.get(t.id, a.occurred_at) : { litres: 0, est: 0, n: 0, last: null };
    const level = a ? r2(Math.max(0, a.stock_after + d.litres)) : (t.current_stock_liters ?? null);
    const capacity = t.capacity_liters > 0 ? t.capacity_liters : null;
    // average daily use over the last avg_days (or the monitor's coverage, >= 12 h)
    const windowMs = cfg.avg_days * DAY_MS;
    const covFrom = source === 'measured' ? coverage.first : null;
    const spanMs = covFrom !== null ? Math.min(windowMs, nowMs - covFrom) : windowMs;
    let avgDaily = null;
    if (source !== 'manual' && spanMs >= MIN_AVG_SPAN_MS) {
      const used = -this.stmts.useSince.get(t.id, isoOf(nowMs - spanMs)).litres;
      avgDaily = used / (spanMs / DAY_MS);
    }
    const daysLeft = level !== null && avgDaily !== null && avgDaily > 0.01 ? level / avgDaily : null;
    const th = thresholdsFor(cfg, t.id);
    const estimatedL = -d.est;
    const state = cfg.enabled ? stockState({ level, capacity, daysLeft, estimated: source === 'estimated', source }, th) : 'unknown';
    const anchorMs = a ? toMs(a.occurred_at) : null;
    let gap = null;
    const histFrom = source === 'measured' ? coverage.first : source === 'estimated' ? coverage.relayFirst : null;
    if (source !== 'manual' && anchorMs !== null && (histFrom === null || histFrom > anchorMs + 60000)) {
      let doseCycles = null;
      try {
        doseCycles = this.db.prepare('SELECT COUNT(*) AS n FROM fertigation_dose_cycle_log WHERE cycle_started_at >= ? AND cycle_started_at < ?')
          .get(dbTs(anchorMs), dbTs(histFrom ?? nowMs)).n;
      } catch (_) { doseCycles = null; }
      gap = { from: isoOf(anchorMs), to: isoOf(histFrom), dose_cycles: doseCycles };
    }
    return {
      tank_id: t.id,
      name: t.name,
      role: t.role,
      level_l: level === null ? null : r1(level),
      capacity_l: capacity,
      pct: level !== null && capacity ? r1((level / capacity) * 100) : null,
      source,                                   // measured | estimated | manual
      estimated: source === 'estimated',
      state,                                    // ok | caution | alarm | unknown
      days_left: daysLeft === null ? null : r1(daysLeft),
      avg_daily_l: avgDaily === null ? null : r1(avgDaily),
      avg_span_days: source !== 'manual' && spanMs >= MIN_AVG_SPAN_MS ? r1(spanMs / DAY_MS) : null,
      anchor: a ? { kind: a.kind, at: a.occurred_at, level_l: r1(a.stock_after) } : null,
      used_since_anchor_l: r1(-d.litres),
      estimated_since_anchor_l: r1(estimatedL),
      last_draw_at: d.last,
      measured_until: source === 'measured' ? isoOf(coverage.last) : null,
      unmetered_gap: gap,
      thresholds: th,
    };
  }

  /** Paginated ledger of one tank, newest first. */
  ledger(tankId, { limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE tank_id = ?').get(tankId).n;
    const rows = this.db.prepare('SELECT * FROM tank_stock_ledger WHERE tank_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?').all(tankId, lim, off);
    return {
      total, limit: lim, offset: off,
      entries: rows.map(r => {
        let detail = null;
        try { detail = r.detail_json ? JSON.parse(r.detail_json) : null; } catch (_) { detail = null; }
        return { id: r.id, kind: r.kind, ref: r.ref, litres: r.litres, stock_after: r.stock_after, estimated: !!r.estimated, occurred_at: r.occurred_at, detail };
      }),
    };
  }

  // ─── alerts ───────────────────────────────────────────────────────────────

  _loadState() {
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(STATE_KEY);
      return row && row.value ? JSON.parse(row.value) || {} : {};
    } catch (_) { return {}; }
  }

  _saveState(st) {
    this.db.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(STATE_KEY, JSON.stringify(st));
  }

  _alertSpec(v, state) {
    const f1 = (x) => (x === null || x === undefined ? '—' : (Math.round(x * 10) / 10).toFixed(1));
    const days = v.days_left !== null ? M('tank_stock.alert.days_left', { days: f1(v.days_left) }) : M('tank_stock.alert.days_unknown');
    const params = {
      tank: tankLabel(v.name, v.tank_id), level: `${Math.round(v.level_l)}`, pct: f1(v.pct), capacity: `${Math.round(v.capacity_l)}`, days,
    };
    const key = state === 'alarm' ? 'tank_stock.alert.empty' : 'tank_stock.alert.low';
    return M(v.estimated ? `${key}_estimated` : key, params);
  }

  /**
   * Low-stock alerts on state transitions (persisted per tank, so a restart does not
   * re-send): worse -> alert (critical for alarm, warning for caution) + Telegram;
   * better but still low -> the open alert is rewritten; back to ok -> resolved (info).
   */
  evaluateAlerts() {
    const cfg = this.getConfig();
    const views = this.viewAll();
    const prevAll = this._loadState();
    const next = {};
    let changed = false;
    for (const v of views) {
      const key = String(v.tank_id);
      const prev = prevAll[key] || { state: 'ok' };
      const state = cfg.enabled && v.state !== 'unknown' ? v.state : 'ok';
      const fp = `tank_stock:${v.tank_id}`;
      next[key] = { state, level_l: v.level_l };
      if (state === 'ok') {
        if (prev.state !== 'ok') {
          const spec = M('tank_stock.alert.restored', { tank: tankLabel(v.name, v.tank_id), level: `${Math.round(v.level_l ?? 0)}`, pct: v.pct === null ? '—' : v.pct.toFixed(1) });
          this._updateOpenAlert(fp, { message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p, severity: 'info' });
          changed = true;
        }
        continue;
      }
      const spec = this._alertSpec(v, state);
      const severity = state === 'alarm' ? 'critical' : 'warning';
      if (RANK[state] > RANK[prev.state] || prev.state === 'ok') {
        this._createAlert({ severity, source: 'tank_stock', fingerprint: fp, message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p });
        if (cfg.telegram) this._notify(M(state === 'alarm' ? 'tank_stock.telegram.empty' : 'tank_stock.telegram.low', { tank: v.name.split(' — ')[0] }), spec, severity);
        changed = true;
      } else if (prev.state !== state || Math.abs((prev.level_l ?? 0) - (v.level_l ?? 0)) >= 1) {
        // same or better but still low: refresh the open alert quietly (no new occurrence, no Telegram)
        this._updateOpenAlert(fp, { message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p, severity });
        changed = true;
      } else {
        next[key] = prev;
      }
    }
    if (changed || JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(prevAll).sort())) this._saveState(next);
    return next;
  }

  _notify(title, body, severity) {
    const clean = (s) => String(s).replace(/[_*`[\]]/g, ' ');
    if (this._notifyFn) {
      try { this._notifyFn(clean(i18n.render('en', title)), clean(i18n.render('en', body)), severity, { titleSpec: title, bodySpec: body }); } catch (e) { this.log.error(`[TankStock] notify failed: ${e.message}`); }
      return;
    }
    Promise.resolve().then(async () => {
      const { telegramService } = require('./TelegramService');
      if (!telegramService.isConfigured()) return;
      const lang = typeof telegramService.getLanguage === 'function' ? telegramService.getLanguage() : 'en';
      await telegramService.sendAlert(clean(i18n.render(lang, title)), clean(i18n.render(lang, body)), severity);
    }).catch(e => this.log.error(`[TankStock] Telegram failed: ${e.message}`));
  }
}

let singleton = null;
function getTankStockService() {
  if (!singleton) {
    const { db } = require('../utils/database');
    const { createAlert, updateOpenAlert } = require('../utils/alertBroadcast');
    const { getMqttIngestService } = require('./MqttIngestService');
    singleton = new TankStockService({ db, createAlert, updateOpenAlert, mqtt: getMqttIngestService() });
  }
  return singleton;
}

module.exports = { TankStockService, getTankStockService, validateConfig, mergeConfig, stockState, thresholdsFor, tankLabel, toMs, DEFAULTS, CONFIG_KEY };
