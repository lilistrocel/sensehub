const express = require('express');
const { agronomistService } = require('../services/AgronomistService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/agronomist/config — current config + key-present flag
router.get('/config', (req, res) => {
  const cfg = agronomistService.getConfig();
  res.json({
    ...cfg,
    api_key_present: !!process.env.ANTHROPIC_API_KEY,
  });
});

// PUT /api/agronomist/config — update config (admin only)
router.put('/config', requireRole('admin'), (req, res) => {
  try {
    const updated = agronomistService.saveConfig(req.body || {});
    res.json({
      ...updated,
      api_key_present: !!process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/agronomist/reports?limit=30&offset=0
router.get('/reports', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const offset = parseInt(req.query.offset) || 0;
  res.json(agronomistService.listReports(limit, offset));
});

// GET /api/agronomist/reports/:id
router.get('/reports/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const report = agronomistService.getReportById(id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
});

// GET /api/agronomist/reports/by-date/:date — YYYY-MM-DD
router.get('/reports/by-date/:date', (req, res) => {
  const report = agronomistService.getReportByDate(req.params.date);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
});

// POST /api/agronomist/generate — manual trigger
// Body: { date?: 'YYYY-MM-DD' (defaults to today), force?: boolean }
router.post('/generate', requireRole('admin', 'operator'), async (req, res) => {
  const { date, force } = req.body || {};
  try {
    const report = await agronomistService.generateDailyReport(date || null, { force: !!force });
    res.json({ ok: true, report });
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ error: err.message, code: 'ALREADY_EXISTS' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agronomist/weekly-rollup — manual weekly rollup trigger
router.post('/weekly-rollup', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const result = await agronomistService.runWeeklyRollup(req.body?.date || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/agronomist/reports/:id
router.delete('/reports/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const changes = agronomistService.deleteReport(id);
  res.json({ ok: true, deleted: changes });
});

// GET /api/agronomist/memory — Tier 3 long-term memory + version history
router.get('/memory', (req, res) => {
  const versions = agronomistService.getMemoryHistory();
  res.json({
    current: versions[0] || null,
    history: versions,
  });
});

// GET /api/agronomist/reports/:id/clarifications — list the discussion thread on a report
router.get('/reports/:id/clarifications', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  res.json(agronomistService.listClarifications(id));
});

// POST /api/agronomist/reports/:id/clarifications — append a clarification.
// Body: { message: string, regenerate?: boolean }
// If regenerate=true, the daily report is rebuilt with the new clarification injected
// into the prompt. The response includes the updated report so the UI can refresh.
router.post('/reports/:id/clarifications', requireRole('admin', 'operator'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { message, regenerate } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const report = agronomistService.getReportById(id);
  if (!report) return res.status(404).json({ error: 'Report not found' });

  try {
    const clar = agronomistService.addClarification(id, {
      userId: req.user?.id || null,
      userName: req.user?.name || req.user?.email || null,
      message,
      triggeredRegenerate: !!regenerate,
    });

    if (regenerate) {
      try {
        const regenerated = await agronomistService.generateDailyReport(report.report_date, { force: true });
        return res.json({ ok: true, clarification: clar, report: regenerated, regenerated: true });
      } catch (err) {
        // Clarification is saved even if regeneration fails — surface both
        return res.status(500).json({
          error: `Clarification saved, but regeneration failed: ${err.message}`,
          clarification: clar,
          regenerated: false,
        });
      }
    }
    res.json({ ok: true, clarification: clar, regenerated: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agronomist/preview — see what data would be sent to Claude for today
//                              without actually calling the API. Useful for debugging.
router.get('/preview', (req, res) => {
  const date = req.query.date || null;
  const dateStr = date || (() => {
    const tz = process.env.TZ;
    if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return new Date().toISOString().split('T')[0];
  })();
  try {
    const snapshot = agronomistService.aggregateDailyData(dateStr);
    res.json({ date: dateStr, snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
