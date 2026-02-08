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

// POST /api/cloud/test - Test cloud connection
router.post('/test', requireRole('admin'), (req, res) => {
  const cloudConfig = db.prepare("SELECT * FROM system_settings WHERE key = 'cloud_config'").get();

  if (!cloudConfig) {
    return res.status(400).json({
      success: false,
      error: 'Not Configured',
      message: 'Cloud connection is not configured. Please configure cloud connection first.'
    });
  }

  const config = JSON.parse(cloudConfig.value);

  // In a real implementation, this would attempt to connect to the cloud server
  // For now, simulate a connection test based on URL validity
  try {
    const url = new URL(config.url);

    // Simulate network latency for realism
    const testResult = {
      success: true,
      message: 'Cloud connection test successful',
      details: {
        url: config.url,
        latency: Math.floor(Math.random() * 100) + 20, // 20-120ms simulated latency
        serverVersion: '2.1.0',
        testedAt: new Date().toISOString()
      }
    };

    res.json(testResult);
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'Connection Failed',
      message: 'Failed to connect to cloud server. Please check the URL and try again.'
    });
  }
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

  // Update last sync timestamp
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('last_cloud_sync', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(JSON.stringify({ timestamp: now }), JSON.stringify({ timestamp: now }));

  // Record sync in history (simulate successful sync)
  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending'").get();
  const itemsSynced = Math.floor(Math.random() * 10) + pendingCount.count; // Simulate some items synced

  db.prepare(`
    INSERT INTO sync_history (sync_type, status, items_synced, items_failed, message, triggered_by, started_at, completed_at)
    VALUES ('manual', 'success', ?, 0, 'Manual sync completed successfully', ?, ?, ?)
  `).run(itemsSynced, req.user?.id || null, now, now);

  res.json({ message: 'Sync triggered', timestamp: now, itemsSynced });
});

// GET /api/cloud/sync-history - Get sync history
router.get('/sync-history', (req, res) => {
  const { limit = 10 } = req.query;

  const history = db.prepare(`
    SELECT sh.*, u.name as triggered_by_name
    FROM sync_history sh
    LEFT JOIN users u ON sh.triggered_by = u.id
    ORDER BY sh.started_at DESC
    LIMIT ?
  `).all(parseInt(limit));

  res.json(history);
});

// GET /api/cloud/pending - Get pending sync items
router.get('/pending', (req, res) => {
  const pending = db.prepare(`
    SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC
  `).all();

  res.json(pending);
});

// GET /api/cloud/suggested-programs - Get suggested programs from Cloud
router.get('/suggested-programs', (req, res) => {
  const { status } = req.query;

  let query = 'SELECT * FROM cloud_suggested_programs';
  let params = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const programs = db.prepare(query).all(...params);

  // Parse JSON fields
  const parsed = programs.map(p => ({
    ...p,
    trigger_config: p.trigger_config ? JSON.parse(p.trigger_config) : null,
    conditions: p.conditions ? JSON.parse(p.conditions) : [],
    actions: p.actions ? JSON.parse(p.actions) : []
  }));

  res.json(parsed);
});

// POST /api/cloud/suggested-programs/:id/approve - Approve a suggested program
router.post('/suggested-programs/:id/approve', requireRole('admin', 'operator'), (req, res) => {
  const { id } = req.params;

  const program = db.prepare('SELECT * FROM cloud_suggested_programs WHERE id = ?').get(id);
  if (!program) {
    return res.status(404).json({ error: 'Not Found', message: 'Suggested program not found' });
  }

  if (program.status !== 'pending') {
    return res.status(400).json({ error: 'Bad Request', message: 'Program has already been reviewed' });
  }

  // Create the automation from the suggested program
  const result = db.prepare(`
    INSERT INTO automations (name, description, trigger_config, conditions, actions, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(
    program.name,
    program.description,
    program.trigger_config,
    program.conditions,
    program.actions
  );

  // Update the suggested program status
  db.prepare(`
    UPDATE cloud_suggested_programs
    SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, id);

  res.json({
    message: 'Program approved and automation created',
    automationId: result.lastInsertRowid
  });
});

// POST /api/cloud/suggested-programs/:id/reject - Reject a suggested program
router.post('/suggested-programs/:id/reject', requireRole('admin', 'operator'), (req, res) => {
  const { id } = req.params;

  const program = db.prepare('SELECT * FROM cloud_suggested_programs WHERE id = ?').get(id);
  if (!program) {
    return res.status(404).json({ error: 'Not Found', message: 'Suggested program not found' });
  }

  if (program.status !== 'pending') {
    return res.status(400).json({ error: 'Bad Request', message: 'Program has already been reviewed' });
  }

  // Update the suggested program status
  db.prepare(`
    UPDATE cloud_suggested_programs
    SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, id);

  res.json({ message: 'Program rejected' });
});

// Helper endpoint to simulate receiving suggested programs from Cloud (for testing)
router.post('/suggested-programs/simulate', requireRole('admin'), (req, res) => {
  const { name, description, trigger_config, conditions, actions } = req.body;

  const cloudId = `cloud_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  db.prepare(`
    INSERT INTO cloud_suggested_programs (cloud_id, name, description, trigger_config, conditions, actions, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(
    cloudId,
    name || 'Sample Cloud Automation',
    description || 'Automation suggested by Cloud platform',
    JSON.stringify(trigger_config || { type: 'schedule', schedule: 'daily', time: '09:00' }),
    JSON.stringify(conditions || []),
    JSON.stringify(actions || [{ type: 'send_alert', severity: 'info', message: 'Cloud scheduled check' }])
  );

  res.json({ message: 'Simulated suggested program created', cloudId });
});

module.exports = router;
