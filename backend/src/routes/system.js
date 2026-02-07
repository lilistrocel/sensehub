const express = require('express');
const os = require('os');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/system/info - Get system information
router.get('/info', (req, res) => {
  const info = {
    version: process.env.npm_package_version || '1.0.0',
    node_version: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: process.uptime(),
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

// GET /api/system/logs - Get system logs
router.get('/logs', requireRole('admin'), (req, res) => {
  const { level, limit } = req.query;

  // In production, this would read from actual log files
  const logs = [
    { timestamp: new Date().toISOString(), level: 'info', message: 'System started' },
    { timestamp: new Date().toISOString(), level: 'info', message: 'Database connected' }
  ];

  res.json(logs);
});

module.exports = router;
