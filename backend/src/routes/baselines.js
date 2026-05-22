const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper: fetch the latest reading for a given equipment+metric.
// Returns { value, unit, timestamp } or null if no reading exists.
function getLatestReading(equipmentId, metricName) {
  const row = db.prepare(
    `SELECT value, unit, timestamp
     FROM readings
     WHERE equipment_id = ? AND COALESCE(name, '') = COALESCE(?, '')
     ORDER BY id DESC LIMIT 1`
  ).get(equipmentId, metricName);
  return row || null;
}

// Decorate a baseline row with the latest reading + computed delta.
function decorate(b) {
  const latest = getLatestReading(b.equipment_id, b.metric_name);
  const current = latest ? latest.value : null;
  const delta = (current !== null && b.baseline_value !== null)
    ? (current - b.baseline_value)
    : null;
  return {
    ...b,
    current_value: current,
    current_timestamp: latest ? latest.timestamp : null,
    delta,
  };
}

// GET /api/baselines/active
// List every active baseline across all equipment, with the latest reading
// and delta computed. Used by the dashboard widget.
router.get('/active', (req, res) => {
  const rows = db.prepare(
    `SELECT b.*, e.name as equipment_name, e.status as equipment_status
     FROM consumption_baselines b
     JOIN equipment e ON e.id = b.equipment_id
     ORDER BY b.created_at DESC`
  ).all();
  res.json(rows.map(decorate));
});

// GET /api/baselines/equipment/:equipmentId
// List baselines for one equipment with current deltas.
router.get('/equipment/:equipmentId', (req, res) => {
  const rows = db.prepare(
    `SELECT b.*, e.name as equipment_name, e.status as equipment_status
     FROM consumption_baselines b
     JOIN equipment e ON e.id = b.equipment_id
     WHERE b.equipment_id = ?
     ORDER BY b.created_at DESC`
  ).all(req.params.equipmentId);
  res.json(rows.map(decorate));
});

// POST /api/baselines/equipment/:equipmentId
// Body: { metric_name, label? }
// Captures the latest reading for the given metric as the baseline.
// Any existing baseline for the same (equipment, metric) pair is replaced.
router.post('/equipment/:equipmentId', requireRole('admin', 'operator'), (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const { metric_name, label } = req.body;
  if (!metric_name) {
    return res.status(400).json({ error: 'Bad Request', message: 'metric_name is required' });
  }
  const equipment = db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }
  const latest = getLatestReading(equipmentId, metric_name);
  if (!latest) {
    return res.status(400).json({ error: 'Bad Request', message: `No readings yet for metric "${metric_name}" on this equipment` });
  }

  // Replace any existing baseline for the same (equipment, metric)
  db.prepare(
    'DELETE FROM consumption_baselines WHERE equipment_id = ? AND metric_name = ?'
  ).run(equipmentId, metric_name);

  const result = db.prepare(
    `INSERT INTO consumption_baselines (equipment_id, metric_name, baseline_value, unit, label)
     VALUES (?, ?, ?, ?, ?)`
  ).run(equipmentId, metric_name, latest.value, latest.unit || null, label || null);

  const row = db.prepare(
    `SELECT b.*, e.name as equipment_name, e.status as equipment_status
     FROM consumption_baselines b JOIN equipment e ON e.id = b.equipment_id
     WHERE b.id = ?`
  ).get(result.lastInsertRowid);
  res.status(201).json(decorate(row));
});

// DELETE /api/baselines/:id — stop tracking.
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM consumption_baselines WHERE id = ?').run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Baseline not found' });
  }
  res.json({ message: 'Baseline cleared', id });
});

module.exports = router;
