const express = require('express');
const { db } = require('../utils/database');

const router = express.Router();

// GET /api/dashboard/overview - Get dashboard overview
router.get('/overview', (req, res) => {
  // Equipment statistics
  const equipmentStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
      SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
      SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warning
    FROM equipment WHERE enabled = 1
  `).get();

  // Zone count
  const zoneCount = db.prepare('SELECT COUNT(*) as count FROM zones').get();

  // Active automations
  const automationStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as active
    FROM automations
  `).get();

  // Unacknowledged alerts
  const alertStats = db.prepare(`
    SELECT
      COUNT(*) as unacknowledged,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning
    FROM alerts WHERE acknowledged = 0
  `).get();

  // Recent alerts
  const recentAlerts = db.prepare(`
    SELECT a.*, e.name as equipment_name
    FROM alerts a
    LEFT JOIN equipment e ON a.equipment_id = e.id
    ORDER BY a.created_at DESC
    LIMIT 5
  `).all();

  // Recent automation runs
  const recentAutomations = db.prepare(`
    SELECT al.*, a.name as automation_name
    FROM automation_logs al
    JOIN automations a ON al.automation_id = a.id
    ORDER BY al.triggered_at DESC
    LIMIT 5
  `).all();

  res.json({
    equipment: equipmentStats,
    zones: { total: zoneCount.count },
    automations: automationStats,
    alerts: alertStats,
    recentAlerts,
    recentAutomations
  });
});

// GET /api/dashboard/zone/:id - Get zone dashboard
router.get('/zone/:id', (req, res) => {
  const zoneId = req.params.id;

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);

  if (!zone) {
    return res.status(404).json({ error: 'Not Found', message: 'Zone not found' });
  }

  // Equipment in zone
  const equipment = db.prepare(`
    SELECT e.* FROM equipment e
    JOIN equipment_zones ez ON e.id = ez.equipment_id
    WHERE ez.zone_id = ?
  `).all(zoneId);

  // Zone alerts
  const alerts = db.prepare(`
    SELECT * FROM alerts WHERE zone_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(zoneId);

  res.json({
    zone,
    equipment,
    alerts
  });
});

// GET /api/dashboard/equipment/:id - Get equipment dashboard
router.get('/equipment/:id', (req, res) => {
  const equipmentId = req.params.id;

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Recent readings
  const readings = db.prepare(`
    SELECT * FROM readings WHERE equipment_id = ? ORDER BY timestamp DESC LIMIT 100
  `).all(equipmentId);

  // Equipment alerts
  const alerts = db.prepare(`
    SELECT * FROM alerts WHERE equipment_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(equipmentId);

  // Zones
  const zones = db.prepare(`
    SELECT z.* FROM zones z
    JOIN equipment_zones ez ON z.id = ez.zone_id
    WHERE ez.equipment_id = ?
  `).all(equipmentId);

  res.json({
    equipment,
    readings,
    alerts,
    zones
  });
});

module.exports = router;
