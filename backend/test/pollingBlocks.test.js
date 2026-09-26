const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const blocks = require(path.join(__dirname, '..', 'src', 'services', 'ModbusBlockReads.js'));
const { ModbusTcpClient } = require(path.join(__dirname, '..', 'src', 'services', 'ModbusTcpClient.js'));

const TARGET = { host: '192.168.1.7', port: 502, unitId: 3 };

// Register-style mapping helpers
const reg = (address, extra = {}) => ({ name: `r${address}`, type: 'input', register: address, functionCode: 4, dataType: 'uint16', ...extra });
const coil = (address, extra = {}) => ({ name: `c${address}`, type: 'coil', register: String(address), ...extra });

/**
 * Stub Modbus client: `registers` / `coils` are the device memory; `reject`
 * lets a test make specific (fc,address,quantity) requests fail with an
 * error. Every call is recorded.
 */
function stubClient({ registers = {}, coils = {}, reject = () => null } = {}) {
  const calls = [];
  const serve = (fc, address, quantity, mem, bit) => {
    calls.push({ fc, address, quantity });
    const err = reject({ fc, address, quantity });
    if (err) return Promise.reject(err);
    return Promise.resolve(Array.from({ length: quantity }, (_, i) => {
      const v = mem[address + i];
      return bit ? v === true : (v === undefined ? 0 : v);
    }));
  };
  return {
    calls,
    readCoils: (h, p, u, a, q) => serve(1, a, q, coils, true),
    readDiscreteInputs: (h, p, u, a, q) => serve(2, a, q, coils, true),
    readHoldingRegisters: (h, p, u, a, q) => serve(3, a, q, registers, false),
    readInputRegisters: (h, p, u, a, q) => serve(4, a, q, registers, false),
  };
}

const modbusException = (code = 2) => {
  const e = new Error(`Modbus exception ${code}: Illegal data address`);
  e.modbusCode = code;
  return e;
};

// ---------------------------------------------------------------------------
// buildRuns: grouping
// ---------------------------------------------------------------------------

test('buildRuns: the SEKO map (1000-1003, 1005-1008, FC04) is ONE block 1000x9 read through the hole at 1004', () => {
  const mappings = [1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008].map(a => reg(a));
  const { runs, unsupported } = blocks.buildRuns(mappings);
  assert.equal(unsupported.length, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fc, 4);
  assert.equal(runs[0].address, 1000);
  assert.equal(runs[0].quantity, 9);
  assert.equal(runs[0].items.length, 8);
});

test('buildRuns: holes of up to 2 registers are merged, a hole of 3 splits the run', () => {
  // 10, 13 -> hole of 2 (11,12): merged.  13, 17 -> hole of 3 (14,15,16): split.
  const { runs } = blocks.buildRuns([reg(10), reg(13), reg(17), reg(18)]);
  assert.deepEqual(runs.map(r => [r.address, r.quantity, r.items.length]), [[10, 4, 2], [17, 2, 2]]);
});

test('buildRuns: unsorted input is sorted by address; disabled and address-less mappings are skipped', () => {
  const { runs } = blocks.buildRuns([reg(5), reg(3, { enabled: false }), reg(1), { name: 'nope', type: 'input' }, reg(2)]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].address, 1);
  assert.equal(runs[0].quantity, 5);
  assert.deepEqual(runs[0].items.map(i => i.address), [1, 2, 5]);
});

test('buildRuns: different function codes never share a block', () => {
  const { runs } = blocks.buildRuns([reg(1), reg(2, { functionCode: 3, type: 'holding' }), reg(3)]);
  assert.deepEqual(runs.map(r => [r.fc, r.address, r.quantity]), [[3, 2, 1], [4, 1, 3]]);
});

test('buildRuns: a run is capped at 100 registers (multi-register items count their full span)', () => {
  // 60 contiguous int32 mappings (2 regs each) = 120 registers -> two runs of 100 and 20
  const mappings = Array.from({ length: 60 }, (_, i) => reg(100 + 2 * i, { dataType: 'int32', quantity: 2 }));
  const { runs } = blocks.buildRuns(mappings);
  assert.deepEqual(runs.map(r => [r.address, r.quantity, r.items.length]), [[100, 100, 50], [200, 20, 10]]);
  for (const r of runs) assert.ok(r.quantity <= 100);
});

test('buildRuns: coils are grouped with the same hole rule and a 2000-coil cap', () => {
  const mappings = [coil(1), coil(2), coil(3), coil(4), coil(5), coil(6, { enabled: false })];
  const { runs } = blocks.buildRuns(mappings);
  assert.deepEqual(runs.map(r => [r.fc, r.address, r.quantity, r.items.length]), [[1, 1, 5, 5]]);

  const many = Array.from({ length: 2500 }, (_, i) => coil(i));
  const big = blocks.buildRuns(many).runs;
  assert.deepEqual(big.map(r => r.quantity), [2000, 500]);
});

test('buildRuns: the Circutor CEM-C31 map splits on the wide gaps only', () => {
  const addrs = [1842, 1844, 1846, 1848, 1850, 1852, 1854, 1856, 1858, 1862, 1864, 1866, 1868, 1876, 1884, 0, 2, 4, 6, 8, 10, 198];
  const mappings = addrs.map(a => ({ name: `m${a}`, register: String(a), type: 'holding', dataType: 'int32', quantity: 2 }));
  const { runs } = blocks.buildRuns(mappings);
  // 0-11 (6 items), 198-199, 1842-1859 (1860,1861 = hole of 2 -> merged with 1862-1869), 1876-1877, 1884-1885
  assert.deepEqual(runs.map(r => [r.address, r.quantity, r.items.length]), [
    [0, 12, 6], [198, 2, 1], [1842, 28, 13], [1876, 2, 1], [1884, 2, 1],
  ]);
});

test('buildRuns: mappings with an unsupported function code are reported, not grouped', () => {
  const { runs, unsupported } = blocks.buildRuns([reg(1), reg(2, { functionCode: 6 })]);
  assert.equal(runs.length, 1);
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].fc, 6);
});

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

test('sliceRun + decodeItem: a 32-bit two-register mapping is sliced out of the block and decoded like a direct read', () => {
  const mappings = [
    reg(1842, { functionCode: 3, dataType: 'int32', quantity: 2, byteOrder: 'ABCD' }),
    reg(1844, { functionCode: 3, dataType: 'int32', quantity: 2, byteOrder: 'CDAB' }),
    reg(1846, { functionCode: 3, dataType: 'uint16' }),
  ];
  const { runs } = blocks.buildRuns(mappings);
  assert.equal(runs.length, 1);
  const run = runs[0];
  // block words for 1842..1846
  const data = [0xFFFF, 0xFFFE, 0x0001, 0x0002, 0x1234];

  const interpret = (words, mapping) => {
    // minimal int32/uint16 decoder honouring byteOrder, mirroring ModbusPollingService.interpretRegisterValue
    if (mapping.dataType === 'uint16') return words[0] & 0xFFFF;
    const [hi, lo] = mapping.byteOrder === 'CDAB' ? [words[1], words[0]] : [words[0], words[1]];
    return Buffer.from([(hi >> 8) & 0xFF, hi & 0xFF, (lo >> 8) & 0xFF, lo & 0xFF]).readInt32BE(0);
  };

  const [i1842, i1844, i1846] = run.items;
  assert.deepEqual(blocks.sliceRun(data, run, i1842), [0xFFFF, 0xFFFE]);
  assert.deepEqual(blocks.sliceRun(data, run, i1844), [0x0001, 0x0002]);
  assert.deepEqual(blocks.sliceRun(data, run, i1846), [0x1234]);

  assert.equal(blocks.decodeItem(blocks.sliceRun(data, run, i1842), i1842, interpret), -2);          // 0xFFFFFFFE
  assert.equal(blocks.decodeItem(blocks.sliceRun(data, run, i1844), i1844, interpret), 0x00020001);  // word-swapped
  assert.equal(blocks.decodeItem(blocks.sliceRun(data, run, i1846), i1846, interpret), 0x1234);
  // decode must equal what the per-mapping path would have produced from a direct read of the same words
  assert.equal(interpret([0xFFFF, 0xFFFE], i1842.mapping), -2);
});

test('decodeItem: coils and discrete inputs decode to 1/0 from the first bit; empty data is null', () => {
  const { runs } = blocks.buildRuns([coil(1), coil(2)]);
  const run = runs[0];
  const data = [true, false];
  assert.equal(blocks.decodeItem(blocks.sliceRun(data, run, run.items[0]), run.items[0]), 1);
  assert.equal(blocks.decodeItem(blocks.sliceRun(data, run, run.items[1]), run.items[1]), 0);
  assert.equal(blocks.decodeItem([], run.items[0]), null);
});

// ---------------------------------------------------------------------------
// readMappings: one request per block, exception fallback, partial failure
// ---------------------------------------------------------------------------

test('readMappings: SEKO map is ONE request and every mapping gets its value, in mapping order', async () => {
  const registers = { 1000: 539, 1001: 12, 1002: 65535, 1003: 353, 1004: 999, 1005: 16126, 1006: 1, 1007: 2, 1008: 3 };
  const client = stubClient({ registers });
  const mappings = [1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008].map(a => reg(a));
  const r = await blocks.readMappings(client, TARGET, mappings, { interpret: (w) => w[0] });
  assert.deepEqual(client.calls, [{ fc: 4, address: 1000, quantity: 9 }]);
  assert.equal(r.requests, 1);
  assert.equal(r.attempted, 8);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.readings.map(x => [x.address, x.value]), [[1000, 539], [1001, 12], [1002, 65535], [1003, 353], [1005, 16126], [1006, 1], [1007, 2], [1008, 3]]);
  assert.equal(r.readings[0].mapping, mappings[0]); // same object, so name/unit/scale are preserved
});

test('readMappings: hole-free block rejected with a Modbus exception -> per-mapping fallback in the same cycle, remembered as "single"', async () => {
  const registers = { 1: 11, 2: 22, 3: 33 };
  const client = stubClient({ registers, reject: ({ quantity }) => (quantity > 1 ? modbusException(2) : null) });
  const mappings = [reg(1), reg(2), reg(3)];
  const memory = new Map();
  const log = [];

  const first = await blocks.readMappings(client, TARGET, mappings, { runModes: memory, log: (m) => log.push(m) });
  assert.deepEqual(client.calls, [
    { fc: 4, address: 1, quantity: 3 },   // block attempt
    { fc: 4, address: 1, quantity: 1 },   // fallback, once per mapping
    { fc: 4, address: 2, quantity: 1 },
    { fc: 4, address: 3, quantity: 1 },
  ]);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.readings.map(x => x.value), [11, 22, 33]);
  assert.deepEqual([...memory.entries()], [['4:1:3', blocks.MODE_SINGLE]]);
  assert.equal(log.length, 1);
  assert.match(log[0], /rejected/);

  // Next cycle: no block attempt at all
  client.calls.length = 0;
  const second = await blocks.readMappings(client, TARGET, mappings, { runModes: memory });
  assert.deepEqual(client.calls.map(c => c.quantity), [1, 1, 1]);
  assert.equal(second.failed, 0);

  // A fresh memory (config reload) tries the block again
  client.calls.length = 0;
  await blocks.readMappings(client, TARGET, mappings, { runModes: new Map() });
  assert.equal(client.calls[0].quantity, 3);
});

test('readMappings: Circutor .206 case - block spanning a hole rejected -> hole-free sub-blocks, remembered as "split"', async () => {
  // 1842..1859 and 1862..1869 with the unimplemented 1860-1861 in between
  const registers = {};
  for (let a = 1842; a < 1860; a++) registers[a] = a;
  for (let a = 1862; a < 1870; a++) registers[a] = a;
  const spansHole = ({ address, quantity }) => address <= 1860 && address + quantity - 1 >= 1860;
  const client = stubClient({ registers, reject: (q) => (spansHole(q) ? modbusException(3) : null) });
  const mappings = [];
  for (let a = 1842; a < 1860; a += 2) mappings.push(reg(a, { functionCode: 3, type: 'holding', dataType: 'int32', quantity: 2 }));
  for (let a = 1862; a < 1870; a += 2) mappings.push(reg(a, { functionCode: 3, type: 'holding', dataType: 'int32', quantity: 2 }));
  const memory = new Map();

  const r = await blocks.readMappings(client, TARGET, mappings, { runModes: memory, interpret: (w) => w[0] });
  assert.deepEqual(client.calls, [
    { fc: 3, address: 1842, quantity: 28 },  // block through the hole -> exception 3
    { fc: 3, address: 1842, quantity: 18 },  // hole-free sub-blocks
    { fc: 3, address: 1862, quantity: 8 },
  ]);
  assert.equal(r.failed, 0);
  assert.equal(r.readings.length, 13);
  assert.deepEqual([...memory.entries()], [['3:1842:28', blocks.MODE_SPLIT]]);

  client.calls.length = 0;
  await blocks.readMappings(client, TARGET, mappings, { runModes: memory, interpret: (w) => w[0] });
  assert.deepEqual(client.calls.map(c => c.quantity), [18, 8]);
});

test('readMappings: Circutor .205 case - block spanning a hole silently dropped (timeout), sub-blocks answer -> remembered as "split" after 3 cycles in a row', async () => {
  const registers = { 10: 1, 11: 2, 14: 5, 15: 6 };
  const spansHole = ({ address, quantity }) => address <= 12 && address + quantity - 1 >= 12;
  const client = stubClient({ registers, reject: (q) => (spansHole(q) ? new Error('Request timeout') : null) });
  const mappings = [reg(10), reg(11), reg(14), reg(15)];
  const memory = new Map();
  for (let cycle = 1; cycle <= blocks.SPLIT_AFTER_TIMEOUTS; cycle++) {
    client.calls.length = 0;
    const r = await blocks.readMappings(client, TARGET, mappings, { runModes: memory });
    assert.deepEqual(client.calls.map(c => [c.address, c.quantity]), [[10, 6], [10, 2], [14, 2]], `cycle ${cycle}`);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.readings.map(x => x.value), [1, 2, 5, 6]);
    assert.equal(memory.get('4:10:6'), cycle < blocks.SPLIT_AFTER_TIMEOUTS ? undefined : blocks.MODE_SPLIT, `cycle ${cycle}`);
  }
  client.calls.length = 0;
  await blocks.readMappings(client, TARGET, mappings, { runModes: memory });
  assert.deepEqual(client.calls.map(c => [c.address, c.quantity]), [[10, 2], [14, 2]], 'split remembered: no block attempt');
});

test('readMappings: SEKO case - ONE lost block frame on a busy bus does not switch FC04 1000x9 to 4 sub-block reads (2026-09-26 11:30:15)', async () => {
  const registers = { 1000: 605, 1001: 0, 1002: -5, 1003: 350, 1004: 0, 1005: 2080, 1006: 0, 1007: 0, 1008: 88 };
  let dropNext = true;
  const client = stubClient({ registers, reject: (q) => { if (q.quantity === 9 && dropNext) { dropNext = false; return new Error('Request timeout'); } return null; } });
  const seko = [1000, 1003, 1005, 1008].map(a => ({ ...reg(a), functionCode: 4 }));
  const memory = new Map();
  const r1 = await blocks.readMappings(client, TARGET, seko, { runModes: memory });
  assert.equal(r1.failed, 0, 'sub-blocks still deliver this cycle');
  assert.equal(memory.size, 0, 'not remembered after one timeout');
  client.calls.length = 0;
  const r2 = await blocks.readMappings(client, TARGET, seko, { runModes: memory });
  assert.deepEqual(client.calls.map(c => [c.address, c.quantity]), [[1000, 9]], 'next cycle: one block request again');
  assert.equal(r2.failed, 0);
  // a later single timeout starts the streak from 1 again (block success reset it)
  dropNext = true;
  await blocks.readMappings(client, TARGET, seko, { runModes: memory });
  assert.equal(memory.size, 0);
});

test('readMappings: block spanning a hole times out AND its sub-blocks time out -> nothing remembered (flaky bus, not the hole)', async () => {
  const client = stubClient({ registers: { 10: 1, 11: 2, 14: 5 }, reject: () => new Error('Request timeout') });
  const memory = new Map();
  const r = await blocks.readMappings(client, TARGET, [reg(10), reg(11), reg(14)], { runModes: memory });
  assert.deepEqual(client.calls.map(c => [c.address, c.quantity]), [[10, 5], [10, 2], [14, 1]]);
  assert.equal(r.attempted, 3);
  assert.equal(r.failed, 3);
  assert.equal(memory.size, 0);
  assert.equal(r.readings.length, 0);
});

test('readMappings: in split mode a rejected sub-block drops the whole run to per-mapping, without re-reading what succeeded', async () => {
  const registers = { 10: 1, 11: 2, 14: 5, 15: 6 };
  const client = stubClient({ registers, reject: ({ address, quantity }) => (quantity > 1 && address !== 10 ? modbusException(2) : null) });
  const memory = new Map([['4:10:6', blocks.MODE_SPLIT]]);
  const r = await blocks.readMappings(client, TARGET, [reg(10), reg(11), reg(14), reg(15)], { runModes: memory });
  assert.deepEqual(client.calls.map(c => [c.address, c.quantity]), [[10, 2], [14, 2], [14, 1], [15, 1]]);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.readings.map(x => x.value), [1, 2, 5, 6]);
  assert.equal(memory.get('4:10:6'), blocks.MODE_SINGLE);
});

test('readMappings: a timed-out hole-free block is NOT retried per mapping; its mappings count as failed, other runs still succeed', async () => {
  const registers = { 1: 11, 2: 22, 50: 55 };
  const client = stubClient({ registers, reject: ({ address }) => (address === 1 ? new Error('Request timeout') : null) });
  const r = await blocks.readMappings(client, TARGET, [reg(1), reg(2), reg(50)]);
  assert.deepEqual(client.calls, [{ fc: 4, address: 1, quantity: 2 }, { fc: 4, address: 50, quantity: 1 }]);
  assert.equal(r.attempted, 3);
  assert.equal(r.failed, 2);
  assert.deepEqual(r.readings.map(x => [x.address, x.value]), [[50, 55]]);
  assert.equal(r.connectionError, null);
  assert.match(r.lastError.message, /timeout/);
});

test('readMappings: a connection-level error short-circuits the cycle (later runs are not attempted)', async () => {
  const client = stubClient({ reject: () => new Error('connect EHOSTUNREACH 192.168.1.7:502') });
  const r = await blocks.readMappings(client, TARGET, [reg(1), reg(2), reg(50)]);
  assert.equal(client.calls.length, 1);
  assert.equal(r.readings.length, 0);
  assert.equal(r.attempted, 2);
  assert.equal(r.failed, 2);
  assert.ok(r.connectionError);
});

test('readMappings: per-mapping fallback partial failure keeps the successful readings', async () => {
  const registers = { 1: 11, 3: 33 };
  const client = stubClient({
    registers,
    reject: ({ address, quantity }) => (quantity > 1 ? modbusException(2) : address === 2 ? new Error('Request timeout') : null),
  });
  const r = await blocks.readMappings(client, TARGET, [reg(1), reg(2), reg(3)]);
  assert.equal(r.attempted, 3);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.readings.map(x => x.value), [11, 33]);
});

test('readMappings: gapMs sleeps between consecutive requests to the device, never before the first', async () => {
  const sleeps = [];
  const client = stubClient({ registers: { 1: 1, 50: 5, 100: 7 } });
  await blocks.readMappings(client, TARGET, [reg(1), reg(50), reg(100)], { gapMs: 300, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(client.calls.length, 3);
  assert.deepEqual(sleeps, [300, 300]);
});

// ---------------------------------------------------------------------------
// ModbusTcpClient: per-unit inter-request gap with a stubbed clock
// ---------------------------------------------------------------------------

function fakeClock() {
  let now = 1_000_000;
  const sleeps = [];
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  };
}

function primedClient(clock) {
  const client = new ModbusTcpClient({ now: clock.now, sleep: clock.sleep });
  // Pretend the pool already holds a live connection so no TCP is attempted.
  const key = client.getConnectionKey('192.168.1.7', 502);
  client.connectionPool.set(key, { connected: true, client: {}, updateActivity() {}, disconnect: async () => {}, reconnect: async () => { throw new Error('no'); } });
  client.requestQueues.set(key, []);
  client.processing.set(key, false);
  return client;
}

test('ModbusTcpClient gap: second request to the same unit waits out the remaining gap; a different unit on the same gateway does not', async () => {
  const clock = fakeClock();
  const client = primedClient(clock);
  client.setRequestGap('192.168.1.7', 502, 3, 300);
  assert.equal(client.getRequestGap('192.168.1.7', 502, 3), 300);

  const op = async () => { clock.advance(180); return 'ok'; }; // the SEKO answers in ~180 ms

  await client.queueRequest('192.168.1.7', 502, 3, op);
  assert.deepEqual(clock.sleeps, []);                         // first request: no wait

  clock.advance(50);                                          // 50 ms later, poller issues the next one
  await client.queueRequest('192.168.1.7', 502, 3, op);
  assert.deepEqual(clock.sleeps, [250]);                      // waited 300 - 50

  clock.advance(10);
  await client.queueRequest('192.168.1.7', 502, 6, op);       // relay board on the same bus: no gap configured
  assert.deepEqual(clock.sleeps, [250]);

  clock.advance(1000);                                        // well past the gap: no wait
  await client.queueRequest('192.168.1.7', 502, 3, op);
  assert.deepEqual(clock.sleeps, [250]);
  await client.shutdown();
});

test('ModbusTcpClient gap: measured from when the previous request FINISHED (including a timeout/failure), and applied before a retry', async () => {
  const clock = fakeClock();
  const client = primedClient(clock);
  client.setRequestGap('192.168.1.7', 502, 3, 300);

  let n = 0;
  const flaky = async () => { n++; clock.advance(20); if (n === 1) throw new Error('CRC error'); return 'ok'; };
  // retries: 2 -> attempt 1 fails at t+20, the 1 s inter-attempt wait covers the gap, attempt 2 succeeds
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => origSetTimeout(() => { if (ms === 1000) clock.advance(1000); fn(); }, 0);
  try {
    await client.queueRequest('192.168.1.7', 502, 3, flaky, { retries: 2 });
  } finally {
    global.setTimeout = origSetTimeout;
  }
  assert.equal(n, 2);
  assert.deepEqual(clock.sleeps, []); // the 1000 ms retry pause already exceeded the 300 ms gap

  // Now a request straight after the failure-then-success: gap measured from the last finish
  await client.queueRequest('192.168.1.7', 502, 3, async () => 'ok');
  assert.deepEqual(clock.sleeps, [300]);
  await client.shutdown();
});

test('ModbusTcpClient: a Modbus exception response is not retried', async () => {
  const clock = fakeClock();
  const client = primedClient(clock);
  let n = 0;
  await assert.rejects(
    client.queueRequest('192.168.1.7', 502, 3, async () => { n++; throw modbusException(2); }, { retries: 3 }),
    /Modbus exception 2/
  );
  assert.equal(n, 1);
  await client.shutdown();
});

test('ModbusTcpClient: setRequestGap(0) clears the gap', async () => {
  const clock = fakeClock();
  const client = primedClient(clock);
  client.setRequestGap('192.168.1.7', 502, 3, 300);
  client.setRequestGap('192.168.1.7', 502, 3, 0);
  assert.equal(client.getRequestGap('192.168.1.7', 502, 3), 0);
  await client.queueRequest('192.168.1.7', 502, 3, async () => 'a');
  await client.queueRequest('192.168.1.7', 502, 3, async () => 'b');
  assert.deepEqual(clock.sleeps, []);
  await client.shutdown();
});
