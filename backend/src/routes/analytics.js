/**
 * Analytics export — downloads a ZIP pack of CSV files for long-term analysis.
 *
 * Endpoint: GET /api/analytics/export
 *   ?domains=sensors,fertigation,automations,reference   (comma-separated; default = all)
 *   ?recent_days=30                                       (default 30)
 *   ?recent_granularity=hourly|raw                        (default hourly)
 *   ?include_trend=true                                   (default true; produces all-time daily aggregates)
 *
 * Returns: application/zip, streamed.
 *
 * File layout in the ZIP:
 *   README.txt
 *   trend/sensor_readings_daily.csv
 *   trend/fertigation_daily.csv
 *   trend/automation_logs_daily.csv
 *   recent_30d/sensor_readings_hourly.csv  (or sensor_readings_raw.csv if granularity=raw)
 *   recent_30d/fertigation_events.csv
 *   recent_30d/automation_logs.csv
 *   reference/lab_readings.csv
 *   reference/amic_cycles.csv
 *   reference/agronomist_reports.csv
 *   reference/operational_plans.csv
 */

const express = require('express');
const archiver = require('archiver');
const { db } = require('../utils/database');
const {
  UTF8_BOM,
  csvLine,
  csvFromRows,
  normalizeTimestampStr,
} = require('../utils/csvWriter');

const router = express.Router();

const ALL_DOMAINS = ['sensors', 'fertigation', 'automations', 'reference'];

router.get('/export', (req, res) => {
  const domains = (req.query.domains || ALL_DOMAINS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(d => ALL_DOMAINS.includes(d));
  const recentDays = Math.min(365, Math.max(1, parseInt(req.query.recent_days) || 30));
  const recentGranularity = req.query.recent_granularity === 'raw' ? 'raw' : 'hourly';
  const includeTrend = req.query.include_trend !== 'false';

  const today = new Date().toISOString().slice(0, 10);
  const zipName = `analytics_export_${today}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('[analytics] archive error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  // Track row counts for README
  const counts = {};
  const includeFile = (label, csvText, rows) => {
    archive.append(csvText, { name: label });
    counts[label] = rows;
  };

  try {
    // ===== trend (all-time daily aggregates) =====
    if (includeTrend) {
      if (domains.includes('sensors')) {
        const { csv, rows } = exportSensorReadingsDaily();
        includeFile('trend/sensor_readings_daily.csv', csv, rows);
      }
      if (domains.includes('fertigation')) {
        const { csv, rows } = exportFertigationDaily();
        includeFile('trend/fertigation_daily.csv', csv, rows);
      }
      if (domains.includes('automations')) {
        const { csv, rows } = exportAutomationLogsDaily();
        includeFile('trend/automation_logs_daily.csv', csv, rows);
      }
    }

    // ===== recent_NNd =====
    const recentLabel = `recent_${recentDays}d`;
    if (domains.includes('sensors')) {
      if (recentGranularity === 'hourly') {
        const { csv, rows } = exportSensorReadingsHourly(recentDays);
        includeFile(`${recentLabel}/sensor_readings_hourly.csv`, csv, rows);
      } else {
        const { csv, rows } = exportSensorReadingsRaw(recentDays);
        includeFile(`${recentLabel}/sensor_readings_raw.csv`, csv, rows);
      }
    }
    if (domains.includes('fertigation')) {
      const { csv, rows } = exportFertigationEvents(recentDays);
      includeFile(`${recentLabel}/fertigation_events.csv`, csv, rows);
    }
    if (domains.includes('automations')) {
      const { csv, rows } = exportAutomationLogsRaw(recentDays);
      includeFile(`${recentLabel}/automation_logs.csv`, csv, rows);
    }

    // ===== reference =====
    if (domains.includes('reference')) {
      const lab = exportLabReadings();
      includeFile('reference/lab_readings.csv', lab.csv, lab.rows);
      const amic = exportAmicCycles();
      includeFile('reference/amic_cycles.csv', amic.csv, amic.rows);
      const agro = exportAgronomistReports();
      includeFile('reference/agronomist_reports.csv', agro.csv, agro.rows);
      const plans = exportOperationalPlans();
      includeFile('reference/operational_plans.csv', plans.csv, plans.rows);
    }

    // ===== README =====
    const readme = buildReadme({ domains, recentDays, recentGranularity, includeTrend, counts });
    archive.append(readme, { name: 'README.txt' });

    archive.finalize();
  } catch (err) {
    console.error('[analytics] export failed:', err);
    archive.append(`Export error: ${err.message}\n`, { name: 'ERROR.txt' });
    archive.finalize();
  }
});

// ---------------- Sensor readings ----------------

function exportSensorReadingsDaily() {
  const rows = db.prepare(`
    SELECT
      date(r.timestamp) AS day,
      r.equipment_id,
      e.name AS equipment_name,
      e.type AS equipment_type,
      COALESCE(r.name, '') AS metric,
      COALESCE(r.unit, '') AS unit,
      COUNT(*) AS sample_count,
      ROUND(MIN(r.value), 4) AS min_val,
      ROUND(AVG(r.value), 4) AS mean_val,
      ROUND(MAX(r.value), 4) AS max_val
    FROM readings r
    JOIN equipment e ON r.equipment_id = e.id
    WHERE r.value IS NOT NULL
    GROUP BY day, r.equipment_id, COALESCE(r.name, '')
    ORDER BY day, r.equipment_id, metric
  `).all();
  const header = ['day', 'equipment_id', 'equipment_name', 'equipment_type', 'metric', 'unit',
                  'sample_count', 'min', 'mean', 'max'];
  const csv = csvFromRows(header, rows.map(r => [
    r.day, r.equipment_id, r.equipment_name, r.equipment_type, r.metric, r.unit,
    r.sample_count, r.min_val, r.mean_val, r.max_val,
  ]));
  return { csv, rows: rows.length };
}

function exportSensorReadingsHourly(days) {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d %H:00:00', r.timestamp) AS hour,
      r.equipment_id,
      e.name AS equipment_name,
      COALESCE(r.name, '') AS metric,
      COALESCE(r.unit, '') AS unit,
      COUNT(*) AS sample_count,
      ROUND(MIN(r.value), 4) AS min_val,
      ROUND(AVG(r.value), 4) AS mean_val,
      ROUND(MAX(r.value), 4) AS max_val
    FROM readings r
    JOIN equipment e ON r.equipment_id = e.id
    WHERE r.value IS NOT NULL
      AND datetime(r.timestamp) > datetime('now', ?)
    GROUP BY hour, r.equipment_id, COALESCE(r.name, '')
    ORDER BY hour, r.equipment_id, metric
  `).all(`-${days} days`);
  const header = ['hour', 'equipment_id', 'equipment_name', 'metric', 'unit',
                  'sample_count', 'min', 'mean', 'max'];
  const csv = csvFromRows(header, rows.map(r => [
    r.hour, r.equipment_id, r.equipment_name, r.metric, r.unit,
    r.sample_count, r.min_val, r.mean_val, r.max_val,
  ]));
  return { csv, rows: rows.length };
}

function exportSensorReadingsRaw(days) {
  const rows = db.prepare(`
    SELECT
      r.timestamp,
      r.equipment_id,
      e.name AS equipment_name,
      COALESCE(r.name, '') AS metric,
      COALESCE(r.unit, '') AS unit,
      r.value
    FROM readings r
    JOIN equipment e ON r.equipment_id = e.id
    WHERE r.value IS NOT NULL
      AND datetime(r.timestamp) > datetime('now', ?)
    ORDER BY r.timestamp, r.equipment_id, metric
  `).all(`-${days} days`);
  const header = ['timestamp', 'equipment_id', 'equipment_name', 'metric', 'unit', 'value'];
  const csv = csvFromRows(header, rows.map(r => [
    normalizeTimestampStr(r.timestamp), r.equipment_id, r.equipment_name, r.metric, r.unit, r.value,
  ]));
  return { csv, rows: rows.length };
}

// ---------------- Fertigation ----------------

/**
 * Daily fertigation totals: pair ON/OFF events, sum seconds, multiply by flow_rate to get liters.
 * Done in JS because correlated subqueries are slow in SQLite.
 */
function exportFertigationDaily() {
  const events = db.prepare(`
    SELECT
      re.equipment_id, re.channel, re.state, re.created_at,
      e.name AS equipment_name
    FROM relay_events re
    JOIN equipment e ON re.equipment_id = e.id
    WHERE (e.name LIKE '%irrigation%' OR e.name LIKE '%fertigation%' OR e.name LIKE '%dosing%')
    ORDER BY re.equipment_id, re.channel, re.created_at
  `).all();
  const configs = db.prepare(`
    SELECT rcc.equipment_id, rcc.channel, rcc.ingredient_name, rcc.flow_rate, rcc.flow_unit,
           fm.name AS mixture_name
    FROM relay_channel_config rcc
    LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id
  `).all();
  const cfgMap = new Map();
  for (const c of configs) cfgMap.set(`${c.equipment_id}|${c.channel}`, c);

  // Pair ON → next OFF per (eq, channel), accumulate per day
  const acc = new Map(); // key: day|eq|channel → { seconds }
  const byEqCh = new Map();
  for (const ev of events) {
    const k = `${ev.equipment_id}|${ev.channel}`;
    if (!byEqCh.has(k)) byEqCh.set(k, []);
    byEqCh.get(k).push(ev);
  }
  for (const [k, evs] of byEqCh) {
    for (let i = 0; i < evs.length; i++) {
      const cur = evs[i];
      if (cur.state !== 1) continue;
      const nextOff = evs.slice(i + 1).find(e => e.state === 0);
      if (!nextOff) continue;
      const onMs = new Date(normalizeIso(cur.created_at)).getTime();
      const offMs = new Date(normalizeIso(nextOff.created_at)).getTime();
      const durSec = Math.round((offMs - onMs) / 1000);
      if (!Number.isFinite(durSec) || durSec <= 0 || durSec > 86400) continue;
      const day = cur.created_at.slice(0, 10);
      const ak = `${day}|${cur.equipment_id}|${cur.channel}|${cur.equipment_name}`;
      if (!acc.has(ak)) acc.set(ak, { seconds: 0, cycles: 0 });
      acc.get(ak).seconds += durSec;
      acc.get(ak).cycles += 1;
    }
  }

  const rows = [];
  for (const [k, v] of acc) {
    const [day, eqId, ch, eqName] = k.split('|');
    const cfg = cfgMap.get(`${eqId}|${ch}`);
    const flow_rate = cfg?.flow_rate || null;
    const liters = (flow_rate && v.seconds > 0) ? Math.round((v.seconds / 60) * flow_rate * 100) / 100 : null;
    rows.push([
      day, parseInt(eqId), eqName, parseInt(ch),
      cfg?.ingredient_name || '', cfg?.mixture_name || '',
      v.cycles, v.seconds, Math.round(v.seconds / 60 * 10) / 10,
      flow_rate || '', cfg?.flow_unit || '', liters || '',
    ]);
  }
  rows.sort((a, b) => (a[0] + a[1] + a[3]).localeCompare(b[0] + b[1] + b[3]));
  const header = ['day', 'equipment_id', 'equipment_name', 'channel', 'ingredient', 'mixture',
                  'cycle_count', 'total_seconds', 'total_minutes', 'flow_rate', 'flow_unit', 'total_liters'];
  return { csv: csvFromRows(header, rows), rows: rows.length };
}

function exportFertigationEvents(days) {
  const rows = db.prepare(`
    SELECT
      re.id, re.equipment_id, e.name AS equipment_name, re.channel,
      re.state, re.source, re.automation_id, re.created_at,
      rcc.ingredient_name, fm.name AS mixture_name, rcc.flow_rate, rcc.flow_unit
    FROM relay_events re
    JOIN equipment e ON re.equipment_id = e.id
    LEFT JOIN relay_channel_config rcc
      ON rcc.equipment_id = re.equipment_id AND rcc.channel = re.channel
    LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id
    WHERE (e.name LIKE '%irrigation%' OR e.name LIKE '%fertigation%' OR e.name LIKE '%dosing%')
      AND datetime(re.created_at) > datetime('now', ?)
    ORDER BY re.created_at
  `).all(`-${days} days`);
  const header = ['event_id', 'timestamp', 'equipment_id', 'equipment_name', 'channel',
                  'state', 'source', 'automation_id', 'ingredient', 'mixture', 'flow_rate', 'flow_unit'];
  const csv = csvFromRows(header, rows.map(r => [
    r.id, normalizeTimestampStr(r.created_at), r.equipment_id, r.equipment_name, r.channel,
    r.state, r.source || '', r.automation_id || '',
    r.ingredient_name || '', r.mixture_name || '', r.flow_rate || '', r.flow_unit || '',
  ]));
  return { csv, rows: rows.length };
}

// ---------------- Automation logs ----------------

function exportAutomationLogsDaily() {
  const rows = db.prepare(`
    SELECT
      date(al.triggered_at) AS day,
      al.automation_id,
      a.name AS automation_name,
      al.status,
      COUNT(*) AS n
    FROM automation_logs al
    LEFT JOIN automations a ON al.automation_id = a.id
    GROUP BY day, al.automation_id, al.status
    ORDER BY day, al.automation_id, al.status
  `).all();
  const header = ['day', 'automation_id', 'automation_name', 'status', 'count'];
  const csv = csvFromRows(header, rows.map(r => [
    r.day, r.automation_id, r.automation_name || '', r.status, r.n,
  ]));
  return { csv, rows: rows.length };
}

function exportAutomationLogsRaw(days) {
  const rows = db.prepare(`
    SELECT
      al.id, al.automation_id, a.name AS automation_name, al.status,
      al.message, al.triggered_at, al.completed_at
    FROM automation_logs al
    LEFT JOIN automations a ON al.automation_id = a.id
    WHERE datetime(al.triggered_at) > datetime('now', ?)
    ORDER BY al.triggered_at DESC
  `).all(`-${days} days`);
  const header = ['log_id', 'automation_id', 'automation_name', 'status', 'message',
                  'triggered_at', 'completed_at'];
  const csv = csvFromRows(header, rows.map(r => [
    r.id, r.automation_id, r.automation_name || '', r.status, r.message || '',
    normalizeTimestampStr(r.triggered_at), normalizeTimestampStr(r.completed_at),
  ]));
  return { csv, rows: rows.length };
}

// ---------------- Reference ----------------

function exportLabReadings() {
  const cols = db.pragma('table_info(lab_readings)').map(c => c.name);
  if (cols.length === 0) return { csv: csvFromRows(['(empty)'], []), rows: 0 };
  const rows = db.prepare(`SELECT * FROM lab_readings ORDER BY id`).all();
  const csv = csvFromRows(cols, rows.map(r => cols.map(c => {
    const v = r[c];
    return /timestamp|date|created|updated|at$/i.test(c) && typeof v === 'string' ? normalizeTimestampStr(v) : v;
  })));
  return { csv, rows: rows.length };
}

function exportAmicCycles() {
  const cols = db.pragma('table_info(amic_cycle_history)').map(c => c.name);
  if (cols.length === 0) return { csv: csvFromRows(['(empty)'], []), rows: 0 };
  const rows = db.prepare(`SELECT * FROM amic_cycle_history ORDER BY id`).all();
  const csv = csvFromRows(cols, rows.map(r => cols.map(c => {
    const v = r[c];
    return /timestamp|date|created|updated|at$/i.test(c) && typeof v === 'string' ? normalizeTimestampStr(v) : v;
  })));
  return { csv, rows: rows.length };
}

function exportAgronomistReports() {
  // Skip the heavy text columns to keep the CSV usable in Excel
  const rows = db.prepare(`
    SELECT id, report_date, status, opinion, summary, model,
           input_tokens, output_tokens, generated_at
    FROM agronomist_reports
    ORDER BY report_date
  `).all();
  const header = ['id', 'report_date', 'status', 'opinion', 'summary', 'model',
                  'input_tokens', 'output_tokens', 'generated_at'];
  const csv = csvFromRows(header, rows.map(r => [
    r.id, r.report_date, r.status, r.opinion || '', r.summary || '', r.model || '',
    r.input_tokens || 0, r.output_tokens || 0, normalizeTimestampStr(r.generated_at),
  ]));
  return { csv, rows: rows.length };
}

function exportOperationalPlans() {
  const rows = db.prepare(`
    SELECT id, plan_date, version, status, headline, summary,
           input_tokens, output_tokens, generated_at, applied_at, rejection_feedback
    FROM operational_plans
    ORDER BY plan_date, version
  `).all();
  const header = ['id', 'plan_date', 'version', 'status', 'headline', 'summary',
                  'input_tokens', 'output_tokens', 'generated_at', 'applied_at', 'rejection_feedback'];
  const csv = csvFromRows(header, rows.map(r => [
    r.id, r.plan_date, r.version, r.status, r.headline || '', r.summary || '',
    r.input_tokens || 0, r.output_tokens || 0,
    normalizeTimestampStr(r.generated_at), normalizeTimestampStr(r.applied_at),
    r.rejection_feedback || '',
  ]));
  return { csv, rows: rows.length };
}

// ---------------- README ----------------

function buildReadme({ domains, recentDays, recentGranularity, includeTrend, counts }) {
  const lines = [
    'SenseHub Analytics Export',
    '=========================',
    `Generated: ${new Date().toISOString()}`,
    `Domains: ${domains.join(', ')}`,
    `Recent window: last ${recentDays} days (${recentGranularity} granularity)`,
    `Trend (all-time daily): ${includeTrend ? 'included' : 'excluded'}`,
    '',
    'File layout:',
    '  trend/        long-horizon aggregates from earliest reading to today',
    '  recent_Nd/    higher-resolution recent window for detailed analysis',
    '  reference/    low-volume lookup data (raw)',
    '',
    'Row counts:',
  ];
  for (const [name, n] of Object.entries(counts).sort()) {
    lines.push(`  ${String(n).padStart(8)}   ${name}`);
  }
  lines.push('');
  lines.push('CSV format: UTF-8 with BOM. Timestamps in "YYYY-MM-DD HH:MM:SS" UTC.');
  lines.push('Numeric columns use "." decimal, no thousands separator.');
  lines.push('');
  lines.push('Column dictionaries:');
  lines.push('');
  lines.push('  sensor_readings_*');
  lines.push('    day/hour       — UTC bucket boundary');
  lines.push('    equipment_id   — equipment.id');
  lines.push('    metric         — readings.name (e.g. "Substrate Moisture")');
  lines.push('    sample_count   — number of raw readings in the bucket');
  lines.push('    min/mean/max   — aggregated value across the bucket');
  lines.push('');
  lines.push('  fertigation_daily');
  lines.push('    cycle_count    — ON→OFF pair count for that day');
  lines.push('    total_seconds  — sum of cycle durations');
  lines.push('    total_liters   — total_minutes × flow_rate (null if flow_rate not configured)');
  lines.push('');
  lines.push('  automation_logs_*');
  lines.push('    status         — success | failure | skipped');
  lines.push('    message        — only on raw logs; reason for skip / failure detail');
  lines.push('');
  return UTF8_BOM + lines.join('\r\n');
}

// ---------------- helpers ----------------

function normalizeIso(s) {
  if (!s) return s;
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

module.exports = router;
