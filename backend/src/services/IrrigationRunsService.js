/**
 * IrrigationRunsService — keeps irrigation_runs in step with the monitor.
 *
 * READ-ONLY with respect to the plant: it never touches a relay, coil or
 * setpoint and raises no alert. Its only writes are irrigation_runs rows
 * (derived data, see utils/irrigationRunsSchema.js).
 *
 *   start()   backfill the last 7 local days (idempotent), then regroup on
 *             every stored cycle report (MqttIngestService.onCycle, debounced
 *             3 s) and every 5 min over the last 3 h (closes provisional runs,
 *             picks up relay events that arrive after the last cycle).
 *   rebuild(fromMs, toMs)  build the runs starting in the window and upsert
 *             them by run_key (a row is rewritten only when its detail changed);
 *             rows in the window whose key is no longer produced are deleted.
 */

const builder = require('./IrrigationRunBuilder');
const DR = require('./DailyReportService');

const DEBOUNCE_MS = 3000;
const TICK_MS = 5 * 60000;
const TICK_WINDOW_MS = 3 * 3600000;
const BACKFILL_DAYS = 7;

const iso = (ms) => new Date(ms).toISOString();

class IrrigationRunsService {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {Function} [deps.now]
   * @param {object}   [deps.mqtt]       { onCycle(fn) } (MqttIngestService)
   * @param {Function} [deps.broadcast]  (type, data) => void; defaults to global.broadcast
   * @param {object}   [deps.logger]
   * @param {Function} [deps.setTimer]   (fn, ms) => handle (tests)
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.now = deps.now || (() => Date.now());
    this.mqtt = deps.mqtt || null;
    this._broadcast = deps.broadcast || null;
    this.log = deps.logger || console;
    this._setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    this._unsub = null;
    this.timer = null;
    this._pending = null;
    this._debounce = null;
    this.lastRebuild = null;
    this._stmts = null;
  }

  get stmts() {
    if (this._stmts) return this._stmts;
    const db = this.db;
    this._stmts = {
      upsert: db.prepare(`
        INSERT INTO irrigation_runs
          (run_key, type, status, started_at, ended_at, local_date, duration_s, water_l, automation_id,
           dose_controller_run_id, operators, uncontrolled_dosing, provisional, detail_json, created_at, updated_at)
        VALUES (@run_key, @type, @status, @started_at, @ended_at, @local_date, @duration_s, @water_l, @automation_id,
           @dose_controller_run_id, @operators, @uncontrolled_dosing, @provisional, @detail_json, @now, @now)
        ON CONFLICT(run_key) DO UPDATE SET
          type = excluded.type, status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at,
          local_date = excluded.local_date, duration_s = excluded.duration_s, water_l = excluded.water_l,
          automation_id = excluded.automation_id, dose_controller_run_id = excluded.dose_controller_run_id,
          operators = excluded.operators, uncontrolled_dosing = excluded.uncontrolled_dosing,
          provisional = excluded.provisional, detail_json = excluded.detail_json, updated_at = excluded.updated_at
        WHERE irrigation_runs.detail_json IS NOT excluded.detail_json
      `),
      keysIn: db.prepare('SELECT id, run_key FROM irrigation_runs WHERE started_at >= ? AND started_at < ?'),
      del: db.prepare('DELETE FROM irrigation_runs WHERE id = ?'),
      byKey: db.prepare('SELECT id FROM irrigation_runs WHERE run_key = ?'),
    };
    return this._stmts;
  }

  start() {
    if (this.mqtt && typeof this.mqtt.onCycle === 'function' && !this._unsub) {
      this._unsub = this.mqtt.onCycle((cycle) => this.onCycle(cycle));
    }
    // backfill after the rest of the start-up (a few hundred ms of SQLite work)
    this._setTimer(() => {
      try {
        const r = this.backfill(BACKFILL_DAYS);
        this.log.log(`[IrrigationRuns] backfill ${BACKFILL_DAYS} d: ${r.runs} runs (${r.inserted} new, ${r.updated} updated, ${r.deleted} removed)`);
      } catch (e) { this.log.error(`[IrrigationRuns] backfill failed: ${e.message}`); }
    }, 5000);
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { const n = this.now(); this.rebuild(n - TICK_WINDOW_MS, n + 60000); } catch (e) { this.log.error(`[IrrigationRuns] rebuild failed: ${e.message}`); }
      }, TICK_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /** A cycle report landed: regroup its surroundings (debounced; several reports can arrive together). */
  onCycle(cycle) {
    const s = cycle && cycle.start ? Date.parse(cycle.start) : NaN;
    const e = cycle && cycle.end ? Date.parse(cycle.end) : NaN;
    if (!Number.isFinite(s)) return;
    const from = s - 3 * 3600000;
    const to = (Number.isFinite(e) ? e : s) + 10 * 60000;
    this._pending = this._pending ? { from: Math.min(this._pending.from, from), to: Math.max(this._pending.to, to) } : { from, to };
    if (this._debounce) return;
    this._debounce = this._setTimer(() => this.flushPending(), DEBOUNCE_MS);
  }

  flushPending() {
    this._debounce = null;
    const p = this._pending;
    this._pending = null;
    if (!p) return null;
    try { return this.rebuild(p.from, p.to); } catch (e) { this.log.error(`[IrrigationRuns] rebuild failed: ${e.message}`); return null; }
  }

  backfill(days = BACKFILL_DAYS) {
    const nowMs = this.now();
    const tz = DR.getTimezone(this.db);
    const today = DR.localDateStr(tz, nowMs);
    const from = DR.localMidnightUtcMs(tz, DR.addDays(today, -(days - 1)));
    return this.rebuild(from, nowMs + 60000);
  }

  rebuild(fromMs, toMs) {
    const nowMs = this.now();
    const { runs } = builder.buildRuns(this.db, { fromMs, toMs, nowMs });
    const st = this.stmts;
    const stamp = iso(nowMs);
    const out = { runs: runs.length, inserted: 0, updated: 0, deleted: 0, unchanged: 0, changed: [] };
    const tx = this.db.transaction(() => {
      const keep = new Set();
      for (const r of runs) {
        keep.add(r.key);
        const existed = st.byKey.get(r.key);
        const info = st.upsert.run({
          run_key: r.key, type: r.type, status: r.status, started_at: r.started_at, ended_at: r.ended_at,
          local_date: r.local_date, duration_s: r.duration_s, water_l: r.water_l, automation_id: r.automation_id ?? null,
          dose_controller_run_id: r.dose_controller_run_id ?? null, operators: (r.operators || []).join(',') || null,
          uncontrolled_dosing: r.uncontrolled_dosing ? 1 : 0, provisional: r.provisional ? 1 : 0,
          detail_json: JSON.stringify(r), now: stamp,
        });
        if (!info.changes) { out.unchanged++; continue; }
        if (existed) out.updated++; else out.inserted++;
        out.changed.push({ key: r.key, type: r.type, status: r.status, started_at: r.started_at });
      }
      for (const row of st.keysIn.all(iso(fromMs), iso(toMs))) {
        if (!keep.has(row.run_key)) { st.del.run(row.id); out.deleted++; }
      }
    });
    tx();
    this.lastRebuild = { at: stamp, from: iso(fromMs), to: iso(toMs), ...out, changed: out.changed.length };
    if (out.changed.length || out.deleted) this._emit('irrigation_runs_updated', { changed: out.changed, deleted: out.deleted });
    return out;
  }

  _emit(type, data) {
    try {
      const b = this._broadcast || global.broadcast;
      if (b) b(type, data);
    } catch (_) { /* never breaks a rebuild */ }
  }

  // ─── read API ─────────────────────────────────────────────────────────────

  format(row) {
    if (!row) return null;
    let d = {};
    try { d = JSON.parse(row.detail_json) || {}; } catch (_) { d = {}; }
    return { id: row.id, ...d, key: row.run_key, updated_at: row.updated_at || row.created_at || null };
  }

  get(id) {
    return this.format(this.db.prepare('SELECT * FROM irrigation_runs WHERE id = ?').get(id));
  }

  last() {
    return this.format(this.db.prepare('SELECT * FROM irrigation_runs ORDER BY started_at DESC, id DESC LIMIT 1').get());
  }

  /**
   * @param {object} q { from, to (ISO), date (YYYY-MM-DD | 'today'), type, limit, offset }
   */
  list({ from = null, to = null, date = null, type = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    let localDate = null;
    if (date) {
      localDate = date === 'today' ? DR.localDateStr(DR.getTimezone(this.db), this.now()) : date;
      where.push('local_date = ?'); params.push(localDate);
    }
    if (from) { where.push('started_at >= ?'); params.push(from); }
    if (to) { where.push('started_at < ?'); params.push(to); }
    if (type) { where.push('type = ?'); params.push(type); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM irrigation_runs ${w}`).get(...params).n;
    const agg = this.db.prepare(`SELECT COALESCE(SUM(water_l), 0) AS water_l, SUM(uncontrolled_dosing) AS unc FROM irrigation_runs ${w}`).get(...params);
    const rows = this.db.prepare(`SELECT * FROM irrigation_runs ${w} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {
      total,
      date: localDate,
      timezone: DR.getTimezone(this.db),
      water_l: Math.round(agg.water_l * 10) / 10,
      uncontrolled_dosing_runs: agg.unc || 0,
      runs: rows.map(r => this.format(r)),
    };
  }
}

let singleton = null;
function getIrrigationRunsService() {
  if (!singleton) {
    const { db } = require('../utils/database');
    const { getMqttIngestService } = require('./MqttIngestService');
    singleton = new IrrigationRunsService({ db, mqtt: getMqttIngestService() });
  }
  return singleton;
}

module.exports = { IrrigationRunsService, getIrrigationRunsService, TYPES: Object.keys(builder.TYPE_LABEL) };
