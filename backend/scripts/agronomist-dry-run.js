#!/usr/bin/env node
/**
 * agronomist-dry-run — build the agronomist (or planner) request body WITHOUT
 * calling the Anthropic API and print per-section sizes.
 *
 *   node scripts/agronomist-dry-run.js --db /path/to.db --report-date 2026-07-01 [--capture photo.jpg]
 *   node scripts/agronomist-dry-run.js --db /path/to.db --report-id 103
 *   node scripts/agronomist-dry-run.js --db /path/to.db --plan-date 2026-06-28 | --plan-id 68
 *   node scripts/agronomist-dry-run.js --db /path/to.db --today            (live aggregateDailyData + real capture)
 *   node scripts/agronomist-dry-run.js --db /path/to.db --today --planner  (also builds the planner request; --dump-planner-request out.json)
 *   add --dump-request out.json to write the exact request body (image data truncated unless --full)
 *
 * Every mode prints the effective AI data-source policy (ai_data_sources): which
 * sections the model receives, which sources are out of service, and the
 * OUT OF SERVICE note as it appears in the user message.
 *
 * Replay modes print BEFORE (the saved input_snapshot as it was sent) and AFTER
 * (the same snapshot passed through the slimming helpers) so the effect of the
 * slimming can be measured on real historical prompts.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : dflt; };
const has = name => args.includes(name);

const dbArg = opt('--db');
if (dbArg) process.env.DB_PATH = path.resolve(dbArg);
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = '';

const { db } = require('../src/utils/database');
const { agronomistService } = require('../src/services/AgronomistService');
const { operationalPlannerService } = require('../src/services/OperationalPlannerService');
const { agronomistCaptureService } = require('../src/services/AgronomistCaptureService');
const S = require('../src/services/AiSnapshotSlimming');

const CHARS_PER_TOKEN = 3.6;
const tok = chars => Math.round(chars / CHARS_PER_TOKEN);

function printStats(label, stats, extra = {}) {
  const rows = Object.entries(stats).filter(([k]) => !k.startsWith('_') && typeof stats[k] === 'number' && !['system_prompt_chars', 'user_text_chars', 'image_bytes', 'image_base64_chars', 'capture_id', 'capture_age_hours'].includes(k))
    .sort((a, b) => b[1] - a[1]);
  const total = stats._total ?? rows.reduce((a, [, v]) => a + v, 0);
  console.log(`\n== ${label} ==`);
  console.log('section'.padEnd(30) + 'chars'.padStart(10) + 'pct'.padStart(7) + 'tokens~'.padStart(9));
  for (const [k, v] of rows) {
    console.log(k.padEnd(30) + String(v).padStart(10) + (total ? (100 * v / total).toFixed(1) + '%' : '').padStart(7) + String(tok(v)).padStart(9));
  }
  console.log('TOTAL snapshot JSON'.padEnd(30) + String(total).padStart(10) + ''.padStart(7) + String(tok(total)).padStart(9));
  if (stats.user_text_chars != null) console.log(`user text chars: ${stats.user_text_chars} (~${tok(stats.user_text_chars)} tokens)`);
  if (stats.system_prompt_chars != null) console.log(`system prompt chars: ${stats.system_prompt_chars} (~${tok(stats.system_prompt_chars)} tokens)`);
  if ('image_present' in stats) console.log(`image block: ${stats.image_present ? `YES — ${stats.image_bytes} bytes JPEG, ${stats.image_base64_chars} base64 chars${stats.capture_age_hours != null ? `, ${stats.capture_age_hours} h old` : ''}` : 'none'}`);
  for (const [k, v] of Object.entries(extra)) console.log(`${k}: ${v}`);
}

function loadCapture(file) {
  if (!file) return null;
  const buffer = fs.readFileSync(file);
  const { jpegDimensions } = require('../src/services/AgronomistCaptureService');
  const d = jpegDimensions(buffer);
  return { capture: { id: 0, camera_name: 'dry-run file', capture_date: opt('--report-date') || new Date().toISOString().slice(0, 10), created_at: new Date().toISOString(), preset_id: null, width: d?.width, height: d?.height }, ageHours: 0, buffer };
}

function dumpRequest(body) {
  const out = opt('--dump-request');
  if (!out) return;
  const clone = JSON.parse(JSON.stringify(body));
  if (!has('--full')) {
    for (const m of clone.messages) for (const c of (Array.isArray(m.content) ? m.content : [])) {
      if (c.type === 'image') c.source.data = c.source.data.slice(0, 40) + `...(${c.source.data.length} chars)`;
    }
  }
  fs.writeFileSync(out, JSON.stringify(clone, null, 2));
  console.log(`request body written to ${out}`);
}

function endOfDay(dateStr) { return `${dateStr}T23:59:59Z`; }

// ---------------------------------------------------------------------------
// Agronomist replay / live
// ---------------------------------------------------------------------------

function dataSourceLines(stats, snapshotObj, userText) {
  const ds = stats.data_sources || { disabled: [], excluded_equipment_ids: [] };
  const lines = {
    'sections present': Object.keys(snapshotObj || {}).filter(k => k !== 'snapshot_stats').join(', '),
    'data_sources.disabled': ds.disabled.length ? ds.disabled.map(d => `${d.key}${d.reason ? ` (${d.reason})` : ''}`).join('; ') : 'none',
    'excluded_equipment_ids': ds.excluded_equipment_ids.length ? ds.excluded_equipment_ids.join(', ') : 'none',
  };
  const m = /OUT OF SERVICE[^\n]*/.exec(userText || '');
  lines['out-of-service note'] = m ? m[0] : 'absent';
  return lines;
}

function runAgronomist({ date, snapshot, capture, label }) {
  const cfg = agronomistService.getConfig();
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date, snapshot, cfg, capture, clarifications: [], historyBlock: agronomistService._formatHistoryBlock() });
  const content = requestBody.messages[0].content;
  const userText = content.find(c => c.type === 'text')?.text || '';
  // The sections the model actually receives (buildDailyRequest re-applies the data-source policy).
  const sentJson = /```json\n([\s\S]*?)\n```/.exec(userText);
  let sentSnapshot = null;
  try { sentSnapshot = sentJson ? JSON.parse(sentJson[1]) : null; } catch {}
  printStats(label, stats, {
    'content blocks': content.map(c => c.type).join(' -> '),
    'total request chars (JSON)': JSON.stringify(requestBody).length,
    ...dataSourceLines(stats, sentSnapshot, userText),
  });
  return requestBody;
}

if (opt('--report-id') || opt('--report-date')) {
  const row = opt('--report-id')
    ? db.prepare('SELECT * FROM agronomist_reports WHERE id = ?').get(parseInt(opt('--report-id'), 10))
    : db.prepare('SELECT * FROM agronomist_reports WHERE report_date = ?').get(opt('--report-date'));
  if (!row) { console.error('report not found'); process.exit(1); }
  const saved = JSON.parse(row.input_snapshot);
  const date = row.report_date;
  console.log(`Agronomist report #${row.id} ${date} (${row.status}, model ${row.model}); saved input_snapshot ${row.input_snapshot.length} chars; input_tokens=${row.input_tokens} cache_read=${row.cache_read_tokens}`);
  const capture = loadCapture(opt('--capture'));

  const before = runAgronomist({ date, snapshot: saved, capture: null, label: `BEFORE (saved snapshot as sent on ${date}, no image)` });
  const slimmed = { ...saved, operator_tasks: S.slimOperatorTasks(saved.operator_tasks, { now: endOfDay(date) }) };
  const after = runAgronomist({ date, snapshot: slimmed, capture, label: `AFTER (operator_tasks slimmed${capture ? ', image attached' : ''})` });
  console.log(`\noperator_tasks rows: ${(saved.operator_tasks || []).length} -> ${slimmed.operator_tasks.length}`);
  dumpRequest(after);
  void before;
}

// ---------------------------------------------------------------------------
// Planner replay
// ---------------------------------------------------------------------------

if (opt('--plan-id') || opt('--plan-date')) {
  const row = opt('--plan-id')
    ? db.prepare('SELECT * FROM operational_plans WHERE id = ?').get(parseInt(opt('--plan-id'), 10))
    : db.prepare('SELECT * FROM operational_plans WHERE plan_date = ? ORDER BY version DESC LIMIT 1').get(opt('--plan-date'));
  if (!row) { console.error('plan not found'); process.exit(1); }
  const saved = JSON.parse(row.input_snapshot);
  delete saved.snapshot_stats;
  console.log(`Planner plan #${row.id} for ${row.plan_date} (generated ${row.generated_for}, v${row.version}, ${row.status}); saved input_snapshot ${row.input_snapshot.length} chars; input_tokens=${row.input_tokens} cache_read=${row.cache_read_tokens}`);

  const beforeStats = S.sectionStats(saved);
  const beforeSnapStats = S.sectionStats(saved.today_snapshot || {});
  printStats('BEFORE (saved planner context)', beforeStats);
  printStats('BEFORE today_snapshot breakdown', beforeSnapStats);

  const ctx = JSON.parse(JSON.stringify(saved));
  const eqIdx = S.equipmentIndexFromInventory(ctx.equipment);
  const rawAutos = ctx.current_automations || [];
  ctx.current_automations = rawAutos.map(a => S.compactAutomation(a, eqIdx));
  const now = endOfDay(ctx.today || row.generated_for);
  ctx.operator_tasks = S.slimOperatorTasks(ctx.operator_tasks, { now });
  if (ctx.today_snapshot?.operator_tasks) ctx.today_snapshot.operator_tasks = S.slimOperatorTasks(ctx.today_snapshot.operator_tasks, { now });
  S.dedupePlannerContext(ctx);
  const afterStats = S.sectionStats(ctx);
  printStats('AFTER (compact automations, slimmed tasks, deduped today_snapshot)', afterStats);
  printStats('AFTER today_snapshot breakdown', S.sectionStats(ctx.today_snapshot || {}));
  console.log(`\ncurrent_automations: ${rawAutos.length} rows, ${beforeStats.current_automations} -> ${afterStats.current_automations} chars`);
  console.log(`operator_tasks (top): ${(saved.operator_tasks || []).length} -> ${ctx.operator_tasks.length} rows, ${beforeStats.operator_tasks || 0} -> ${afterStats.operator_tasks} chars`);
  console.log(`today_snapshot.operator_tasks: ${(saved.today_snapshot?.operator_tasks || []).length} rows / ${beforeSnapStats.operator_tasks || 0} chars -> removed`);
  console.log(`TOTAL: ${beforeStats._total} -> ${afterStats._total} chars (${(100 * (1 - afterStats._total / beforeStats._total)).toFixed(1)}% smaller), ~${tok(beforeStats._total)} -> ~${tok(afterStats._total)} tokens`);
  console.log('\nsample compact automation:', JSON.stringify(ctx.current_automations[0]));
  if (opt('--dump-request')) fs.writeFileSync(opt('--dump-request'), JSON.stringify(ctx, null, 2));
}

// ---------------------------------------------------------------------------
// Live "today" build (current DB, real capture if present)
// ---------------------------------------------------------------------------

if (has('--today')) {
  const date = opt('--date') || agronomistService._localDateStr(new Date());
  const snapshot = agronomistService.aggregateDailyData(date);
  const cfg = agronomistService.getConfig();
  let capture = null;
  try { capture = agronomistCaptureService.getCaptureForReport(date, { cameraId: cfg.capture_camera_id || null }); } catch (e) { console.warn('capture lookup failed:', e.message); }
  const body = runAgronomist({ date, snapshot, capture, label: `TODAY ${date} (live aggregateDailyData, capture ${capture ? '#' + capture.capture.id : 'none'})` });
  dumpRequest(body);

  if (has('--planner')) {
    const ctx = operationalPlannerService.buildPlanningContext(date, {});
    const { requestBody, userMessage, stats } = operationalPlannerService.buildPlanRequest({ today: date, context: ctx });
    printStats(`TODAY planner context ${date}`, stats, {
      'today_snapshot sections': Object.keys(ctx.today_snapshot || {}).join(', '),
      'total request chars (JSON)': JSON.stringify(requestBody).length,
      ...dataSourceLines(stats, ctx, userMessage),
    });
    const plannerOut = opt('--dump-planner-request');
    if (plannerOut) { fs.writeFileSync(plannerOut, JSON.stringify(requestBody, null, 2)); console.log(`planner request body written to ${plannerOut}`); }
  }
}

if (!opt('--report-id') && !opt('--report-date') && !opt('--plan-id') && !opt('--plan-date') && !has('--today')) {
  console.log('usage: see header of this file');
}
