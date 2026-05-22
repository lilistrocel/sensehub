const express = require('express');
const { operationalPlannerService } = require('../services/OperationalPlannerService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/planner/config
router.get('/config', (req, res) => {
  res.json({
    ...operationalPlannerService.getConfig(),
    api_key_present: !!process.env.ANTHROPIC_API_KEY,
  });
});

// PUT /api/planner/config — admin only
router.put('/config', requireRole('admin'), (req, res) => {
  try {
    const updated = operationalPlannerService.saveConfig(req.body || {});
    res.json({ ...updated, api_key_present: !!process.env.ANTHROPIC_API_KEY });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/planner/plans?limit=30
router.get('/plans', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const offset = parseInt(req.query.offset) || 0;
  res.json(operationalPlannerService.listPlans(limit, offset));
});

// GET /api/planner/plans/by-date/:date — YYYY-MM-DD
router.get('/plans/by-date/:date', (req, res) => {
  const plan = operationalPlannerService.getPlanByDate(req.params.date);
  if (!plan) return res.status(404).json({ error: 'Not found' });
  res.json(plan);
});

// GET /api/planner/plans/:id
router.get('/plans/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const plan = operationalPlannerService.getPlanById(id);
  if (!plan) return res.status(404).json({ error: 'Not found' });
  res.json(plan);
});

// GET /api/planner/plans/by-date/:date/versions — full version history for a plan_date
router.get('/plans/by-date/:date/versions', (req, res) => {
  res.json(operationalPlannerService.listVersionsForDate(req.params.date));
});

// POST /api/planner/generate — admin/operator manual trigger
// Body: { date?: 'YYYY-MM-DD' (reference today, defaults to today), force?: boolean }
// Generates the plan FOR THE DAY AFTER `date`.
router.post('/generate', requireRole('admin', 'operator'), async (req, res) => {
  const { date, force } = req.body || {};
  try {
    const plan = await operationalPlannerService.generatePlanForTomorrow(date || null, { force: !!force });
    res.json({ ok: true, plan });
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ error: err.message, code: 'ALREADY_EXISTS' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planner/plans/:id/guardrails — list triggered guardrails for a plan
router.get('/plans/:id/guardrails', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const plan = operationalPlannerService.getPlanById(id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(operationalPlannerService.evaluatePlanGuardrails(plan));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planner/plans/:id/confirm — admin/operator
// Walks changes_from_today and applies INSERT/UPDATE/DISABLE on automations.
//
// Body (optional): { overrides: [{ rule_id, rule_name, reason }] }
// If the plan triggers any guardrails, the apply path refuses unless EVERY
// triggered rule has a matching override with a non-empty reason AND the user's
// role matches override_role. On block returns 409 GUARDRAIL_BLOCKED with the
// triggered rule details so the UI can present an override dialog.
router.post('/plans/:id/confirm', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];

  // Enforce role on each override: admin-only rules cannot be bypassed by an operator.
  if (overrides.length > 0) {
    const plan = operationalPlannerService.getPlanById(id);
    if (plan) {
      const triggered = operationalPlannerService.evaluatePlanGuardrails(plan);
      for (const o of overrides) {
        const rule = triggered.find(t => t.rule_id === o.rule_id || t.rule_name === o.rule_name);
        if (!rule) continue;
        const role = req.user?.role;
        const allowed = rule.override_role === 'admin_or_operator'
          ? (role === 'admin' || role === 'operator')
          : (role === rule.override_role);
        if (!allowed) {
          return res.status(403).json({
            error: `Override for "${rule.rule_name}" requires role ${rule.override_role} (current role: ${role || 'none'})`,
            code: 'OVERRIDE_FORBIDDEN',
            rule_name: rule.rule_name,
            required_role: rule.override_role,
          });
        }
      }
    }
  }

  try {
    const result = operationalPlannerService.applyPlan(id, req.user?.id || null, { overrides });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'ALREADY_CONFIRMED') return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'GUARDRAIL_BLOCKED') {
      return res.status(409).json({ error: err.message, code: err.code, guardrails: err.guardrails });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planner/plans/:id/reject — admin/operator
// Body: { feedback: string }  REQUIRED non-empty
// Marks plan rejected and regenerates a new plan addressing the feedback.
router.post('/plans/:id/reject', requireRole('admin', 'operator'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const feedback = (req.body && req.body.feedback) || '';
  try {
    const result = await operationalPlannerService.rejectPlan(id, feedback, req.user?.id || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'FEEDBACK_REQUIRED') return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planner/plans/:id/scorecard — compute the deterministic scorecard for this plan
//   ?stop_at_now=1 — partial scoring (for today's still-running plan), else full-day
router.get('/plans/:id/scorecard', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const plan = operationalPlannerService.getPlanById(id);
  if (!plan) return res.status(404).json({ error: 'Not found' });
  const opts = {};
  if (req.query.stop_at_now === '1' || req.query.stop_at_now === 'true') opts.stopAtMs = Date.now();
  res.json(operationalPlannerService.computeScorecard(plan, opts));
});

// DELETE /api/planner/plans/:id — admin only
router.delete('/plans/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const changes = operationalPlannerService.deletePlan(id);
  res.json({ ok: true, deleted: changes });
});

// ─── Plan clarifications (non-destructive Q&A on a plan) ───

// GET /api/planner/plans/:id/clarifications — list the thread
router.get('/plans/:id/clarifications', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(operationalPlannerService.listClarifications(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planner/plans/:id/clarifications — operator posts a question/highlight,
// service immediately responds with reasoning (no plan modification).
// Body: { role: 'question' | 'highlight', message: string }
router.post('/plans/:id/clarifications', requireRole('admin', 'operator'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { role, message } = req.body || {};
  try {
    const row = await operationalPlannerService.postClarification({
      planId: id,
      message,
      role,
      userId: req.user?.id || null,
      userName: req.user?.email || req.user?.name || null,
    });
    res.json(row);
  } catch (err) {
    if (err.code === 'MESSAGE_REQUIRED') return res.status(400).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planner/plans/:id/clarifications/regenerate — bundle open clarifications
// into rejection feedback, reject the plan, regenerate a new version that addresses them.
router.post('/plans/:id/clarifications/regenerate', requireRole('admin', 'operator'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await operationalPlannerService.convertClarificationsToRegenerate(id, req.user?.id || null);
    res.json(result);
  } catch (err) {
    if (err.code === 'NO_CLARIFICATIONS') return res.status(400).json({ error: err.message, code: err.code });
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
