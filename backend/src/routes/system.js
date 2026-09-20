const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Get build date from package.json modification time or current date as fallback
const getBuildDate = () => {
  try {
    const packagePath = path.join(__dirname, '../../package.json');
    const stats = fs.statSync(packagePath);
    return stats.mtime.toISOString();
  } catch (e) {
    return new Date().toISOString();
  }
};

// Store start time for uptime calculations
const startTime = new Date();

// GET /api/system/info - Get system information
router.get('/info', (req, res) => {
  const info = {
    version: '1.0.0',
    buildDate: getBuildDate(),
    releaseType: 'stable',
    codename: 'Edge One',
    node_version: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: process.uptime(),
    startedAt: startTime.toISOString(),
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem()
    },
    cpus: os.cpus().length,
    database: {
      connected: db !== null,
      path: process.env.DB_PATH || 'data/sensehub.db'
    }
  };

  res.json(info);
});

// GET /api/system/schema - Get database schema information
router.get('/schema', (req, res) => {
  try {
    // Get all tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

    const schema = {};
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
      schema[table.name] = columns.map(col => ({
        name: col.name,
        type: col.type,
        notnull: col.notnull === 1,
        pk: col.pk === 1
      }));
    }

    res.json({
      tables: tables.map(t => t.name),
      tableCount: tables.length,
      schema
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/system/logs - Get system logs
router.get('/logs', requireRole('admin'), (req, res) => {
  const { level, limit = 100, offset = 0 } = req.query;
  const maxLimit = parseInt(limit) || 100;
  const offsetNum = parseInt(offset) || 0;

  try {
    // Read actual log files
    const logsDir = path.join(__dirname, '../../..', 'logs');
    const logs = [];

    // Log file paths to read
    const logFiles = [
      { path: path.join(logsDir, 'backend.log'), source: 'backend' },
      { path: path.join(logsDir, 'frontend.log'), source: 'frontend' },
      { path: path.join(logsDir, 'init.log'), source: 'init' }
    ];

    // Also read system events from database
    try {
      const systemLogs = db.prepare(`
        SELECT 'automation' as source, 'info' as level,
               status || ': ' || COALESCE(message, name) as message,
               triggered_at as timestamp
        FROM automation_logs al
        JOIN automations a ON al.automation_id = a.id
        ORDER BY triggered_at DESC
        LIMIT 50
      `).all();

      systemLogs.forEach(log => {
        logs.push({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level,
          source: log.source,
          message: log.message
        });
      });
    } catch (dbErr) {
      // Ignore if table doesn't exist
    }

    // Read from actual log files
    for (const logFile of logFiles) {
      try {
        if (fs.existsSync(logFile.path)) {
          const content = fs.readFileSync(logFile.path, 'utf8');
          const lines = content.split('\n').filter(line => line.trim());

          lines.forEach(line => {
            // Parse log lines - try to extract timestamp and level
            let timestamp = new Date().toISOString();
            let logLevel = 'info';
            let message = line;

            // Try to parse nodemon/npm style logs
            if (line.includes('[nodemon]')) {
              logLevel = 'info';
              message = line.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI codes
            } else if (line.toLowerCase().includes('error')) {
              logLevel = 'error';
            } else if (line.toLowerCase().includes('warn')) {
              logLevel = 'warning';
            } else if (line.toLowerCase().includes('debug')) {
              logLevel = 'debug';
            }

            // Try to extract timestamp from line (ISO format or common formats)
            const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
            if (timestampMatch) {
              timestamp = new Date(timestampMatch[1]).toISOString();
            }

            logs.push({
              timestamp,
              level: logLevel,
              source: logFile.source,
              message: message.trim()
            });
          });
        }
      } catch (fileErr) {
        // Skip files that can't be read
      }
    }

    // Add some system events from alerts
    try {
      const alertLogs = db.prepare(`
        SELECT 'alert' as source, severity as level, message,
               created_at as timestamp
        FROM alerts
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      alertLogs.forEach(log => {
        logs.push({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level === 'critical' ? 'error' : (log.level === 'warning' ? 'warning' : 'info'),
          source: log.source,
          message: log.message
        });
      });
    } catch (dbErr) {
      // Ignore if table doesn't exist
    }

    // Sort by timestamp descending (most recent first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Filter by level if specified
    let filteredLogs = logs;
    if (level && level !== 'all') {
      const levelOrder = { error: 0, warning: 1, info: 2, debug: 3 };
      const filterLevel = levelOrder[level] !== undefined ? levelOrder[level] : 2;
      filteredLogs = logs.filter(log => {
        const logLevelNum = levelOrder[log.level] !== undefined ? levelOrder[log.level] : 2;
        return logLevelNum <= filterLevel;
      });
    }

    // Apply pagination
    const paginatedLogs = filteredLogs.slice(offsetNum, offsetNum + maxLimit);

    res.json({
      logs: paginatedLogs,
      total: filteredLogs.length,
      offset: offsetNum,
      limit: maxLimit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/system/services - Get status of all services and Docker containers
router.get('/services', requireRole('admin'), async (req, res) => {
  const services = [];

  // 1. Backend (self)
  services.push({
    name: 'Backend API',
    container: 'sensehub-backend',
    type: 'core',
    status: 'online',
    port: process.env.PORT || 3003,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    details: { pid: process.pid, nodeVersion: process.version }
  });

  // 2. Database
  services.push({
    name: 'Database (SQLite)',
    type: 'core',
    status: db ? 'online' : 'offline',
    details: { path: process.env.DB_PATH || 'data/sensehub.db' }
  });

  // 3. go2rtc
  try {
    const r = await fetch('http://127.0.0.1:1984/api', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const info = await r.json();
      services.push({
        name: 'go2rtc (Camera Streams)',
        container: 'sensehub-go2rtc',
        type: 'sidecar',
        status: 'online',
        port: 1984,
        details: { version: info.version, revision: info.revision }
      });
    } else {
      services.push({ name: 'go2rtc (Camera Streams)', container: 'sensehub-go2rtc', type: 'sidecar', status: 'error', details: { httpStatus: r.status } });
    }
  } catch (e) {
    services.push({ name: 'go2rtc (Camera Streams)', container: 'sensehub-go2rtc', type: 'sidecar', status: 'offline', error: e.message });
  }

  // 4. MCP Server
  try {
    const r = await fetch('http://127.0.0.1:3001/health', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const info = await r.json();
      services.push({
        name: 'MCP Server',
        container: 'sensehub-mcp',
        type: 'sidecar',
        status: 'online',
        port: 3001,
        details: info
      });
    } else {
      services.push({ name: 'MCP Server', container: 'sensehub-mcp', type: 'sidecar', status: 'error', details: { httpStatus: r.status } });
    }
  } catch (e) {
    services.push({ name: 'MCP Server', container: 'sensehub-mcp', type: 'sidecar', status: 'offline', error: e.message });
  }

  // 5. Frontend/Nginx (check from backend side)
  try {
    const r = await fetch('http://127.0.0.1:3002/', { signal: AbortSignal.timeout(3000) });
    services.push({
      name: 'Frontend (Nginx)',
      container: 'sensehub-frontend',
      type: 'core',
      status: r.ok ? 'online' : 'error',
      port: 3002,
      details: { httpStatus: r.status }
    });
  } catch (e) {
    services.push({ name: 'Frontend (Nginx)', container: 'sensehub-frontend', type: 'core', status: 'offline', error: e.message });
  }

  // 6. Cloudflared tunnel
  try {
    // Cloudflared doesn't have a health endpoint; check if the metrics endpoint is reachable
    const r = await fetch('http://127.0.0.1:45705/metrics', { signal: AbortSignal.timeout(3000) });
    services.push({
      name: 'Cloudflare Tunnel',
      container: 'sensehub-cloudflared',
      type: 'sidecar',
      status: r.ok ? 'online' : 'error',
      details: { metricsAvailable: r.ok }
    });
  } catch (e) {
    // Cloudflared may not expose metrics - just report unknown
    services.push({ name: 'Cloudflare Tunnel', container: 'sensehub-cloudflared', type: 'sidecar', status: 'unknown', error: 'Metrics endpoint not reachable' });
  }

  // 7. Internal services (Modbus, Automation, Camera)
  const { modbusPollingService } = require('../services/ModbusPollingService');
  const { automationSchedulerService } = require('../services/AutomationSchedulerService');
  const { cameraStreamService } = require('../services/CameraStreamService');

  services.push({
    name: 'Modbus Polling',
    type: 'internal',
    status: modbusPollingService.isPaused
      ? 'paused'
      : (modbusPollingService.isRunning ? 'online' : 'offline'),
    details: {
      deviceCount: modbusPollingService.devices ? modbusPollingService.devices.size : 0,
      paused: !!modbusPollingService.isPaused,
      autoResumeAt: modbusPollingService.autoResumeAt || null
    }
  });

  services.push({
    name: 'Automation Scheduler',
    type: 'internal',
    status: automationSchedulerService.intervalId ? 'online' : 'offline'
  });

  services.push({
    name: 'Camera Stream Service',
    type: 'internal',
    status: cameraStreamService.ready ? 'online' : 'offline',
    details: { go2rtcConnected: cameraStreamService.ready }
  });

  // System info
  const systemInfo = {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
    loadAvg: os.loadavg(),
    uptime: os.uptime()
  };

  res.json({ services, system: systemInfo, timestamp: new Date().toISOString() });
});

// DELETE /api/system/clear/:target - Clear history data
router.delete('/clear/:target', requireRole('admin'), (req, res) => {
  const { target } = req.params;
  const { before } = req.query; // optional ISO date to only clear older records

  const results = {};

  try {
    const whereDate = before ? ` AND created_at < ?` : '';
    const params = before ? [before] : [];

    switch (target) {
      case 'alerts': {
        const r = db.prepare(`DELETE FROM alerts WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'alerts';
        break;
      }
      case 'automation-logs': {
        const dateCol = before ? ' AND triggered_at < ?' : '';
        const r = db.prepare(`DELETE FROM automation_logs WHERE 1=1${dateCol}`).run(...params);
        results.deleted = r.changes;
        results.target = 'automation_logs';
        break;
      }
      case 'equipment-errors': {
        const r = db.prepare(`DELETE FROM equipment_errors WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'equipment_errors';
        // Reset equipment error_log field
        db.prepare("UPDATE equipment SET error_log = NULL WHERE error_log IS NOT NULL").run();
        break;
      }
      case 'readings': {
        const dateCol = before ? ' AND timestamp < ?' : '';
        const r = db.prepare(`DELETE FROM readings WHERE 1=1${dateCol}`).run(...params);
        results.deleted = r.changes;
        results.target = 'readings';
        break;
      }
      case 'lab-readings': {
        const dateCol = before ? ' AND sample_date < ?' : '';
        const r = db.prepare(`DELETE FROM lab_readings WHERE 1=1${dateCol}`).run(...params);
        results.deleted = r.changes;
        results.target = 'lab_readings';
        break;
      }
      case 'sync-queue': {
        const r = db.prepare(`DELETE FROM sync_queue WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'sync_queue';
        break;
      }
      case 'relay-events': {
        const r = db.prepare(`DELETE FROM relay_events WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'relay_events';
        break;
      }
      case 'watchdog-events': {
        const r = db.prepare(`DELETE FROM watchdog_events WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'watchdog_events';
        break;
      }
      case 'watchdog-cooldowns': {
        const r1 = db.prepare("UPDATE automations SET last_watchdog_alert = NULL WHERE last_watchdog_alert IS NOT NULL").run();
        const r2 = db.prepare("UPDATE equipment SET last_watchdog_alert = NULL WHERE last_watchdog_alert IS NOT NULL").run();
        results.deleted = r1.changes + r2.changes;
        results.target = 'watchdog_cooldowns';
        break;
      }
      case 'request-log': {
        const r = db.prepare(`DELETE FROM request_log WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'request_log';
        break;
      }
      case 'network-usage': {
        const r = db.prepare(`DELETE FROM network_usage WHERE 1=1${whereDate}`).run(...params);
        results.deleted = r.changes;
        results.target = 'network_usage';
        break;
      }
      default:
        return res.status(400).json({ error: 'Bad Request', message: `Unknown target: ${target}` });
    }

    console.log(`[System] Cleared ${results.deleted} records from ${results.target}${before ? ` (before ${before})` : ''}`);
    res.json({ message: `Cleared ${results.deleted} record(s) from ${results.target}`, ...results });
  } catch (err) {
    console.error('[System] Clear error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

// GET /api/system/data-counts - Get record counts for data management
router.get('/data-counts', requireRole('admin'), (req, res) => {
  try {
    const counts = {
      alerts: db.prepare('SELECT COUNT(*) as count FROM alerts').get().count,
      automation_logs: db.prepare('SELECT COUNT(*) as count FROM automation_logs').get().count,
      equipment_errors: db.prepare('SELECT COUNT(*) as count FROM equipment_errors').get().count,
      readings: db.prepare('SELECT COUNT(*) as count FROM readings').get().count,
      lab_readings: db.prepare('SELECT COUNT(*) as count FROM lab_readings').get().count,
      relay_events: db.prepare('SELECT COUNT(*) as count FROM relay_events').get().count,
      watchdog_events: db.prepare('SELECT COUNT(*) as count FROM watchdog_events').get().count,
      sync_queue: db.prepare('SELECT COUNT(*) as count FROM sync_queue').get().count,
      request_log: (() => { try { return db.prepare('SELECT COUNT(*) as count FROM request_log').get().count; } catch { return 0; } })(),
      network_usage: (() => { try { return db.prepare('SELECT COUNT(*) as count FROM network_usage').get().count; } catch { return 0; } })(),
    };
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/connectivity - Current connectivity status + recent history
router.get('/connectivity', (req, res) => {
  try {
    const { watchdogService } = require('../services/WatchdogService');
    const current = watchdogService.getConnectivityStatus();

    const history = db.prepare(`
      SELECT * FROM watchdog_events
      WHERE event_type IN ('connectivity', 'system')
      ORDER BY created_at DESC
      LIMIT 200
    `).all();

    res.json({ current, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/watchdog-history - All watchdog events with optional filters
router.get('/watchdog-history', (req, res) => {
  const { event_type, target, limit = 100, offset = 0 } = req.query;

  let where = '1=1';
  const params = [];

  if (event_type) { where += ' AND event_type = ?'; params.push(event_type); }
  if (target) { where += ' AND target = ?'; params.push(target); }

  try {
    const total = db.prepare(`SELECT COUNT(*) as count FROM watchdog_events WHERE ${where}`).get(...params).count;
    const events = db.prepare(`
      SELECT * FROM watchdog_events
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    res.json({ events, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/request-log - Get API request log analytics
router.get('/request-log', requireRole('admin'), (req, res) => {
  const { minutes = 60, group_by = 'path' } = req.query;
  const cutoff = new Date(Date.now() - parseInt(minutes) * 60 * 1000).toISOString();

  try {
    // Per-path summary
    const byPath = db.prepare(`
      SELECT path, method,
             COUNT(*) as requests,
             SUM(response_bytes) as total_bytes,
             AVG(response_bytes) as avg_bytes,
             AVG(duration_ms) as avg_duration_ms,
             MAX(response_bytes) as max_bytes
      FROM request_log
      WHERE created_at > ?
      GROUP BY path, method
      ORDER BY total_bytes DESC
    `).all(cutoff);

    // Per-IP summary
    const byIp = db.prepare(`
      SELECT ip,
             COUNT(*) as requests,
             SUM(response_bytes) as total_bytes,
             COUNT(DISTINCT path) as unique_paths
      FROM request_log
      WHERE created_at > ?
      GROUP BY ip
      ORDER BY total_bytes DESC
    `).all(cutoff);

    // Overall totals
    const totals = db.prepare(`
      SELECT COUNT(*) as requests,
             SUM(response_bytes) as total_bytes,
             AVG(response_bytes) as avg_bytes,
             AVG(duration_ms) as avg_duration_ms
      FROM request_log
      WHERE created_at > ?
    `).get(cutoff);

    // Recent requests
    const recent = db.prepare(`
      SELECT method, path, status, response_bytes, duration_ms, ip, created_at
      FROM request_log
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(cutoff);

    res.json({ byPath, byIp, totals, recent, period: { minutes: parseInt(minutes), since: cutoff } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/relay-drift - Get relay drift log entries
router.get('/relay-drift', requireRole('admin'), (req, res) => {
  const { limit = 100, equipment_id, hours = 24 } = req.query;
  try {
    const cutoff = new Date(Date.now() - parseInt(hours) * 3600 * 1000).toISOString();
    let where = 'created_at > ?';
    const params = [cutoff];
    if (equipment_id) {
      where += ' AND equipment_id = ?';
      params.push(parseInt(equipment_id));
    }
    const entries = db.prepare(`
      SELECT * FROM relay_drift_log
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, parseInt(limit));

    // Summary by equipment+channel
    const summary = db.prepare(`
      SELECT equipment_id, equipment_name, channel, context, COUNT(*) as count,
             MAX(created_at) as last_seen
      FROM relay_drift_log
      WHERE created_at > ?
      GROUP BY equipment_id, channel, context
      ORDER BY count DESC, last_seen DESC
    `).all(cutoff);

    res.json({ entries, summary, period: { hours: parseInt(hours), since: cutoff } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/network-usage - Get network usage statistics
router.get('/network-usage', requireRole('admin'), (req, res) => {
  const { period = 'daily', days = 30, interface: iface } = req.query;

  try {
    let groupBy, dateFormat, limit;
    if (period === 'monthly') {
      groupBy = "strftime('%Y-%m', timestamp)";
      dateFormat = 'month';
      limit = parseInt(days) || 12;
    } else {
      // daily (default)
      groupBy = "date(timestamp)";
      dateFormat = 'day';
      limit = parseInt(days) || 30;
    }

    let whereClause = '1=1';
    const params = [];

    if (iface) {
      whereClause += ' AND interface = ?';
      params.push(iface);
    }

    // Aggregated usage per period
    const usage = db.prepare(`
      SELECT ${groupBy} as period,
             interface,
             SUM(rx_bytes) as rx_bytes,
             SUM(tx_bytes) as tx_bytes,
             SUM(rx_bytes + tx_bytes) as total_bytes,
             COUNT(*) as samples
      FROM network_usage
      WHERE ${whereClause}
      GROUP BY ${groupBy}, interface
      ORDER BY period DESC
      LIMIT ?
    `).all(...params, limit * 10); // multiply for multiple interfaces

    // Total summary
    const summary = db.prepare(`
      SELECT interface,
             SUM(rx_bytes) as rx_bytes,
             SUM(tx_bytes) as tx_bytes,
             SUM(rx_bytes + tx_bytes) as total_bytes,
             MIN(timestamp) as first_record,
             MAX(timestamp) as last_record,
             COUNT(*) as samples
      FROM network_usage
      WHERE ${whereClause}
      GROUP BY interface
    `).all(...params);

    // Today's usage
    const today = db.prepare(`
      SELECT interface,
             SUM(rx_bytes) as rx_bytes,
             SUM(tx_bytes) as tx_bytes,
             SUM(rx_bytes + tx_bytes) as total_bytes
      FROM network_usage
      WHERE date(timestamp) = date('now') ${iface ? 'AND interface = ?' : ''}
      GROUP BY interface
    `).all(...(iface ? [iface] : []));

    // This month's usage
    const thisMonth = db.prepare(`
      SELECT interface,
             SUM(rx_bytes) as rx_bytes,
             SUM(tx_bytes) as tx_bytes,
             SUM(rx_bytes + tx_bytes) as total_bytes
      FROM network_usage
      WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now') ${iface ? 'AND interface = ?' : ''}
      GROUP BY interface
    `).all(...(iface ? [iface] : []));

    // Available interfaces
    const interfaces = db.prepare(
      'SELECT DISTINCT interface FROM network_usage ORDER BY interface'
    ).all().map(r => r.interface);

    res.json({
      period: dateFormat,
      usage,
      summary,
      today,
      thisMonth,
      interfaces
    });
  } catch (err) {
    console.error('[System] Network usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/network-usage/live - Get current /proc/net/dev snapshot
router.get('/network-usage/live', requireRole('admin'), (req, res) => {
  try {
    const content = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = content.split('\n').slice(2);
    const interfaces = [];
    const excluded = new Set(['lo', 'docker0']);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ifacePart, ...rest] = trimmed.split(':');
      const iface = ifacePart.trim();
      if (excluded.has(iface) || iface.startsWith('br-') || iface.startsWith('veth')) continue;
      const values = rest.join(':').trim().split(/\s+/);
      interfaces.push({
        name: iface,
        rx_bytes: parseInt(values[0]) || 0,
        tx_bytes: parseInt(values[8]) || 0,
        rx_packets: parseInt(values[1]) || 0,
        tx_packets: parseInt(values[9]) || 0
      });
    }

    res.json({ interfaces, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
