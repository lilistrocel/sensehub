const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper function to get network interfaces
function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const networkInfo = {
    interfaces: [],
    ipAddress: null,
    gateway: null,
    dns: []
  };

  // Get all network interfaces
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        networkInfo.interfaces.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac
        });
        // Use first non-internal IPv4 as primary
        if (!networkInfo.ipAddress) {
          networkInfo.ipAddress = addr.address;
        }
      }
    }
  }

  // Try to determine gateway (this is platform-dependent)
  // On Linux, we can try reading /proc/net/route
  try {
    if (process.platform === 'linux') {
      const routeData = fs.readFileSync('/proc/net/route', 'utf8');
      const lines = routeData.split('\n');
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3 && parts[1] === '00000000') {
          // Default route - gateway is in hex
          const gatewayHex = parts[2];
          const octets = [];
          for (let i = 6; i >= 0; i -= 2) {
            octets.push(parseInt(gatewayHex.substring(i, i + 2), 16));
          }
          networkInfo.gateway = octets.join('.');
          break;
        }
      }
    }
  } catch (e) {
    // Fallback - use common default gateway pattern
    if (networkInfo.ipAddress) {
      const parts = networkInfo.ipAddress.split('.');
      networkInfo.gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    }
  }

  // Try to get DNS servers
  try {
    if (process.platform === 'linux') {
      const resolvConf = fs.readFileSync('/etc/resolv.conf', 'utf8');
      const lines = resolvConf.split('\n');
      for (const line of lines) {
        if (line.startsWith('nameserver')) {
          const dns = line.split(/\s+/)[1];
          if (dns) {
            networkInfo.dns.push(dns);
          }
        }
      }
    }
  } catch (e) {
    // Fallback - common DNS servers
    networkInfo.dns = ['8.8.8.8', '8.8.4.4'];
  }

  // Ensure we have defaults
  if (!networkInfo.ipAddress) {
    networkInfo.ipAddress = '127.0.0.1';
  }
  if (!networkInfo.gateway) {
    networkInfo.gateway = '192.168.1.1';
  }
  if (networkInfo.dns.length === 0) {
    networkInfo.dns = ['8.8.8.8', '8.8.4.4'];
  }

  return networkInfo;
}

// GET /api/settings/network - Get network configuration
router.get('/network', requireRole('admin'), (req, res) => {
  try {
    const networkInfo = getNetworkInfo();
    res.json(networkInfo);
  } catch (error) {
    console.error('Error getting network info:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to get network information' });
  }
});

// Helper function to get directory size
function getDirectorySize(dirPath) {
  let totalSize = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        totalSize += getDirectorySize(filePath);
      } else {
        try {
          const stats = fs.statSync(filePath);
          totalSize += stats.size;
        } catch (e) {
          // Skip files we can't read
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  return totalSize;
}

// GET /api/settings/storage - Get storage usage information
router.get('/storage', requireRole('admin'), (req, res) => {
  try {
    // Get database file size
    const dbPath = path.join(__dirname, '../../data/sensehub.db');
    let dbSize = 0;
    try {
      const dbStats = fs.statSync(dbPath);
      dbSize = dbStats.size;
    } catch (e) {
      // Database file might not exist yet
    }

    // Get data directory size (includes database and any other data files)
    const dataDir = path.join(__dirname, '../../data');
    const dataDirSize = getDirectorySize(dataDir);

    // Get logs directory size
    const logsDir = path.join(__dirname, '../../../logs');
    const logsDirSize = getDirectorySize(logsDir);

    // Get table counts for breakdown
    const tableStats = {};
    const tables = ['users', 'sessions', 'equipment', 'zones', 'equipment_zones',
                    'readings', 'automations', 'automation_logs', 'alerts',
                    'system_settings', 'sync_queue'];

    for (const table of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
        tableStats[table] = count.count;
      } catch (e) {
        tableStats[table] = 0;
      }
    }

    // Estimate total storage (in a real Pi deployment, we'd use disk stats)
    // For development, we'll simulate reasonable values
    const totalSpace = 32 * 1024 * 1024 * 1024; // 32 GB (typical SD card)
    const usedBySystem = 8 * 1024 * 1024 * 1024; // 8 GB for OS
    const usedByApp = dataDirSize + logsDirSize;
    const availableSpace = totalSpace - usedBySystem - usedByApp;

    res.json({
      database: {
        size: dbSize,
        path: dbPath
      },
      dataDirectory: {
        size: dataDirSize,
        path: dataDir
      },
      logsDirectory: {
        size: logsDirSize,
        path: logsDir
      },
      tableStats,
      disk: {
        total: totalSpace,
        used: usedBySystem + usedByApp,
        available: availableSpace,
        usedByApp: usedByApp,
        usedBySystem: usedBySystem,
        percentUsed: Math.round(((usedBySystem + usedByApp) / totalSpace) * 100)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting storage info:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to get storage information' });
  }
});

// GET /api/settings - Get system settings
router.get('/', requireRole('admin'), (req, res) => {
  const settings = db.prepare('SELECT * FROM system_settings').all();

  const settingsObj = {};
  settings.forEach(s => {
    try {
      settingsObj[s.key] = JSON.parse(s.value);
    } catch {
      settingsObj[s.key] = s.value;
    }
  });

  res.json(settingsObj);
});

// PUT /api/settings - Update system settings
router.put('/', requireRole('admin'), (req, res) => {
  const updates = req.body;

  const stmt = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);

  for (const [key, value] of Object.entries(updates)) {
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    stmt.run(key, valueStr, valueStr);
  }

  res.json({ message: 'Settings updated' });
});

// POST /api/settings/backup - Create backup
router.post('/backup', requireRole('admin'), (req, res) => {
  // In production, this would create an actual backup
  const backup = {
    id: Date.now(),
    created_at: new Date().toISOString(),
    size: '2.5 MB',
    status: 'completed'
  };

  res.json(backup);
});

// POST /api/settings/restore - Restore from backup
router.post('/restore', requireRole('admin'), (req, res) => {
  const { backup_id, confirm } = req.body;

  if (!confirm) {
    return res.status(400).json({ error: 'Bad Request', message: 'Confirmation required' });
  }

  // In production, this would restore from backup
  res.json({ message: 'Restore initiated', backup_id });
});

// POST /api/settings/factory-reset - Factory reset
router.post('/factory-reset', requireRole('admin'), (req, res) => {
  const { password, confirm } = req.body;

  if (!confirm || confirm !== 'FACTORY_RESET') {
    return res.status(400).json({ error: 'Bad Request', message: 'Must confirm with "FACTORY_RESET"' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password required' });
  }

  // Verify admin password
  const session = db.prepare(`
    SELECT u.password_hash FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(req.headers.authorization?.substring(7));

  if (!session || !bcrypt.compareSync(password, session.password_hash)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
  }

  // In production, this would perform factory reset
  res.json({ message: 'Factory reset initiated - system will restart' });
});

module.exports = router;
