/**
 * Closed-loop dose controller API (services/DoseController.js).
 *
 *   GET /api/dose-controller/status              any role — live mode, per-tank target vs dosed, pH, acid use, last run
 *                                                reasons (mode_reason, reason, tanks[].why, ph.gate, warnings, paused.reason,
 *                                                end_reason) in req.lang; English originals in sibling *_en fields
 *   GET /api/dose-controller/runs                any role — ?date=YYYY-MM-DD&from=&to=&limit=&offset= (run records)
 *   GET /api/dose-controller/runs/last           any role — latest finished run (per-zone table), { run: null } if none
 *   GET /api/dose-controller/config              admin — settings (system_settings 'dose_controller') + defaults + programs' control_mode
 *   PUT /api/dose-controller/config              admin — partial (deep) update, validated
 *   PUT /api/dose-controller/programs/:id/mode   admin — { control_mode: 'closed_loop' | 'open_loop' } (takes effect next cycle)
 *
 * Nothing here actuates. The controller only drives valves inside a dose cycle
 * started by an automation (or /api/fertigation/dose-cycle/start).
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');
const { db } = require('../utils/database');
const { getDoseController, DEFAULT_CONFIG, localizeStatus, localizeRun } = require('../services/DoseController');

const router = express.Router();

router.get('/status', (req, res) => {
  try {
    res.json(localizeStatus(getDoseController().getStatus(), req.lang));
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/runs/last', (req, res) => {
  try {
    res.json({ run: localizeRun(getDoseController().lastRun(), req.lang) });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/runs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const toIso = (v) => {
    if (v === undefined || v === '') return null;
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : NaN;
  };
  const from = toIso(req.query.from);
  const to = toIso(req.query.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return res.status(400).json({ error: 'Bad Request', message: 'from/to must be ISO 8601' });
  const date = req.query.date ? String(req.query.date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad Request', message: 'date must be YYYY-MM-DD' });
  try {
    const out = getDoseController().listRuns({ limit, offset, from, to, date });
    res.json({ ...out, runs: (out.runs || []).map(r => localizeRun(r, req.lang)) });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

function programModes() {
  try {
    return db.prepare('SELECT id, name, status, control_mode FROM fertigation_dose_programs ORDER BY id').all();
  } catch (_) {
    return [];
  }
}

router.get('/config', requireRole('admin'), (req, res) => {
  const ctl = getDoseController();
  res.json({ config: ctl.getConfig(true), defaults: DEFAULT_CONFIG, programs: programModes() });
});

router.put('/config', requireRole('admin'), (req, res) => {
  try {
    const config = getDoseController().saveConfig(req.body || {});
    res.json({ config, programs: programModes() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status === 400 ? 'Bad Request' : 'Internal Server Error', message: err.message });
  }
});

router.put('/programs/:id/mode', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const mode = req.body && req.body.control_mode;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad Request', message: 'bad program id' });
  if (!['closed_loop', 'open_loop'].includes(mode)) return res.status(400).json({ error: 'Bad Request', message: "control_mode must be 'closed_loop' or 'open_loop'" });
  try {
    const r = db.prepare('UPDATE fertigation_dose_programs SET control_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mode, id);
    if (!r.changes) return res.status(404).json({ error: 'Not Found', message: 'Dose program not found' });
    res.json({ programs: programModes() });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

module.exports = router;
