/**
 * Logs API — unified, read-only activity log: people's actions (audit_log)
 * merged with the system event tables (relay bursts, automation runs, alerts,
 * flow watch, irrigation runs, dose runs, drift). See services/UnifiedLogService.js.
 *
 * Roles: admin + operator. Viewers get 403 — the log carries IPs, devices and
 * request bodies, and the viewer role is "dashboards / status only".
 *
 *   GET /api/logs?from&to&range&category&actor&actor_type&target_type&target_id&action&q&severity&source&result&limit&cursor
 *   GET /api/logs/facets
 *   GET /api/logs/export.csv  (same filters, capped rows)
 *   GET /api/logs/:source/:id
 *
 * Language: system items' summary / actor_label / target_name are rendered at read
 * time in req.lang (English originals in summary_en / actor_label_en / target_name_en);
 * the `q` search matches both. audit_log summaries, automation_logs messages and
 * dose-cycle notes are stored English text and stay English.
 */

const express = require('express');
const { requireRole } = require('../middleware/auth');
const { queryLogs, collectLogs, getLogDetail, getFacets, SOURCES } = require('../services/UnifiedLogService');

const router = express.Router();
router.use(requireRole('admin', 'operator'));

const EXPORT_MAX_ROWS = 5000;

router.get('/', (req, res) => {
  try {
    res.json(queryLogs(req.query, { lang: req.lang }));
  } catch (err) {
    console.error('[Logs] query failed:', err.message);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/facets', (req, res) => {
  try {
    res.json(getFacets());
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// Excel formula injection guard: a cell starting with = + - @ is prefixed.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  s = s.replace(/\r/g, '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function localTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(iso)).replace(',', '');
  } catch (_) { return iso; }
}

router.get('/export.csv', (req, res) => {
  try {
    const { items, truncated, timezone } = collectLogs(req.query, EXPORT_MAX_ROWS, { lang: req.lang });
    const header = ['time_utc', `time_local (${timezone})`, 'actor_type', 'actor', 'role', 'device', 'ip', 'category', 'action', 'target_type', 'target_id', 'target_name', 'summary', 'result', 'status_code', 'severity', 'count', 'source', 'id'];
    const lines = [header.map(csvCell).join(',')];
    for (const it of items) {
      lines.push([
        it.time, localTime(it.time, timezone), it.actor_type, it.actor_email || it.actor_label, it.actor_role, it.device, it.ip,
        it.category, it.action, it.target_type, it.target_id, it.target_name, it.summary, it.result, it.status_code, it.severity,
        it.repeat_count || it.count, it.source, it.id,
      ].map(csvCell).join(','));
    }
    if (truncated) lines.push(csvCell(`# truncated at ${EXPORT_MAX_ROWS} rows — narrow the filters`));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sensehub-logs-${stamp}.csv"`);
    res.send(`﻿${lines.join('\n')}\n`);
  } catch (err) {
    console.error('[Logs] export failed:', err.message);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

router.get('/:source/:id', (req, res) => {
  const { source, id } = req.params;
  if (!SOURCES.includes(source)) return res.status(400).json({ error: 'Bad Request', message: `unknown source '${source}'` });
  try {
    const d = getLogDetail(source, id, { lang: req.lang });
    if (!d) return res.status(404).json({ error: 'Not Found', message: 'Log entry not found' });
    res.json(d);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

module.exports = router;
