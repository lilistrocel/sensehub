const express = require('express');
const fs = require('fs');
const { agronomistService } = require('../services/AgronomistService');
const { agronomistCaptureService } = require('../services/AgronomistCaptureService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const localToday = () => {
  const { db } = require('../utils/database');
  const { getSystemTimezone, localDateStr } = require('../utils/systemTimezone');
  return localDateStr(new Date(), getSystemTimezone(db));
};

// ---------------------------------------------------------------------------
// Noon canopy captures
// ---------------------------------------------------------------------------

const withUrl = r => ({ ...r, image_url: `/api/agronomist/captures/${r.id}/image` });

// POST /api/agronomist/capture-now — take a canopy SESSION immediately (testing, or a
// missed noon): `capture_frames` frames `capture_spacing_seconds` apart, scored for
// sharpness. Body: { date?: 'YYYY-MM-DD', camera_id?, preset_id?, frames?, spacing_seconds? }
// Defaults come from agronomist_config. Rows are stored as source='manual'.
router.post('/capture-now', requireRole('admin', 'operator'), async (req, res) => {
  const cfg = agronomistService.getConfig();
  const body = req.body || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localToday();
  try {
    const row = await agronomistCaptureService.captureForDate(date, {
      cameraId: body.camera_id ? parseInt(body.camera_id, 10) : (cfg.capture_camera_id || null),
      presetId: body.preset_id !== undefined ? (parseInt(body.preset_id, 10) || null) : (cfg.capture_preset_id || null),
      source: 'manual',
      frames: body.frames !== undefined ? parseInt(body.frames, 10) : (cfg.capture_frames || 3),
      spacingMs: (body.spacing_seconds !== undefined ? parseInt(body.spacing_seconds, 10) : (cfg.capture_spacing_seconds ?? 30)) * 1000,
    });
    const { frames, session, ...best } = row;
    res.json({
      ok: true,
      session,
      frames: frames.map(withUrl),
      capture: withUrl(best),   // best (sharpest) frame — compatibility
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/agronomist/captures?days=7&camera_id=
// { days, groups: [{ date, camera_id, camera_name, best_id, frames: [...] }], captures: flat }
router.get('/captures', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
  const cameraId = req.query.camera_id ? parseInt(req.query.camera_id, 10) : null;
  try {
    const groups = agronomistCaptureService.listCapturesGrouped({ days, cameraId })
      .map(g => ({ ...g, frames: g.frames.map(withUrl) }));
    res.json({ days, groups, captures: groups.flatMap(g => g.frames) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agronomist/captures/:id/image — the JPEG itself
router.get('/captures/:id/image', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const row = agronomistCaptureService.getById(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const abs = agronomistCaptureService.absolutePath(row.path);
  if (!abs.startsWith(agronomistCaptureService.rootDir) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'Image file missing' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(abs);
});

// GET /api/agronomist/config — current config + key-present flag + provider health
router.get('/config', (req, res) => {
  const cfg = agronomistService.getConfig();
  res.json({
    ...cfg,
    api_key_present: !!process.env.ANTHROPIC_API_KEY,
    health: agronomistService.getHealth(),
  });
});

// GET /api/agronomist/health — provider failure state (consecutive failures, pause flag)
router.get('/health', (req, res) => {
  res.json({
    api_key_present: !!process.env.ANTHROPIC_API_KEY,
    ...agronomistService.getHealth(),
  });
});

// POST /api/agronomist/retry-now — run today's daily report immediately, bypassing the
// scheduler's billing/auth pause. A success clears the pause on its own; a failure
// returns the classified error so the UI can show it.
router.post('/retry-now', requireRole('admin', 'operator'), async (req, res) => {
  const { date } = req.body || {};
  try {
    const report = await agronomistService.generateDailyReport(date || null, { force: false });
    res.json({ ok: true, report, health: agronomistService.getHealth() });
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ error: err.message, code: 'ALREADY_EXISTS', health: agronomistService.getHealth() });
    }
    res.status(502).json({
      error: err.message,
      error_class: err.errorClass || agronomistService.classifyProviderError(err),
      kept_existing: !!err.keptExisting,
      health: agronomistService.getHealth(),
    });
  }
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
    // A failed force-regenerate keeps the existing report (kept_existing: true).
    res.status(502).json({
      error: err.keptExisting ? `Regeneration failed; the existing report was kept. ${err.message}` : err.message,
      error_class: err.errorClass || agronomistService.classifyProviderError(err),
      kept_existing: !!err.keptExisting,
    });
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
        // Clarification is saved even if regeneration fails; the report content is
        // kept (generateDailyReport never overwrites a success with a failure).
        return res.status(502).json({
          error: `Clarification saved, but regeneration failed${err.keptExisting ? ' — the previous report was kept' : ''}: ${err.message}`,
          error_class: err.errorClass || agronomistService.classifyProviderError(err),
          kept_existing: !!err.keptExisting,
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
