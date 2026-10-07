// Stale auto-off vs newer ON on the shared pump channels (operator-approved fix 2026-10-07).
//
// Incident 2026-10-07 03:41:18 UTC, run 118 (also 2026-09-29 run 106, 2026-10-02 run 112):
// zone 3's pump ON came ~6 s late on a busy Modbus bus; its auto-off (timed from the
// actual ON) fired ~3 s AFTER zone 4's pump ON on the same channels; the OFF's read-back
// saw zone 4's new ON, treated it as a failed OFF and re-wrote OFF (relay_drift_log
// auto_off_verify_failed) -> zone 4 valve open 3.5 min with no pumping.
//
// The bus stub is a strict FIFO (like the pooled host:port queue on the RS485 gateway) that
// the test can hold, so the exact interleaving is reproduced deterministically.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}
global.broadcast = global.broadcast || (() => {});
const { modbusTcpClient } = src('services', 'ModbusTcpClient.js');
const { relayTimerService } = src('services', 'RelayTimerService.js');
const { automationArmingService } = src('services', 'AutomationArmingService.js');
const ledger = src('services', 'RelayCommandLedger.js');
const { executeControlAction, autoOffSeconds, stopAllRelays } = src('services', 'AutomationExecutor.js');

db.prepare("INSERT OR IGNORE INTO automations (id, name, enabled, trigger_config, actions) VALUES (118, 'Fertigation 07:30', 1, '{}', '[]')").run();
const AUTO = { id: 118, name: 'Fertigation 07:30' };
const PUMP = 1;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); }
  throw new Error(`timed out waiting for ${what}`);
}

function board() {
  const maps = JSON.stringify([1, 2, 3, 4, 5, 6].map(ch => ({ name: ch === 1 ? 'Irrigation Pump' : ch === 2 ? 'Mixing Pump' : `Irrigation Zone ${ch - 2}`, register: String(ch), type: 'coil', access: 'readwrite' })));
  return Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings, last_reading) VALUES ('Waveshare Irrigation 1', 'relay', 'modbus', '192.0.2.7:502', 6, 'online', ?, ?)")
    .run(maps, JSON.stringify({ relayStates: {} })).lastInsertRowid);
}

/** FIFO bus stub. hold()/release() freeze the queue; `stuckOn` coils ignore the first N OFF writes. */
function fifoBus({ stuckOffWrites = {} } = {}) {
  const coils = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
  const log = [];
  const queue = [];
  let held = false;
  let running = false;
  const orig = {
    writeSingleCoil: modbusTcpClient.writeSingleCoil, readCoils: modbusTcpClient.readCoils,
    writeMultipleCoils: modbusTcpClient.writeMultipleCoils,
  };
  const pump = async () => {
    if (running) return;
    running = true;
    while (!held && queue.length) {
      await new Promise(r => setImmediate(r));
      if (held) break;
      const op = queue.shift();
      op.run();
    }
    running = false;
  };
  const enqueue = (desc, fn) => new Promise((resolve, reject) => {
    queue.push({ desc, run: () => { log.push({ ...desc, at: Date.now() }); try { resolve(fn()); } catch (e) { reject(e); } } });
    pump();
  });
  modbusTcpClient.writeSingleCoil = (h, p, u, addr, v) => enqueue({ op: 'fc05', addr, v }, () => {
    if (v === false && stuckOffWrites[addr] > 0) { stuckOffWrites[addr]--; return {}; }
    coils[addr] = v; return {};
  });
  modbusTcpClient.writeMultipleCoils = (h, p, u, addr, values) => enqueue({ op: 'fc15', addr, values: [...values] }, () => {
    values.forEach((v, i) => { coils[addr + i] = v; }); return {};
  });
  modbusTcpClient.readCoils = (h, p, u, addr, qty) => enqueue({ op: 'fc01', addr, qty }, () => Array.from({ length: qty }, (_, i) => coils[addr + i] === true));
  return {
    coils, log, queue,
    hold() { held = true; },
    release() { held = false; pump(); },
    writes: (addr) => log.filter(l => (l.op === 'fc05' && l.addr === addr) || (l.op === 'fc15' && addr >= l.addr && addr < l.addr + l.values.length))
      .map(l => (l.op === 'fc05' ? l.v : l.values[addr - l.addr])),
    restore: () => Object.assign(modbusTcpClient, orig),
  };
}

const events = (eqId, ch) => db.prepare('SELECT state, source, confirmed, readback_state FROM relay_events WHERE equipment_id = ? AND channel = ? ORDER BY id').all(eqId, ch);
const drift = (eqId) => db.prepare('SELECT context FROM relay_drift_log WHERE equipment_id = ?').all(eqId).map(r => r.context);
const unconfirmedAlerts = (eqId, ch) => db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE fingerprint = ?').get(`relay_unconfirmed:${eqId}:${ch}`).n;
const pumpOn = (eqId, delay, duration) => ({ type: 'control', action: 'on', equipment_id: eqId, channel: PUMP, delay_seconds: delay, duration_seconds: duration });

test('autoOffSeconds: the OFF is timed from the PLANNED window, never longer than the duration, never below 1 s', () => {
  const planned = 1_000_000;
  assert.equal(autoOffSeconds(210, planned, planned), 210);
  assert.equal(autoOffSeconds(210, planned, planned + 6000), 204, '6 s late ON -> OFF still at the planned end');
  assert.equal(autoOffSeconds(210, planned, planned - 5000), 210, 'early: capped at the duration (max-on bounded)');
  assert.equal(autoOffSeconds(210, planned, planned + 600_000), 1, 'absurdly late: 1 s minimum');
});

test('2026-10-07 03:41:18 sequence: zone 3 auto-off OFF lands, zone 4 pump ON lands before its read-back -> the read-back ON is explained by the newer ON: NO re-write, logged automation_auto_off_superseded, zone 4 keeps pumping and its own auto-off still ends it', async () => {
  ledger._reset();
  const eqId = board();
  const bus = fifoBus();
  try {
    // zone 3 pump window
    await executeControlAction(pumpOn(eqId, 0, 0.12), AUTO, { actionIdx: 8 });
    assert.equal(bus.coils[PUMP], true);
    // busy bus: zone 3's auto-off OFF is issued but queued
    bus.hold();
    await waitFor(() => bus.queue.some(q => q.desc.op === 'fc05' && q.desc.v === false), 'zone 3 auto-off OFF queued');
    // zone 4's pump ON is issued behind it, before zone 3's OFF read-back
    const z4 = executeControlAction(pumpOn(eqId, 0, 0.4), AUTO, { actionIdx: 11 });
    await waitFor(() => bus.queue.length >= 2, 'zone 4 ON queued');
    bus.release();
    await z4;
    await waitFor(() => events(eqId, PUMP).some(e => e.source === 'automation_auto_off_superseded'), 'superseded event');
    await sleep(50);

    // the coil writes on the pump channel: ON (z3), OFF (z3 auto-off), ON (z4) — and NO OFF re-write after z4's ON
    assert.deepEqual(bus.writes(PUMP), [true, false, true]);
    assert.equal(bus.coils[PUMP], true, 'zone 4 is pumping');
    const sup = events(eqId, PUMP).find(e => e.source === 'automation_auto_off_superseded');
    assert.deepEqual(sup, { state: 1, source: 'automation_auto_off_superseded', confirmed: 1, readback_state: 1 });
    assert.ok(!drift(eqId).includes('auto_off_verify_failed'), 'no false auto_off_verify_failed');
    assert.equal(unconfirmedAlerts(eqId, PUMP), 0, 'no unconfirmed-write alert');
    assert.ok(relayTimerService.getOffTimer(eqId, PUMP), 'zone 4 owns its own pending auto-off');

    // zone 4's own auto-off still ends the window
    await waitFor(() => bus.coils[PUMP] === false, 'zone 4 auto-off');
    await waitFor(() => events(eqId, PUMP).slice(-1)[0].source === 'automation_auto_off', 'zone 4 auto-off logged');
    const last = events(eqId, PUMP).slice(-1)[0];
    assert.deepEqual(last, { state: 0, source: 'automation_auto_off', confirmed: 1, readback_state: 0 });
  } finally {
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});

test('late pump ON on a busy bus: the auto-off fires at the PLANNED end (armed before the write), so zone 3 is OFF before zone 4\'s pump ON — no overlap at all', async () => {
  ledger._reset();
  const eqId = board();
  const bus = fifoBus();
  try {
    bus.hold(); // the bus is busy when zone 3's delayed pump ON fires
    await executeControlAction(pumpOn(eqId, 0.05, 0.3), AUTO, { actionIdx: 8 });   // planned 0.05 .. 0.35
    await executeControlAction(pumpOn(eqId, 0.45, 0.2), AUTO, { actionIdx: 11 });  // planned 0.45 .. 0.65
    await waitFor(() => bus.queue.length >= 1, 'zone 3 ON queued');
    await sleep(200);           // ON lands ~0.2 s late (old code: OFF at ~0.55, after zone 4's ON at 0.45)
    bus.release();
    await waitFor(() => bus.writes(PUMP).length >= 3, 'zone 4 ON written');
    const w = bus.log.filter(l => l.op === 'fc05' && l.addr === PUMP);
    assert.deepEqual(w.map(l => l.v), [true, false, true], 'zone 3 OFF strictly before zone 4 ON');
    assert.equal(bus.coils[PUMP], true);
    assert.ok(!events(eqId, PUMP).some(e => e.source === 'automation_auto_off_superseded'), 'no race to resolve');
    await waitFor(() => bus.coils[PUMP] === false && bus.writes(PUMP).length === 4, 'zone 4 auto-off');
  } finally {
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});

test('safety: a GENUINE failed OFF (no newer command) still re-writes OFF once and logs auto_off_verify_failed', async () => {
  ledger._reset();
  const eqId = board();
  const bus = fifoBus({ stuckOffWrites: { [PUMP]: 1 } }); // first OFF is ignored by the "board"
  try {
    await executeControlAction(pumpOn(eqId, 0, 0.05), AUTO, { actionIdx: 2 });
    await waitFor(() => bus.coils[PUMP] === false, 'OFF after the re-write');
    await waitFor(() => events(eqId, PUMP).some(e => e.source === 'automation_auto_off'), 'auto-off logged');
    assert.deepEqual(bus.writes(PUMP), [true, false, false], 'one re-write');
    assert.ok(drift(eqId).includes('auto_off_verify_failed'));
    assert.ok(!events(eqId, PUMP).some(e => e.source === 'automation_auto_off_superseded'));
  } finally {
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});

test('safety: a newer ON with NO auto-off of its own (e.g. manual, unbounded) does not suppress the OFF — OFF still wins, as before', async () => {
  ledger._reset();
  const eqId = board();
  const bus = fifoBus();
  try {
    await executeControlAction(pumpOn(eqId, 0, 0.1), AUTO, { actionIdx: 2 });
    bus.hold();
    await waitFor(() => bus.queue.some(q => q.desc.op === 'fc05' && q.desc.v === false), 'auto-off OFF queued');
    // an unbounded ON (recorded, no pending auto-off) lands between the OFF and its read-back
    ledger.record(eqId, PUMP, true, { source: 'manual' });
    const manual = modbusTcpClient.writeSingleCoil('192.0.2.7', 502, 6, PUMP, true);
    bus.release();
    await manual;
    await waitFor(() => events(eqId, PUMP).some(e => e.source === 'automation_auto_off'), 'auto-off logged');
    assert.deepEqual(bus.writes(PUMP), [true, false, true, false], 'OFF re-written after the unbounded ON');
    assert.equal(bus.coils[PUMP], false);
    assert.ok(!events(eqId, PUMP).some(e => e.source === 'automation_auto_off_superseded'));
  } finally {
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});

test('safety: Stop All during an in-flight pump ON ends OFF — the ON\'s read-back retry never re-energises after the newer stop-all OFF, and its auto-off timer is cancelled', async () => {
  ledger._reset();
  db.prepare('DELETE FROM equipment').run();
  const eqId = board();
  const bus = fifoBus();
  try {
    bus.hold();
    const on = executeControlAction(pumpOn(eqId, 0, 30), AUTO, { actionIdx: 2 });
    await waitFor(() => bus.queue.length >= 1, 'ON queued');
    const stop = stopAllRelays();
    await waitFor(() => bus.queue.some(q => q.desc.op === 'fc15'), 'stop-all FC15 queued');
    bus.release();
    const summary = await stop;
    await on;
    await sleep(30);
    assert.equal(summary.ok, true);
    assert.deepEqual(bus.writes(PUMP), [true, false], 'no ON re-write after the stop-all OFF');
    assert.equal(bus.coils[PUMP], false);
    assert.equal(relayTimerService.getOffTimer(eqId, PUMP), null);
  } finally {
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});

test('safety: disarm (emergency stop) never blocks an auto-off; a delayed pump ON is refused while disarmed', async () => {
  ledger._reset();
  const eqId = board();
  const bus = fifoBus();
  try {
    await executeControlAction(pumpOn(eqId, 0, 0.08), AUTO, { actionIdx: 2 });
    automationArmingService.disarm({ reason: 'test' });
    await executeControlAction(pumpOn(eqId, 0.15, 0.2), AUTO, { actionIdx: 5 });
    await waitFor(() => bus.coils[PUMP] === false, 'auto-off while disarmed');
    await sleep(250);
    assert.deepEqual(bus.writes(PUMP), [true, false], 'the delayed ON never went out');
  } finally {
    automationArmingService.reArm({ by: 'test' });
    relayTimerService.cancelAllTimers();
    bus.restore();
  }
});
