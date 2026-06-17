const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Resolve the live database file path the same way utils/database.js does, so
// backup/restore/storage always point at the real DB (honours DB_PATH env in Docker).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/sensehub.db');
const DATA_DIR = path.dirname(DB_PATH);

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
    const dbPath = DB_PATH;
    let dbSize = 0;
    try {
      const dbStats = fs.statSync(dbPath);
      dbSize = dbStats.size;
    } catch (e) {
      // Database file might not exist yet
    }

    // Get data directory size (includes database and any other data files)
    const dataDir = DATA_DIR;
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

    const usedByApp = dataDirSize + logsDirSize;

    // Real disk stats for the filesystem holding the data directory.
    // fs.statfsSync is available on Node 18.15+. Fall back to an estimate if not.
    let totalSpace = 0;
    let availableSpace = 0;
    let usedSpace = 0;
    let usedBySystem = 0;
    let diskEstimated = false;

    try {
      if (typeof fs.statfsSync === 'function') {
        const stat = fs.statfsSync(dataDir);
        // bsize = block size, blocks = total, bavail = free for unprivileged user
        const blockSize = stat.bsize;
        totalSpace = stat.blocks * blockSize;
        availableSpace = stat.bavail * blockSize;
        usedSpace = totalSpace - (stat.bfree * blockSize);
        // Everything used that isn't this app's data/logs we attribute to "system".
        usedBySystem = Math.max(0, usedSpace - usedByApp);
      } else {
        throw new Error('fs.statfsSync unavailable');
      }
    } catch (e) {
      // Graceful fallback: report what we actually know (app usage) and clearly
      // flag the capacity figures as estimated rather than inventing exact values.
      diskEstimated = true;
      usedBySystem = 0;
      usedSpace = usedByApp;
      totalSpace = usedByApp; // only the portion we can measure
      availableSpace = 0;
    }

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
        used: usedSpace,
        available: availableSpace,
        usedByApp: usedByApp,
        usedBySystem: usedBySystem,
        percentUsed: totalSpace > 0 ? Math.round((usedSpace / totalSpace) * 100) : 0,
        estimated: diskEstimated
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

// The SQLite file magic header — first 16 bytes of every valid database file.
const SQLITE_MAGIC = Buffer.from('SQLite format 3 ', 'binary');

// GET /api/settings/backup - Create a real backup of the live DB and stream it
// to the client as a file download. Uses better-sqlite3's online backup API
// (db.backup) which produces a consistent snapshot safely while the DB is in
// use (it cooperates with WAL), writing to a temp file we then stream and clean up.
router.get('/backup', requireRole('admin'), async (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `sensehub-backup-${ts}.db`;
  const tmpPath = path.join(os.tmpdir(), `sensehub-backup-${Date.now()}-${process.pid}.db`);

  try {
    // db.backup() returns a Promise and runs incrementally, yielding to the
    // event loop between batches of pages, so it won't block on a large DB.
    await db.backup(tmpPath);
  } catch (error) {
    console.error('Backup creation failed:', error);
    try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create backup' });
  }

  let size = 0;
  try { size = fs.statSync(tmpPath).size; } catch (e) { /* ignore */ }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (size) res.setHeader('Content-Length', String(size));

  const cleanup = () => {
    try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
  };

  const stream = fs.createReadStream(tmpPath);
  stream.on('error', (err) => {
    console.error('Backup stream error:', err);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to stream backup' });
    } else {
      res.destroy();
    }
  });
  res.on('close', cleanup);
  stream.pipe(res);
});

// POST /api/settings/restore - Restore the DB from an uploaded SQLite file.
//
// Approach & limitation: better-sqlite3 holds an open handle on the live DB
// file for the lifetime of the process, so hot-swapping the file underneath it
// is unsafe. The robust approach used here is:
//   1. Validate the uploaded bytes are a real SQLite file (magic header) and
//      can be opened as a DB containing our expected tables.
//   2. Make a timestamped SAFETY COPY of the current live DB (never destroy the
//      current DB without a backup first).
//   3. Atomically replace the live DB file with the validated upload (and remove
//      the now-stale WAL/SHM sidecar files so SQLite re-derives them on boot).
//   4. Respond success instructing the client a restart is required, then
//      process.exit(0). Docker's `restart: unless-stopped` policy relaunches the
//      container, which reopens the freshly-restored DB file.
// LIMITATION: this only works under a process supervisor that restarts the app
// (Docker compose here). In a bare `node` dev run with no supervisor the file is
// replaced and the process exits, but it won't auto-restart — the operator must
// start it again manually. The DB is safely replaced regardless.
//
// The raw file is uploaded as application/octet-stream; express.raw() buffers it
// into req.body (express.json() ignores non-JSON content types so it is untouched).
router.post(
  '/restore',
  requireRole('admin'),
  express.raw({ type: ['application/octet-stream', 'application/x-sqlite3'], limit: '512mb' }),
  (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No backup file received. Upload the .db file as the raw request body (application/octet-stream).'
      });
    }

    // 1. Validate SQLite magic header.
    if (body.length < SQLITE_MAGIC.length || !body.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Uploaded file is not a valid SQLite database (bad file header).'
      });
    }

    // 2. Deeper validation: open the upload as a real SQLite DB and confirm it
    //    contains the tables we expect, BEFORE touching the live DB.
    const Database = require('better-sqlite3');
    const stagingPath = path.join(DATA_DIR, `restore-upload-${Date.now()}.db`);
    try {
      fs.writeFileSync(stagingPath, body);
    } catch (e) {
      console.error('Restore: failed to write staging file:', e);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to stage uploaded file' });
    }

    const REQUIRED_TABLES = ['users', 'equipment', 'system_settings'];
    try {
      const verifyDb = new Database(stagingPath, { readonly: true, fileMustExist: true });
      try {
        verifyDb.pragma('schema_version'); // forces a read; throws if not a DB
        const rows = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type='table'"
        ).all();
        const tableNames = new Set(rows.map(r => r.name));
        const missing = REQUIRED_TABLES.filter(t => !tableNames.has(t));
        if (missing.length > 0) {
          throw new Error(`backup is missing expected tables: ${missing.join(', ')}`);
        }
      } finally {
        verifyDb.close();
      }
    } catch (e) {
      try { fs.existsSync(stagingPath) && fs.unlinkSync(stagingPath); } catch (_) { /* ignore */ }
      console.error('Restore validation failed:', e.message);
      return res.status(400).json({
        error: 'Bad Request',
        message: `Uploaded file failed validation: ${e.message}`
      });
    }

    // 3. Safety-backup the current live DB, then replace it with the upload.
    const safetyTs = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyPath = path.join(DATA_DIR, `pre-restore-backup-${safetyTs}.db`);
    try {
      // Use the online backup API for a consistent copy of the live DB.
      // db.backup is async; await it inside this sync handler via a small wrapper.
      // (We must complete it before overwriting the file.)
      // eslint-disable-next-line no-inner-declarations
      const doSwap = async () => {
        await db.backup(safetyPath);

        // Replace the live DB file with the validated upload.
        fs.copyFileSync(stagingPath, DB_PATH);
        try { fs.unlinkSync(stagingPath); } catch (_) { /* ignore */ }

        // Remove stale WAL/SHM so SQLite doesn't replay the old WAL over the new file.
        for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
          try { fs.existsSync(sidecar) && fs.unlinkSync(sidecar); } catch (_) { /* ignore */ }
        }
      };

      doSwap()
        .then(() => {
          console.log(`Restore complete. Safety backup at ${safetyPath}. Restarting process...`);
          res.json({
            success: true,
            message: 'Restore complete. The system is restarting to load the restored database. You may need to log in again.',
            safetyBackup: path.basename(safetyPath),
            restarting: true
          });
          // Give the response time to flush, then exit so the supervisor (Docker)
          // restarts us with the new DB file. SIGTERM handlers also run on exit.
          setTimeout(() => process.exit(0), 750);
        })
        .catch((err) => {
          console.error('Restore swap failed:', err);
          try { fs.existsSync(stagingPath) && fs.unlinkSync(stagingPath); } catch (_) { /* ignore */ }
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error', message: 'Restore failed while applying backup. Live database was not modified.' });
          }
        });
    } catch (error) {
      console.error('Restore error:', error);
      try { fs.existsSync(stagingPath) && fs.unlinkSync(stagingPath); } catch (_) { /* ignore */ }
      return res.status(500).json({ error: 'Internal Server Error', message: 'Restore failed' });
    }
  }
);

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

  try {
    // Clear all data tables (in order to respect foreign keys)
    const tablesToClear = [
      'sync_queue',
      'automation_logs',
      'alerts',
      'readings',
      'equipment_zones',
      'automations',
      'zones',
      'equipment',
      'sessions',
      'users',
      'system_settings'
    ];

    // Use transaction for atomic operation
    const clearTables = db.transaction(() => {
      for (const table of tablesToClear) {
        try {
          db.prepare(`DELETE FROM ${table}`).run();
        } catch (e) {
          console.log(`Note: Could not clear table ${table}: ${e.message}`);
        }
      }

      // Mark system as needing setup by ensuring no users exist
      // The setup-status endpoint checks for user count
    });

    clearTables();

    console.log('Factory reset completed - all data cleared');

    res.json({
      success: true,
      message: 'Factory reset complete - redirecting to setup wizard',
      redirectTo: '/setup'
    });
  } catch (error) {
    console.error('Factory reset error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Factory reset failed' });
  }
});

module.exports = router;
