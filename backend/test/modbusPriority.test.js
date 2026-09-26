// Part B (2026-09-26 15:32:35 incident): a 12 s pH Down pulse stayed open 17 s
// because its OFF write waited on the shared USR gateway (192.168.1.7:502)
// behind SEKO reads and a 5 s timeout. These tests drive ModbusTcpClient's
// host:port queue with a stubbed slow bus — no sockets are opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ModbusTcpClient } = require(path.join(__dirname, '..', 'src', 'services', 'ModbusTcpClient.js'));

const HOST = '192.0.2.7';
const PORT = 502;

function slowBusClient(opts = {}) {
  const client = new ModbusTcpClient(opts);
  const key = client.getConnectionKey(HOST, PORT);
  // A live pooled connection so no TCP is attempted.
  client.connectionPool.set(key, { connected: true, client: {}, updateActivity() {}, disconnect: async () => {}, reconnect: async () => { throw new Error('no reconnect in tests'); } });
  client.requestQueues.set(key, []);
  client.processing.set(key, false);
  return client;
}

/** Records every operation on the wire: start/end times and overlap. */
function wire() {
  const t0 = Date.now();
  const log = [];
  let active = 0;
  let maxActive = 0;
  const op = (name, { ms = 0, hang = false } = {}) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    const entry = { name, start: Date.now() - t0, end: null };
    log.push(entry);
    try {
      if (hang) await new Promise(() => {}); // lost frame: only the client's timeout ends it
      await new Promise(r => setTimeout(r, ms));
      return name;
    } finally {
      // (a hung op never reaches here; the client times it out and moves on)
      entry.end = Date.now() - t0;
      active--;
    }
  };
  // A hung operation keeps `active` raised; count overlap by start/end instead.
  return { log, op, now: () => Date.now() - t0, maxActive: () => maxActive };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('slow bus: an OFF write queued behind four SEKO sub-block reads (each losing its frame -> 150 ms timeout) waits for at most the ONE read on the wire', async () => {
  const w = wire();
  const c2 = slowBusClient();
  const conn = c2.connectionPool.get(c2.getConnectionKey(HOST, PORT));
  conn.client.setID = () => {};
  conn.client.writeCoil = async () => { w.log.push({ name: 'OFF', start: w.now(), end: w.now() }); };
  const timeouts = [];
  const readPs = [0, 1, 2, 3].map(i => c2.queueRequest(HOST, PORT, 3, w.op(`seko${i}`, { hang: true }), { timeout: 150, retries: 1 }).catch(e => { timeouts.push(e.message); }));
  await sleep(20);                                       // the first SEKO read is on the wire
  const enqueuedAt = w.now();
  const offP = c2.writeSingleCoil(HOST, PORT, 2, 1, false, { timeout: 500, retries: 1 });
  await offP;
  const off = w.log.find(e => e.name === 'OFF');
  assert.ok(off, 'the OFF went out');
  const waited = off.start - enqueuedAt;
  assert.ok(waited <= 150 + 40, `OFF waited ${waited} ms (one in-flight 150 ms read at most)`);
  const order = w.log.map(e => e.name);
  assert.deepEqual(order.slice(0, 2), ['seko0', 'OFF'], `order ${order.join(',')}`);
  await Promise.all(readPs);
  assert.equal(timeouts.length, 4, 'every SEKO read still ran and timed out on its own');
  assert.deepEqual(w.log.map(e => e.name), ['seko0', 'OFF', 'seko1', 'seko2', 'seko3']);
  await c2.shutdown();
});

test('priority: writes default to HIGH and overtake queued normal reads; FIFO inside a class; nothing ever overlaps on the wire', async () => {
  const client = slowBusClient();
  const w = wire();
  const conn = client.connectionPool.get(client.getConnectionKey(HOST, PORT));
  conn.client.setID = () => {};
  conn.client.writeCoil = async (a, v) => { const e = { name: `W${a}`, start: w.now() }; w.log.push(e); await sleep(10); e.end = w.now(); };
  const ps = [];
  ps.push(client.queueRequest(HOST, PORT, 6, w.op('poll6', { ms: 60 })));     // on the wire first
  await sleep(5);
  ps.push(client.queueRequest(HOST, PORT, 3, w.op('seko-a', { ms: 30 })));
  ps.push(client.queueRequest(HOST, PORT, 2, w.op('poll2', { ms: 30 })));
  ps.push(client.writeSingleCoil(HOST, PORT, 2, 1, true));                    // high
  ps.push(client.queueRequest(HOST, PORT, 3, w.op('seko-b', { ms: 30 })));
  ps.push(client.writeSingleCoil(HOST, PORT, 2, 2, false));                   // high, after W1
  await Promise.all(ps);
  assert.deepEqual(w.log.map(e => e.name), ['poll6', 'W1', 'W2', 'seko-a', 'poll2', 'seko-b']);
  const sorted = [...w.log].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, `${sorted[i].name} overlapped ${sorted[i - 1].name}`);
  await client.shutdown();
});

test('priority: a failing normal read yields to a waiting HIGH write before its retry (no 1 s retry pause holding the bus)', async () => {
  const client = slowBusClient();
  const w = wire();
  const conn = client.connectionPool.get(client.getConnectionKey(HOST, PORT));
  conn.client.setID = () => {};
  conn.client.writeCoil = async (a) => { w.log.push({ name: `W${a}`, start: w.now(), end: w.now() }); };
  let n = 0;
  const flaky = async () => { n++; w.log.push({ name: `read#${n}`, start: w.now(), end: w.now() + 50 }); await sleep(50); if (n === 1) throw new Error('Request timeout'); return 'ok'; };
  const readP = client.queueRequest(HOST, PORT, 6, flaky, { retries: 3 });
  await sleep(10);
  const t = w.now();
  await client.writeSingleCoil(HOST, PORT, 2, 1, false);
  const wEntry = w.log.find(e => e.name === 'W1');
  assert.ok(wEntry.start - t <= 50 + 30, `write waited ${wEntry.start - t} ms`);
  assert.equal(await readP, 'ok');
  assert.deepEqual(w.log.map(e => e.name), ['read#1', 'W1', 'read#2']);
  await client.shutdown();
});

test('bus gap: a SEKO request waits for 300 ms of BUS quiet after another unit\'s request, and a HIGH write arriving during that wait goes first', async () => {
  const client = slowBusClient();
  client.setRequestGap(HOST, PORT, 3, 300);
  const w = wire();
  const conn = client.connectionPool.get(client.getConnectionKey(HOST, PORT));
  conn.client.setID = () => {};
  conn.client.writeCoil = async (a) => { w.log.push({ name: `W${a}`, start: w.now(), end: w.now() }); };
  await client.queueRequest(HOST, PORT, 6, w.op('poll6', { ms: 5 }));
  const polledAt = w.now();
  const sekoP = client.queueRequest(HOST, PORT, 3, w.op('seko', { ms: 5 }));
  await sleep(50);
  const t = w.now();
  await client.writeSingleCoil(HOST, PORT, 2, 1, false);
  await sekoP;
  const seko = w.log.find(e => e.name === 'seko');
  const wr = w.log.find(e => e.name === 'W1');
  assert.ok(wr.start - t < 30, `write not held by the SEKO gap (${wr.start - t} ms)`);
  assert.ok(wr.start < seko.start, 'write went before the SEKO request');
  assert.ok(seko.start - wr.end >= 290, `SEKO waited ${seko.start - wr.end} ms of bus quiet after the write`);
  assert.ok(seko.start - polledAt >= 290);
  await client.shutdown();
});
