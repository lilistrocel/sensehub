/**
 * Crop & Nutrition API (operator request 2026-09-28).
 *
 * Read (every logged-in role):
 *   GET  /api/nutrition/profiles?zone_id=&include_inactive=1   crop profiles (history with include_inactive)
 *   GET  /api/nutrition/profiles/active?zone_id=               active profile (primary crop zone first)
 *   GET  /api/nutrition/profiles/:id                           profile + stage + targets + protocol
 *   GET  /api/nutrition/protocols                              human agronomist baselines (read-only)
 *   GET  /api/nutrition/protocols/:id
 *   GET  /api/nutrition/system?profile_id=                     live fertigation system (derived, read-only)
 *   GET  /api/nutrition/feed?period=last_run|today|7d&profile_id=   deterministic feed calculator
 *   GET  /api/nutrition/advisor/config                         schedule / auto settings + health + key flag
 *   GET  /api/nutrition/advisor/estimate                       cost estimate of one run (no API call)
 *   GET  /api/nutrition/advice?limit=&offset=                  advice history (summaries, req.lang)
 *   GET  /api/nutrition/advice/latest                          latest good advice (+ a newer running/failed run)
 *   GET  /api/nutrition/advice/:id?original=1                  one advice in req.lang (or English)
 * Write:
 *   POST /api/nutrition/profiles                    admin, operator — new crop cycle (previous one kept as history)
 *   PUT  /api/nutrition/profiles/:id                admin, operator — editable fields (not the live system)
 *   PUT  /api/nutrition/profiles/:id/targets        admin, operator — stage + element targets
 *   POST /api/nutrition/profiles/:id/targets/reset  admin, operator — back to the linked protocol's defaults
 *   POST /api/nutrition/profiles/:id/targets/scale-to-ec  admin, operator — { stage, preview = true, include = [] | true }:
 *        element targets of the stage scaled to its input EC target (protocol ratios kept); preview returns
 *        the rows (old → new, hand-edited rows kept) + factor + EC math and writes nothing
 *   POST /api/nutrition/advice/run                  admin, operator — start an AI run (uses API credits) → 202
 *        { profile_id?, notes? } notes = operator context for this run (≤ 1000 chars, stored on the advice)
 *   POST /api/nutrition/advice/:id/translate        admin — (re)translate one advice ({ lang })
 *   PUT  /api/nutrition/advisor/config              admin
 *
 * "Follow crop targets" link to the dose controller (operator decision 2026-09-30,
 * services/ControllerLinkService.js):
 *   GET  /api/nutrition/controller-link?profile_id=            any role — link mode, controller values + origin,
 *        crop-implied values (match / mismatch), pending / approved proposal, history, source-water
 *        discrepancy, EC fine-tuning state, element best fit (advisory)
 *   GET  /api/nutrition/profiles/:id/controller-link/proposals?limit=&offset=   any role — proposal history
 *   PUT  /api/nutrition/profiles/:id/controller-link           admin, operator — { mode: 'manual' | 'follow_crop_targets' }
 *   POST /api/nutrition/controller-link/proposals/:pid/approve admin, operator — { note? } applies at the NEXT dose-cycle start
 *   POST /api/nutrition/controller-link/proposals/:pid/reject  admin, operator — { note? }
 *   POST /api/nutrition/profiles/:id/controller-link/ec-trim   admin, operator — { enable, confirm: true,
 *        handheld_ec_ms, seko_ec_ms, measured_at, note } EC fine-tuning (enable needs the recorded SEKO check)
 * These write dose-controller SETPOINTS only through approved proposals (never mid-cycle, never a coil).
 *
 * Everything else is ADVISORY ONLY: it never changes recipes, dose programs, dosing
 * ratios, tanks or automations. No endpoint actuates anything.
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');

const wantsOriginal = (req) => /^(1|true|yes)$/i.test(String(req.query.original || ''));
const PERIODS = ['last_run', 'today', '7d'];

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  const body = { error: err && err.message ? err.message : String(err) };
  if (err && err.field) body.field = err.field;
  if (err && err.code) body.code = err.code;
  if (err && err.running_id) body.running_id = err.running_id;
  if (err && err.reason) body.reason = err.reason;
  for (const k of ['newer_id', 'fields', 'deviation_pct', 'status_now']) if (err && err[k] !== undefined) body[k] = err[k];
  if (status >= 500) console.error('[nutrition]', err && err.stack ? err.stack : err);
  res.status(status).json(body);
}

/**
 * @param deps.profiles  CropProfileService
 * @param deps.advisor   FertilizerAdvisorService
 * @param deps.systemView FertigationSystemView
 */
function createNutritionRouter(deps = {}) {
  const router = express.Router();
  const profiles = () => deps.profiles || require('../services/CropProfileService').cropProfileService;
  const advisor = () => deps.advisor || require('../services/FertilizerAdvisorService').getFertilizerAdvisor();
  const systemView = () => deps.systemView || require('../services/FertigationSystemView').fertigationSystemView;
  const db = () => deps.db || require('../utils/database').db;
  const idParam = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const link = () => deps.link || require('../services/ControllerLinkService').getControllerLinkService();
  // A write to the crop targets / source water / stage: a linked profile gets a new proposal
  // when the implied controller values changed (never applied without approval).
  const relink = (id) => {
    try { link().evaluate(id); } catch (e) { if (!e.status || e.status >= 500) console.error('[nutrition] controller link evaluation failed:', e.message); }
  };

  const profileFor = (req) => {
    const id = idParam(req.query.profile_id);
    const p = id ? profiles().getProfile(id) : profiles().getActive(idParam(req.query.zone_id));
    if (!p) { const e = new Error('No crop profile'); e.status = 404; e.code = 'NO_PROFILE'; throw e; }
    return p;
  };

  // ---------- profiles ----------

  router.get('/profiles', (req, res) => {
    try {
      res.json(profiles().list({ zoneId: idParam(req.query.zone_id), includeInactive: /^(1|true)$/i.test(String(req.query.include_inactive || '')) }));
    } catch (err) { sendError(res, err); }
  });

  router.get('/profiles/active', (req, res) => {
    try {
      res.json({ profile: profiles().getActive(idParam(req.query.zone_id)) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/profiles/:id', (req, res) => {
    try {
      const p = profiles().getProfile(idParam(req.params.id));
      if (!p) return res.status(404).json({ error: 'Crop profile not found' });
      res.json(p);
    } catch (err) { sendError(res, err); }
  });

  router.post('/profiles', requireRole('admin', 'operator'), (req, res) => {
    try {
      res.status(201).json(profiles().create(req.body || {}, { userId: req.user && req.user.id }));
    } catch (err) { sendError(res, err); }
  });

  router.put('/profiles/:id', requireRole('admin', 'operator'), (req, res) => {
    try {
      const p = profiles().update(idParam(req.params.id), req.body || {}, { userId: req.user && req.user.id });
      relink(p.id);
      res.json(p);
    } catch (err) { sendError(res, err); }
  });

  router.put('/profiles/:id/targets', requireRole('admin', 'operator'), (req, res) => {
    try {
      const p = profiles().setTargets(idParam(req.params.id), req.body || {}, { userId: req.user && req.user.id });
      relink(p.id);
      res.json(p);
    } catch (err) { sendError(res, err); }
  });

  router.post('/profiles/:id/targets/reset', requireRole('admin', 'operator'), (req, res) => {
    try {
      const p = profiles().resetTargetsToProtocol(idParam(req.params.id), { userId: req.user && req.user.id });
      relink(p.id);
      res.json(p);
    } catch (err) { sendError(res, err); }
  });

  router.post('/profiles/:id/targets/scale-to-ec', requireRole('admin', 'operator'), (req, res) => {
    try {
      const b = req.body || {};
      const preview = b.preview === undefined ? true : !!b.preview;
      res.json(profiles().scaleTargetsToEc(idParam(req.params.id), { stage: b.stage, preview, include: b.include === undefined ? [] : b.include }, { userId: req.user && req.user.id }));
    } catch (err) { sendError(res, err); }
  });

  // ---------- "Follow crop targets" link to the dose controller ----------

  const who = (req) => (req.user ? { id: req.user.id ?? null, email: req.user.email ?? null, role: req.user.role } : null);

  router.get('/controller-link', (req, res) => {
    try {
      const id = idParam(req.query.profile_id) || link().activeProfileId();
      if (!id) return res.json({ view: null });
      res.json({ view: link().view(id) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/profiles/:id/controller-link/proposals', (req, res) => {
    try {
      const id = idParam(req.params.id);
      if (!id) return res.status(404).json({ error: 'Crop profile not found' });
      res.json(link().listProposals(id, { limit: req.query.limit, offset: req.query.offset }));
    } catch (err) { sendError(res, err); }
  });

  router.put('/profiles/:id/controller-link', requireRole('admin', 'operator'), (req, res) => {
    try {
      const id = idParam(req.params.id);
      const r = link().setMode(id, (req.body || {}).mode, who(req));
      res.json({ ...r, view: link().view(id) });
    } catch (err) { sendError(res, err); }
  });

  router.post('/controller-link/proposals/:pid/approve', requireRole('admin', 'operator'), (req, res) => {
    try {
      const p = link().approve(idParam(req.params.pid), who(req), (req.body || {}).note);
      res.json({ proposal: p, view: link().view(p.profile_id) });
    } catch (err) { sendError(res, err); }
  });

  router.post('/controller-link/proposals/:pid/reject', requireRole('admin', 'operator'), (req, res) => {
    try {
      const p = link().reject(idParam(req.params.pid), who(req), (req.body || {}).note);
      res.json({ proposal: p, view: link().view(p.profile_id) });
    } catch (err) { sendError(res, err); }
  });

  router.post('/profiles/:id/controller-link/ec-trim', requireRole('admin', 'operator'), (req, res) => {
    try {
      res.json({ view: link().setEcTrim(idParam(req.params.id), req.body || {}, who(req)) });
    } catch (err) { sendError(res, err); }
  });

  // ---------- protocols (read-only baselines) ----------

  router.get('/protocols', (req, res) => {
    try { res.json(profiles().listProtocols()); } catch (err) { sendError(res, err); }
  });

  router.get('/protocols/:id', (req, res) => {
    try {
      const p = profiles().protocolRow(idParam(req.params.id));
      if (!p) return res.status(404).json({ error: 'Protocol not found' });
      res.json(p);
    } catch (err) { sendError(res, err); }
  });

  // ---------- live system + calculator ----------

  router.get('/system', (req, res) => {
    try {
      const p = profileFor(req);
      res.json(systemView().build({ profile: p }));
    } catch (err) {
      if (err.code === 'NO_PROFILE') {
        try { return res.json(systemView().build({ profile: null })); } catch (e) { return sendError(res, e); }
      }
      sendError(res, err);
    }
  });

  router.get('/feed', (req, res) => {
    try {
      const period = PERIODS.includes(req.query.period) ? req.query.period : 'today';
      const p = profileFor(req);
      const FC = require('../services/FeedCalculator');
      const { getSystemTimezone } = require('../utils/systemTimezone');
      const lib = db().prepare('SELECT name, composition FROM fertigation_ingredients WHERE name = ?');
      res.json(FC.buildFeedReport(db(), {
        profile: p, period, tz: getSystemTimezone(db()),
        nowMs: deps.now ? deps.now() : Date.now(),
        protocolData: p.protocol ? p.protocol.data : null,
        library: (name) => lib.get(name) || null,
      }));
    } catch (err) { sendError(res, err); }
  });

  // ---------- advisor ----------

  router.get('/advisor/config', (req, res) => {
    try {
      const a = advisor();
      res.json({ ...a.getConfig(), model: a.model(), effort: a.effort(), api_key_present: !!process.env.ANTHROPIC_API_KEY, health: a.getHealth(), running: a.isRunning() });
    } catch (err) { sendError(res, err); }
  });

  router.put('/advisor/config', requireRole('admin'), (req, res) => {
    try { res.json(advisor().saveConfig(req.body || {})); } catch (err) { sendError(res, err); }
  });

  router.get('/advisor/estimate', (req, res) => {
    try { res.json(advisor().estimate({ profileId: idParam(req.query.profile_id) })); } catch (err) { sendError(res, err); }
  });

  router.get('/advice', (req, res) => {
    try {
      const a = advisor();
      const list = a.list({ limit: req.query.limit, offset: req.query.offset });
      const original = wantsOriginal(req);
      list.items = list.items.map(it => {
        if (it.status !== 'success' || original) return { ...it, translation_status: 'original' };
        const full = a.localize(a.get(it.id, { full: false }), req.lang);
        return { ...it, summary: full.advice ? full.advice.summary : it.summary, translation_status: full.translation_status };
      });
      res.json(list);
    } catch (err) { sendError(res, err); }
  });

  router.get('/advice/latest', (req, res) => {
    try {
      const a = advisor();
      const l = a.latest();
      res.json({
        advice: l.advice ? a.localize(l.advice, req.lang, { original: wantsOriginal(req) }) : null,
        newer: l.newer,
        running: a.isRunning(),
        health: a.getHealth(),
      });
    } catch (err) { sendError(res, err); }
  });

  router.get('/advice/:id', (req, res) => {
    try {
      const a = advisor();
      const adv = a.get(idParam(req.params.id));
      if (!adv) return res.status(404).json({ error: 'Advice not found' });
      res.json(a.localize(adv, req.lang, { original: wantsOriginal(req) }));
    } catch (err) { sendError(res, err); }
  });

  router.post('/advice/run', requireRole('admin', 'operator'), (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set in the backend environment', code: 'NO_API_KEY' });
      const b = req.body || {};
      if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') return res.status(400).json({ error: 'notes must be text', field: 'notes' });
      const { MAX_NOTES_CHARS } = require('../services/FertilizerAdvisorService');
      if (typeof b.notes === 'string' && b.notes.trim().length > MAX_NOTES_CHARS) return res.status(400).json({ error: `notes must be at most ${MAX_NOTES_CHARS} characters`, field: 'notes' });
      const { id } = advisor().start({ trigger: 'manual', userId: req.user && req.user.id, profileId: idParam(b.profile_id), notes: b.notes });
      res.status(202).json({ ok: true, id, status: 'running' });
    } catch (err) { sendError(res, err); }
  });

  router.post('/advice/:id/translate', requireRole('admin'), (req, res) => {
    try {
      const lang = (req.body || {}).lang;
      if (!['tr', 'ar'].includes(lang)) return res.status(400).json({ error: 'lang must be tr or ar' });
      const a = advisor();
      const adv = a.get(idParam(req.params.id), { full: false });
      if (!adv || adv.status !== 'success') return res.status(404).json({ error: 'Advice not found' });
      const queued = a.enqueueTranslations(adv.id, { langs: [lang], force: true });
      res.status(202).json({ ok: true, queued });
    } catch (err) { sendError(res, err); }
  });

  return router;
}

module.exports = createNutritionRouter();
module.exports.createNutritionRouter = createNutritionRouter;
