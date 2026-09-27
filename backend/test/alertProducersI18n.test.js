/**
 * i18n of the alert producers outside the flow watch / dose controller:
 * watchdog (connectivity, restart, missed automations, equipment offline /
 * recovered + Telegram), relay safety force-OFF, relay read-back, interlock,
 * automation executor / scheduler, agronomist provider alert, MQTT error
 * flags, AMIC scheduled calibration, camera reachability.
 *
 * For each: the stored `message` is the exact English the producer wrote
 * before i18n (fingerprints / filters unchanged), `message_key` is stored,
 * and tr / ar renders are real translations with no leftover {placeholders}.
 * No Modbus / network / Telegram I/O: every client is stubbed.
 */
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const { db } = require('../src/utils/database');
const i18n = require('../src/i18n');
const { localizeAlert } = require('../src/utils/alertBroadcast');
const { formatTelegramAlert, telegramService } = require('../src/services/TelegramService');

global.broadcast = () => {};

const lastAlert = () => db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 1').get();
const alertByFp = (fp) => db.prepare('SELECT * FROM alerts WHERE fingerprint = ? ORDER BY id DESC LIMIT 1').get(fp);

/** tr / ar renders: translated, no placeholder left, Western digits only. */
function assertLocalized(row) {
  assert.ok(row && row.message_key, 'message_key stored');
  for (const lang of ['tr', 'ar']) {
    const out = localizeAlert(row, lang).message;
    assert.ok(out && out !== row.message, `${lang} render differs from English: ${out}`);
    assert.doesNotMatch(out, /\{[a-z_]+\}/, `${lang} leftover placeholder: ${out}`);
    assert.doesNotMatch(out, /[٠-٩۰-۹]/, `${lang} non-Western digits: ${out}`);
  }
  assert.strictEqual(localizeAlert(row, 'en').message, row.message);
}

function eqRow(name, extra = {}) {
  const info = db.prepare(
    'INSERT INTO equipment (name, protocol, address, status, enabled, last_communication, register_mappings) VALUES (?, ?, ?, ?, 1, ?, ?)'
  ).run(name, 'modbus', extra.address || 'bad-address', extra.status || 'online', extra.last_communication || null, extra.register_mappings || '[]');
  return Number(info.lastInsertRowid);
}

// ─── watchdog ────────────────────────────────────────────────────────────────

const { watchdogService } = require('../src/services/WatchdogService');

test('watchdog: _durationSpec renders exactly like _formatDuration in English', () => {
  for (const ms of [0, 999, 45000, 59999, 60000, 125000, 3599000, 3600000, 7_500_000, 86_399_000, 86_400_000, 300_000_000]) {
    assert.strictEqual(i18n.render('en', watchdogService._durationSpec(ms)), watchdogService._formatDuration(ms), `ms=${ms}`);
  }
  assert.strictEqual(i18n.render('tr', watchdogService._durationSpec(7_500_000)), '2 sa 5 dk');
  assert.strictEqual(i18n.render('ar', watchdogService._durationSpec(45000)), '45 ث');
});

test('watchdog: missed-schedule detail specs render the exact English detail', () => {
  const now = new Date();
  const lastRun = new Date(now.getTime() - 3 * 86_400_000);
  const cases = [
    { type: 'schedule', schedule_type: 'daily', time: '00:00' },
    { type: 'schedule', schedule_type: 'weekly', time: '00:00', day_of_week: String(now.getDay()) },
    { type: 'schedule', schedule_type: 'hourly', minute: '0' },
  ];
  let checked = 0;
  for (const cfg of cases) {
    for (const lr of [lastRun, null]) {
      const r = watchdogService._isScheduleMissed(cfg, lr, 0, new Date(now.getTime() + 1000));
      if (!r.missed) continue; // e.g. exactly on the minute
      checked++;
      assert.strictEqual(i18n.render('en', r.detailSpec), r.detail);
      for (const lang of ['tr', 'ar']) {
        const out = i18n.render(lang, r.detailSpec);
        assert.notStrictEqual(out, r.detail);
        assert.doesNotMatch(out, /\{[a-z_]+\}/);
      }
    }
  }
  assert.ok(checked >= 4, `checked ${checked}`);
});

test('watchdog: connectivity down / up alerts keep the "Watchdog: " English text', async () => {
  const orig = { isConfigured: telegramService.isConfigured };
  telegramService.isConfigured = () => false;
  try {
    watchdogService._connState.mcp = { up: true, downSince: null };
    await watchdogService._handleConnTransition('mcp', false);
    const down = alertByFp('connectivity_down:mcp');
    assert.strictEqual(down.message, 'Watchdog: mcp went offline');
    assert.strictEqual(down.message_key, 'watchdog.conn_down_alert');
    assertLocalized(down);

    watchdogService._connState.mcp.downSince = new Date(Date.now() - 125000).toISOString();
    await watchdogService._handleConnTransition('mcp', true);
    const up = alertByFp('connectivity_up:mcp');
    const ev = db.prepare("SELECT message FROM watchdog_events WHERE target = 'mcp' AND status = 'up' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(up.message, `Watchdog: ${ev.message}`);
    assert.match(up.message, /^Watchdog: mcp back online \(was down 2m\)$/);
    assertLocalized(up);
    assert.match(localizeAlert(up, 'tr').message, /2 dk/);
  } finally {
    telegramService.isConfigured = orig.isConfigured;
  }
});

test('watchdog: restart gap alert', () => {
  db.prepare("INSERT INTO watchdog_events (event_type, target, status, message, created_at) VALUES ('system', 'x', 'x', 'x', datetime('now', '-3 hours'))").run();
  // make it the newest event
  db.prepare("DELETE FROM watchdog_events WHERE created_at > datetime('now', '-3 hours', '+1 second')").run();
  watchdogService._pendingNotifications = [];
  watchdogService._detectRestartGap();
  const row = alertByFp('system_restart');
  const ev = db.prepare("SELECT message FROM watchdog_events WHERE event_type = 'system' AND status = 'restart' ORDER BY id DESC LIMIT 1").get();
  assert.strictEqual(row.message, `Watchdog: ${ev.message}`);
  assert.match(row.message, /^Watchdog: System restarted after 3h 0m gap/);
  assertLocalized(row);
  const q = watchdogService._pendingNotifications.find(n => n.title === 'System Restart Detected');
  assert.ok(q && q.titleSpec && q.detailSpec, 'queued notification carries i18n specs');
  assert.strictEqual(i18n.render('en', q.detailSpec), q.detail);
  watchdogService._pendingNotifications = [];
});

test('watchdog: equipment offline → alert + Telegram per language; recovery', async () => {
  const sent = [];
  const orig = { sendAlert: telegramService.sendAlert };
  telegramService.sendAlert = async (title, detail, severity) => { sent.push({ title, detail, severity }); };
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000 - 30_000).toISOString().replace('T', ' ').slice(0, 19);
    const id = eqRow('Fan board 3', { status: 'offline', last_communication: twoHoursAgo });
    await watchdogService._checkEquipmentHealth();
    const row = alertByFp(`equipment_offline:${id}`);
    const ev = db.prepare("SELECT message, detail FROM watchdog_events WHERE target = 'Fan board 3' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(row.message, `Watchdog: ${ev.detail}`);
    assert.strictEqual(row.message, 'Watchdog: Equipment "Fan board 3" is offline. Last communication: 2h 0m ago.');
    assert.strictEqual(row.message_key, 'watchdog.equipment_alert');
    assertLocalized(row);

    // Telegram: specs; English identical to the old strings, tr / ar translated
    const tg = sent.find(s => i18n.render('en', s.title) === 'Equipment Offline: Fan board 3');
    assert.ok(tg, 'telegram sent with i18n title');
    assert.strictEqual(i18n.render('en', tg.detail), ev.detail);
    const at = new Date('2026-09-27T10:00:00Z');
    const tgOpts = { title: tg.title, details: tg.detail, severity: tg.severity, tz: 'Asia/Dubai', at };
    const en = formatTelegramAlert({ ...tgOpts, lang: 'en' });
    const tr = formatTelegramAlert({ ...tgOpts, lang: 'tr' });
    const ar = formatTelegramAlert({ ...tgOpts, lang: 'ar' });
    assert.match(en, /Equipment "Fan board 3" is offline\. Last communication: 2h 0m ago\./);
    assert.match(en, /Equipment Offline: Fan board 3/);
    assert.match(tr, /Ekipman Çevrimdışı: Fan board 3/);
    assert.match(tr, /2 sa 0 dk önce/);
    assert.match(ar, /المعدّة غير متصلة: Fan board 3/);
    assert.match(ar, /14:00:00/); // Western digits, 24 h, Asia/Dubai
    for (const s of [tr, ar]) assert.doesNotMatch(s, /\{[a-z_]+\}|[٠-٩]/);

    // recovery
    db.prepare("UPDATE equipment SET status = 'online' WHERE id = ?").run(id);
    await watchdogService._checkEquipmentHealth();
    const rec = alertByFp(`equipment_recovered:${id}`);
    assert.match(rec.message, /^Watchdog: Equipment "Fan board 3" is back online \(alerted \d+s ago\)\.$/);
    assertLocalized(rec);

    // a failed send queues the English strings + the specs
    telegramService.sendAlert = async () => { throw new Error('offline'); };
    watchdogService._pendingNotifications = [];
    const id2 = eqRow('Dosing board', { status: 'error', last_communication: twoHoursAgo });
    db.prepare("UPDATE equipment SET error_log = 'timeout' WHERE id = ?").run(id2);
    await watchdogService._checkEquipmentHealth();
    const err = alertByFp(`equipment_offline:${id2}`);
    assert.strictEqual(err.message, 'Watchdog: Equipment "Dosing board" has errors. Last communication: 2h 0m ago.\nError: timeout');
    assertLocalized(err);
    const q = watchdogService._pendingNotifications.find(n => n.title === 'Equipment Error: Dosing board');
    assert.ok(q && q.titleSpec && q.detailSpec);
    assert.strictEqual(i18n.render('en', q.detailSpec), q.detail);
    watchdogService._pendingNotifications = [];
  } finally {
    telegramService.sendAlert = orig.sendAlert;
  }
});

test('watchdog: missed-automation alert message (title + detail specs)', async () => {
  const sent = [];
  const orig = { sendAlert: telegramService.sendAlert };
  telegramService.sendAlert = async (title, detail) => { sent.push({ title, detail }); };
  try {
    const info = db.prepare("INSERT INTO automations (name, enabled, trigger_config, actions) VALUES ('Irrigation 06:00', 1, ?, '[]')")
      .run(JSON.stringify({ type: 'schedule', schedule_type: 'hourly', minute: '0' }));
    const aid = Number(info.lastInsertRowid);
    db.prepare("UPDATE automations SET last_run = datetime('now', '-5 hours') WHERE id = ?").run(aid);
    await watchdogService._checkMissedAutomations();
    const row = alertByFp(`watchdog_missed:${aid}`);
    if (!row) return; // within the grace window of this hour's slot — nothing to assert
    assert.match(row.message, /^Watchdog: Automation Missed: Irrigation 06:00 - Hourly automation \(at :00\) has not fired this hour\. Last run: \S+Z$/);
    assert.strictEqual(row.message_key, 'watchdog.automation_alert');
    assertLocalized(row);
    const tg = sent.find(s => i18n.render('en', s.title) === 'Automation Missed: Irrigation 06:00');
    assert.ok(tg);
    assert.match(i18n.render('tr', tg.title), /Otomasyon Kaçırıldı/);
  } finally {
    telegramService.sendAlert = orig.sendAlert;
  }
});

// ─── relay safety / read-back / interlock ───────────────────────────────────

test('relay safety force-OFF alert (stubbed Modbus client)', async () => {
  const { relaySafetyWatchdogService } = require('../src/services/RelaySafetyWatchdogService');
  const { modbusTcpClient } = require('../src/services/ModbusTcpClient');
  const orig = modbusTcpClient.writeSingleCoilFireAndForget;
  const writes = [];
  modbusTcpClient.writeSingleCoilFireAndForget = async (...a) => { writes.push(a); };
  try {
    const eqId = eqRow('Fan relay 5', { address: '10.255.255.1:502' });
    await relaySafetyWatchdogService._forceOff({
      equipment_id: eqId, channel: 3, equipment_name: 'Fan relay 5', equipment_address: '10.255.255.1:502', slave_id: 5,
      write_only: true, on_time: '2026-09-27 08:00:00', auto_name: 'Climate cooling', on_auto_id: 84,
    }, 3700, 3600, 'action_duration', 1800);
    assert.strictEqual(writes.length, 1); // stub only
    const row = alertByFp(`relay_force_off:${eqId}:3`);
    assert.strictEqual(row.message,
      '[Safety] Force-OFF Fan relay 5 ch 3: Channel was ON for 3700s (threshold 3600s, expected 1800s + grace). Originally turned ON at 2026-09-27 08:00:00 by automation #84 "Climate cooling". Watchdog force-OFF complete.');
    assertLocalized(row);

    await relaySafetyWatchdogService._forceOff({
      equipment_id: eqId, channel: 4, equipment_name: 'Fan relay 5', equipment_address: '10.255.255.1:502', slave_id: 5,
      write_only: true, on_time: '2026-09-27 08:00:00', auto_name: null, on_auto_id: null,
    }, 7300, 7200);
    const row2 = alertByFp(`relay_force_off:${eqId}:4`);
    assert.strictEqual(row2.message,
      '[Safety] Force-OFF Fan relay 5 ch 4: Channel was ON for 7300s (threshold 7200s, global default). Originally turned ON at 2026-09-27 08:00:00. Watchdog force-OFF complete.');
    assertLocalized(row2);
  } finally {
    modbusTcpClient.writeSingleCoilFireAndForget = orig;
  }
});

test('relay read-back: write not confirmed alert', () => {
  const { reportUnconfirmed } = require('../src/services/RelayReadback');
  const warn = console.warn; console.warn = () => {};
  try {
    const eqId = eqRow('Irrigation board');
    reportUnconfirmed({ id: eqId, name: 'Irrigation board' }, 2, false, true, { source: 'manual' });
    const row = alertByFp(`relay_unconfirmed:${eqId}:2`);
    assert.strictEqual(row.message, 'Irrigation board ch 2: relay write not confirmed — requested OFF, hardware reads ON');
    assertLocalized(row);
    assert.match(localizeAlert(row, 'tr').message, /istenen KAPALI, donanımdan okunan AÇIK/);
    reportUnconfirmed({ id: eqId, name: 'Irrigation board' }, 3, true, null);
    assert.strictEqual(alertByFp(`relay_unconfirmed:${eqId}:3`).message, 'Irrigation board ch 3: relay write not confirmed — requested ON, hardware reads unknown');
  } finally { console.warn = warn; }
});

test('interlock: violation + hardware conflict alerts', async () => {
  const interlock = require('../src/services/RelayInterlockService');
  const err = console.error; console.error = () => {};
  try {
    const eqId = eqRow('Shade board');
    interlock.reportViolation({ id: eqId, name: 'Shade board' }, 1, new Error('ch 1 "Open" is interlocked with ch 2 "Close" which is ON'), { source: 'manual' });
    const v = alertByFp(`interlock:${eqId}:1`);
    assert.strictEqual(v.message, '[Interlock] Shade board ch 1 [manual]: ch 1 "Open" is interlocked with ch 2 "Close" which is ON');
    assertLocalized(v);

    const mappings = JSON.stringify([
      { type: 'coil', access: 'readwrite', register: 1, label: 'Open', interlockWith: 2 },
      { type: 'coil', access: 'readwrite', register: 2, label: 'Close' },
    ]);
    const cid = eqRow('Shade board 2', { register_mappings: mappings, address: 'invalid' });
    const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(cid);
    const stub = { writeSingleCoil: async () => { throw new Error('must not be called'); }, readCoils: async () => [true] };
    await interlock.resolveHardwareConflict(row, { 1: true, 2: true }, stub);
    const c = alertByFp(`interlock_conflict:${cid}:1`);
    assert.strictEqual(c.message, '[Interlock] HARDWARE CONFLICT on Shade board 2: "Open" (ch 1) and "Close" (ch 2) were both ON. Forced OFF; verified: none — CHECK HARDWARE.');
    assertLocalized(c);
  } finally { console.error = err; }
});

// ─── automation executor / scheduler / agronomist / mqtt / amic / camera ────

test('automation executor: default alert text is a key; a user-written alert text is stored as typed', async () => {
  const { executeAutomation } = require('../src/services/AutomationExecutor');
  const info = db.prepare("INSERT INTO automations (name, enabled, trigger_config, actions) VALUES ('Alert only', 1, '{\"type\":\"manual\"}', '[]')").run();
  const aid = Number(info.lastInsertRowid);
  await executeAutomation({ id: aid, name: 'Alert only', actions: [{ type: 'alert', severity: 'warning' }] }, 'test');
  const d = db.prepare("SELECT * FROM alerts WHERE automation_id = ? AND source = 'automation' ORDER BY id DESC LIMIT 1").get(aid);
  assert.strictEqual(d.message, 'Automation triggered');
  assertLocalized(d);
  await executeAutomation({ id: aid, name: 'Alert only', actions: [{ type: 'alert', severity: 'warning', message: 'Check the drain tank' }] }, 'test');
  const u = lastAlert();
  assert.strictEqual(u.message, 'Check the drain tank');
  assert.strictEqual(u.message_key, null);
  assert.strictEqual(localizeAlert(u, 'ar').message, 'Check the drain tank');
});

test('automation scheduler: consecutive-skips alert text (plural per language)', () => {
  const { createAlert } = require('../src/utils/alertBroadcast');
  // same options as AutomationSchedulerService's consecutive-skip alert
  for (const n of [3, 6, 12]) {
    const row = createAlert({ severity: n >= 12 ? 'critical' : 'warning', source: 'scheduler', automation_id: 7,
      fingerprint: 'automation_consecutive_skips:7', messageKey: 'automation.consecutive_skips', messageParams: { name: 'Pads', id: '7', count: n } });
    assert.strictEqual(row.message, `Automation "Pads" (id=7) has skipped ${n} consecutive times. Verify the sensor reading driving the skip is correct.`);
    assertLocalized(row);
  }
  const ar = (n) => i18n.t('ar', 'automation.consecutive_skips', { name: 'Pads', id: '7', count: n });
  assert.match(ar(3), /3 مرات/);   // few
  assert.match(ar(12), /12 مرة/);  // many
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/AutomationSchedulerService.js'), 'utf8');
  assert.match(src, /messageKey: 'automation\.consecutive_skips'/);
});

test('agronomist scheduler: provider (billing) alert', () => {
  const { agronomistSchedulerService } = require('../src/services/AgronomistSchedulerService');
  agronomistSchedulerService._raiseProviderAlert({ lastErrorClass: 'billing', paused: true, consecutiveFailures: 3, lastErrorMessage: 'Your credit balance is too low' });
  const row = lastAlert();
  assert.strictEqual(row.source, 'agronomist');
  assert.strictEqual(row.message, '[Agronomist] Anthropic credit balance exhausted — 3 consecutive failed report(s); scheduled runs paused until settings are saved or Retry now succeeds. Last error: Your credit balance is too low');
  assertLocalized(row);
  agronomistSchedulerService._raiseProviderAlert({ lastErrorClass: 'refusal', paused: false, consecutiveFailures: 1, lastErrorMessage: '' });
  // createAlert trims, as it always did
  assert.strictEqual(lastAlert().message, '[Agronomist] Report declined by the model — 1 consecutive failed report(s). Last error:');
});

test('mqtt: flow meter error_flags alert', () => {
  const { MqttIngestService } = require('../src/services/MqttIngestService');
  const { createAlert } = require('../src/utils/alertBroadcast');
  const eqId = eqRow('Irrigation monitor');
  const fake = { stmts: { setErrorFlags: { run() {} } }, log: { warn() {}, log() {} }, createAlert };
  MqttIngestService.prototype._onErrorFlags.call(fake, { name: 'Irrigation monitor', equipmentId: eqId, farmId: '1021', lastAlertedErrorFlags: 0 }, 12);
  const row = alertByFp(`mqtt_error_flags:${eqId}:12`);
  assert.strictEqual(row.message, 'Irrigation monitor: flow meter reports error_flags=12 (0xC). Flow readings may be unreliable until it clears.');
  assertLocalized(row);
});

test('amic scheduler: scheduled calibration triggered / failed (stubbed AMIC)', async () => {
  const { amicSchedulerService } = require('../src/services/AmicSchedulerService');
  const { amicService } = require('../src/services/AmicService');
  // AmicService starts a 15 s background sampler at require time; stop it so it never ticks
  // (it would find no cycle and do nothing) and the test process can exit.
  clearInterval(amicService._samplerTimer);
  const orig = { getSchedule: amicService.getSchedule, cur: amicService._getCurrentCycle, trig: amicService.triggerCalibrate, save: amicService.saveSchedule };
  const now = new Date(Date.now() - 60_000);
  const slot = () => ({ enabled: true, hour: now.getHours(), minute: now.getMinutes(), label: 'morning' });
  const hm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  let sched = { enabled: true, times: [slot()] };
  amicService.getSchedule = () => sched;
  amicService._getCurrentCycle = () => null;
  amicService.saveSchedule = () => {};
  const log = console.log; const errLog = console.error; console.log = () => {}; console.error = () => {};
  try {
    amicService.triggerCalibrate = async () => ({ ok: true });
    await amicSchedulerService._tick();
    const ok = db.prepare("SELECT * FROM alerts WHERE source = 'amic' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(ok.message, `[AMIC] Scheduled Calibration triggered at ${hm} (morning)`);
    assertLocalized(ok);

    sched = { enabled: true, times: [slot()] };
    amicService.triggerCalibrate = async () => { throw new Error('Modbus timeout'); };
    await amicSchedulerService._tick();
    const bad = alertByFp(`amic_scheduled_calibrate_failed:${now.getHours()}:${now.getMinutes()}`);
    assert.strictEqual(bad.message, `[AMIC] Scheduled Calibration FAILED to trigger at ${hm}: Modbus timeout`);
    assertLocalized(bad);
  } finally {
    Object.assign(amicService, { getSchedule: orig.getSchedule, _getCurrentCycle: orig.cur, triggerCalibrate: orig.trig, saveSchedule: orig.save });
    console.log = log; console.error = errLog;
  }
});

test('camera: unreachable / reachable again (localhost probes only)', async () => {
  const { cameraStreamService } = require('../src/services/CameraStreamService');
  const warn = console.warn; const log = console.log; console.warn = () => {}; console.log = () => {};
  const server = net.createServer(s => s.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const openPort = server.address().port;
  try {
    const info = db.prepare("INSERT INTO cameras (name, stream_url, go2rtc_name, ip_address, rtsp_port, status) VALUES ('Canopy PTZ', 'rtsp://x', 'i18n_test_cam', '127.0.0.1', 1, 'online')").run();
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(Number(info.lastInsertRowid));
    await cameraStreamService.probeCamera(cam); // port 1 on localhost: refused
    const down = alertByFp(`camera_unreachable:${cam.id}`);
    assert.match(down.message, /^Camera "Canopy PTZ" \(127\.0\.0\.1\) unreachable since \S+ — check power\/network; if it uses DHCP its IP may have changed \(set a DHCP reservation\)$/);
    assertLocalized(down);
    const cam2 = { ...db.prepare('SELECT * FROM cameras WHERE id = ?').get(cam.id), rtsp_port: openPort };
    await cameraStreamService.probeCamera(cam2);
    const up = alertByFp(`camera_recovered:${cam.id}`);
    assert.match(up.message, /^Camera "Canopy PTZ" \(127\.0\.0\.1\) is reachable again \(unreachable since \S+\)$/);
    assertLocalized(up);
  } finally {
    server.close();
    console.warn = warn; console.log = log;
  }
});
