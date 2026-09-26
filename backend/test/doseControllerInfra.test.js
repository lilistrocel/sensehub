// Infrastructure for the closed-loop dose controller: the one-shot control_mode
// migration and the temporary SEKO poll boost (ModbusPollingService.setIntervalOverride).
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
src('utils', 'database.js');
const { ensureDoseControllerSchema } = src('utils', 'doseControllerSchema.js');
const { ModbusPollingService } = src('services', 'ModbusPollingService.js');

test('migration: adds control_mode (open_loop default), sets program 7 to closed_loop ONCE; an operator change sticks', () => {
  const mem = new Database(':memory:');
  mem.exec("CREATE TABLE fertigation_dose_programs (id INTEGER PRIMARY KEY, name TEXT)");
  mem.prepare('INSERT INTO fertigation_dose_programs (id, name) VALUES (?, ?)').run(5, 'Full Strength Permissive');
  mem.prepare('INSERT INTO fertigation_dose_programs (id, name) VALUES (?, ?)').run(7, 'Full Strength Permissive — nutrients only (no acid)');
  const log = console.log; console.log = () => {};
  try {
    ensureDoseControllerSchema(mem);
    const modes = () => Object.fromEntries(mem.prepare('SELECT id, control_mode FROM fertigation_dose_programs').all().map(r => [r.id, r.control_mode]));
    assert.deepEqual(modes(), { 5: 'open_loop', 7: 'closed_loop' });
    mem.prepare("UPDATE fertigation_dose_programs SET control_mode = 'open_loop' WHERE id = 7").run();
    ensureDoseControllerSchema(mem); // next backend start
    assert.deepEqual(modes(), { 5: 'open_loop', 7: 'open_loop' });
    assert.ok(mem.pragma('table_info(dose_controller_runs)').some(c => c.name === 'zones_json'));
  } finally { console.log = log; }
});

test('poll boost: sensors only, clamped to >= 5 s, expires by itself, carries the short read timeout; relay boards untouched', () => {
  const svc = new ModbusPollingService();
  const now = Date.now();
  const mk = (id, mappings) => {
    return { id, name: `dev ${id}`, address: '192.0.2.7:502', slave_id: 3, polling_interval_ms: 30000, request_gap_ms: 300, register_mappings: JSON.stringify(mappings) };
  };
  const seko = mk(17, [{ name: 'pH', register: 1000, functionCode: 4 }]);
  const board = mk(2, [{ name: 'Relay 1', register: 1, type: 'coil' }]);
  const StateClass = require(path.join(__dirname, '..', 'src', 'services', 'ModbusPollingService.js')).__DevicePollingState;
  assert.ok(StateClass, 'DevicePollingState exported for tests');
  svc.devices.set(17, new StateClass(seko));
  svc.devices.set(2, new StateClass(board));
  assert.equal(svc.setIntervalOverride(2, 10000, { untilMs: now + 60000 }), false, 'relay board refused');
  assert.equal(svc.devices.get(2).getEffectiveInterval(), 30000);
  assert.equal(svc.setIntervalOverride(17, 1000, { untilMs: now + 60000, requestOptions: { timeout: 1500, retries: 1 } }), true);
  const st = svc.devices.get(17);
  assert.equal(st.getEffectiveInterval(), 5000, 'clamped to 5 s');
  svc.setIntervalOverride(17, 10000, { untilMs: now + 60000, requestOptions: { timeout: 1500, retries: 1 } });
  assert.equal(st.getEffectiveInterval(), 10000);
  assert.deepEqual(st.getOverrideRequestOptions(), { timeout: 1500, retries: 1 });
  st.consecutiveErrors = 6; // a sick SEKO still backs off (32 s)
  assert.equal(st.getEffectiveInterval(), 32000);
  st.consecutiveErrors = 0;
  assert.equal(st.getBaseInterval(now + 61000), 30000, 'expired override dropped');
  assert.equal(st.intervalOverride, null);
  assert.equal(st.getOverrideRequestOptions(), undefined);
  svc.setIntervalOverride(17, 10000, { untilMs: now + 60000 });
  assert.equal(svc.clearIntervalOverride(17), true);
  assert.equal(st.getEffectiveInterval(), 30000);
});
