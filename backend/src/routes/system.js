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
    status: modbusPollingService.isRunning ? 'online' : 'offline',
    details: { deviceCount: modbusPollingService.devices ? modbusPollingService.devices.size : 0 }
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

module.exports = router;
