/**
 * Irrigation flow watch API (services/IrrigationFlowWatchService.js).
 *
 *   GET /api/flow-watch/status      any role — live state, flow vs expected, active rules, last episode
 *   GET /api/flow-watch/episodes    any role — ?kind=&from=&to=&limit=&offset= (from/to ISO 8601)
 *   GET /api/flow-watch/config      admin — thresholds (system_settings 'irrigation_flow_watch') + defaults + baselines
 *   PUT /api/flow-watch/config      admin — partial update; { reset_baselines: true } clears learned baselines
 *
 * Nothing here actuates. (The service itself may abort a running dose cycle
 * when abort_dosing_on_no_water is on — that is configured here, not triggered.)
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');
const { getFlowWatchService, DEFAULT_CONFIG, RULES } = require('../services/IrrigationFlowWatchService');

const router = express.Router();

router.get('/status', (req, res) => {
  try {
    res.json(getFlowWatchService().getStatus());
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/episodes', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && !RULES[kind]) return res.status(400).json({ error: 'Bad Request', message: `unknown kind; one of ${Object.keys(RULES).join(', ')}` });
  const toIso = (v) => {
    if (v === undefined || v === '') return null;
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : NaN;
  };
  const from = toIso(req.query.from);
  const to = toIso(req.query.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return res.status(400).json({ error: 'Bad Request', message: 'from/to must be ISO 8601' });
  try {
    res.json(getFlowWatchService().listEpisodes({ limit, offset, kind, from, to }));
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/config', requireRole('admin'), (req, res) => {
  const svc = getFlowWatchService();
  res.json({ config: svc.getConfig(), defaults: DEFAULT_CONFIG, baselines: svc.getBaselines() });
});

router.put('/config', requireRole('admin'), (req, res) => {
  const svc = getFlowWatchService();
  const body = { ...(req.body || {}) };
  const reset = body.reset_baselines === true;
  delete body.reset_baselines;
  try {
    const config = Object.keys(body).length ? svc.saveConfig(body) : svc.getConfig();
    if (reset) svc.resetBaselines();
    res.json({ config, baselines: svc.getBaselines() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status === 400 ? 'Bad Request' : 'Internal Server Error', message: err.message });
  }
});

module.exports = router;
