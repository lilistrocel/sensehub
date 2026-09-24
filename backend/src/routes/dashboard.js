const express = require('express');
const { db } = require('../utils/database');
const { modbusPollingService } = require('../services/ModbusPollingService');
const { automationArmingService } = require('../services/AutomationArmingService');
const sb = require('../services/StatusBoardHelpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/dashboard/status-board — one call for everything above the fold on
// the operator dashboard. Cached server-side for 5 s (cheap to hit from many
// tabs). Pure grouping / unknown / stale logic lives in StatusBoardHelpers.
// ---------------------------------------------------------------------------
const STATUS_BOARD_CACHE_MS = 5000;
let statusBoardCache = { at: 0, body: null };

function readTimezone() {
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'timezone'").get();
    if (!row || !row.value) return process.env.TZ || 'UTC';
    const parsed = JSON.parse(row.value);
    return (parsed && parsed.timezone) || process.env.TZ || 'UTC';
  } catch (e) {
    return process.env.TZ || 'UTC';
  }
}

function buildStatusBoard() {
  const nowMs = Date.now();
  const equipment = db.prepare(`
    SELECT id, name, type, enabled, write_only, status, polling_interval_ms, last_communication, last_reading, register_mappings
    FROM equipment ORDER BY id ASC
  `).all();

  // Newest relay_events row per channel (indexed lookup per channel is far
  // cheaper than a MAX(id) GROUP BY over the whole table).
  const lastEventStmt = db.prepare(`
    SELECT state, source, created_at, confirmed FROM relay_events
    WHERE equipment_id = ? AND channel = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  const lastEventFor = (equipmentId, channel) => {
    try { return lastEventStmt.get(equipmentId, channel) || null; } catch (e) { return null; }
  };

  const climate = sb.buildClimate(equipment, nowMs);
  const relayGroups = sb.buildRelayGroups(equipment, lastEventFor, nowMs);

  // Automations
  const enabledCount = db.prepare('SELECT COUNT(*) AS c FROM automations WHERE enabled = 1').get().c;
  let disarmed;
  try { disarmed = automationArmingService.getState(); } catch (e) { disarmed = { disarmed: true, reason: e.message }; }
  const recent = db.prepare(`
    SELECT al.automation_id, a.name, al.triggered_at, al.status, al.message
    FROM automation_logs al JOIN automations a ON a.id = al.automation_id
    ORDER BY al.triggered_at DESC, al.id DESC LIMIT 8
  `).all().map(r => ({
    automation_id: r.automation_id,
    name: r.name,
    ts: sb.toIso(r.triggered_at),
    trigger_type: sb.triggerTypeFromLogMessage(r.message),
    ok: r.status === 'success',
    status: r.status,
    message: r.message,
  }));
  const climateRules = db.prepare(`
    SELECT id, name, enabled, last_run, run_count FROM automations WHERE name LIKE 'Climate%' ORDER BY id ASC
  `).all().map(r => ({ id: r.id, name: r.name, enabled: !!r.enabled, last_run: sb.toIso(r.last_run), run_count: r.run_count || 0 }));

  // Alerts (open = unacknowledged)
  const alertCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN severity = 'warning'  THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN severity = 'info'     THEN 1 ELSE 0 END) AS info
    FROM alerts WHERE acknowledged = 0
  `).get();
  const latestAlerts = db.prepare(`
    SELECT id, severity, message, created_at, last_seen_at, occurrence_count
    FROM alerts WHERE acknowledged = 0
    ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC LIMIT 3
  `).all().map(a => ({
    id: a.id, severity: a.severity, message: a.message,
    ts: sb.toIso(a.last_seen_at || a.created_at), occurrence_count: a.occurrence_count || 1,
  }));

  // System
  const enabledEquipment = equipment.filter(e => e.enabled);
  let pollingPaused = false, heartbeatDeviceCount = 0;
  try { pollingPaused = !!modbusPollingService.isPaused; heartbeatDeviceCount = modbusPollingService.getHeartbeatDeviceCount(); } catch (e) {}
  let camera = null;
  try {
    const cam = db.prepare('SELECT id, name, status, updated_at FROM cameras WHERE enabled = 1 ORDER BY id ASC LIMIT 1').get();
    if (cam) camera = { id: cam.id, name: cam.name, status: cam.status, lastSeen: sb.toIso(cam.updated_at) };
  } catch (e) {}

  return {
    now: new Date(nowMs).toISOString(),
    timezone: readTimezone(),
    climate,
    relayGroups,
    automations: { enabled: enabledCount, disarmed, recent, climateRules },
    alerts: {
      critical: alertCounts.critical || 0,
      warning: alertCounts.warning || 0,
      info: alertCounts.info || 0,
      latest: latestAlerts,
    },
    system: {
      pollingPaused,
      heartbeatDeviceCount,
      devicesOnline: enabledEquipment.filter(e => e.status === 'online').length,
      devicesTotal: enabledEquipment.length,
      disabledDevices: equipment.filter(e => !e.enabled).map(e => e.id),
      camera,
    },
  };
}

router.get('/status-board', (req, res) => {
  try {
    const now = Date.now();
    if (statusBoardCache.body && now - statusBoardCache.at < STATUS_BOARD_CACHE_MS) {
      res.set('X-Cache', 'HIT');
      return res.json(statusBoardCache.body);
    }
    const body = buildStatusBoard();
    statusBoardCache = { at: now, body };
    res.set('X-Cache', 'MISS');
    res.json(body);
  } catch (err) {
    console.error('[Dashboard] status-board failed:', err.message);
    res.status(500).json({ error: 'status-board failed', message: err.message });
  }
});

/**
 * Build a map of equipment_id -> Set of disabled register names.
 * Used to filter out readings for registers the user has disabled.
 */
function getDisabledRegisterNames() {
  const disabledMap = new Map();
  try {
    const rows = db.prepare("SELECT id, register_mappings FROM equipment WHERE register_mappings IS NOT NULL").all();
    for (const row of rows) {
      let mappings;
      try { mappings = JSON.parse(row.register_mappings); } catch { continue; }
      if (!Array.isArray(mappings)) continue;
      const disabledNames = new Set();
      for (const m of mappings) {
        if (m.enabled === false) {
          disabledNames.add(m.name);
        }
      }
      if (disabledNames.size > 0) {
        disabledMap.set(row.id, disabledNames);
      }
    }
  } catch (err) {
    console.error('Error building disabled register map:', err.message);
  }
  return disabledMap;
}

// GET /api/dashboard/overview - Get dashboard overview
// Query params:
//   hours=24         - time range for chart data (default 24)
//   include_chart=1  - include chartReadings (default 1, set to 0 for lighter response)
router.get('/overview', (req, res) => {
  // Parse time range from query params (in hours, default 24)
  const hoursAgo = parseInt(req.query.hours) || 24;
  const includeChart = req.query.include_chart !== '0' && req.query.include_chart !== 'false';
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

  // Historical readings for chart (filtered by time range, downsampled).
  // Bucket width scales with the range so every range yields ~150 points per
  // series (24 h -> 10 min, 7 d -> 68 min, 30 d -> 288 min) instead of up to
  // 288 five-minute buckets. Minimum 5 min. Rows keep equipment_name because
  // the Dashboard chart/CSV export reads it per row.
  // Skip if client doesn't need chart data (saves ~400-650 KB per request)
  let chartReadings = [];
  if (includeChart) {
    const CHART_TARGET_POINTS = 150;
    const bucketMinutes = Math.max(5, Math.ceil((hoursAgo * 60) / CHART_TARGET_POINTS));
    const bucketSeconds = bucketMinutes * 60;
    // Bucket on the unix epoch (integer division), then render the bucket
    // start as 'YYYY-MM-DD HH:MM:SS' so the client parses it like before.
    const bucketExpr = `(CAST(strftime('%s', r.timestamp) AS INTEGER) / ${bucketSeconds}) * ${bucketSeconds}`;
    const chartQuery = `
      SELECT r.equipment_id,
        AVG(r.value) as value, r.unit, r.name,
        datetime(${bucketExpr}, 'unixepoch') as timestamp,
        e.name as equipment_name
      FROM readings r
      INNER JOIN equipment e ON r.equipment_id = e.id
      WHERE r.timestamp >= ?
      GROUP BY r.equipment_id, COALESCE(r.name, ''), ${bucketExpr}
      ORDER BY timestamp ASC`;
    chartReadings = db.prepare(chartQuery).all(startTime);
  }

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

  // Latest lab readings (one per nutrient per zone)
  const latestLabReadings = db.prepare(`
    SELECT lr.*, z.name as zone_name
    FROM lab_readings lr
    LEFT JOIN zones z ON lr.zone_id = z.id
    WHERE lr.id IN (SELECT MAX(id) FROM lab_readings GROUP BY nutrient, COALESCE(zone_id, 0))
    ORDER BY lr.zone_id ASC, lr.nutrient ASC
  `).all();

  // Filter out readings for disabled registers
  const disabledMap = getDisabledRegisterNames();
  const filterReading = (r) => {
    if (!r.name) return true;
    const disabled = disabledMap.get(r.equipment_id);
    return !disabled || !disabled.has(r.name);
  };

  res.json({
    equipment: equipmentStats,
    zones: { total: zoneCount.count },
    automations: automationStats,
    alerts: alertStats,
    recentAlerts,
    recentAutomations,
    latestReadings: latestReadings.filter(filterReading),
    activeAutomations,
    chartReadings: chartReadings.filter(filterReading),
    equipmentList,
    latestLabReadings,
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

  // Filter out readings for disabled registers
  const eqDisabledMap = getDisabledRegisterNames();
  const eqDisabled = eqDisabledMap.get(parseInt(equipmentId));
  const filteredReadings = eqDisabled
    ? readings.filter(r => !r.name || !eqDisabled.has(r.name))
    : readings;

  res.json({
    equipment,
    readings: filteredReadings,
    alerts,
    zones
  });
});

module.exports = router;
