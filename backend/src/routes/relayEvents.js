/**
 * Relay events API — read-only audit trail of every relay ON/OFF transition,
 * plus a "zone runs" view that pairs each ON with its matching OFF and computes duration.
 *
 * Used by the Relay Events admin page to diagnose stuck-on incidents, template drift,
 * and operator reports about zones running too long or too short.
 */

const express = require('express');
const { db } = require('../utils/database');
const { relaySafetyWatchdogService } = require('../services/RelaySafetyWatchdogService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/relay-events — paginated list of raw relay state changes
//   ?equipment_id=, &channel=, &source=, &from=, &to=, &limit=, &offset=
router.get('/', (req, res) => {
  const { equipment_id, channel, source, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const where = ['1=1'];
  const params = [];
  if (equipment_id) { where.push('re.equipment_id = ?'); params.push(parseInt(equipment_id)); }
  if (channel)      { where.push('re.channel = ?');      params.push(parseInt(channel)); }
  if (source)       { where.push('re.source = ?');       params.push(source); }
  if (from)         { where.push('re.created_at >= ?');  params.push(from); }
  if (to)           { where.push('re.created_at <= ?');  params.push(to); }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM relay_events re WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db.prepare(`
    SELECT re.id, re.equipment_id, re.channel, re.state, re.source, re.automation_id, re.created_at,
           e.name AS equipment_name, a.name AS automation_name
    FROM relay_events re
    LEFT JOIN equipment e ON re.equipment_id = e.id
    LEFT JOIN automations a ON re.automation_id = a.id
    WHERE ${where.join(' AND ')}
    ORDER BY re.created_at DESC, re.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ events: rows, total, limit, offset });
});

// GET /api/relay-events/runs — every ON paired with its next OFF, with computed duration.
// This is the "zone runs" view the operators care about most.
//   ?equipment_id=, &channel=, &from=, &to=, &min_duration=, &limit=, &offset=
router.get('/runs', (req, res) => {
  const { equipment_id, channel, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const minDuration = parseInt(req.query.min_duration) || 0;

  const where = ['re1.state = 1'];
  const params = [];
  if (equipment_id) { where.push('re1.equipment_id = ?'); params.push(parseInt(equipment_id)); }
  if (channel)      { where.push('re1.channel = ?');      params.push(parseInt(channel)); }
  if (from)         { where.push('re1.created_at >= ?');  params.push(from); }
  if (to)           { where.push('re1.created_at <= ?');  params.push(to); }

  // Pair each ON event with the next OFF on the same equipment+channel.
  // Note: the duration column in the SELECT is in seconds, computed via SQLite julianday math
  // (cheap because the LEFT JOIN already restricts to a single matched OFF).
  const rows = db.prepare(`
    SELECT
      re1.id AS on_id,
      re1.equipment_id,
      re1.channel,
      re1.created_at AS on_time,
      re1.source AS on_source,
      re1.automation_id AS on_auto_id,
      e.name AS equipment_name,
      a.name AS automation_name,
      (
        SELECT MIN(re2.created_at) FROM relay_events re2
        WHERE re2.equipment_id = re1.equipment_id
          AND re2.channel = re1.channel
          AND re2.state = 0
          AND re2.created_at > re1.created_at
      ) AS off_time,
      (
        SELECT re2.source FROM relay_events re2
        WHERE re2.equipment_id = re1.equipment_id
          AND re2.channel = re1.channel
          AND re2.state = 0
          AND re2.created_at > re1.created_at
        ORDER BY re2.created_at ASC LIMIT 1
      ) AS off_source
    FROM relay_events re1
    LEFT JOIN equipment e ON re1.equipment_id = e.id
    LEFT JOIN automations a ON re1.automation_id = a.id
    WHERE ${where.join(' AND ')}
    ORDER BY re1.created_at DESC, re1.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  // Compute duration in JS to handle "still running" (no off_time yet) cleanly
  const now = Date.now();
  const runs = rows.map(r => {
    let durationSec = null;
    if (r.off_time) {
      const ms = new Date(r.off_time + 'Z').getTime() - new Date(r.on_time + 'Z').getTime();
      durationSec = Math.max(0, Math.round(ms / 1000));
    } else {
      const ms = now - new Date(r.on_time + 'Z').getTime();
      durationSec = Math.max(0, Math.round(ms / 1000));
    }
    return { ...r, duration_seconds: durationSec, still_running: !r.off_time };
  });

  const filtered = minDuration > 0 ? runs.filter(r => r.duration_seconds >= minDuration) : runs;
  res.json({ runs: filtered, limit, offset });
});

// GET /api/relay-events/stats — quick stats over the last 24h / 7d / 30d
router.get('/stats', (req, res) => {
  const buckets = [
    { label: '24h', sql: "datetime('now','-1 days')" },
    { label: '7d',  sql: "datetime('now','-7 days')" },
    { label: '30d', sql: "datetime('now','-30 days')" },
  ];
  const out = {};
  for (const b of buckets) {
    out[b.label] = {
      total_events: db.prepare(`SELECT COUNT(*) AS c FROM relay_events WHERE created_at > ${b.sql}`).get().c,
      force_off_events: db.prepare(`SELECT COUNT(*) AS c FROM relay_events WHERE source='watchdog_force_off' AND created_at > ${b.sql}`).get().c,
      manual_events: db.prepare(`SELECT COUNT(*) AS c FROM relay_events WHERE source='manual' AND created_at > ${b.sql}`).get().c,
    };
  }
  out.currently_on = db.prepare(`
    SELECT re.equipment_id, re.channel, re.created_at AS on_time, re.source, e.name AS equipment_name
    FROM relay_events re JOIN equipment e ON re.equipment_id = e.id
    WHERE re.id IN (SELECT MAX(id) FROM relay_events GROUP BY equipment_id, channel)
      AND re.state = 1
    ORDER BY re.created_at ASC
  `).all().map(r => ({
    ...r,
    on_for_seconds: Math.max(0, Math.round((Date.now() - new Date(r.on_time + 'Z').getTime()) / 1000)),
  }));
  res.json(out);
});

// GET /api/relay-events/safety-config — current watchdog config
router.get('/safety-config', (req, res) => {
  res.json(relaySafetyWatchdogService.getConfig());
});

// PUT /api/relay-events/safety-config — admin only
router.put('/safety-config', requireRole('admin'), (req, res) => {
  try {
    const updated = relaySafetyWatchdogService.saveConfig(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/relay-events/safety-check — manual trigger of a single safety pass (for debugging)
router.post('/safety-check', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const acted = await relaySafetyWatchdogService._tick();
    res.json({ ok: true, acted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
