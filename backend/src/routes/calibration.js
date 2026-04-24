const express = require('express');
const { db } = require('../utils/database');
const { calibrationService } = require('../services/CalibrationService');

const router = express.Router();

// GET /api/calibration - List all calibrations
router.get('/', (req, res) => {
  try {
    const cals = db.prepare(`
      SELECT sc.*, e.name as equipment_name
      FROM sensor_calibrations sc
      LEFT JOIN equipment e ON sc.equipment_id = e.id
      ORDER BY sc.equipment_id, sc.metric_name
    `).all();
    res.json(cals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calibration/:equipment_id/:metric - Get calibration + pairs + history
router.get('/:equipment_id/:metric', (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipment_id);
    const metricName = decodeURIComponent(req.params.metric);
    const labNutrient = req.query.lab_nutrient || 'EC';
    const zoneId = req.query.zone_id ? parseInt(req.query.zone_id) : null;

    const calibration = calibrationService.get(equipmentId, metricName);
    const pairs = calibrationService.getPairs(equipmentId, metricName, labNutrient, zoneId);
    const latestEstimate = calibrationService.getLatestEstimate(equipmentId, metricName);

    // Get recent sensor history (last 24h) for charting
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sensorHistory = db.prepare(`
      SELECT timestamp, value FROM readings
      WHERE equipment_id = ? AND name = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(equipmentId, metricName, cutoff);

    res.json({
      calibration,
      pairs,
      latestEstimate,
      sensorHistory,
      labNutrient
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calibration/:equipment_id/:metric/recompute - Recompute calibration
router.post('/:equipment_id/:metric/recompute', (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipment_id);
    const metricName = decodeURIComponent(req.params.metric);
    const labNutrient = req.body.lab_nutrient || 'EC';
    const zoneId = req.body.zone_id !== undefined ? req.body.zone_id : null;

    const cal = calibrationService.recompute(equipmentId, metricName, labNutrient, zoneId);
    res.json(cal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calibration/:equipment_id/:metric/estimate?value=N - Apply calibration
router.get('/:equipment_id/:metric/estimate', (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipment_id);
    const metricName = decodeURIComponent(req.params.metric);
    const rawValue = parseFloat(req.query.value);
    if (isNaN(rawValue)) {
      return res.status(400).json({ error: 'value query param required' });
    }
    const result = calibrationService.estimate(equipmentId, metricName, rawValue);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
