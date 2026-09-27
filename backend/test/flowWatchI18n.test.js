/**
 * Flow watch + Stop irrigation i18n (en / tr / ar).
 *
 * The replays reuse the simulator of test/flowWatch.test.js (loaded with its test()
 * calls turned into no-ops, so its scenarios do not run twice). For each alert:
 *   - alerts.message is the English text (identical to the pre-i18n wording, which
 *     test/flowWatch.test.js keeps asserting), message_key / message_params stored
 *   - localizeAlert(row, 'tr' | 'ar') renders a different text, with no leftover
 *     {placeholders}, no catalog keys, Western digits only.
 */
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const express = require('express');
const http = require('http');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const i18n = src('i18n', 'index.js');
const { localizeAlert } = src('utils', 'alertBroadcast.js');
const { createIrrigationStopRouter, localizeStopResult } = src('routes', 'irrigationStop.js');

// ── the flowWatch.test.js simulator, without its tests ──────────────────────
function loadFlowWatchHarness() {
  const file = path.join(__dirname, 'flowWatch.test.js');
  let code = fs.readFileSync(file, 'utf8');
  const TEST_REQUIRE = "const test = require('node:test');";
  assert.ok(code.includes(TEST_REQUIRE), 'flowWatch.test.js layout changed');
  code = code.replace(TEST_REQUIRE, 'const test = () => {};');
  code += '\nmodule.exports = { Sim, db, run1530Sim, panelSim, PANEL_RATES, NORMAL_RATES, INCIDENT_RATES, lerp, noiseGen, guardAlerts };\n';
  const m = new Module(file + '#i18n-harness', module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}
const H = loadFlowWatchHarness();
const { db } = H;

const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
const KEYISH = /\b(flow_watch|irrigation_stop|common)\.[a-z_]+/;
const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;

/** Assert an alert row is stored English + key and renders cleanly in tr / ar. Returns { en, tr, ar }. */
function checkAlert(row, { key, enPattern }) {
  assert.ok(row, 'alert row');
  assert.equal(row.message_key, key);
  assert.ok(row.message_params, 'message_params stored');
  assert.doesNotThrow(() => JSON.parse(row.message_params));
  if (enPattern) assert.match(row.message, enPattern);
  const out = { en: row.message };
  for (const lang of ['en', 'tr', 'ar']) {
    const loc = localizeAlert(row, lang);
    assert.equal(loc.message_en, row.message, 'message_en = stored English');
    assert.equal(loc.message_key, key);
    if (lang === 'en') { assert.equal(loc.message, row.message, 'English render = stored text'); continue; }
    assert.notEqual(loc.message, row.message, `${lang} differs from English`);
    assert.doesNotMatch(loc.message, PLACEHOLDER, `${lang}: leftover placeholder in ${loc.message}`);
    assert.doesNotMatch(loc.message, KEYISH, `${lang}: catalog key in ${loc.message}`);
    assert.doesNotMatch(loc.message, EASTERN_DIGITS);
    out[lang] = loc.message;
  }
  return out;
}

const examples = {};

test('i18n: pump protection run shutdown (Zone 4, retry failed) — English stored, tr/ar rendered; Telegram gets English + specs', async () => {
  const { sim, plant } = H.run1530Sim({}, { alwaysStuck: [6] });
  await sim.run({ from: -20, to: 170, flowAt: plant.flowAt, dosingAt: H.NORMAL_RATES });
  const a = H.guardAlerts(sim);
  assert.equal(a.length, 1);
  const r = checkAlert(a[0], {
    key: 'flow_watch.shutdown.main',
    enPattern: /^Irrigation stopped: Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) had no water for 1\d s with the pumps running — pumps, zones and dosing switched off to prevent over-pressure\. A cold restart \(pumps \+ valve off 10 s, then on again\) did not bring water\. Zones not irrigated this run: Irrigation Zone 4\. Check the valve\. \(OFF confirmed on relays 1, 2, 3, 4, 5, 6; 0 pending start\(s\) cancelled; dose cycle #85 aborted\.\)$/,
  });
  assert.match(r.tr, /^Sulama durduruldu: Irrigation Zone 4 \(Waveshare Irrigation 1 röle 6\) pompalar çalışırken 1\d sn boyunca susuz kaldı/);
  assert.match(r.tr, /röleler 1, 2, 3, 4, 5, 6 üzerinde doğrulandı/);
  assert.match(r.ar, /^توقف الري: Irrigation Zone 4 \(Waveshare Irrigation 1 المرحّل 6\)/);
  assert.match(r.ar, /1، 2، 3، 4، 5، 6/, 'Arabic list separator');
  assert.match(r.ar, /دورة الحقن #85/);
  examples.shutdown = r;
  // Telegram (injected notify): English text + the specs to render in telegram_language
  const n = sim.notifications.find(x => /^Irrigation stopped: Irrigation Zone 4/.test(x.text));
  assert.ok(n, 'shutdown notified');
  assert.equal(n.title, 'Irrigation stopped: no water flow');
  sim.dispose();
});

test('i18n: cold-restart retry that works → "recovered" update keeps key + params, renders tr/ar', async () => {
  const { sim, plant } = H.run1530Sim();
  await sim.run({ from: -20, to: 170, flowAt: plant.flowAt, dosingAt: H.NORMAL_RATES, actions: { 150: s => { s.sched.running = false; } } });
  const a = H.guardAlerts(sim);
  assert.equal(a.length, 1);
  const r = checkAlert(a[0], { key: 'flow_watch.retry.recovered_valve', enPattern: /^Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) recovered after a cold restart \(retry\): .* Dosing resumed with the zone target kept\. The valve sticks when switched under pressure — check it\.$/ });
  assert.match(r.tr, /soğuk yeniden başlatmadan \(deneme\) sonra düzeldi/);
  assert.match(r.ar, /إعادة تشغيل باردة/);
  sim.dispose();
});

test('i18n: dosing without water (zone 4 incident replay) — fire + automatic abort outcome + end summary compose from specs', async () => {
  const base = Date.parse('2026-09-26T05:40:55Z');
  const sim = new H.Sim({ base, relays: { 1: true, 2: true, 5: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 630000);
  sim.relayEvent(sim.irr, 2, true, 'automation', base - 630000);
  sim.relayEvent(sim.irr, 5, true, 'automation', base - 209000);
  const noise = H.noiseGen(7);
  const flowAt = (rel) => {
    if (rel < 0) return 8837 + noise(90);
    if (rel <= 5) return H.lerp(8837, 2157, rel / 5);
    if (rel <= 18) return H.lerp(2157, 0, (rel - 5) / 13);
    return 0;
  };
  const dosingAt = (rel) => (sim.sched.running || (sim.t - sim.dosingStoppedAt) < 40000 ? H.INCIDENT_RATES(rel) : [0, 0, 0, 0]);
  // stop after the abort: the alert carries the fire message + the abort outcome
  await sim.run({
    from: -60, to: 40, flowAt, dosingAt, activeAt: (rel) => rel < 9,
    actions: { 0: s => s.setRelay(6, true), 1: s => s.setRelay(5, false, 'automation_auto_off') },
  });
  let dosing = sim.alerts().find(x => x.fingerprint === `flow_watch:dosing_without_water:${sim.dos}`);
  const fire = checkAlert(dosing, {
    key: 'flow_watch.fire.dosing_without_water',
    enPattern: /^Fertiliser is dosing into a line with no water flow: Tank A \d+ L\/h, Tank B \d+ L\/h, Tank C \d+ L\/h, Tank D \d+ L\/h \(water 0 L\/h, below 500 L\/h for 1\d s\)\. Dosing stopped automatically: dose cycle #85 aborted by the flow watch, injector valves closed \(Tank A, Tank B, Tank C, Tank D\)\. Pumps and zone valves were not touched\.$/,
  });
  assert.match(fire.tr, /^Su akışı olmayan bir hatta gübre dozlanıyor: Tank A \d+ L\/h/);
  assert.match(fire.tr, /Dozlama otomatik olarak durduruldu: dozlama döngüsü #85 akış izleme tarafından iptal edildi/);
  assert.match(fire.ar, /^يتم حقن السماد في خط لا تتدفق فيه المياه: Tank A \d+ L\/h، Tank B/);
  assert.match(fire.ar, /توقف الحقن تلقائيًا/);
  examples.dosing_fire = fire;
  // status: active[].message in the request language + raw key
  const st = sim.svc.getStatus(sim.t, { lang: 'ar' });
  const act = st.active.find(x => x.rule === 'dosing_without_water');
  assert.ok(act && act.fired);
  assert.equal(act.message, localizeAlert(dosing, 'ar').message);
  assert.equal(act.message_en, dosing.message);
  assert.equal(act.message_key, 'flow_watch.fire.dosing_without_water');
  assert.equal(sim.svc.getStatus(sim.t).active.find(x => x.rule === 'dosing_without_water').message, dosing.message, 'default English');

  await sim.run({ from: 40.5, to: 260, flowAt, dosingAt, activeAt: () => false, actions: { 169: s => { for (const ch of [1, 2, 6]) s.setRelay(ch, false, 'stop_all'); } } });
  dosing = sim.alerts().find(x => x.fingerprint === `flow_watch:dosing_without_water:${sim.dos}`);
  const end = checkAlert(dosing, {
    key: 'flow_watch.end.dosing',
    enPattern: /^Dosing without water \(Tank A \d+ L\/h, .*\) lasted \d+ s; dosing stopped automatically — dose cycle #85 aborted by the flow watch, injector valves closed \(Tank A, Tank B, Tank C, Tank D\)\. Pumps and zone valves were not touched\. About [\d.]+ L of concentrate went in with no water flow\. Find out why there was no water flow before the next run\.$/,
  });
  assert.match(end.tr, /^Su olmadan dozlama \(Tank A/);
  assert.match(end.ar, /^استمر الحقن بدون مياه \(Tank A/);
  examples.dosing_end = end;
  const noFlow = sim.alerts().find(x => x.fingerprint === `flow_watch:valve_no_flow:${sim.irr}:6`);
  checkAlert(noFlow, { key: 'flow_watch.end.valve_no_flow', enPattern: /^Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) ran 2 min \d+ s with no water flowing/ });
  // Telegram: injected notify still gets English; the 4th arg carries the specs
  const n = sim.notifications.find(x => x.title === 'Fertigation: dosing without water — ended');
  assert.ok(n, JSON.stringify(sim.notifications.map(x => x.title)));
  sim.dispose();
});

test('i18n: manual panel irrigation — start and end (summary) alerts in tr/ar', async () => {
  const sim = H.panelSim();
  const water = (rel) => (rel >= 30 && rel < 750 ? 8934 : 0);
  const dose = (rel) => (rel >= 30 && rel < 750 ? H.PANEL_RATES : [0, 0, 0, 0]);
  await sim.run({ from: 0, to: 700, flowAt: water, dosingAt: dose, activeAt: () => true });
  let a = sim.alerts();
  assert.equal(a.length, 1);
  const start = checkAlert(a[0], {
    key: 'flow_watch.fire.manual_panel',
    enPattern: /^Manual irrigation detected \(panel\) — water 8,934 L\/h, started \d\d:\d\d\. No SenseHub pump or zone relay is ON, so the zone is unknown \(≈ one zone's flow\) and dosing is outside SenseHub control\.$/,
  });
  assert.match(start.tr, /^Manuel sulama algılandı \(pano\) — su 8,934 L\/h/);
  assert.match(start.tr, /\(≈ bir bölgenin debisi\)/);
  assert.match(start.ar, /^تم اكتشاف ري يدوي \(اللوحة\) — المياه 8,934 L\/h/);
  examples.panel_start = start;

  await sim.run({ from: 700.5, to: 800, flowAt: water, dosingAt: dose, activeAt: (rel) => rel < 760 });
  a = sim.alerts();
  const end = checkAlert(a[0], {
    key: 'flow_watch.end.manual_panel',
    enPattern: /^Manual irrigation \(panel\) ended: \d\d:\d\d–\d\d:\d\d, 12 min, 1,7\d\d L water, Tank A 9 L, Tank B 9 L, Tank C 9\.25 L, Tank D 5\.75 L \(1:\d{3}\)\.$/,
  });
  assert.match(end.tr, /^Manuel sulama \(pano\) sona erdi: \d\d:\d\d–\d\d:\d\d, 12 dk, 1,7\d\d L su, Tank A 9 L, Tank B 9 L, Tank C 9\.25 L, Tank D 5\.75 L \(1:\d{3}\)\.$/);
  assert.match(end.ar, /^انتهى الري اليدوي \(اللوحة\): \d\d:\d\d–\d\d:\d\d، 12 د، 1,7\d\d L مياه، Tank A 9 L، Tank B 9 L، Tank C 9\.25 L، Tank D 5\.75 L \(1:\d{3}\)\.$/);
  examples.panel_end = end;
  sim.dispose();
});

test('i18n: panel escalation (long run) — escalated fire text and end summary compose in tr/ar', async () => {
  const sim = H.panelSim({ manual_panel_max_minutes: 2 });
  const water = (rel) => (rel >= 10 && rel < 190 ? 8934 : 0);
  await sim.run({ from: 0, to: 240, flowAt: water, dosingAt: (rel) => (water(rel) ? H.PANEL_RATES : [0, 0, 0, 0]), activeAt: () => true });
  const a = sim.alerts();
  const r0 = checkAlert(a[0], { key: 'flow_watch.end.manual_panel', enPattern: /Escalated to caution: running 2 min/ });
  assert.match(r0.tr, /Dikkat seviyesine yükseltildi: 2 dk \d+ sn çalışıyor, 2 dk sınırından uzun\./);
  const r1 = checkAlert(a[1], { key: 'flow_watch.end.panel_attention', enPattern: /^Manual irrigation \(panel\) that needed attention ended at .*Escalated because running 2 min/ });
  assert.match(r1.ar, /سبب التصعيد: يعمل منذ 2 د/);
  sim.dispose();
});

test('i18n: Stop irrigation — alert stored English + key; service result carries keys; route answers in the request language', async () => {
  const base = Date.now();
  const sim = new H.Sim({ base, doseRunning: true, relays: { 1: true, 2: true, 3: true } });
  const r = await sim.svc.stopIrrigation({ userEmail: 'operator@farm.test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.message_key, 'irrigation_stop.message');
  assert.match(r.message, /^Irrigation stopped by operator@farm\.test at \d\d:\d\d — pumps, zones and dosing off; fans\/climate unaffected\. \(interrupted Irrigation Zone 1; dose cycle #85 aborted; OFF confirmed: Waveshare Irrigation 1 \(Irrigation Pump, Mixing Pump, Irrigation Zone 1, Irrigation Zone 2, Irrigation Zone 3, Irrigation Zone 4\); Waveshare Irrigation 2 \(Relay 1, Relay 2, Relay 3, Relay 4, Relay 5\)\.\)$/);
  assert.equal(r.untouched, 'fans, climate and every other board');
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(r.alert_id);
  const al = checkAlert(row, { key: 'irrigation_stop.message' });
  assert.match(al.tr, /^Sulama operator@farm\.test tarafından \d\d:\d\d saatinde durduruldu/);
  assert.match(al.ar, /^أوقف operator@farm\.test الري الساعة \d\d:\d\d/);
  examples.stop = al;

  const tr = localizeStopResult(r, 'tr');
  assert.equal(tr.message, al.tr);
  assert.equal(tr.message_en, r.message);
  assert.equal(tr.untouched, 'fanlar, iklimlendirme ve diğer tüm kartlar');

  // the route, over HTTP, with req.lang set the way the language middleware does
  const events = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, email: 'operator@farm.test', role: 'operator' }; req.lang = req.headers['accept-language'] || 'en'; next(); });
  app.use('/api/irrigation', createIrrigationStopRouter({ getService: () => sim.svc, broadcast: (t, d) => events.push({ t, d }) }));
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}/api/irrigation/stop`, { method: 'POST', headers: { 'Accept-Language': 'ar' } });
    const body = await resp.json();
    assert.equal(resp.status, 200);
    assert.match(body.message, /^أوقف operator@farm\.test الري/);
    assert.match(body.message_en, /^Irrigation stopped by operator@farm\.test/);
    assert.equal(body.message_key, 'irrigation_stop.message');
    assert.equal(body.untouched, 'المراوح والتحكم المناخي وجميع اللوحات الأخرى');
    await new Promise(res => setTimeout(res, 20));
    const ws = events.find(e => e.t === 'stop_irrigation_result');
    assert.ok(ws, 'broadcast');
    assert.match(ws.d.message, /^Irrigation stopped by/, 'broadcast keeps English message');
    assert.match(ws.d.message_i18n.tr, /^Sulama operator@farm\.test tarafından/);
    assert.match(ws.d.message_i18n.ar, /^أوقف operator@farm\.test الري/);
  } finally {
    server.close();
  }
  sim.dispose();
});

test('i18n: Stop irrigation OFF not confirmed — error localized, English error unchanged', async () => {
  const sim = new H.Sim({ base: Date.now(), doseRunning: false, relays: { 1: true, 3: true } });
  sim.act.failOff = 2; // first board's OFF write (and its one re-send) never confirms
  const r = await sim.svc.stopIrrigation({ userEmail: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /^OFF not confirmed on Irrigation Pump \(Waveshare Irrigation 1 relay 1\), .* — switch off at the panel\.$/);
  assert.match(r.message, /^Irrigation stopped by an operator at \d\d:\d\d — .* WARNING: OFF NOT CONFIRMED on Waveshare Irrigation 1 relay 1 \(Irrigation Pump\), .* — switch off at the panel NOW\.$/);
  const tr = localizeStopResult(r, 'tr');
  assert.match(tr.error, /^Irrigation Pump \(Waveshare Irrigation 1 röle 1\), .* üzerinde KAPATMA onaylanmadı — panodan kapatın\.$/);
  assert.match(tr.message, /^Sulama bir operatör tarafından/);
  const ar = localizeStopResult(r, 'ar');
  assert.match(ar.message, /^أوقف أحد المشغّلين الري/);
  assert.match(ar.message, /تحذير: الإيقاف غير مؤكَّد/);
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(r.alert_id);
  assert.equal(row.severity, 'critical');
  checkAlert(row, { key: 'irrigation_stop.message' });
  sim.dispose();
});

test('i18n: rule titles (Telegram) and relay-state reasons have tr/ar', () => {
  for (const k of ['valve_no_flow', 'low_flow', 'flow_above_expected', 'dosing_without_water', 'water_without_valve', 'flow_after_pump_off', 'monitor_blind', 'manual_panel', 'pump_no_flow_shutdown']) {
    const key = `flow_watch.title.${k}`;
    assert.equal(i18n.t('en', key), src('services', 'IrrigationFlowWatchService.js').RULES[k].title, 'English title = RULES title');
    assert.notEqual(i18n.t('tr', key), i18n.t('en', key));
    assert.notEqual(i18n.t('ar', key), i18n.t('en', key));
  }
  assert.equal(i18n.render('ar', i18n.M('flow_watch.title.resolved', { title: i18n.M('flow_watch.title.valve_no_flow') })), 'الري: لا يوجد تدفق للمياه — تم الحل');
});

test('i18n: print the rendered examples (report)', () => {
  for (const [name, r] of Object.entries(examples)) {
    for (const lang of ['en', 'tr', 'ar']) console.log(`[example] ${name} ${lang}: ${r[lang]}`);
  }
  assert.ok(examples.shutdown && examples.panel_end && examples.dosing_fire);
});
