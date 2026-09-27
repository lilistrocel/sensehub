// Dose controller i18n: alert texts (message_key + params, English byte-identical
// to the historical text), status reasons rendered at read time, irrigation-run
// notes / labels in tr / ar. In-memory DB; nothing reaches hardware.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const i18n = src('i18n', 'index.js');
const { createAlert, updateOpenAlert, localizeAlert } = src('utils', 'alertBroadcast.js');
const DC = src('services', 'DoseController.js');
const { localizeRun: localizeIrrigationRun } = src('services', 'IrrigationRunsService.js');

const quiet = { log() {}, warn() {}, error() {} };
const noPlaceholders = (s) => assert.ok(!/\{[a-z_]+\}/i.test(s), `leftover placeholder in: ${s}`);
const hasArabic = (s) => /[؀-ۿ]/.test(s);

// ─── alert specs reproduce the historical English exactly ───────────────────
test('dose controller alert specs: English render = the historical template text', () => {
  const tName = 'B — Calcium nitrate';
  const V = 12.34; const target = 10.5; const factor = 1.15; const W = 1234.5;
  const cases = [
    [DC.ALERT_SPECS.fallback('monitor blind: no flowmeter data for 12 s — fixed schedule'),
      'Dose controller fell back to the fixed dosing schedule: monitor blind: no flowmeter data for 12 s — fixed schedule. Ratio control resumes when the irrigation monitor data returns.'],
    [DC.ALERT_SPECS.fallbackEnded(47, 'closed loop resumed (closed_loop)', 'monitor blind: no flowmeter data — fixed schedule'),
      'Dose controller: fixed-schedule fallback ended after 47 s (closed loop resumed (closed_loop)). Cause was: monitor blind: no flowmeter data — fixed schedule.'],
    [DC.ALERT_SPECS.overdose(tName, V, target, factor, W),
      `Dose controller closed ${tName}: ${`${tName}: ${V} L dosed vs ${target} L target (> ${factor}x)`} for ${W} L of water. Check the valve and the venturi.`],
    [DC.ALERT_SPECS.valveLeak(tName, 0.62, 3),
      `Dose controller: ${`${tName} drew 0.62 L while commanded closed`} (ch 3) — the valve may be stuck open; re-sent OFF.`],
    [DC.ALERT_SPECS.phFloor(4.9, 5.2, 31.5),
      'Fertigation pH 4.9 fell below the 5.2 floor — pH Down valve closed and locked out for the rest of this cycle (31.5 s acid used). Check the acid dosing and the probe.'],
    [DC.ALERT_SPECS.phNotVerifiable('last pH sample 95 s old'),
      'Dose controller: feed pH not verifiable (last pH sample 95 s old) — pH Down valve held closed.'],
    [DC.ALERT_SPECS.phSensorFault('frozen', 'pH stuck at 5.81 for 180 s while water flows'),
      'Dose controller: feed pH sensor frozen (pH stuck at 5.81 for 180 s while water flows) — pH Down valve closed for the rest of this cycle.'],
    [DC.ALERT_SPECS.acidCap('cycle', 120, 6.4, 5.8),
      'Dose controller: acid cap reached (120 s per cycle) with feed pH 6.4 still above 5.8 — no more pH Down this cycle.'],
    [DC.ALERT_SPECS.acidCap('day', 900, 6.4, 5.8),
      'Dose controller: acid cap reached (900 s per day) with feed pH 6.4 still above 5.8 — no more pH Down this day.'],
    [DC.ALERT_SPECS.valveMismatch('D — Micro', 4),
      `Dose controller: ${'D — Micro (ch 4) reads ON while commanded OFF'} — OFF re-sent.`],
    [DC.ALERT_SPECS.underdose('D', 200, 100, '—', 1.2, 300),
      'Dose controller: D could not reach 1:200 — valve open 100 % of the run, achieved 1:— (1.2 L for 300 L water). Venturi draw is below what the ratio needs.'],
    [DC.ALERT_SPECS.underdose('A', 150, null, null, 0, 0),
      `Dose controller: A could not reach 1:150 — valve open ${null} % of the run, achieved 1:${null} (0 L for 0 L water). Venturi draw is below what the ratio needs.`],
  ];
  for (const [spec, want] of cases) {
    assert.equal(i18n.render('en', spec), want);
    for (const L of ['tr', 'ar']) {
      const out = i18n.render(L, spec);
      noPlaceholders(out);
      assert.notEqual(out, want, `${spec.$k} not translated to ${L}`);
    }
    assert.ok(hasArabic(i18n.render('ar', spec)));
  }
});

// ─── alerts go through createAlert with key + params, stored English ─────────
test('dose controller alerts: stored English + message_key; API renders tr / ar; fallback-ended rewrite keeps a key', () => {
  const ctl = new DC.DoseController({ db, createAlert, updateOpenAlert, autoTick: false, logger: quiet, now: () => Date.now() });
  const c = { ctx: { automationId: null }, alerts: new Set(), trips: [], fallbackPeriods: [], tanks: [], phTank: null };
  const reason = 'monitor blind: flowmeter unhealthy (signal 2, flags 8) — fixed schedule';
  const now = Date.now();
  c.fallbackPeriods.push({ from: new Date(now - 47000).toISOString(), to: null, reason });
  ctl._alert(c, 'fallback', 'warning', DC.ALERT_SPECS.fallback(reason), { equipment_id: null });
  c.fallbackAlerted = true;
  let row = db.prepare("SELECT * FROM alerts WHERE fingerprint = 'dose_controller:fallback' AND acknowledged = 0").get();
  assert.equal(row.message, `Dose controller fell back to the fixed dosing schedule: ${reason}. Ratio control resumes when the irrigation monitor data returns.`);
  assert.equal(row.message_key, 'dose_controller.alert.fallback');
  const tr = localizeAlert(row, 'tr');
  assert.match(tr.message, /sabit dozlama programına geri döndü/);
  assert.match(tr.message, /debimetre arızalı \(sinyal 2, bayraklar 8\)/, 'nested reason translated');
  assert.equal(tr.message_en, row.message);
  noPlaceholders(tr.message);
  const ar = localizeAlert(row, 'ar');
  assert.ok(hasArabic(ar.message));
  noPlaceholders(ar.message);

  ctl._closeFallback(c, now, 'closed loop resumed (closed_loop)');
  row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(row.id);
  assert.equal(row.severity, 'info');
  assert.match(row.message, /^Dose controller: fixed-schedule fallback ended after 4[6-8] s \(closed loop resumed \(closed_loop\)\)\. Cause was: monitor blind: flowmeter unhealthy/);
  assert.equal(row.message_key, 'dose_controller.alert.fallback_ended');
  const tr2 = localizeAlert(row, 'tr').message;
  assert.match(tr2, /sabit program geri dönüşü 4[6-8] sn sonra sona erdi \(kapalı döngü yeniden başladı \(closed_loop\)\)/);
  noPlaceholders(localizeAlert(row, 'ar').message);

  // pH sensor fault path (real method) -> key + nested detail
  const c2 = { ctx: { automationId: null }, alerts: new Set(), trips: [], acid: { open: false, faultLatched: null }, cfgAtStart: { ph: { sensor_equipment_id: null } } };
  ctl._sensorFault(c2, now, 'implausible', 'pH 14.2 outside 2-12');
  const r3 = db.prepare("SELECT * FROM alerts WHERE fingerprint = 'dose_controller:ph_sensor' AND acknowledged = 0").get();
  assert.equal(r3.message, 'Dose controller: feed pH sensor implausible (pH 14.2 outside 2-12) — pH Down valve closed for the rest of this cycle.');
  assert.match(localizeAlert(r3, 'tr').message, /mantıksız değer \(pH 14\.2, 2-12 aralığının dışında\)/);
});

// ─── status reasons ─────────────────────────────────────────────────────────
test('dose controller status: reasons localized for tr / ar with *_en originals; English untouched; unknown text stays', () => {
  const status = {
    running: true, mode: 'fallback',
    mode_reason: 'monitor blind: no flowmeter data for 31 s — fixed schedule',
    reason: 'waiting for water flow',
    warnings: ['pH window 30 s is shorter than the plant lag (tau 15 s + dead time 20 s)'],
    paused: { reason: 'flow watch cold-restart retry: Irrigation Zone 4 no water', since: null },
    tanks: [{ tank_id: 1, why: 'zone target reached' }, { tank_id: 2, why: 'behind target' }, { tank_id: 3, why: 'some future reason' }],
    ph: { gate: 'acid cap reached (120 s this cycle)', acid: { last_decision: { skipped: 'floor touched — one window skipped' } } },
    last_run: { id: 9, end_reason: 'stop_irrigation: Stop irrigation pressed by op@farm.test' },
  };
  assert.equal(DC.localizeStatus(status, 'en'), status);
  const tr = DC.localizeStatus(status, 'tr');
  assert.equal(tr.mode_reason, 'izleme körleşti: 31 sn boyunca debimetre verisi yok — sabit program');
  assert.equal(tr.mode_reason_en, status.mode_reason);
  assert.equal(tr.reason, 'su akışı bekleniyor');
  assert.match(tr.warnings[0], /pH penceresi 30 sn/);
  assert.deepEqual(tr.warnings_en, status.warnings);
  assert.match(tr.paused.reason, /Irrigation Zone 4 su yok/);
  assert.equal(tr.tanks[0].why, 'bölge hedefine ulaşıldı');
  assert.equal(tr.tanks[0].why_en, 'zone target reached');
  assert.equal(tr.tanks[2].why, 'some future reason', 'unknown reason stays English');
  assert.equal(tr.ph.gate, 'asit sınırına ulaşıldı (bu döngüde 120 sn)');
  assert.equal(tr.ph.acid.last_decision.skipped, 'alt sınıra değildi — bir pencere atlandı');
  assert.equal(tr.last_run.end_reason, 'Sulamayı Durdur: op@farm.test tarafından basıldı');
  assert.equal(tr.last_run.end_reason_en, status.last_run.end_reason);
  assert.equal(status.tanks[0].why, 'zone target reached', 'input not mutated');
  const ar = DC.localizeStatus(status, 'ar');
  for (const s of [ar.mode_reason, ar.reason, ar.tanks[0].why, ar.ph.gate, ar.paused.reason, ar.warnings[0]]) { assert.ok(hasArabic(s), s); noPlaceholders(s); }
});

test('dose controller reasons: every known English reason maps to a key whose English render is identical', () => {
  const samples = [
    'controller switched off — fixed schedule', 'automations disarmed — dosing valves held closed', 'dosing paused — paused',
    'waiting for monitor data (no dosing data for 7 s)', 'monitor blind: no flow value — fixed schedule', 'water stopped — nutrient valves closed',
    'no pH sample since the start delay ended 40 s ago', 'pH stuck at 5.8 for 120 s while water flows', 'pH fell below 5.2 — locked out this cycle',
    'pH sensor frozen', 'daily acid cap reached (900 s)', 'start delay (cup flush)', 'planned pump stop ahead', 'no pH Down tank bound to the dosing board',
    'manual stop', 'stop-all requested', 'flow_watch: dosing without water flow', 'flow_watch_shutdown: Irrigation Zone 4 no water flow',
    'coil write failed: timeout', 'backend restarted during the cycle', 'fixed schedule (no ratio set)', 'no water (monitor idle)',
  ];
  for (const text of samples) {
    const spec = DC.reasonSpec(text);
    assert.equal(typeof spec, 'object', `no key for "${text}"`);
    assert.equal(i18n.render('en', spec), text);
    for (const L of ['tr', 'ar']) {
      const out = DC.localizeReason(L, text);
      assert.notEqual(out, text, `${L}: "${text}" untranslated`);
      noPlaceholders(out);
    }
  }
});

// ─── irrigation runs ────────────────────────────────────────────────────────
test('irrigation runs: type_label, notes (from notes_i18n) and "Zone unknown" rendered in tr / ar; English unchanged', () => {
  const { M } = i18n;
  const notesI18n = [
    M('irrigation_runs.note.stopped_by_operator', { source: M('irrigation_runs.stop_irrigation'), user: M('irrigation_runs.note.user_suffix', { user: 'op@farm.test' }), at: '12:31:07' }),
    M('irrigation_runs.note.manual_open_closed', { zone: 'Zone 4', opened: '12:23:47', by: 'ismail@a20core.com', closed: '12:32:07', closed_by: 'lilistrocel@gmail.com' }),
    M('irrigation_runs.note.uncontrolled_dosing', { tanks: i18n.list([M('irrigation_runs.note.tank_litres', { tank: 'A', litres: '1.25' }), M('irrigation_runs.note.tank_litres', { tank: 'B', litres: '0.9' })]) }),
  ];
  const run = {
    id: 3, type: 'automated', type_label: 'Scheduled',
    notes: notesI18n.map(n => i18n.render('en', n)), notes_i18n: notesI18n,
    zone_visits: [{ visit: 1, zone_unknown: true, name: 'Zone unknown' }, { visit: 2, name: 'Zone 4' }],
  };
  assert.deepEqual(run.notes, [
    'Stopped by the operator (Stop irrigation, op@farm.test) at 12:31:07',
    'Zone 4 was open manually during this run: opened 12:23:47 by ismail@a20core.com, closed 12:32:07 by lilistrocel@gmail.com',
    'Dosing outside SenseHub control: A 1.25 L, B 0.9 L',
  ]);
  assert.equal(localizeIrrigationRun(run, 'en'), run);
  const tr = localizeIrrigationRun(run, 'tr');
  assert.equal(tr.type_label, 'Zamanlanmış');
  assert.equal(tr.type_label_en, 'Scheduled');
  assert.match(tr.notes[0], /^Operatör tarafından durduruldu \(Sulamayı Durdur, op@farm\.test\), saat 12:31:07$/);
  assert.match(tr.notes[2], /A 1\.25 L, B 0\.9 L/);
  assert.deepEqual(tr.notes_en, run.notes);
  assert.equal(tr.zone_visits[0].name, 'Bölge bilinmiyor');
  assert.equal(tr.zone_visits[1].name, 'Zone 4');
  const ar = localizeIrrigationRun(run, 'ar');
  assert.equal(ar.type_label, 'مجدول');
  assert.match(ar.notes[2], /A 1\.25 L، B 0\.9 L/, 'Arabic list separator, Western digits');
  ar.notes.forEach(noPlaceholders);
  // a run stored before i18n (no notes_i18n) keeps its English notes
  const old = localizeIrrigationRun({ id: 1, type: 'manual_panel', type_label: 'Manual — panel', notes: ['legacy note'] }, 'ar');
  assert.deepEqual(old.notes, ['legacy note']);
  assert.equal(old.type_label, 'يدوي — اللوحة');
});
