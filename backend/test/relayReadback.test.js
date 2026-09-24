const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const rb = require(path.join(__dirname, '..', 'src', 'services', 'RelayReadback.js'));

const TARGET = { host: '192.168.1.202', port: 4196, unitId: 7 };

/**
 * Stub Modbus client. `coils` is the hardware truth; `readsBeforeFix` lets a
 * test simulate a relay that only takes the value after the retry write.
 */
function stubClient({ coils = {}, readFails = false, readSeq = null } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls, coils,
    async readCoils(host, port, unitId, address, quantity, options) {
      calls.push({ op: 'read', address, quantity, options });
      reads++;
      if (readFails) throw new Error('timeout');
      if (readSeq) return readSeq[Math.min(reads - 1, readSeq.length - 1)];
      return Array.from({ length: quantity }, (_, i) => coils[address + i] === true);
    },
  };
}

test('decideConfirmed compares read-back with requested; null when unavailable', () => {
  assert.equal(rb.decideConfirmed(true, true), true);
  assert.equal(rb.decideConfirmed(false, false), true);
  assert.equal(rb.decideConfirmed(false, true), false);
  assert.equal(rb.decideConfirmed(true, false), false);
  assert.equal(rb.decideConfirmed(null, true), null);
  assert.equal(rb.decideConfirmed(undefined, false), null);
});

test('confirmCoilWrite: read-back matches -> confirmed, source readback, FC01 with {timeout:2000, retries:1}', async () => {
  const client = stubClient({ coils: { 5: true } });
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.readback, true);
  assert.equal(r.source, 'readback');
  assert.equal(r.retried, false);
  assert.deepEqual(r.item, { channel: 5, requested: true, readback: true, confirmed: true });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].options, { timeout: 2000, retries: 1 });
  assert.equal(client.calls[0].quantity, 1);
});

test('confirmCoilWrite: read-back disagrees and no retry -> confirmed false with the read value', async () => {
  const client = stubClient({ coils: { 5: false } });
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true);
  assert.equal(r.confirmed, false);
  assert.equal(r.readback, false);
  assert.equal(r.source, 'readback');
  assert.equal(r.retried, false);
});

test('confirmCoilWrite: disagreement triggers exactly one retry, then re-reads and confirms', async () => {
  const client = stubClient({ coils: { 5: false } });
  let retries = 0;
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true, {
    retry: async () => { retries++; client.coils[5] = true; },
  });
  assert.equal(retries, 1);
  assert.equal(r.retried, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.readback, true);
  assert.equal(client.calls.filter(c => c.op === 'read').length, 2);
});

test('confirmCoilWrite: still wrong after the retry -> confirmed false, only one retry', async () => {
  const client = stubClient({ coils: { 5: false } });
  let retries = 0;
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true, { retry: async () => { retries++; } });
  assert.equal(retries, 1);
  assert.equal(r.confirmed, false);
  assert.equal(r.readback, false);
  assert.equal(r.retried, true);
});

test('confirmCoilWrite: write-only device -> no read, confirmed false, readback null, source write_only', async () => {
  const client = stubClient({ coils: { 5: true } });
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true, { writeOnly: true, retry: async () => { throw new Error('must not retry'); } });
  assert.equal(r.confirmed, false);
  assert.equal(r.readback, null);
  assert.equal(r.source, 'write_only');
  assert.equal(client.calls.length, 0);
});

test('confirmCoilWrite: read failure -> confirmed false, readback null, source readback_failed, no throw', async () => {
  const client = stubClient({ readFails: true });
  const r = await rb.confirmCoilWrite(client, TARGET, 5, true, { retry: async () => { throw new Error('must not retry'); } });
  assert.equal(r.confirmed, false);
  assert.equal(r.readback, null);
  assert.equal(r.source, 'readback_failed');
});

test('confirmWrite (multi-coil): per-channel items, overall confirmed only when every coil matches', async () => {
  const client = stubClient({ coils: { 1: true, 2: false, 3: true } });
  const r = await rb.confirmWrite(client, TARGET, 1, [true, true, true]);
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.readback, [true, false, true]);
  assert.deepEqual(r.items.map(i => [i.channel, i.confirmed]), [[1, true], [2, false], [3, true]]);
  assert.equal(client.calls[0].quantity, 3);

  const ok = await rb.confirmWrite(stubClient({ coils: { 1: false, 2: false } }), TARGET, 1, [false, false]);
  assert.equal(ok.confirmed, true);
});

test('confirmWrite: retry read failure keeps the first read-back rather than throwing', async () => {
  const client = stubClient({ readSeq: [[false]] });
  let n = 0;
  client.readCoils = async function (host, port, unitId, address, quantity) {
    n++;
    if (n === 1) return [false];
    throw new Error('bus busy');
  };
  const r = await rb.confirmWrite(client, TARGET, 4, [true], { retry: async () => {} });
  assert.equal(r.retried, true);
  assert.deepEqual(r.readback, [false]);
  assert.equal(r.confirmed, false);
});

test('confirmWrite: a throwing retry is swallowed and the second read decides', async () => {
  const client = stubClient({ coils: { 4: false } });
  const r = await rb.confirmWrite(client, TARGET, 4, [true], { retry: async () => { client.coils[4] = true; throw new Error('write timeout'); } });
  assert.equal(r.confirmed, true);
});
