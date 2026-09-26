// Infrastructure for the pump no-flow protection + soft-switch runs (2026-09-26):
// RelayTimerService per-action delayed starts and per-run cancel, the executor's
// dose-cycle length, and the flow watch's REAL actuator path (confirmed FC15 +
// read-back + RelayEventLogger source, guarded ON) against a stubbed Modbus client.
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
const { RelayTimerService } = src('services', 'RelayTimerService.js');
const { doseCycleSeconds } = src('services', 'AutomationExecutor.js');
const { modbusTcpClient } = src('services', 'ModbusTcpClient.js');
const { automationArmingService } = src('services', 'AutomationArmingService.js');
const { defaultActuator } = src('services', 'IrrigationFlowWatchService.js');

const quiet = { log() {}, warn() {}, error() {} };
db.prepare("INSERT OR IGNORE INTO automations (id, name, enabled, trigger_config, actions) VALUES (100, 'Fertigation 15:30', 1, '{}', '[]')").run();

test('RelayTimerService: one automation can hold several delayed starts on the SAME channel (soft-switch pump windows); a re-trigger replaces its own', () => {
  const t = new RelayTimerService();
  const noop = async () => {};
  t.scheduleDelayedStart(1, 1, 3, noop, { automationId: 97, checkEnabled: true, actionKey: 'a97:1' });
  t.scheduleDelayedStart(1, 1, 282, noop, { automationId: 97, checkEnabled: true, actionKey: 'a97:4' });
  t.scheduleDelayedStart(1, 1, 561, noop, { automationId: 97, checkEnabled: true, actionKey: 'a97:7' });
  assert.equal(t.getActiveTimers().filter(x => x.channel === 1).length, 3, 'no window cancels another');
  t.scheduleDelayedStart(1, 1, 4, noop, { automationId: 97, checkEnabled: true, actionKey: 'a97:1' });
  assert.equal(t.getActiveTimers().filter(x => x.channel === 1).length, 3, 'same action key replaced');
  // legacy per-channel key unchanged
  t.scheduleDelayedStart(1, 5, 10, noop, {});
  t.scheduleDelayedStart(1, 5, 20, noop, {});
  assert.equal(t.getActiveTimers().filter(x => x.channel === 5).length, 1);
  t.shutdown();
});

test('RelayTimerService: cancelTimersForAutomation cancels that run\'s starts (auto-offs kept by filter), plus un-owned delays on the irrigation board; getOffTimer/cancelTimer', () => {
  const t = new RelayTimerService();
  const noop = async () => {};
  t.scheduleDelayedStart(1, 6, 450, noop, { automationId: 100, checkEnabled: true, actionKey: 'a100:5' });
  t.scheduleOff(1, 1, 600, noop, { automationId: 100 });
  t.scheduleOff(1, 6, 600, noop, { automationId: 100 });
  t.scheduleDelayedStart(1, 4, 30, noop, {});                       // manual delayed start on the irrigation board
  t.scheduleDelayedStart(7, 3, 30, noop, { automationId: 55 });      // another board, another automation
  const gone = t.cancelTimersForAutomation(100, { filter: (e) => e.type !== 'off', extraKeyPrefixes: ['delay:1:'] });
  assert.deepEqual(gone.map(g => g.key).sort(), ['delay:1:4', 'delay:1:6:a100:5']);
  assert.ok(t.getOffTimer(1, 1), 'auto-off kept');
  assert.ok(t.getOffTimer(1, 1).firesAt instanceof Date);
  assert.equal(t.getActiveTimers().length, 3);
  assert.equal(t.cancelTimer('off:1:6'), true);
  assert.equal(t.getOffTimer(1, 6), null);
  assert.ok(t.getActiveTimers().some(x => x.key === 'delay:7:3'), 'other board untouched');
  t.shutdown();
});

test('doseCycleSeconds: identical for today\'s runs (max duration), covers the whole soft-switch run (max delay + duration)', () => {
  const legacy = [
    { type: 'control', status: 'executed', duration_seconds: 600, delay_seconds: null },
    { type: 'control', status: 'executed', duration_seconds: 600, delay_seconds: null },
    { type: 'control', status: 'executed', duration_seconds: 150, delay_seconds: null },
    { type: 'control', status: 'scheduled', duration_seconds: 150, delay_seconds: 150 },
    { type: 'control', status: 'scheduled', duration_seconds: 150, delay_seconds: 450 },
  ];
  assert.equal(doseCycleSeconds(legacy), 600);
  const soft = [0, 1, 2, 3].flatMap(i => {
    const t0 = i * 279;
    return [
      { type: 'control', status: i ? 'scheduled' : 'executed', delay_seconds: i ? t0 : null, duration_seconds: 278 },
      { type: 'control', status: 'scheduled', delay_seconds: t0 + 3, duration_seconds: 270 },
      { type: 'control', status: 'scheduled', delay_seconds: t0 + 3, duration_seconds: 270 },
    ];
  });
  assert.equal(doseCycleSeconds(soft), 837 + 278);
  assert.equal(doseCycleSeconds([{ type: 'control', status: 'error', duration_seconds: 600 }]), 0);
  assert.equal(doseCycleSeconds([{ type: 'control', status: 'skipped_dependency', delay_seconds: 10, duration_seconds: 600 }]), 0);
});

function irrigationBoard() {
  const maps = JSON.stringify([1, 2, 3, 4, 5, 6].map(ch => ({ name: ch === 1 ? 'Irrigation Pump' : ch === 2 ? 'Mixing Pump' : `Irrigation Zone ${ch - 2}`, register: String(ch), type: 'coil', access: 'readwrite' })));
  return Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings, last_reading) VALUES ('Waveshare Irrigation 1', 'relay', 'modbus', '192.0.2.7:502', 6, 'online', ?, ?)")
    .run(maps, JSON.stringify({ relayStates: { 1: true, 2: true, 3: false, 4: false, 5: false, 6: true } })).lastInsertRowid);
}

/** Stub the singleton's coil I/O: records calls, keeps a coil image. Returns restore(). */
function stubModbus({ stuckOn = [] } = {}) {
  const coils = { 1: true, 2: true, 3: false, 4: false, 5: false, 6: true };
  const calls = [];
  const orig = { writeMultipleCoils: modbusTcpClient.writeMultipleCoils, readCoils: modbusTcpClient.readCoils, writeSingleCoil: modbusTcpClient.writeSingleCoil };
  modbusTcpClient.writeMultipleCoils = async (h, p, u, addr, values, options) => {
    calls.push({ op: 'fc15', unit: u, addr, values: [...values], options });
    values.forEach((v, i) => { if (!stuckOn.includes(addr + i)) coils[addr + i] = v; });
    return { address: addr, quantity: values.length };
  };
  modbusTcpClient.readCoils = async (h, p, u, addr, qty, options) => {
    calls.push({ op: 'fc01', unit: u, addr, qty, options });
    return Array.from({ length: qty }, (_, i) => coils[addr + i] === true);
  };
  modbusTcpClient.writeSingleCoil = async () => { throw new Error('unexpected FC05'); };
  return { calls, coils, restore: () => Object.assign(modbusTcpClient, orig) };
}

test('flow watch REAL actuator: shutdown OFF = one FC15 frame for relays 1-6 (priority high, 1.5 s), FC01 read-back, relay_events source flow_watch_shutdown, cache updated — and it works while DISARMED', async () => {
  const eqId = irrigationBoard();
  const bus = stubModbus();
  automationArmingService.disarm({ reason: 'test' });
  try {
    const act = defaultActuator(db, quiet);
    const r = await act.writeOff(eqId, [1, 2, 3, 4, 5, 6], { source: 'flow_watch_shutdown', automationId: 100 });
    assert.equal(r.confirmed, true);
    const fc15 = bus.calls.filter(c => c.op === 'fc15');
    assert.equal(fc15.length, 1);
    assert.deepEqual(fc15[0], { op: 'fc15', unit: 6, addr: 1, values: [false, false, false, false, false, false], options: { priority: 'high', timeout: 1500, retries: 2, retryDelayMs: 200 } });
    const rb = bus.calls.find(c => c.op === 'fc01');
    assert.equal(rb.options.priority, 'high');
    const ev = db.prepare("SELECT channel, state, source, automation_id, confirmed, readback_state FROM relay_events WHERE equipment_id = ? ORDER BY channel").all(eqId);
    assert.deepEqual(ev.map(e => [e.channel, e.state, e.source, e.automation_id, e.confirmed, e.readback_state]),
      [1, 2, 3, 4, 5, 6].map(ch => [ch, 0, 'flow_watch_shutdown', 100, 1, 0]));
    const cache = JSON.parse(db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(eqId).last_reading).relayStates;
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(ch => cache[ch]), [false, false, false, false, false, false]);
    // the retry ON is refused while disarmed — no frame goes out
    const before = bus.calls.length;
    await assert.rejects(act.writeOn(eqId, [6, 1, 2], { source: 'flow_watch_retry', automationId: 100 }), /disarmed/);
    assert.equal(bus.calls.length, before);
  } finally {
    automationArmingService.reArm({ by: 'test' });
    bus.restore();
  }
});

test('flow watch REAL actuator: cold-restart ON writes the zone first, then the pumps (separate FC15 runs), read back, logged flow_watch_retry; a coil that reads back wrong is reported unconfirmed', async () => {
  const eqId = irrigationBoard();
  db.prepare("UPDATE equipment SET last_reading = ? WHERE id = ?").run(JSON.stringify({ relayStates: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false } }), eqId);
  const bus = stubModbus();
  Object.assign(bus.coils, { 1: false, 2: false, 6: false });
  try {
    const act = defaultActuator(db, quiet);
    const r = await act.writeOn(eqId, [6, 1, 2], { source: 'flow_watch_retry', automationId: 100 });
    assert.equal(r.confirmed, true);
    const fc15 = bus.calls.filter(c => c.op === 'fc15').map(c => [c.addr, c.values]);
    assert.deepEqual(fc15, [[6, [true]], [1, [true, true]]]);
    const ev = db.prepare("SELECT channel, state, source FROM relay_events WHERE equipment_id = ? ORDER BY id").all(eqId);
    assert.deepEqual(ev.map(e => [e.channel, e.state, e.source]), [[6, 1, 'flow_watch_retry'], [1, 1, 'flow_watch_retry'], [2, 1, 'flow_watch_retry']]);
  } finally {
    bus.restore();
  }
  // stuck coil: OFF requested, relay 1 still reads ON after the one re-send
  const bus2 = stubModbus({ stuckOn: [1] });
  try {
    const act = defaultActuator(db, quiet);
    const r = await act.writeOff(eqId, [1, 2, 3, 4, 5, 6], { source: 'flow_watch_shutdown', automationId: 100 });
    assert.equal(r.confirmed, false);
    assert.deepEqual(r.items.filter(i => !i.confirmed).map(i => i.channel), [1]);
    assert.equal(bus2.calls.filter(c => c.op === 'fc15').length, 2, 'one re-send on the disagreeing read-back');
  } finally {
    bus2.restore();
  }
});
