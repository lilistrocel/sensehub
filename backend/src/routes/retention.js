const express = require('express');
const { dataRetentionService } = require('../services/DataRetentionService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/retention/config — current settings
router.get('/config', (req, res) => {
  res.json({
    ...dataRetentionService.getConfig(),
    last_run_summary: dataRetentionService.getLastRunSummary(),
  });
});

// PUT /api/retention/config — admin only
router.put('/config', requireRole('admin'), (req, res) => {
  try {
    const merged = dataRetentionService.saveConfig(req.body || {});
    res.json(merged);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/retention/dry-run — admin only. Reports what would be dropped without modifying anything.
router.post('/dry-run', requireRole('admin'), (req, res) => {
  try {
    const cfg = { ...dataRetentionService.getConfig(), ...(req.body || {}), dry_run: true };
    const summary = dataRetentionService.runOnce(cfg);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/retention/run-now — admin only. Executes the retention cycle immediately.
router.post('/run-now', requireRole('admin'), (req, res) => {
  try {
    const cfg = { ...dataRetentionService.getConfig(), ...(req.body || {}) };
    const summary = dataRetentionService.runOnce(cfg);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
