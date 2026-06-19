const express = require('express');
const { db } = require('../utils/database');
const { calibrationService } = require('../services/CalibrationService');
const { requireRole } = require('../middleware/auth');
const { modbusPollingService } = require('../services/ModbusPollingService');

const router = express.Router();

// Reload polling so an updated register mapping (scale/offset) takes effect
// immediately. Fired after the response; never let a refresh failure surface.
function refreshPolling() {
  Promise.resolve()
    .then(() => modbusPollingService.refreshDevices())
    .catch((err) => console.error('Failed to refresh polling after calibration change:', err));
}

// Parse an equipment row's register_mappings (string or array) into an array.
function parseMappings(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

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

// --- Per-metric LINEAR calibration (scale & offset) ---------------------------
//
// This is the per-metric correction that is ACTUALLY applied to readings at poll
// time. Each register mapping carries its own `scale`/`offset`; ModbusPollingService
// computes `raw * scale + offset` per metric (then the legacy equipment-level
// calibration_scale/offset). Editing it here writes straight back into the
// equipment's register_mappings JSON — the same field the poller reads — so there
// is exactly ONE place these values live and no risk of double-application.
//
// The separate sensor_calibrations table (slope/intercept via lab regression,
// handled by the routes below) is an independent, display-only analysis tool and
// is NOT touched here.
//
// NOTE: these routes are declared BEFORE the generic `/:equipment_id/:metric`
// routes so the literal `/linear` segment isn't captured as a `:metric` value.

// GET /api/calibration/:equipment_id/linear - list every metric's scale/offset
router.get('/:equipment_id/linear', (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipment_id);
    const eq = db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(equipmentId);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });

    const metrics = parseMappings(eq.register_mappings)
      .filter(m => m.type !== 'coil' && parseInt(m.functionCode, 10) !== 1)
      .map(m => ({
        name: m.name,
        unit: m.unit || '',
        scale: m.scale !== undefined && m.scale !== null ? parseFloat(m.scale) : 1,
        offset: m.offset !== undefined && m.offset !== null ? parseFloat(m.offset) : 0
      }));

    res.json({ equipment_id: equipmentId, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calibration/:equipment_id/:metric/linear - save one metric's scale/offset
router.put('/:equipment_id/:metric/linear', requireRole('admin', 'operator'), (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipment_id);
    const metricName = decodeURIComponent(req.params.metric);

    const eq = db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(equipmentId);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });

    const mappings = parseMappings(eq.register_mappings);
    const mapping = mappings.find(m => m.name === metricName);
    if (!mapping) return res.status(404).json({ error: `No metric named "${metricName}" on this equipment` });

    // Validate. Allow either field to be omitted (leave that one as-is).
    let { scale, offset } = req.body;
    if (scale !== undefined) {
      scale = parseFloat(scale);
      if (isNaN(scale)) return res.status(400).json({ error: 'scale must be a number' });
      mapping.scale = scale;
    }
    if (offset !== undefined) {
      offset = parseFloat(offset);
      if (isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
      mapping.offset = offset;
    }

    db.prepare(
      "UPDATE equipment SET register_mappings = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(mappings), equipmentId);

    res.json({
      equipment_id: equipmentId,
      metric: metricName,
      scale: mapping.scale !== undefined && mapping.scale !== null ? parseFloat(mapping.scale) : 1,
      offset: mapping.offset !== undefined && mapping.offset !== null ? parseFloat(mapping.offset) : 0
    });

    refreshPolling();
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
