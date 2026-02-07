const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/alerts - List alerts
router.get('/', (req, res) => {
  const { severity, equipment_id, acknowledged, limit } = req.query;

  let query = 'SELECT a.*, e.name as equipment_name, z.name as zone_name FROM alerts a LEFT JOIN equipment e ON a.equipment_id = e.id LEFT JOIN zones z ON a.zone_id = z.id';
  const conditions = [];
  const params = [];

  if (severity) {
    conditions.push('a.severity = ?');
    params.push(severity);
  }

  if (equipment_id) {
    conditions.push('a.equipment_id = ?');
    params.push(equipment_id);
  }

  if (acknowledged !== undefined) {
    conditions.push('a.acknowledged = ?');
    params.push(acknowledged === 'true' ? 1 : 0);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY a.created_at DESC';

  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  }

  const alerts = db.prepare(query).all(...params);
  res.json(alerts);
});

// GET /api/alerts/unacknowledged/count - Get unacknowledged count
router.get('/unacknowledged/count', (req, res) => {
  const result = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0').get();
  res.json({ count: result.count });
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
    'UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime("now") WHERE id = ?'
  ).run(req.user.id, alertId);

  const updated = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  global.broadcast('alert_acknowledged', updated);

  res.json(updated);
});

module.exports = router;
