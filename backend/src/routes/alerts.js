const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const SEVERITIES = ['info', 'warning', 'critical'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const ENRICHED_SELECT = `
  SELECT a.*, e.name as equipment_name, z.name as zone_name, u.name as acknowledged_by_name
  FROM alerts a
  LEFT JOIN equipment e ON a.equipment_id = e.id
  LEFT JOIN zones z ON a.zone_id = z.id
  LEFT JOIN users u ON a.acknowledged_by = u.id
`;

function buildFilters({ severity, equipment_id, acknowledged, automation_id, source }) {
  const conditions = [];
  const params = [];
  if (severity && SEVERITIES.includes(severity)) {
    conditions.push('a.severity = ?');
    params.push(severity);
  }
  if (equipment_id !== undefined && equipment_id !== '') {
    conditions.push('a.equipment_id = ?');
    params.push(parseInt(equipment_id, 10));
  }
  if (automation_id !== undefined && automation_id !== '') {
    conditions.push('a.automation_id = ?');
    params.push(parseInt(automation_id, 10));
  }
  if (source) {
    conditions.push('a.source = ?');
    params.push(String(source));
  }
  if (acknowledged === 'true' || acknowledged === 'false') {
    conditions.push('a.acknowledged = ?');
    params.push(acknowledged === 'true' ? 1 : 0);
  }
  return { where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
}

// GET /api/alerts - List alerts (paginated)
//   ?limit=100 (max 500) &offset=0 &acknowledged=true|false &severity=info|warning|critical
//   &equipment_id=N &automation_id=N &source=...
// Response: { items, total, unacknowledged, limit, offset }
//   total         = rows matching the filters
//   unacknowledged = global open-alert count (independent of filters; same number as
//                    /unacknowledged/count so the UI can show a badge without a second call)
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { where, params } = buildFilters(req.query);

  const items = db.prepare(
    `${ENRICHED_SELECT}${where} ORDER BY COALESCE(a.last_seen_at, a.created_at) DESC, a.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM alerts a${where}`).get(...params);
  const { unacknowledged } = db.prepare('SELECT COUNT(*) as unacknowledged FROM alerts WHERE acknowledged = 0').get();

  res.json({ items, total, unacknowledged, limit, offset });
});

// GET /api/alerts/unacknowledged/count - Get unacknowledged count
router.get('/unacknowledged/count', (req, res) => {
  const result = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').get();
  res.json({ count: result.count });
});

// POST /api/alerts/acknowledge-all - Acknowledge every open alert matching optional filters
//   Body: { severity?: 'info'|'warning'|'critical', equipment_id?: number }
router.post('/acknowledge-all', requireRole('admin', 'operator'), (req, res) => {
  const body = req.body || {};
  const conditions = ['acknowledged = 0'];
  const params = [];
  if (body.severity) {
    if (!SEVERITIES.includes(body.severity)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid severity' });
    }
    conditions.push('severity = ?');
    params.push(body.severity);
  }
  if (body.equipment_id !== undefined && body.equipment_id !== null && body.equipment_id !== '') {
    const eqId = parseInt(body.equipment_id, 10);
    if (Number.isNaN(eqId)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid equipment_id' });
    }
    conditions.push('equipment_id = ?');
    params.push(eqId);
  }

  const info = db.prepare(
    `UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now') WHERE ${conditions.join(' AND ')}`
  ).run(req.user.id, ...params);

  const { unacknowledged } = db.prepare('SELECT COUNT(*) as unacknowledged FROM alerts WHERE acknowledged = 0').get();
  try {
    global.broadcast?.('alerts_acknowledged_bulk', {
      acknowledged: info.changes,
      unacknowledged,
      severity: body.severity || null,
      equipment_id: body.equipment_id ?? null,
      acknowledged_by: req.user.id,
    });
  } catch {}

  res.json({ acknowledged: info.changes, unacknowledged });
});

// POST /api/alerts/:id/acknowledge - Acknowledge alert
router.post('/:id/acknowledge', requireRole('admin', 'operator'), (req, res) => {
  const alertId = req.params.id;

  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);

  if (!alert) {
    return res.status(404).json({ error: 'Not Found', message: 'Alert not found' });
  }

  if (alert.acknowledged) {
    return res.status(400).json({ error: 'Bad Request', message: 'Alert already acknowledged' });
  }

  db.prepare(
    "UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, alertId);

  const updated = db.prepare(`${ENRICHED_SELECT} WHERE a.id = ?`).get(alertId);
  global.broadcast('alert_acknowledged', updated);

  res.json(updated);
});

module.exports = router;
