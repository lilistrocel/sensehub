// In-memory DB: utils/database builds the full schema (incl. mqtt_monitors / irrigation_cycles).
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const P = src('services', 'MqttPayloads.js');
const { Downsampler, effectiveStatus, STALE_AFTER_MS } = src('services', 'MqttDownsampler.js');
const { MqttIngestService } = src('services', 'MqttIngestService.js');
const { db } = src('utils', 'database.js');

const quiet = { log() {}, warn() {}, error() {} };
const T0 = 1790344540670; // 2026-09-25T13:55:40.670Z — the vendor example's ts

// Vendor-doc example payloads
const FLOW = { v: 1, ts: T0, time: '2026-09-25T17:55:40+04:00', flow_lph: 8820.4, net_total_m3: 70.7348, signal_quality: 91, signal_up_pct: 79.5, signal_down_pct: 79.6, error_flags: 0 };
const DOSING = { v: 1, ts: T0 + 996, time: '2026-09-25T17:55:41+04:00', tanks: [
  { id: 1, consumed_l: 146.5, rate_lph: 58.5 }, { id: 2, consumed_l: 144.5, rate_lph: 69.4 },
  { id: 3, consumed_l: 130.25, rate_lph: 61.7 }, { id: 4, consumed_l: 67.75, rate_lph: 31.9 },
  { id: 5, consumed_l: 0, rate_lph: null }] };
const STATE_IDLE = { v: 1, ts: T0 + 42277, time: '2026-09-25T17:56:22+04:00', active: false, since: null };
const REPORT = { v: 1, cycle_id: '20260925T174000', start: '2026-09-25T17:40:00+04:00', end: '2026-09-25T17:48:07+04:00', duration_s: 487, water_m3: 1.2121,
  dosing: [{ id: 1, consumed_l: 6.00 }, { id: 2, consumed_l: 0.00 }, { id: 3, consumed_l: 0.00 }, { id: 4, consumed_l: 5.75 }, { id: 5, consumed_l: 0.00 }] };
const buf = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));

let farmSeq = 5000;
function harness() {
  const farm = String(++farmSeq);
  let now = T0;
  const alerts = [];
  const events = [];
  const mk = () => new MqttIngestService({
    db, logger: quiet, now: () => now,
    createAlert: (a) => { alerts.push(a); return a; },
    broadcast: (type, data) => events.push({ type, data }),
    config: { enabled: false },
  });
  const svc = mk();
  return {
    farm, svc, alerts, events, mk,
    t: (topic) => `farm/${farm}/${topic}`,
    at: (ms) => { now = ms; },
    get now() { return now; },
    eq: () => db.prepare("SELECT * FROM equipment WHERE protocol = 'mqtt' AND address = ?").all(`farm/${farm}/#`),
    readings: (name) => db.prepare(
      `SELECT r.* FROM readings r JOIN equipment e ON e.id = r.equipment_id WHERE e.address = ?${name ? ' AND r.name = ?' : ''} ORDER BY r.id`
    ).all(...[`farm/${farm}/#`].concat(name ? [name] : [])),
  };
}

// ─── payload parsing / validation ───────────────────────────────────────────

test('parseTopic accepts the contract topics and rejects everything else', () => {
  assert.deepEqual(P.parseTopic('farm/1021/flowmeter/live'), { farmId: '1021', kind: 'flowmeter' });
  assert.deepEqual(P.parseTopic('farm/1021/dosing/live'), { farmId: '1021', kind: 'dosing' });
  assert.deepEqual(P.parseTopic('farm/1021/irrigation/report'), { farmId: '1021', kind: 'irrigation_report' });
  assert.deepEqual(P.parseTopic('farm/7/status'), { farmId: '7', kind: 'status' });
  assert.equal(P.parseTopic('farm/1021/flowmeter'), null);
  assert.equal(P.parseTopic('farm/1021/flowmeter/live/extra'), null);
  assert.equal(P.parseTopic('farms/1021/status'), null);
  assert.equal(P.parseTopic('farm/../status'), null);
  assert.equal(P.parseTopic('farm/a b/status'), null);
  assert.equal(P.parseTopic(null), null);
});

test('parseEnvelope enforces JSON object + schema v=1 + size', () => {
  assert.equal(P.parseEnvelope(buf(FLOW)).flow_lph, 8820.4);
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.equal(code(() => P.parseEnvelope(buf({ ...FLOW, v: 2 }))), 'bad_version');
  assert.equal(code(() => P.parseEnvelope(buf({ flow_lph: 1 }))), 'bad_version');
  assert.equal(code(() => P.parseEnvelope(buf('not json'))), 'bad_json');
  assert.equal(code(() => P.parseEnvelope(buf('[1,2]'))), 'bad_shape');
  assert.equal(code(() => P.parseEnvelope(Buffer.alloc(0))), 'empty');
  assert.equal(code(() => P.parseEnvelope(Buffer.alloc(P.MAX_PAYLOAD_BYTES + 1, 32))), 'too_large');
});

test('parseFlowmeter keeps finite fields, drops non-finite / out-of-range ones', () => {
  const ok = P.parseFlowmeter(FLOW);
  assert.deepEqual(ok.invalid, []);
  assert.equal(ok.values.net_total_m3, 70.7348);
  // JSON.parse('1e400') === Infinity; strings are not numbers.
  const bad = P.parseFlowmeter(JSON.parse('{"v":1,"flow_lph":1e400,"net_total_m3":"70.7","signal_quality":150,"error_flags":1.5,"signal_up_pct":50}'));
  assert.deepEqual(bad.values, { signal_up_pct: 50 });
  assert.deepEqual(bad.invalid.sort(), ['error_flags', 'flow_lph', 'net_total_m3', 'signal_quality']);
  assert.throws(() => P.parseFlowmeter({ v: 1, flow_lph: 'x' }), { code: 'no_valid_fields' });
  const metrics = P.flowmeterMetrics(ok.values).map(m => m.name);
  assert.deepEqual(metrics, ['Flow Rate', 'Net Total', 'Signal Quality', 'Error Flags']);
});

test('parseDosing: null tank-5 rate stays null and is never recorded as 0', () => {
  const { tanks } = P.parseDosing(DOSING);
  assert.equal(tanks.length, 5);
  assert.equal(tanks[4].rate_lph, null);
  assert.equal(tanks[4].consumed_l, 0);
  const names = P.dosingMetrics(tanks).map(m => m.name);
  assert.ok(names.includes('Tank 5 Consumed'));
  assert.ok(!names.includes('Tank 5 Rate'));
  assert.equal(names.length, 9);
  assert.throws(() => P.parseDosing({ v: 1, tanks: 'x' }), { code: 'bad_field' });
  const partial = P.parseDosing({ v: 1, tanks: [{ id: 1, consumed_l: -3, rate_lph: 2 }, { id: 1, consumed_l: 5 }] });
  assert.deepEqual(partial.tanks, [{ id: 1, consumed_l: null, rate_lph: 2 }]);
  assert.deepEqual(partial.invalid, ['tank1.consumed_l', 'tank:1']);
});

test('parseReport validates cycle_id/dates/numbers and allows water_m3 null', () => {
  const r = P.parseReport(REPORT);
  assert.equal(r.cycle_id, '20260925T174000');
  assert.equal(r.water_m3, 1.2121);
  assert.equal(r.dosing.length, 5);
  assert.equal(P.parseReport({ ...REPORT, water_m3: null }).water_m3, null);
  assert.throws(() => P.parseReport({ ...REPORT, cycle_id: '2026-09-25' }), { code: 'bad_field' });
  assert.throws(() => P.parseReport({ ...REPORT, start: 'yesterday' }), { code: 'bad_field' });
  assert.throws(() => P.parseReport({ ...REPORT, duration_s: -1 }), { code: 'bad_field' });
  assert.throws(() => P.parseReport({ ...REPORT, dosing: [{ id: 1, consumed_l: 'x' }] }), { code: 'bad_field' });
});

test('pickTimestamp uses device ts only inside the sanity window', () => {
  assert.deepEqual(P.pickTimestamp({ ts: T0 - 500 }, T0), { ms: T0 - 500, source: 'device' });
  assert.deepEqual(P.pickTimestamp({ ts: T0 - 3600e3 }, T0), { ms: T0, source: 'receive' });
  assert.deepEqual(P.pickTimestamp({ ts: T0 + 3600e3 }, T0), { ms: T0, source: 'receive' });
  assert.deepEqual(P.pickTimestamp({}, T0), { ms: T0, source: 'receive' });
  assert.deepEqual(P.pickTimestamp({ ts: '1790344540670' }, T0), { ms: T0, source: 'receive' });
});

// ─── downsampling ───────────────────────────────────────────────────────────

test('Downsampler: 0.5 s stream while irrigating -> one row per 10 s', () => {
  const ds = new Downsampler();
  let kept = 0;
  for (let i = 0; i < 120; i++) if (ds.shouldRecord(1, 'Flow Rate', 8800 + i, T0 + i * 500, true)) kept++;
  assert.equal(kept, 6); // t = 0, 10, 20, 30, 40, 50 s
});

test('Downsampler: idle unchanged value -> only the 5 min heartbeat; a change records after 30 s', () => {
  const ds = new Downsampler();
  let kept = 0;
  for (let i = 0; i <= 60; i++) if (ds.shouldRecord(1, 'Tank 1 Consumed', 146.5, T0 + i * 10000, false)) kept++;
  assert.equal(kept, 3); // t = 0, 300 s, 600 s
  assert.equal(ds.shouldRecord(1, 'Tank 1 Consumed', 147, T0 + 620000, false), false); // < 30 s since last
  assert.equal(ds.shouldRecord(1, 'Tank 1 Consumed', 147, T0 + 630000, false), true);
});

test('Downsampler.forceAll records the next sample of every known metric once', () => {
  const ds = new Downsampler();
  ds.shouldRecord(1, 'A', 1, T0, false);
  ds.shouldRecord(1, 'B', 1, T0, false);
  ds.shouldRecord(2, 'A', 1, T0, false);
  ds.forceAll(1);
  assert.equal(ds.shouldRecord(1, 'A', 1, T0 + 1000, false), true);
  assert.equal(ds.shouldRecord(1, 'A', 1, T0 + 2000, false), false);
  assert.equal(ds.shouldRecord(1, 'B', 1, T0 + 1000, false), true);
  assert.equal(ds.shouldRecord(2, 'A', 1, T0 + 1000, false), false);
});

// ─── staleness ──────────────────────────────────────────────────────────────

test('effectiveStatus: never / stale -> offline, LWT after last data -> offline, error_flags -> warning', () => {
  assert.equal(effectiveStatus({ lastLiveMs: null, brokerState: 'online' }, T0), 'offline');
  assert.equal(effectiveStatus({ lastLiveMs: T0, brokerState: 'online' }, T0 + 1000), 'online');
  assert.equal(effectiveStatus({ lastLiveMs: T0, brokerState: 'online' }, T0 + STALE_AFTER_MS + 1), 'offline');
  assert.equal(effectiveStatus({ lastLiveMs: T0, brokerState: 'offline', brokerStateMs: T0 + 5 }, T0 + 10), 'offline');
  assert.equal(effectiveStatus({ lastLiveMs: T0 + 10, brokerState: 'offline', brokerStateMs: T0 + 5 }, T0 + 20), 'online');
  assert.equal(effectiveStatus({ lastLiveMs: T0, brokerState: 'online', errorFlags: 4 }, T0 + 10), 'warning');
});

// ─── service: provisioning, readings, status, alerts, reports ──────────────

test('service provisions one equipment row per farm, idempotently across restarts', () => {
  const h = harness();
  h.svc.handleMessage(h.t('status'), buf({ v: 1, state: 'online' }), { retain: true });
  h.svc.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  h.svc.handleMessage(h.t('dosing/live'), buf(DOSING), {});
  assert.equal(h.eq().length, 1);
  const eq = h.eq()[0];
  assert.equal(eq.name, `Irrigation Monitor ${h.farm}`);
  assert.equal(eq.protocol, 'mqtt');
  assert.equal(eq.type, 'sensor');
  assert.equal(eq.polling_interval_ms, 30000);

  // "Restart": a fresh service over the same DB re-uses the row.
  const svc2 = h.mk();
  svc2._loadState();
  svc2.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  assert.equal(h.eq().length, 1);
  assert.equal(svc2.getSnapshot(h.farm).equipment_id, eq.id);

  // Lost state row: an orphaned equipment row with the same address is re-adopted.
  db.prepare('DELETE FROM mqtt_monitors WHERE farm_id = ?').run(h.farm);
  const svc3 = h.mk();
  svc3.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  assert.equal(h.eq().length, 1);
});

test('unknown schema version / bad JSON is ignored and does not provision', () => {
  const h = harness();
  const r1 = h.svc.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, v: 2 }), {});
  const r2 = h.svc.handleMessage(h.t('dosing/live'), buf('{oops'), {});
  assert.equal(r1.reason, 'bad_version');
  assert.equal(r2.reason, 'bad_json');
  assert.equal(h.eq().length, 0);
  assert.equal(h.svc.getHealth().messages.rejected, 2);
});

test('live messages write downsampled readings with device ts; null tank rate is skipped', () => {
  const h = harness();
  h.svc.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  h.svc.handleMessage(h.t('dosing/live'), buf(DOSING), {});
  const names = h.readings().map(r => r.name);
  assert.ok(names.includes('Flow Rate'));
  assert.ok(names.includes('Tank 5 Consumed'));
  assert.ok(!names.includes('Tank 5 Rate'));
  assert.ok(!names.includes('Signal Up')); // display-only
  assert.equal(h.readings('Flow Rate')[0].timestamp, new Date(T0).toISOString());
  assert.equal(h.readings('Flow Rate')[0].unit, 'L/h');

  // 60 s of 0.5 s flow samples while irrigating -> ~one row per 10 s, not 120.
  h.svc.handleMessage(h.t('irrigation/state'), buf({ v: 1, ts: T0 + 100, active: true, since: '2026-09-25T17:55:40+04:00' }), {});
  const before = h.readings('Flow Rate').length;
  for (let i = 1; i <= 120; i++) {
    h.at(T0 + 1000 + i * 500);
    h.svc.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, ts: T0 + 1000 + i * 500, flow_lph: 8800 + i }), {});
  }
  const added = h.readings('Flow Rate').length - before;
  assert.ok(added >= 6 && added <= 7, `expected 6-7 flow rows, got ${added}`);
});

test('retained replay of a live topic neither records readings nor counts as liveness', () => {
  const h = harness();
  h.svc.handleMessage(h.t('flowmeter/live'), buf(FLOW), { retain: true });
  assert.equal(h.readings().length, 0);
  const snap = h.svc.getSnapshot(h.farm);
  assert.equal(snap.last_seen, null);
  assert.equal(snap.status, 'offline');
});

test('staleness: online while fresh, offline after 60 s silence, LWT offline immediately, back on data', () => {
  const h = harness();
  h.svc.handleMessage(h.t('status'), buf({ v: 1, state: 'online' }), {});
  h.svc.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  const id = h.eq()[0].id;
  const status = () => db.prepare('SELECT status FROM equipment WHERE id = ?').get(id).status;
  assert.equal(status(), 'online');

  h.at(T0 + 59000); h.svc.tick(h.now);
  assert.equal(status(), 'online');
  h.at(T0 + 61000); h.svc.tick(h.now);
  assert.equal(status(), 'offline'); // status said online, but no data for > 60 s
  assert.ok(h.events.some(e => e.type === 'equipment_status' && e.data.status === 'offline'));

  h.at(T0 + 70000);
  h.svc.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, ts: T0 + 70000 }), {});
  assert.equal(status(), 'online');

  h.at(T0 + 71000);
  h.svc.handleMessage(h.t('status'), buf({ v: 1, state: 'offline' }), {}); // LWT
  assert.equal(status(), 'offline');
  // last_communication is the last LIVE message, which WatchdogService uses for its 5 min offline alert
  assert.equal(db.prepare('SELECT last_communication FROM equipment WHERE id = ?').get(id).last_communication, new Date(T0 + 70000).toISOString());
});

test('error_flags alert fires once per distinct non-zero value, with a stable fingerprint', () => {
  const h = harness();
  const send = (flags, dt) => { h.at(T0 + dt); h.svc.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, ts: T0 + dt, error_flags: flags }), {}); };
  send(0, 0); send(4, 1000); send(4, 2000); send(4, 3000);
  assert.equal(h.alerts.length, 1);
  const id = h.eq()[0].id;
  assert.equal(h.alerts[0].fingerprint, `mqtt_error_flags:${id}:4`);
  assert.equal(h.alerts[0].severity, 'warning');
  assert.equal(db.prepare('SELECT status FROM equipment WHERE id = ?').get(id).status, 'warning');
  send(8, 4000);
  assert.equal(h.alerts.length, 2);
  send(0, 5000); send(8, 6000);
  assert.equal(h.alerts.length, 3); // cleared then recurred -> alert again
  // A restart does not re-alert the same still-active code.
  const svc2 = h.mk(); svc2._loadState();
  const before = h.alerts.length;
  svc2.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, ts: T0 + 7000, error_flags: 8 }), {});
  assert.equal(h.alerts.length, before);
});

test('irrigation report upsert is idempotent on (farm, cycle_id); a changed payload updates in place', () => {
  const h = harness();
  const r1 = h.svc.handleMessage(h.t('irrigation/report'), buf(REPORT), { retain: false });
  const r2 = h.svc.handleMessage(h.t('irrigation/report'), buf(REPORT), { retain: true }); // replay on resubscribe
  const r3 = h.svc.handleMessage(h.t('irrigation/report'), buf(REPORT), { retain: true });
  assert.equal(r1.outcome, 'inserted');
  assert.equal(r2.outcome, 'unchanged');
  assert.equal(r3.outcome, 'unchanged');
  let rows = db.prepare('SELECT * FROM irrigation_cycles WHERE farm_id = ?').all(h.farm);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].water_m3, 1.2121);
  assert.equal(rows[0].duration_s, 487);
  assert.deepEqual(JSON.parse(rows[0].dosing_json)[3], { id: 4, consumed_l: 5.75 });
  assert.equal(h.events.filter(e => e.type === 'irrigation_cycle').length, 1);

  const r4 = h.svc.handleMessage(h.t('irrigation/report'), buf({ ...REPORT, water_m3: null }), {});
  assert.equal(r4.outcome, 'updated');
  rows = db.prepare('SELECT * FROM irrigation_cycles WHERE farm_id = ?').all(h.farm);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].water_m3, null);

  // A fresh service (restart) replaying the retained report still stores nothing new.
  const svc2 = h.mk(); svc2._loadState();
  assert.equal(svc2.handleMessage(h.t('irrigation/report'), buf({ ...REPORT, water_m3: null }), { retain: true }).outcome, 'unchanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM irrigation_cycles WHERE farm_id = ?').get(h.farm).n, 1);
});

test('irrigation state change is recorded and persisted; meta stored raw', () => {
  const h = harness();
  h.svc.handleMessage(h.t('meta'), buf({ v: 1, fields: { flow_lph: 'L/h' } }), { retain: true });
  h.svc.handleMessage(h.t('irrigation/state'), buf(STATE_IDLE), {});
  h.at(T0 + 60000);
  h.svc.handleMessage(h.t('irrigation/state'), buf({ v: 1, ts: T0 + 60000, active: true, since: '2026-09-25T17:56:40+04:00' }), {});
  const rows = h.readings('Irrigation Active').map(r => r.value);
  assert.deepEqual(rows, [0, 1]);
  const mon = db.prepare('SELECT * FROM mqtt_monitors WHERE farm_id = ?').get(h.farm);
  assert.equal(mon.irrigation_active, 1);
  assert.equal(JSON.parse(mon.meta_json).fields.flow_lph, 'L/h');
  assert.equal(h.svc.getSnapshot(h.farm).irrigation.active, true);
});

test('cycle date filter compares device-offset times correctly in SQLite', () => {
  // start 17:40+04:00 == 13:40Z
  const n = (iso) => db.prepare("SELECT julianday('2026-09-25T17:40:00+04:00') >= julianday(?) AS ok").get(iso).ok;
  assert.equal(n('2026-09-25T13:39:59.000Z'), 1);
  assert.equal(n('2026-09-25T13:40:01.000Z'), 0);
});

test('deleting the equipment makes the service forget the monitor; next message re-provisions', () => {
  const h = harness();
  h.svc.handleMessage(h.t('flowmeter/live'), buf(FLOW), {});
  const id = h.eq()[0].id;
  db.prepare('DELETE FROM equipment WHERE id = ?').run(id);
  h.at(T0 + 31000); h.svc.tick(h.now);
  assert.equal(h.svc.getSnapshot(h.farm), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mqtt_monitors WHERE farm_id = ?').get(h.farm).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readings WHERE equipment_id = ?').get(id).n, 0); // FK cascade
  h.svc.handleMessage(h.t('flowmeter/live'), buf({ ...FLOW, ts: T0 + 31000 }), {});
  assert.equal(h.eq().length, 1);
  assert.notEqual(h.eq()[0].id, id);
});
