/**
 * Irrigation runs API (services/IrrigationRunsService.js). Read-only, any role.
 *
 *   GET /api/irrigation/runs        ?from=&to= (ISO 8601) &date=YYYY-MM-DD|today &type=automated|manual_app|manual_panel
 *                                   &limit= (1-500, default 50) &offset=
 *   GET /api/irrigation/runs/last   latest run of any type ({ run: null } if none)
 *   GET /api/irrigation/runs/:id    one run
 *
 * A run = the irrigation monitor's cycles grouped with the relay events:
 * automated (inside an automation's run window), manual_app (pump/zone relays
 * switched in the app) or manual_panel (water with no SenseHub pump/zone relay
 * ON). Nothing here actuates.
 *
 * Language: type_label, notes and the "Zone unknown" visit name are rendered in
 * req.lang (Accept-Language / user preference); English originals in type_label_en /
 * notes_en. Runs built before i18n (no notes_i18n) keep English notes.
 */
const express = require('express');
const { getIrrigationRunsService, localizeRun, TYPES } = require('../services/IrrigationRunsService');

const router = express.Router();

const toIso = (v) => {
  if (v === undefined || v === '') return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : NaN;
};

router.get('/runs/last', (req, res) => {
  try {
    res.json({ run: localizeRun(getIrrigationRunsService().last(), req.lang) });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/runs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const from = toIso(req.query.from);
  const to = toIso(req.query.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return res.status(400).json({ error: 'Bad Request', message: 'from/to must be ISO 8601' });
  const date = req.query.date ? String(req.query.date) : null;
  if (date && date !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad Request', message: "date must be YYYY-MM-DD or 'today'" });
  const type = req.query.type ? String(req.query.type) : null;
  if (type && !TYPES.includes(type)) return res.status(400).json({ error: 'Bad Request', message: `type must be one of ${TYPES.join(', ')}` });
  try {
    const out = getIrrigationRunsService().list({ from, to, date, type, limit, offset });
    res.json(out && Array.isArray(out.runs) ? { ...out, runs: out.runs.map(r => localizeRun(r, req.lang)) } : out);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/runs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad Request', message: 'bad run id' });
  try {
    const run = getIrrigationRunsService().get(id);
    if (!run) return res.status(404).json({ error: 'Not Found', message: 'Irrigation run not found' });
    res.json({ run: localizeRun(run, req.lang) });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

module.exports = router;
