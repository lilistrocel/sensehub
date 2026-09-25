/**
 * Read-only MQTT ingest API (irrigation monitors). All GET, any authenticated
 * role (viewer included). Nothing here publishes or actuates.
 *
 *   GET /api/mqtt/health                    broker connection + ingest counters
 *   GET /api/mqtt/monitors                  live snapshot of every monitor
 *   GET /api/mqtt/monitors/:farmId          one monitor (+ its latest cycle)
 *   GET /api/mqtt/irrigation-cycles         ?farm_id=&from=&to=&limit=&offset=
 */
const express = require('express');
const { db } = require('../utils/database');
const { getMqttIngestService } = require('../services/MqttIngestService');

const router = express.Router();
const FARM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function latestCycle(farmId) {
  const row = db.prepare(
    'SELECT * FROM irrigation_cycles WHERE farm_id = ? ORDER BY start_time DESC, id DESC LIMIT 1'
  ).get(farmId);
  return getMqttIngestService().formatCycle(row);
}

router.get('/health', (req, res) => {
  res.json(getMqttIngestService().getHealth());
});

router.get('/monitors', (req, res) => {
  const svc = getMqttIngestService();
  const monitors = svc.getSnapshots().map(s => ({ ...s, last_cycle: latestCycle(s.farm_id) }));
  res.json({ now: new Date().toISOString(), broker_connected: svc.getHealth().connected, monitors });
});

router.get('/monitors/:farmId', (req, res) => {
  const farmId = String(req.params.farmId);
  if (!FARM_ID_RE.test(farmId)) return res.status(400).json({ error: 'Bad Request', message: 'invalid farm id' });
  const svc = getMqttIngestService();
  const snap = svc.getSnapshot(farmId);
  if (!snap) return res.status(404).json({ error: 'Not Found', message: `no monitor has published on farm/${farmId}` });
  res.json({ now: new Date().toISOString(), broker_connected: svc.getHealth().connected, ...snap, last_cycle: latestCycle(farmId) });
});

/** Accepts ISO 8601 (any offset) or YYYY-MM-DD; returns epoch ms or null. */
function parseDateParam(v, endOfDay = false) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? Date.parse(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

router.get('/irrigation-cycles', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.farm_id !== undefined) {
    const farmId = String(req.query.farm_id);
    if (!FARM_ID_RE.test(farmId)) return res.status(400).json({ error: 'Bad Request', message: 'invalid farm_id' });
    where.push('farm_id = ?');
    params.push(farmId);
  }
  const fromMs = parseDateParam(req.query.from);
  const toMs = parseDateParam(req.query.to, true);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return res.status(400).json({ error: 'Bad Request', message: 'from/to must be ISO 8601 or YYYY-MM-DD' });
  }
  // start_time carries the device's local offset; julianday() normalises it to UTC for comparison.
  if (fromMs !== null) { where.push('julianday(start_time) >= julianday(?)'); params.push(new Date(fromMs).toISOString()); }
  if (toMs !== null) { where.push('julianday(start_time) <= julianday(?)'); params.push(new Date(toMs).toISOString()); }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM irrigation_cycles ${whereSql}`).get(...params).n;
  const totals = db.prepare(`SELECT COALESCE(SUM(water_m3), 0) AS water_m3, COALESCE(SUM(duration_s), 0) AS duration_s FROM irrigation_cycles ${whereSql}`).get(...params);
  const rows = db.prepare(
    `SELECT * FROM irrigation_cycles ${whereSql} ORDER BY julianday(start_time) DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const svc = getMqttIngestService();
  res.json({
    cycles: rows.map(r => svc.formatCycle(r)),
    total,
    limit,
    offset,
    totals: { water_m3: Math.round(totals.water_m3 * 10000) / 10000, duration_s: totals.duration_s },
  });
});

module.exports = router;
