const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const svc = require(path.join(__dirname, '..', 'src', 'services', 'RelayInterlockService.js'));
const {
  InterlockViolation, getPartner, getInterlockPairs, validateWriteSet,
  prepareEnergise, checkHardwareConflict, validateAutomationActions, hasInterlockPairs,
} = svc;

function shadeBoard(overrides = {}) {
  return {
    id: 4, name: 'Fan Board 2', address: '192.168.1.202:4196', slave_id: 2, write_only: 0,
    register_mappings: JSON.stringify([
      { name: 'Big Fan', label: 'Big Fan', type: 'coil', register: 1, access: 'readwrite', functionCode: 1 },
      { name: 'Small Fan', label: 'Small Fan', type: 'coil', register: 3, access: 'readwrite', functionCode: 1 },
      { name: 'Open Greenhouse Shades', label: 'Open Greenhouse Shades', type: 'coil', register: 5, access: 'readwrite', functionCode: 1, interlockWith: 6 },
      { name: 'Close Greenhouse Shades', label: 'Close Greenhouse Shades', type: 'coil', register: 6, access: 'readwrite', functionCode: 1 },
    ]),
    ...overrides,
  };
}

function stubClient({ partnerReadsOff = true, writeFails = false, readFails = false, initial = {} } = {}) {
  const calls = [];
  const coils = { ...initial };
  return {
    calls,
    coils,
    async writeSingleCoil(host, port, unitId, address, value, options) {
      calls.push({ op: 'write', address, value, options });
      if (writeFails) throw new Error('boom');
      coils[address] = value;
    },
    async readCoils(host, port, unitId, address, qty, options) {
      calls.push({ op: 'read', address, qty, options });
      if (readFails) throw new Error('read boom');
      if (!partnerReadsOff) return [true];
      return [coils[address] === true];
    },
  };
}

test('getPartner is symmetric even when only one side declares interlockWith', () => {
  const row = shadeBoard();
  assert.equal(getPartner(row, 5), 6);
  assert.equal(getPartner(row, 6), 5);
  assert.equal(getPartner(row, '6'), 5);
  assert.equal(getPartner(row, 1), null);
  assert.deepEqual(getInterlockPairs(row), [[5, 6]]);
  assert.equal(hasInterlockPairs(row), true);
  assert.equal(hasInterlockPairs({ register_mappings: '[]' }), false);
});

test('getPartner works with array mappings and string registers', () => {
  const row = { id: 1, name: 'X', register_mappings: [
    { type: 'coil', access: 'readwrite', register: '2', interlockWith: '4' },
    { type: 'coil', access: 'readwrite', register: '4' },
  ] };
  assert.equal(getPartner(row, 4), 2);
});

test('validateWriteSet rejects both partners ON, accepts everything else', () => {
  const row = shadeBoard();
  assert.throws(() => validateWriteSet(row, { 5: true, 6: true }), InterlockViolation);
  assert.throws(() => validateWriteSet(row, [{ channel: 5, state: true }, { channel: 6, state: true }]), (e) => {
    assert.match(e.message, /Open Greenhouse Shades/);
    assert.match(e.message, /Close Greenhouse Shades/);
    assert.equal(e.status, 409);
    return e instanceof InterlockViolation;
  });
  assert.doesNotThrow(() => validateWriteSet(row, { 5: true, 6: false }));
  assert.doesNotThrow(() => validateWriteSet(row, { 5: true }));
  assert.doesNotThrow(() => validateWriteSet(row, { 1: true, 3: true, 5: false, 6: true }));
  assert.doesNotThrow(() => validateWriteSet(row, { 5: false, 6: false }));
});

test('prepareEnergise: no partner -> no modbus traffic', async () => {
  const client = stubClient();
  const r = await prepareEnergise(shadeBoard(), 1, client);
  assert.equal(r.partner, null);
  assert.equal(client.calls.length, 0);
});

test('prepareEnergise: partner written OFF with 2s/1-retry options and read back OFF', async () => {
  const client = stubClient({ initial: { 6: true } });
  const r = await prepareEnergise(shadeBoard(), 5, client);
  assert.equal(r.partner, 6);
  assert.equal(r.partnerWasOn, true);
  const write = client.calls.find(c => c.op === 'write');
  assert.deepEqual(write, { op: 'write', address: 6, value: false, options: { timeout: 2000, retries: 1 } });
  const lastRead = client.calls[client.calls.length - 1];
  assert.equal(lastRead.op, 'read');
  assert.equal(lastRead.address, 6);
  assert.equal(client.coils[6], false);
});

test('prepareEnergise: partner still reads ON -> InterlockViolation', async () => {
  const client = stubClient({ partnerReadsOff: false });
  await assert.rejects(prepareEnergise(shadeBoard(), 6, client), (e) => {
    assert.ok(e instanceof InterlockViolation);
    assert.match(e.message, /still reads ON/);
    return true;
  });
});

test('prepareEnergise: partner OFF write fails -> InterlockViolation', async () => {
  const client = stubClient({ writeFails: true });
  await assert.rejects(prepareEnergise(shadeBoard(), 5, client), InterlockViolation);
});

test('prepareEnergise: read-back fails -> InterlockViolation (fail closed)', async () => {
  const client = stubClient({ readFails: true });
  await assert.rejects(prepareEnergise(shadeBoard(), 5, client), InterlockViolation);
});

test('checkHardwareConflict flags only pairs where both are ON', () => {
  const row = shadeBoard();
  assert.deepEqual(checkHardwareConflict(row, { 5: true, 6: true }), [
    { channels: [5, 6], labels: ['Open Greenhouse Shades', 'Close Greenhouse Shades'] },
  ]);
  assert.deepEqual(checkHardwareConflict(row, { 5: true, 6: false }), []);
  assert.deepEqual(checkHardwareConflict(row, { 1: true, 3: true }), []);
  assert.deepEqual(checkHardwareConflict(row, null), []);
});

test('validateAutomationActions: transition frame with both ON is rejected', () => {
  const lookup = (id) => (id === 4 ? shadeBoard() : null);
  const msg = validateAutomationActions([
    { type: 'transition', equipment_id: 4, transitions: [{ channel: 5, state: true }, { channel: 6, state: true }] },
  ], lookup);
  assert.match(msg, /Fan Board 2/);
  assert.match(msg, /ch 5/);
  assert.match(msg, /ch 6/);
  assert.equal(validateAutomationActions([
    { type: 'transition', equipment_id: 4, transitions: [{ channel: 5, state: true }, { channel: 6, state: false }] },
  ], lookup), null);
});

test('validateAutomationActions: two control ON actions on both partners rejected', () => {
  const lookup = (id) => (id === 4 ? shadeBoard() : null);
  const msg = validateAutomationActions([
    { type: 'control', action: 'on', equipment_id: 4, channel: 5 },
    { type: 'alert', message: 'x' },
    { type: 'control', action: 'on', equipment_id: 4, channel: '6', delay_seconds: 30 },
  ], lookup);
  assert.match(msg, /both/);
  assert.match(msg, /Open Greenhouse Shades/);
  // on + off is fine; on on unrelated channels is fine; unknown equipment ignored
  assert.equal(validateAutomationActions([
    { type: 'control', action: 'on', equipment_id: 4, channel: 5 },
    { type: 'control', action: 'off', equipment_id: 4, channel: 6 },
    { type: 'control', action: 'on', equipment_id: 4, channel: 1 },
    { type: 'control', action: 'on', equipment_id: 999, channel: 6 },
  ], lookup), null);
});

test('validateAutomationActions: all_channels ON on interlocked board rejected, OFF allowed', () => {
  const lookup = (id) => (id === 4 ? shadeBoard() : null);
  const msg = validateAutomationActions([{ type: 'control', action: 'on', equipment_id: 4, channel: null }], lookup);
  assert.match(msg, /All channels ON/);
  assert.equal(validateAutomationActions([{ type: 'control', action: 'off', equipment_id: 4, channel: null }], lookup), null);
  // all-on on a board without interlocks is fine
  const plain = shadeBoard({ id: 7, register_mappings: JSON.stringify([{ type: 'coil', access: 'readwrite', register: 1 }]) });
  assert.equal(validateAutomationActions([{ type: 'control', action: 'on', equipment_id: 7, channel: null }], () => plain), null);
});
