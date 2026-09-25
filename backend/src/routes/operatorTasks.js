/**
 * Operator tasks API — the human-in-the-loop surface for the AI agents.
 *
 * The agronomist and planner agents emit structured tasks alongside their
 * reports/plans (e.g. "add 10 kg Ca-nitrate to Tank 1", "drill more drain
 * holes in coco peat bag 5"). The operator confirms with completion notes
 * (theory validated) or declines with a reason (theory disproved). Both
 * outcomes flow into the next agent run's context so its model updates.
 */

const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

// GET /api/operator-tasks
// Query: status (open|done|declined|snoozed|all, default open), source, source_report_id,
//        limit, since (ISO date)
// Every column is qualified with t. — the users join also has created_at (was a 500:
// "ambiguous column name: created_at" on ?since=).
router.get('/', (req, res) => {
  try {
    const where = [];
    const args = [];
    const status = (req.query.status || 'open').toLowerCase();
    if (status !== 'all') { where.push('t.status = ?'); args.push(status); }
    if (req.query.source) { where.push('t.source = ?'); args.push(req.query.source); }
    if (req.query.source_report_id) {
      const rid = parseInt(req.query.source_report_id, 10);
      if (!Number.isFinite(rid)) return res.status(400).json({ error: 'source_report_id must be an integer' });
      where.push('t.source_report_id = ?'); args.push(rid);
    }
    if (req.query.since) { where.push('t.created_at > ?'); args.push(req.query.since); }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const sql = `
      SELECT t.*, u.email AS completed_by_email
      FROM operator_tasks t
      LEFT JOIN users u ON u.id = t.completed_by_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${PRIORITY_ORDER}, t.created_at DESC
      LIMIT ?
    `;
    res.json(db.prepare(sql).all(...args, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/operator-tasks/counts
// Quick badge counts for the sidebar / dashboard widget.
router.get('/counts', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT status, priority, COUNT(*) as n
      FROM operator_tasks
      WHERE status IN ('open', 'snoozed')
      GROUP BY status, priority
    `).all();
    const out = { open_total: 0, open_critical: 0, open_high: 0, snoozed_total: 0 };
    for (const r of rows) {
      if (r.status === 'open') {
        out.open_total += r.n;
        if (r.priority === 'critical') out.open_critical += r.n;
        if (r.priority === 'high') out.open_high += r.n;
      } else if (r.status === 'snoozed') {
        out.snoozed_total += r.n;
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/operator-tasks/:id
router.get('/:id', (req, res) => {
  try {
    const t = db.prepare(`
      SELECT t.*, u.email AS completed_by_email
      FROM operator_tasks t
      LEFT JOIN users u ON u.id = t.completed_by_user_id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-tasks — manual creation by an operator (or used internally by agents)
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const r = db.prepare(`
      INSERT INTO operator_tasks
        (source, source_report_id, source_plan_id, title, description, category, priority,
         instructions, expected_outcome, target_entity, due_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ['agronomist','planner','manual','watchdog'].includes(b.source) ? b.source : 'manual',
      b.source_report_id || null,
      b.source_plan_id || null,
      String(b.title).trim(),
      b.description || null,
      ['physical','measurement','tutorial','config_change'].includes(b.category) ? b.category : 'physical',
      ['low','medium','high','critical'].includes(b.priority) ? b.priority : 'medium',
      b.instructions || null,
      b.expected_outcome || null,
      b.target_entity || null,
      b.due_by || null,
    );
    res.json(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-tasks/:id/complete
// Body: { notes? }
router.post('/:id/complete', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const t = db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (t.status === 'done') return res.status(409).json({ error: 'Task already completed' });
    db.prepare(`
      UPDATE operator_tasks
      SET status = 'done', completed_at = CURRENT_TIMESTAMP, completed_by_user_id = ?, completion_notes = ?
      WHERE id = ?
    `).run(req.user?.id || null, req.body?.notes || null, id);
    res.json(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-tasks/:id/decline
// Body: { reason }  REQUIRED
router.post('/:id/decline', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'decline requires a reason so the agent can update its theory' });
  try {
    const t = db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    db.prepare(`
      UPDATE operator_tasks
      SET status = 'declined', completed_at = CURRENT_TIMESTAMP, completed_by_user_id = ?, decline_reason = ?
      WHERE id = ?
    `).run(req.user?.id || null, reason, id);
    res.json(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-tasks/:id/snooze
// Body: { until: ISO datetime string }
router.post('/:id/snooze', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const until = req.body?.until;
  if (!until) return res.status(400).json({ error: 'until (ISO datetime) is required' });
  try {
    db.prepare(`UPDATE operator_tasks SET status = 'snoozed', snoozed_until = ? WHERE id = ?`).run(until, id);
    res.json(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-tasks/:id/reopen — undo a done/declined/snoozed state
router.post('/:id/reopen', requireRole('admin', 'operator'), (req, res) => {
  try {
    db.prepare(`
      UPDATE operator_tasks
      SET status = 'open', completed_at = NULL, completed_by_user_id = NULL,
          completion_notes = NULL, decline_reason = NULL, snoozed_until = NULL
      WHERE id = ?
    `).run(req.params.id);
    res.json(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/operator-tasks/:id — archive (soft delete via status)
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    db.prepare(`UPDATE operator_tasks SET status = 'archived' WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
