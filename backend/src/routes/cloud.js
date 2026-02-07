const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/cloud/status - Get cloud connection status
router.get('/status', (req, res) => {
  const cloudConfig = db.prepare("SELECT * FROM system_settings WHERE key = 'cloud_config'").get();
  const lastSync = db.prepare("SELECT * FROM system_settings WHERE key = 'last_cloud_sync'").get();

  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending'").get();

  res.json({
    configured: !!cloudConfig,
    connected: false, // Would be determined by actual connection test
    lastSync: lastSync ? JSON.parse(lastSync.value) : null,
    pendingItems: pendingCount.count
  });
});

// POST /api/cloud/connect - Configure cloud connection
router.post('/connect', requireRole('admin'), (req, res) => {
  const { url, apiKey } = req.body;

  if (!url || !apiKey) {
    return res.status(400).json({ error: 'Bad Request', message: 'URL and API key are required' });
  }

  const config = JSON.stringify({ url, apiKey, configuredAt: new Date().toISOString() });

  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('cloud_config', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(config, config);

  res.json({ message: 'Cloud connection configured' });
});

// POST /api/cloud/disconnect - Disconnect from cloud
router.post('/disconnect', requireRole('admin'), (req, res) => {
  db.prepare("DELETE FROM system_settings WHERE key = 'cloud_config'").run();

  res.json({ message: 'Cloud connection removed' });
});

// POST /api/cloud/sync - Trigger manual sync
router.post('/sync', requireRole('admin', 'operator'), (req, res) => {
  // Would trigger actual sync in production
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('last_cloud_sync', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(JSON.stringify({ timestamp: now }), JSON.stringify({ timestamp: now }));

  res.json({ message: 'Sync triggered', timestamp: now });
});

// GET /api/cloud/pending - Get pending sync items
router.get('/pending', (req, res) => {
  const pending = db.prepare(`
    SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC
  `).all();

  res.json(pending);
});

module.exports = router;
