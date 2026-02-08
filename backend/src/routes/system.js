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

module.exports = router;
