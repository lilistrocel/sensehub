// Stop irrigation (requirement 2026-09-27): stops ONLY the irrigation side.
// Operators used Stop All to end irrigation runs; it switched the 7 fan boards off at
// ~35 °C (2026-09-26 09:43 and 15:39, 2026-09-27 14:15:54 and 14:16:55).
//
// Real IrrigationFlowWatchService + its real actuator (executor confirmed writes,
// RelayStateCache, RelayEventLogger) + the real RelayTimerService, over an
// in-memory DB. Modbus is stubbed with a coil model per board — nothing here can
// reach a gateway.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { createAlert, updateOpenAlert } = src('utils', 'alertBroadcast.js');
const { IrrigationFlowWatchService } = src('services', 'IrrigationFlowWatchService.js');
const { relayTimerService } = src('services', 'RelayTimerService.js');
const { automationArmingService } = src('services', 'AutomationArmingService.js');
const { modbusTcpClient } = src('services', 'ModbusTcpClient.js');
const { FertigationDoseScheduler } = src('services', 'FertigationDoseScheduler.js');
const { createIrrigationStopRouter } = src('routes', 'irrigationStop.js');

{ // fresh-DB quirk (see flowWatch.test.js): re-add the read-back columns
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const quiet = { log() {}, warn() {}, error() {} };
const USER = 'operator@farm.test';
const coil = (register, label) => ({ register: String(register), label, type: 'coil', access: 'readwrite' });
const IRR_MAP = [coil(1, 'Irrigation Pump'), coil(2, 'Mixing Pump'), coil(3, 'Irrigation Zone 1'), coil(4, 'Irrigation Zone 2'), coil(5, 'Irrigation Zone 3'), coil(6, 'Irrigation Zone 4')];
const DOS_MAP = [coil(1, 'pH Down (Tank 5)'), coil(2, 'Tank A — Calcium nitrate'), coil(3, 'Tank B — Mg + MKP + K2SO4'), coil(4, 'Tank C — Potassium nitrate'), coil(5, 'Tank D — Fe EDDHA + Fetrilon'), coil(6, 'Relay 6')];
const FAN_MAP = [1, 2, 3, 4, 5, 6].map(ch => coil(ch, `Fan ${ch}`));

// ─── Modbus coil model ──────────────────────────────────────────────────────
const bus = {
  coils: new Map(),   // `${host}:${unit}` -> { [ch]: bool }
  stuck: new Map(),   // `${host}:${unit}:${ch}` -> value it always reads
  dead: new Set(),    // `${host}:${unit}` -> every request times out
  writes: [],         // { host, unit, start, values, fc }
  beforeWrite: null,  // async hook (w) => void
};
const bkey = (host, unit) => `${host}:${unit}`;
const boardCoils = (host, unit) => { const k = bkey(host, unit); if (!bus.coils.has(k)) bus.coils.set(k, {}); return bus.coils.get(k); };
const orig = { wm: modbusTcpClient.writeMultipleCoils, ws: modbusTcpClient.writeSingleCoil, rc: modbusTcpClient.readCoils };
async function doWrite(host, unit, start, values, fc) {
  const w = { host, unit, start, values: [...values], fc };
  bus.writes.push(w);
  if (bus.beforeWrite) await bus.beforeWrite(w);
  if (bus.dead.has(bkey(host, unit))) throw new Error('Timed out');
  const st = boardCoils(host, unit);
  values.forEach((v, i) => { st[start + i] = !!v; });
}
modbusTcpClient.writeMultipleCoils = async (host, port, unit, start, values) => doWrite(host, unit, start, values, 15);
modbusTcpClient.writeSingleCoil = async (host, port, unit, ch, v) => doWrite(host, unit, ch, [v], 5);
modbusTcpClient.readCoils = async (host, port, unit, start, qty) => {
  if (bus.dead.has(bkey(host, unit))) throw new Error('Timed out');
  const st = boardCoils(host, unit);
  return Array.from({ length: qty }, (_, i) => {
    const s = bus.stuck.get(`${host}:${unit}:${start + i}`);
    return s !== undefined ? s : !!st[start + i];
  });
};
test.after(() => {
  modbusTcpClient.writeMultipleCoils = orig.wm;
  modbusTcpClient.writeSingleCoil = orig.ws;
  modbusTcpClient.readCoils = orig.rc;
  relayTimerService.shutdown();
});

// ─── plant ──────────────────────────────────────────────────────────────────
const IRR = { host: '192.0.2.7', unit: 6 };
const DOS = { host: '192.0.2.7', unit: 2 };
const FAN = { host: '192.0.2.202', unit: 15 };
const insEq = db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings, last_reading, last_communication) VALUES (?, 'relay', 'modbus', ?, ?, 'online', ?, ?, datetime('now'))");
const noop = async () => {};

let plantN = 0;
function makePlant({ running = true } = {}) {
  plantN++;
  // unique unit ids per plant so boards never share coil state across tests
  const irrUnit = IRR.unit + plantN * 10; const dosUnit = DOS.unit + plantN * 10; const fanUnit = FAN.unit + plantN * 10;
  const onStates = running ? { 1: true, 2: true, 3: true, 4: false, 5: false, 6: false } : { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
  const irr = Number(insEq.run(`Waveshare Irrigation 1 #${plantN}`, `${IRR.host}:502`, irrUnit, JSON.stringify(IRR_MAP), JSON.stringify({ relayStates: onStates })).lastInsertRowid);
  const dos = Number(insEq.run(`Waveshare Irrigation 2 #${plantN}`, `${DOS.host}:502`, dosUnit, JSON.stringify(DOS_MAP), JSON.stringify({ relayStates: running ? { 1: false, 2: true, 3: true, 4: false, 5: true, 6: false } : {} })).lastInsertRowid);
  const fan = Number(insEq.run(`Fan Board 15 #${plantN}`, `${FAN.host}:502`, fanUnit, JSON.stringify(FAN_MAP), JSON.stringify({ relayStates: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true } })).lastInsertRowid);
  const irrC = boardCoils(IRR.host, irrUnit); Object.assign(irrC, onStates);
  const dosC = boardCoils(DOS.host, dosUnit); if (running) Object.assign(dosC, { 2: true, 3: true, 5: true });
  const fanC = boardCoils(FAN.host, fanUnit); Object.assign(fanC, { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });

  const autoId = Number(db.prepare("INSERT INTO automations (name, enabled, actions) VALUES (?, 1, '[]')").run(`Daily 15:30 soft-switch #${plantN}`).lastInsertRowid);
  const fanAuto = Number(db.prepare("INSERT INTO automations (name, enabled, actions) VALUES (?, 1, '[]')").run(`Fans day #${plantN}`).lastInsertRowid);
  if (running) {
    for (const ch of [1, 2, 3]) db.prepare("INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, created_at) VALUES (?, ?, 1, 'automation', ?, 1, datetime('now', '-60 seconds'))").run(irr, ch, autoId);
  }

  // Soft-switch run (automation 97 shape): zone 1 open now; zones 2-4 + their pump windows pending; auto-offs.
  const timers = [];
  if (running) {
    relayTimerService.scheduleOff(irr, 1, 240, noop, { automationId: autoId });
    relayTimerService.scheduleOff(irr, 2, 240, noop, { automationId: autoId });
    relayTimerService.scheduleOff(irr, 3, 245, noop, { automationId: autoId });
    for (const [i, ch] of [[4, 4], [7, 5], [10, 6]].map(([idx, c]) => [idx, c])) {
      relayTimerService.scheduleDelayedStart(irr, ch, 270 * (ch - 3), noop, { automationId: autoId, checkEnabled: true, actionKey: `a${autoId}:${i}` });
      relayTimerService.scheduleDelayedStart(irr, 1, 270 * (ch - 3) + 3, noop, { automationId: autoId, checkEnabled: true, actionKey: `a${autoId}:${i + 1}` });
    }
  }
  // Fan board: timers owned by the fan automation AND by the irrigation automation — none may be touched.
  relayTimerService.scheduleDelayedStart(fan, 3, 600, noop, { automationId: fanAuto, checkEnabled: true });
  relayTimerService.scheduleOff(fan, 2, 900, noop, { automationId: fanAuto });
  relayTimerService.scheduleDelayedStart(fan, 4, 600, noop, { automationId: autoId, checkEnabled: true, actionKey: `a${autoId}:99` });
  relayTimerService.scheduleDelayedRaw(`transition_delay:${fan}:${fanAuto}:0`, 600, noop, { automationId: fanAuto, checkEnabled: true });

  const dose = new FertigationDoseScheduler();
  const controllerEnds = [];
  let logId = null;
  if (running) {
    logId = Number(db.prepare("INSERT INTO fertigation_dose_cycle_log (status, cycle_started_at) VALUES ('running', datetime('now'))").run().lastInsertRowid);
    dose._active = {
      programId: 7, automationId: autoId, cycleLogId: logId, startedAt: Date.now(), endsAt: Date.now() + 1000000, timers: [], valveStates: {}, dryRun: false,
      schedule: { tanks: [2, 3, 4, 5].map((ch, i) => ({ tank_id: i + 1, tank_name: `Tank ${'ABCD'[i]}`, equipment_id: dos, channel: ch })) },
      extraTargets: [{ tank_id: 5, tank_name: 'pH Down', equipment_id: dos, channel: 1 }],
      controller: { async endCycle(info) { controllerEnds.push(info); return null; } },
    };
  }

  const notifications = [];
  const svc = new IrrigationFlowWatchService({
    db, createAlert, updateOpenAlert, logger: quiet, doseScheduler: dose,
    notify: async (title, text, severity) => { notifications.push({ title, text, severity }); },
    setTimer: () => null,
    config: { irrigation_equipment_id: irr, dosing_equipment_id: dos },
  });
  const units = { irr: irrUnit, dos: dosUnit, fan: fanUnit };
  const cleanup = () => {
    relayTimerService.cancelTimersForEquipment([irr, dos, fan]);
    bus.beforeWrite = null;
  };
  return { irr, dos, fan, autoId, fanAuto, svc, dose, logId, controllerEnds, notifications, units, irrC, dosC, fanC, timers, cleanup };
}

const writesTo = (unit, host) => bus.writes.filter(w => w.unit === unit && (!host || w.host === host));
const timersOn = (eq) => relayTimerService.getActiveTimers().filter(t => Number((/^[a-z_]+:(\d+):/.exec(t.key) || [])[1]) === eq);

// ─── tests ──────────────────────────────────────────────────────────────────

test('stop during a soft-switch run: later zone starts cancelled, eq1 ch1-6 + eq2 ch1-5 OFF confirmed (FC15 + read-back), dose cycle aborted, fan board untouched, run marked, one info alert', async () => {
  const p = makePlant();
  const fanTimersBefore = timersOn(p.fan).map(t => t.key).sort();
  assert.equal(fanTimersBefore.length, 4);
  // (RelayTimerService drops ch1's auto-off when a delayed pump start is armed on ch1, as in a live soft-switch run)
  const irrBefore = timersOn(p.irr);
  assert.equal(irrBefore.filter(t => t.type === 'delay').length, 6);
  const r = await p.svc.stopIrrigation({ userEmail: USER });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.error, null);
  assert.deepEqual(r.channels.map(c => [c.equipment_id, c.channel, c.confirmed]),
    [[p.irr, 1, true], [p.irr, 2, true], [p.irr, 3, true], [p.irr, 4, true], [p.irr, 5, true], [p.irr, 6, true],
      [p.dos, 1, true], [p.dos, 2, true], [p.dos, 3, true], [p.dos, 4, true], [p.dos, 5, true]]);
  assert.equal(r.channels[0].name, 'Irrigation Pump');
  assert.equal(r.channels[10].name, 'Tank D — Fe EDDHA + Fetrilon');
  // hardware: everything irrigation OFF; dosing relay 6 not written; fans still ON and never written
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ch => p.irrC[ch]), [false, false, false, false, false, false]);
  assert.deepEqual([1, 2, 3, 4, 5].map(ch => p.dosC[ch]), [false, false, false, false, false]);
  assert.equal(writesTo(p.units.fan).length, 0, 'no Modbus write to the fan board');
  assert.ok(writesTo(p.units.irr).some(w => w.fc === 15 && w.start === 1 && w.values.length === 6 && w.values.every(v => v === false)), 'one FC15 for ch1-6');
  assert.ok(writesTo(p.units.dos).some(w => w.fc === 15 && w.start === 1 && w.values.length === 5), 'one FC15 for dosing ch1-5');
  assert.ok(!writesTo(p.units.dos).some(w => w.start <= 6 && w.start + w.values.length - 1 >= 6 && w.fc === 15 && w.start + w.values.length > 6), 'dosing relay 6 not in the FC15');
  // timers: none left on the irrigation/dosing boards; fan timers (incl. the irrigation automation's own) untouched
  assert.deepEqual(timersOn(p.irr), []);
  assert.deepEqual(timersOn(p.dos), []);
  assert.deepEqual(timersOn(p.fan).map(t => t.key).sort(), fanTimersBefore);
  assert.deepEqual(r.zones_interrupted, ['Irrigation Zone 1']);
  assert.deepEqual(r.zones_not_started, ['Irrigation Zone 2', 'Irrigation Zone 3', 'Irrigation Zone 4']);
  assert.equal(r.timers_cancelled.filter(t => t.type === 'delay').length, 6);
  assert.deepEqual(r.timers_cancelled.map(t => t.key).sort(), irrBefore.map(t => t.key).sort());
  assert.deepEqual(r.runs_cancelled.map(x => x.automation_id), [p.autoId]);
  // dose cycle aborted with the stop source; closed-loop run gets the end reason
  assert.equal(r.dose.outcome, 'aborted');
  assert.equal(r.dose.cycle_log_id, p.logId);
  assert.equal(p.dose.isRunning(), false);
  assert.deepEqual(p.controllerEnds.map(e => [e.status, e.source]), [['aborted', 'stop_irrigation']]);
  assert.match(p.controllerEnds[0].reason, /^stop_irrigation: Stop irrigation pressed by operator@farm\.test$/);
  assert.equal(db.prepare('SELECT status FROM fertigation_dose_cycle_log WHERE id = ?').get(p.logId).status, 'aborted');
  // relay_events: every OFF logged with source + operator email + confirmed read-back
  // (the dose abort's own FC05 valve closes are logged with the same source, without read-back)
  const abortEv = db.prepare("SELECT channel FROM relay_events WHERE equipment_id = ? AND source = 'stop_irrigation' AND confirmed IS NULL ORDER BY id").all(p.dos);
  assert.deepEqual(abortEv.map(e => e.channel), [2, 3, 4, 5, 1], 'dose abort closed the program valves + pH Down');
  const ev = db.prepare("SELECT equipment_id, channel, state, source, user_email, confirmed FROM relay_events WHERE equipment_id IN (?, ?) AND source = 'stop_irrigation' AND confirmed IS NOT NULL ORDER BY equipment_id, channel").all(p.irr, p.dos);
  assert.deepEqual(ev.map(e => [e.equipment_id, e.channel]), [[p.irr, 1], [p.irr, 2], [p.irr, 3], [p.irr, 4], [p.irr, 5], [p.irr, 6], [p.dos, 1], [p.dos, 2], [p.dos, 3], [p.dos, 4], [p.dos, 5]]);
  assert.ok(ev.every(e => e.state === 0 && e.user_email === USER && e.confirmed === 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ?').get(p.fan).n, 0, 'no relay event on the fan board');
  // relay cache updated with the read-back
  const cache = JSON.parse(db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(p.irr).last_reading).relayStates;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ch => cache[ch]), [false, false, false, false, false, false]);
  // run marked
  const log = db.prepare('SELECT status, message FROM automation_logs WHERE automation_id = ? ORDER BY id DESC').get(p.autoId);
  assert.equal(log.status, 'skipped');
  assert.match(log.message, /^STOPPED by operator \(Stop irrigation, operator@farm\.test\) at \d\d:\d\d: pumps, zones and dosing switched off; fans\/climate not touched\. Zones interrupted: Irrigation Zone 1; zones not started: Irrigation Zone 2, Irrigation Zone 3, Irrigation Zone 4\. Dose cycle #\d+ aborted\.$/);
  // one info alert for this press
  const al = db.prepare("SELECT * FROM alerts WHERE source = 'stop_irrigation' AND equipment_id = ?").all(p.irr);
  assert.equal(al.length, 1);
  assert.equal(al[0].severity, 'info');
  assert.equal(al[0].id, r.alert_id);
  assert.match(al[0].message, /^Irrigation stopped by operator@farm\.test at \d\d:\d\d — pumps, zones and dosing off; fans\/climate unaffected\./);
  assert.equal(al[0].fingerprint, `stop_irrigation:${p.irr}:${Date.parse(r.stopped_at)}`);
  assert.equal(p.notifications.length, 0, 'no Telegram when confirmed');
  p.cleanup();
});

test('stop while DISARMED: OFF writes still go out and are confirmed (OFF is the fail-safe direction)', async () => {
  const p = makePlant();
  automationArmingService.disarm({ by: 'test', reason: 'stop irrigation test' });
  try {
    assert.equal(automationArmingService.isDisarmed(), true);
    const r = await p.svc.stopIrrigation({ userEmail: USER });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.channels.filter(c => c.confirmed).length, 11);
    assert.deepEqual([1, 2, 3].map(ch => p.irrC[ch]), [false, false, false]);
    assert.equal(r.dose.outcome, 'aborted');
    assert.equal(writesTo(p.units.fan).length, 0);
  } finally {
    automationArmingService.reArm({ by: 'test' });
    p.cleanup();
  }
});

test('stop when IDLE is idempotent: confirms everything OFF, nothing to cancel, no dose abort, info alert per press', async () => {
  const p = makePlant({ running: false });
  const r1 = await p.svc.stopIrrigation({ userEmail: USER });
  assert.equal(r1.ok, true);
  assert.equal(r1.channels.length, 11);
  assert.ok(r1.channels.every(c => c.confirmed && c.readback === false));
  assert.deepEqual(r1.timers_cancelled, []);
  assert.deepEqual(r1.runs_cancelled, []);
  assert.deepEqual(r1.zones_interrupted, []);
  assert.deepEqual(r1.zones_not_started, []);
  assert.equal(r1.dose.outcome, 'none');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM automation_logs WHERE automation_id = ?').get(p.autoId).n, 0);
  await new Promise(res => setTimeout(res, 5)); // a second press gets its own alert row
  const r2 = await p.svc.stopIrrigation({ userEmail: USER });
  assert.equal(r2.ok, true);
  assert.notEqual(r2.alert_id, r1.alert_id);
  assert.equal(writesTo(p.units.fan).length, 0);
  assert.equal(timersOn(p.fan).length, 4, 'fan timers untouched');
  p.cleanup();
});

test('concurrent presses share one stop (no interleaved writes)', async () => {
  const p = makePlant({ running: false });
  const [a, b] = await Promise.all([p.svc.stopIrrigation({ userEmail: USER }), p.svc.stopIrrigation({ userEmail: 'other@farm.test' })]);
  assert.equal(a, b);
  assert.equal(writesTo(p.units.irr).filter(w => w.fc === 15).length, 1);
  p.cleanup();
});

test('OFF NOT confirmed (Zone 1 relay stuck ON): re-sent once, auto-off kept as backstop, error surfaced, ONE critical alert + Telegram', async () => {
  const p = makePlant();
  bus.stuck.set(`${IRR.host}:${p.units.irr}:3`, true);
  try {
    const r = await p.svc.stopIrrigation({ userEmail: USER });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unconfirmed.map(c => [c.equipment_id, c.channel, c.name]), [[p.irr, 3, 'Irrigation Zone 1']]);
    assert.match(r.error, /^OFF not confirmed on Irrigation Zone 1 \(Waveshare Irrigation 1 #\d+ relay 3\) — switch off at the panel\.$/);
    // the executor re-sends a disagreeing FC15 once; the whole write is re-sent once more (_writeOffSafe)
    assert.ok(writesTo(p.units.irr).filter(w => w.fc === 15).length >= 3, 'OFF re-sent');
    // the stuck channel keeps its auto-off (backstop); confirmed channels' auto-offs are gone
    assert.deepEqual(timersOn(p.irr).map(t => t.key), [`off:${p.irr}:3`]);
    // no delayed START survives even when OFF is unconfirmed
    assert.equal(timersOn(p.irr).filter(t => t.type === 'delay').length, 0);
    const al = db.prepare("SELECT * FROM alerts WHERE source = 'stop_irrigation' AND equipment_id = ?").all(p.irr);
    assert.equal(al.length, 1);
    assert.equal(al[0].severity, 'critical');
    assert.match(al[0].message, /WARNING: OFF NOT CONFIRMED on Waveshare Irrigation 1 #\d+ relay 3 \(Irrigation Zone 1\) — switch off at the panel NOW\./);
    assert.equal(p.notifications.length, 1);
    assert.equal(p.notifications[0].severity, 'critical');
    const log = db.prepare('SELECT message FROM automation_logs WHERE automation_id = ? ORDER BY id DESC').get(p.autoId);
    assert.match(log.message, /OFF NOT confirmed on every channel\./);
  } finally {
    bus.stuck.delete(`${IRR.host}:${p.units.irr}:3`);
    p.cleanup();
  }
});

test('dosing board not answering: irrigation OFF confirmed, every dosing channel reported unconfirmed (failed), critical alert', async () => {
  const p = makePlant({ running: false });
  bus.dead.add(bkey(DOS.host, p.units.dos));
  try {
    const r = await p.svc.stopIrrigation({ userEmail: USER });
    assert.equal(r.ok, false);
    assert.ok(r.channels.filter(c => c.equipment_id === p.irr).every(c => c.confirmed));
    assert.deepEqual(r.unconfirmed.map(c => c.channel), [1, 2, 3, 4, 5]);
    assert.equal(db.prepare("SELECT severity FROM alerts WHERE id = ?").get(r.alert_id).severity, 'critical');
  } finally {
    bus.dead.delete(bkey(DOS.host, p.units.dos));
    p.cleanup();
  }
});

test('second sweep: an automation mid-trigger arms a zone start while the OFF is on the wire -> cancelled and OFF written again', async () => {
  const p = makePlant({ running: false });
  let armed = false;
  bus.beforeWrite = async (w) => {
    if (!armed && w.unit === p.units.irr && w.fc === 15) {
      armed = true;
      relayTimerService.scheduleDelayedStart(p.irr, 6, 30, noop, { automationId: p.autoId, checkEnabled: true, actionKey: `a${p.autoId}:late` });
    }
  };
  const r = await p.svc.stopIrrigation({ userEmail: USER });
  assert.equal(r.ok, true);
  assert.deepEqual(timersOn(p.irr), []);
  assert.ok(r.timers_cancelled.some(t => t.key === `delay:${p.irr}:6:a${p.autoId}:late`));
  assert.equal(writesTo(p.units.irr).filter(w => w.fc === 15).length, 2, 'OFF written again after the late start');
  p.cleanup();
});

test('flow-watch cold restart pending (retry pause): Stop irrigation cancels it; a restart already on the wire is undone', async () => {
  const p = makePlant();
  const svc = p.svc;
  const now = Date.now();
  const mkGuard = (phase) => ({
    runKey: `a${p.autoId}@test`, automationId: p.autoId, automationName: 'x', phase, retries: new Map([[3, 1]]), idleSince: null, createdAt: now,
    retry: { zone: { channel: 3, name: 'Irrigation Zone 1', expectedLph: 8800, openedAt: now - 30000 }, valveCycle: true, segEndMs: now + 600000, pumpEndMs: now + 600000, zoneEndMs: now + 600000,
      noFlowSince: now - 20000, noFlowMs: 15000, minFlow: 0, startedAt: now - 5000, restartAt: now + 5000, restartedAt: null, attempt: 1,
      fingerprint: `flow_watch:pump_no_flow:${p.irr}:test:3`, message: 'Irrigation Zone 1 had no water.', eventMark: 0, dose: { outcome: 'paused' } },
  });
  // (a) retry pause -> cancelled by the stop
  svc.guard = mkGuard('retry_pause');
  const r = await svc.stopIrrigation({ userEmail: USER });
  assert.equal(r.retry_cancelled, true);
  assert.equal(r.ok, true);
  assert.ok(svc.guard.operatorStopped);
  assert.equal(svc.guard.retry.outcome, 'abandoned');
  // the restart path itself refuses after an operator stop (nothing re-energised)
  svc.guard.phase = 'retry_restarting';
  svc.guard.retry.outcome = null;
  const before = bus.writes.length;
  await svc._retryRestart(svc.guard, Date.now());
  assert.equal(bus.writes.slice(before).filter(w => w.values.some(v => v === true)).length, 0, 'no ON write after Stop irrigation');

  // (b) restart ON already on the wire when the stop lands -> ON undone right after
  p.cleanup();
  const q = makePlant({ running: false });
  // relay state must be fresh + known for _retryRestart; pump/zone OFF during the pause
  q.svc.guard = mkGuard('retry_restarting');
  q.svc.guard.automationId = q.autoId;
  let release;
  const gate = new Promise(res => { release = res; });
  bus.beforeWrite = async (w) => { if (w.unit === q.units.irr && w.values.some(v => v === true)) await gate; };
  const restart = q.svc._retryRestart(q.svc.guard, Date.now());
  await new Promise(res => setTimeout(res, 10));
  const stopP = q.svc.stopIrrigation({ userEmail: USER });
  const sr = await stopP;
  assert.equal(sr.ok, true);
  release();
  await restart;
  assert.deepEqual([1, 2, 3].map(ch => q.irrC[ch]), [false, false, false], 'pumps + zone OFF after the late restart ON');
  const last = db.prepare("SELECT source, user_email FROM relay_events WHERE equipment_id = ? AND channel = 1 ORDER BY id DESC LIMIT 1").get(q.irr);
  assert.deepEqual(last, { source: 'stop_irrigation', user_email: USER });
  assert.equal(q.svc.guard.retry.outcome, 'abandoned');
  q.cleanup();
});

test('RelayTimerService.cancelTimersForEquipment: matches only the given boards (delay/off/transition), filters starts/offs and channels', () => {
  const s = new (require(path.join(__dirname, '..', 'src', 'services', 'RelayTimerService.js')).RelayTimerService)();
  s.scheduleDelayedStart(1, 3, 100, noop, { automationId: 97, actionKey: 'a97:1' });
  s.scheduleOff(1, 1, 100, noop, { automationId: 97 });
  s.scheduleOff(1, 4, 100, noop, { automationId: 97 });
  s.scheduleDelayedRaw('transition_delay:1:97:0', 100, noop, { automationId: 97 });
  s.scheduleDelayedRaw('transition_off:2:97:0', 100, noop, { automationId: 97 });
  s.scheduleDelayedStart(11, 3, 100, noop, { automationId: 97 });     // fan board 11, same automation
  s.scheduleOff(12, 1, 100, noop, { automationId: 88 });              // equipment 12 must not match "1"
  s.scheduleDelayedRaw('transition_delay:15:88:0', 100, noop, { automationId: 88 });
  try {
    assert.deepEqual(s.listTimersForEquipment([1, 2], { kind: 'starts' }).map(t => t.key).sort(), ['delay:1:3:a97:1', 'transition_delay:1:97:0']);
    const offs = s.cancelTimersForEquipment([1, 2], { kind: 'offs', channels: [1], includeRaw: false });
    assert.deepEqual(offs.map(t => t.key), ['off:1:1']);
    const rest = s.cancelTimersForEquipment([1, 2]);
    assert.deepEqual(rest.map(t => t.key).sort(), ['delay:1:3:a97:1', 'off:1:4', 'transition_delay:1:97:0', 'transition_off:2:97:0']);
    assert.deepEqual(s.getActiveTimers().map(t => t.key).sort(), ['delay:11:3', 'off:12:1', 'transition_delay:15:88:0']);
  } finally {
    s.shutdown();
  }
});

test('route POST /api/irrigation/stop: viewer 403 (service never called), operator/admin 200 with the email passed, 202 past the deadline + result broadcast', async () => {
  const calls = [];
  const events = [];
  let slow = false;
  const fake = {
    stopIrrigation: async (opts) => {
      calls.push(opts);
      if (slow) await new Promise(res => setTimeout(res, 80));
      return { ok: true, channels: [{ confirmed: true }], stopped_by: opts.userEmail };
    },
  };
  const express = require('express');
  const app = express();
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { email: `${role}@farm.test`, role }; next(); });
  app.use('/api/irrigation', createIrrigationStopRouter({ getService: () => fake, broadcast: (t, d) => events.push({ t, d }), deadlineMs: 40 }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/irrigation/stop`;
  const post = (role) => fetch(url, { method: 'POST', headers: role ? { 'x-role': role } : {} });
  try {
    assert.equal((await post('viewer')).status, 403);
    assert.equal((await post(null)).status, 401);
    assert.equal(calls.length, 0, 'viewer / anonymous never reach the service');
    const op = await post('operator');
    assert.equal(op.status, 200);
    assert.equal((await op.json()).stopped_by, 'operator@farm.test');
    assert.equal((await post('admin')).status, 200);
    assert.deepEqual(calls.map(c => c.userEmail), ['operator@farm.test', 'admin@farm.test']);
    slow = true;
    const pending = await post('operator');
    assert.equal(pending.status, 202);
    assert.equal((await pending.json()).inProgress, true);
    await new Promise(res => setTimeout(res, 120));
    const fin = events.filter(e => e.t === 'stop_irrigation_result');
    assert.equal(fin.length, 3, 'every stop broadcasts its final result');
    assert.equal(fin[2].d.inProgress, false);
    assert.equal(fin[2].d.ok, true);
  } finally {
    server.close();
  }
});
