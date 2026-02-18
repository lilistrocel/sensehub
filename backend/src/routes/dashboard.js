const express = require('express');
const { db } = require('../utils/database');

const router = express.Router();

// GET /api/dashboard/overview - Get dashboard overview
router.get('/overview', (req, res) => {
  // Parse time range from query params (in hours, default 24)
  const hoursAgo = parseInt(req.query.hours) || 24;
  const startTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
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

  // Latest sensor readings - get latest reading per equipment per metric name
  // Exclude stale unnamed readings for devices that now have named readings
  const latestReadings = db.prepare(`
    SELECT r.*, e.name as equipment_name, e.status as equipment_status, e.enabled as equipment_enabled
    FROM readings r
    INNER JOIN equipment e ON r.equipment_id = e.id
    WHERE r.id IN (
      SELECT MAX(id) FROM readings GROUP BY equipment_id, COALESCE(name, '')
    )
    AND NOT (r.name IS NULL AND EXISTS (
      SELECT 1 FROM readings r2 WHERE r2.equipment_id = r.equipment_id AND r2.name IS NOT NULL
    ))
    ORDER BY e.name ASC, r.name ASC
    LIMIT 50
  `).all();

  // Equipment list for direct control (enabled equipment only)
  const equipmentList = db.prepare(`
    SELECT id, name, description, type, status, enabled, register_mappings, last_reading, write_only, slave_id, address
    FROM equipment
    WHERE enabled = 1
    ORDER BY status DESC, name ASC
    LIMIT 20
  `).all().map(eq => {
    // Parse JSON fields for the frontend
    try { eq.register_mappings = eq.register_mappings ? JSON.parse(eq.register_mappings) : []; } catch (e) { eq.register_mappings = []; }
    try { eq.last_reading = eq.last_reading ? JSON.parse(eq.last_reading) : null; } catch (e) { eq.last_reading = null; }
    return eq;
  });

  // Historical readings for chart (filtered by time range, downsampled)
  let chartQuery;
  if (hoursAgo <= 1) {
    // Raw data for <= 1 hour
    chartQuery = `
      SELECT r.equipment_id, r.value, r.unit, r.timestamp, r.name, e.name as equipment_name
      FROM readings r
      INNER JOIN equipment e ON r.equipment_id = e.id
      WHERE r.timestamp >= ?
      ORDER BY r.timestamp ASC`;
  } else if (hoursAgo <= 24) {
    // 5-minute buckets
    chartQuery = `
      SELECT r.equipment_id,
        AVG(r.value) as value, r.unit, r.name,
        strftime('%Y-%m-%d %H:', r.timestamp) || printf('%02d', (CAST(strftime('%M', r.timestamp) AS INTEGER) / 5) * 5) || ':00' as timestamp,
        e.name as equipment_name
      FROM readings r
      INNER JOIN equipment e ON r.equipment_id = e.id
      WHERE r.timestamp >= ?
      GROUP BY r.equipment_id, COALESCE(r.name, ''), strftime('%Y-%m-%d %H:', r.timestamp) || printf('%02d', (CAST(strftime('%M', r.timestamp) AS INTEGER) / 5) * 5)
      ORDER BY timestamp ASC`;
  } else if (hoursAgo <= 168) {
    // 1-hour buckets for <= 7 days
    chartQuery = `
      SELECT r.equipment_id,
        AVG(r.value) as value, r.unit, r.name,
        strftime('%Y-%m-%d %H:00:00', r.timestamp) as timestamp,
        e.name as equipment_name
      FROM readings r
      INNER JOIN equipment e ON r.equipment_id = e.id
      WHERE r.timestamp >= ?
      GROUP BY r.equipment_id, COALESCE(r.name, ''), strftime('%Y-%m-%d %H', r.timestamp)
      ORDER BY timestamp ASC`;
  } else {
    // 6-hour buckets for > 7 days
    chartQuery = `
      SELECT r.equipment_id,
        AVG(r.value) as value, r.unit, r.name,
        strftime('%Y-%m-%d ', r.timestamp) || printf('%02d', (CAST(strftime('%H', r.timestamp) AS INTEGER) / 6) * 6) || ':00:00' as timestamp,
        e.name as equipment_name
      FROM readings r
      INNER JOIN equipment e ON r.equipment_id = e.id
      WHERE r.timestamp >= ?
      GROUP BY r.equipment_id, COALESCE(r.name, ''), strftime('%Y-%m-%d', r.timestamp) || (CAST(strftime('%H', r.timestamp) AS INTEGER) / 6)
      ORDER BY timestamp ASC`;
  }
  const chartReadings = db.prepare(chartQuery).all(startTime);

  // Active automations list with last run info
  const activeAutomations = db.prepare(`
    SELECT
      a.id,
      a.name,
      a.description,
      a.enabled,
      a.last_run,
      a.run_count,
      a.trigger_config,
      (SELECT status FROM automation_logs WHERE automation_id = a.id ORDER BY triggered_at DESC LIMIT 1) as last_status
    FROM automations a
    WHERE a.enabled = 1
    ORDER BY a.last_run DESC NULLS LAST
    LIMIT 10
  `).all();

  res.json({
    equipment: equipmentStats,
    zones: { total: zoneCount.count },
    automations: automationStats,
    alerts: alertStats,
    recentAlerts,
    recentAutomations,
    latestReadings,
    activeAutomations,
    chartReadings,
    equipmentList,
    timeRange: { hours: hoursAgo, startTime }
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
