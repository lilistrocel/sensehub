// SEKO Kontrol 800 EC auto-range decoding (services/ModbusAutoRange.js) — incident
// 2026-09-26 "EC 10x too low". Sequences are real stored readings of equipment 17
// "Water EC" (stored at the old fixed scale x0.1, so raw = stored x 10).
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { decodeAutoRange, seedFromHistory } = src('services', 'ModbusAutoRange.js');
const { ModbusPollingService, AUTO_RANGE_STATE_KEY } = src('services', 'ModbusPollingService.js');
const { patchMappings } = src('utils', 'sekoEcAutoRange.js');
const { DoseController } = src('services', 'DoseController.js');

const AR = { lowScale: 0.1, highScale: 1, switchAt: 2000 };
const quiet = { log() {}, warn() {}, error() {} };

/** Decode a stored (x0.1) series from a starting state; returns decoded values. */
function replay(stored, start) {
  let st = start;
  return stored.map(v => {
    const d = decodeAutoRange(Math.round(v * 10), st, AR);
    st = { range: d.range, value: d.value };
    return d.value;
  });
}

// 2026-09-25 12:59:21 -> 13:05:55 (first fertigation run starts ~13:00)
const SEQ_RUN1_START = [1528.0, 1527.4, 1750.2, 285.9, 326.0, 368.0, 396.5, 399.1, 383.6];
// 13:08:26 -> 13:15:30 (end of that run: EC falls back below 2000 µS -> low range)
const SEQ_RUN1_END = [444.1, 446.2, 324.7, 217.2, 1398.5, 1096.2, 1388.7, 1609.5, 1675.3, 1647.4, 1733.2, 1958.9, 1953.5];
// 2026-09-26 03:30:04 -> 03:43:11 (07:30 run: stagnant cup, flush, then fertilised feed)
const SEQ_0730 = [1580.7, 922.1, 232.1, 278.8, 343.1, 387.6, 416.9, 426.8, 436.7, 452.2, 465.1, 467.8, 424.7, 623.0, 739.4, 834.1, 902.1, 961.7, 1000.3, 1000.3];
// 2026-09-26 08:28 -> 08:31 (12:30 run start, today)
const SEQ_1230 = [289.7, 288.8, 287.5, 232.0, 212.6, 220.0, 229.5];

test('real switch 2026-09-25T13:00:52Z: raw 17502 -> 2859 decodes 1750.2 -> 2859 µS (HIGH), then follows the run in µS', () => {
  const out = replay(SEQ_RUN1_START, { range: 'low', value: 1528.6 });
  assert.deepEqual(out, [1528, 1527.4, 1750.2, 2859, 3260, 3680, 3965, 3991, 3836]);
});

test('end of that run: 2172 µS (high) -> raw 13985 decodes 1398.5 µS (back to LOW) and stays below 2000', () => {
  const out = replay(SEQ_RUN1_END, { range: 'high', value: 4400 });
  assert.deepEqual(out.slice(0, 4), [4441, 4462, 3247, 2172]);
  assert.deepEqual(out.slice(4), [1398.5, 1096.2, 1388.7, 1609.5, 1675.3, 1647.4, 1733.2, 1958.9, 1953.5]);
});

test('07:30 run: stagnant 1580.7 -> flush 922.1 (low) -> raw 2321 = 2321 µS (HIGH) up to 10,003 µS (concentrate in the cup)', () => {
  const out = replay(SEQ_0730, { range: 'low', value: 1580.9 });
  assert.deepEqual(out.slice(0, 2), [1580.7, 922.1]);
  assert.equal(out[2], 2321);
  assert.deepEqual(out.slice(-3), [9617, 10003, 10003]);
});

test('today 12:30 run start decodes in µS: 2897 -> 2126 -> 2295 (2.1-2.9 mS/cm, as the SEKO panel shows)', () => {
  assert.deepEqual(replay(SEQ_1230, { range: 'high', value: 2900 }), [2897, 2888, 2875, 2320, 2126, 2200, 2295]);
});

test('boundary: 1999.9 µS low (raw 19999) -> raw 2003 = 2003 µS (2.00 mS/cm) HIGH; and 2010 high -> raw 19950 = 1995 µS LOW', () => {
  let d = decodeAutoRange(19999, { range: 'low', value: 1999.8 }, AR);
  assert.deepEqual([d.value, d.range], [1999.9, 'low']);
  d = decodeAutoRange(2003, { range: 'low', value: 1999.9 }, AR);
  assert.deepEqual([d.value, d.range, d.switched], [2003, 'high', true]);
  assert.equal((d.value / 1000).toFixed(2), '2.00');
  d = decodeAutoRange(19950, { range: 'high', value: 2010 }, AR);
  assert.deepEqual([d.value, d.range, d.switched], [1995, 'low', true]);
});

test('ambiguous jump (raw 9000 after 3000 µS: 9000 or 900?) keeps the range and flags it; no state -> 2000-5999 pattern assumed HIGH', () => {
  const d = decodeAutoRange(9000, { range: 'high', value: 3000 }, AR);
  assert.deepEqual([d.value, d.range, d.ambiguous, d.switched], [9000, 'high', true, false]);
  let n = decodeAutoRange(2859, null, AR);
  assert.deepEqual([n.value, n.range, n.assumed], [2859, 'high', true]);
  n = decodeAutoRange(15000, null, AR);
  assert.deepEqual([n.value, n.range], [1500, 'low']);
  n = decodeAutoRange(1200, { range: 'high', value: 2100 }, AR); // raw < 1800: cannot be the high range
  assert.deepEqual([n.value, n.range], [120, 'low']);
});

test('seed from stored history (old x0.1 values, then post-fix µS values): the real history ends HIGH', () => {
  const history = [...SEQ_RUN1_START, ...SEQ_RUN1_END, ...SEQ_0730, ...SEQ_1230];
  assert.deepEqual(seedFromHistory(history, AR, 0.1), { range: 'high', value: 2295 });
  // a post-fix high-range value (>= 2000) is taken as decoded
  assert.deepEqual(seedFromHistory([1500.2, 2950], AR, 0.1), { range: 'high', value: 2950 });
  assert.deepEqual(seedFromHistory([1500.2, 1400.1], AR, 0.1), { range: 'low', value: 1400.1 });
});

test('cross-check hints override continuity: fertilised feed forces HIGH, no dosing prefers the raw-water EC', () => {
  // flush read low (400), fertiliser dosing again, raw 2500: continuity says 250 µS, the monitor says fertilised
  const cont = decodeAutoRange(2500, { range: 'low', value: 400 }, AR);
  assert.equal(cont.value, 250);
  const fert = decodeAutoRange(2500, { range: 'low', value: 400 }, AR, { minValue: 1000, basis: 'dosing' });
  assert.deepEqual([fert.value, fert.range, fert.overridden], [2500, 'high', 'dosing']);
  // a low reading already above minValue is left alone
  assert.equal(decodeAutoRange(15000, { range: 'low', value: 1400 }, AR, { minValue: 1000 }).overridden, null);
  // run start: buffer flushed to raw water (< 2000 µS) between samples; raw 4000 read 4000 by continuity
  const c2 = decodeAutoRange(4000, { range: 'high', value: 3000 }, AR);
  assert.equal(c2.value, 4000);
  const water = decodeAutoRange(4000, { range: 'high', value: 3000 }, AR, { preferValue: 350, basis: 'raw_water' });
  assert.deepEqual([water.value, water.range, water.overridden], [400, 'low', 'raw_water']);
});

test('polling service: seeds from stored readings, decodes HIGH now, persists the state, never applies mapping.scale twice; hint override is reported', () => {
  const eqId = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO Kontrol 800 (Fertigation Water)', 'sensor', 'modbus', '192.0.2.8:502', 3, 'online')").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (?, 'Water EC', ?, 'µS/cm', ?)");
  const history = [...SEQ_RUN1_START, ...SEQ_RUN1_END, ...SEQ_0730, ...SEQ_1230];
  history.forEach((v, i) => ins.run(eqId, v, new Date(Date.parse('2026-09-25T12:59:00Z') + i * 30000).toISOString()));
  const svc = new ModbusPollingService();
  const logs = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try {
    const mapping = { name: 'Water EC', register: 1005, functionCode: 4, dataType: 'uint16', scale: 0.1, unit: 'µS/cm', autoRange: { ...AR } };
    assert.equal(svc.decodeAutoRange(eqId, mapping, 2475), 2475);
    const saved = JSON.parse(db.prepare('SELECT value FROM system_settings WHERE key = ?').get(AUTO_RANGE_STATE_KEY).value);
    assert.equal(saved[`${eqId}:Water EC`].range, 'high');
    assert.equal(svc.applyCalibration(2475, { calibration_scale: 1, calibration_offset: 0 }, mapping), 2475, 'scale 0.1 not applied to a decoded value');
    assert.equal(svc.applyCalibration(5823, { calibration_scale: 1, calibration_offset: 0 }, { scale: 0.001 }), 5.823, 'other mappings unchanged');
    // a fresh service (restart) seeds from the persisted state
    const svc2 = new ModbusPollingService();
    assert.equal(svc2.decodeAutoRange(eqId, mapping, 3100), 3100);
    // hint provider (DoseController.ecRangeHint) overriding continuity is reported
    const overrides = [];
    svc2.setAutoRangeHintProvider(() => ({ preferValue: 300, basis: 'raw_water', onOverride: (d) => overrides.push(d) }));
    assert.equal(svc2.decodeAutoRange(eqId, mapping, 3200), 320);
    assert.equal(overrides.length, 1);
    assert.deepEqual([overrides[0].basis, overrides[0].continuity, overrides[0].value], ['raw_water', 3200, 320]);
  } finally {
    console.log = logs.log; console.warn = logs.warn;
  }
});

test('register-map migration: the live SEKO mapping gets autoRange on 1005 only, label cleaned, note added, idempotent', () => {
  const live = [{ name: 'pH', label: 'pH', type: 'input', register: 1000, functionCode: 4, unit: 'pH', dataType: 'uint16', scale: 0.01 }, { name: 'Free Chlorine', label: 'Free Chlorine', type: 'input', register: 1001, functionCode: 4, unit: 'ppm', dataType: 'uint16', scale: 0.01, enabled: false }, { name: 'Water Temperature', label: 'Water Temperature', type: 'input', register: 1003, functionCode: 4, unit: '°C', dataType: 'uint16', scale: 0.1 }, { name: 'Water EC', label: 'Water EC (scale unverified)', type: 'input', register: 1005, functionCode: 4, unit: 'µS/cm', dataType: 'uint16', scale: 0.1 }, { name: 'Status Bits', label: 'Status Bits', type: 'input', register: 1008, functionCode: 4, unit: 'raw', dataType: 'uint16', scale: 1 }];
  const { changed, mappings } = patchMappings(live);
  assert.equal(changed, true);
  const ec = mappings.find(m => m.register === 1005);
  assert.deepEqual(ec.autoRange, AR);
  assert.equal(ec.label, 'Water EC');
  assert.equal(ec.name, 'Water EC', 'metric name (history key) unchanged');
  assert.match(ec.note, /auto-ranges/);
  assert.deepEqual(mappings.filter(m => m.register !== 1005), live.filter(m => m.register !== 1005));
  assert.equal(patchMappings(mappings).changed, false);
});

test('DoseController.ecRangeHint: fertilised while >= 2 tanks dose at 1:80-1:250 with water; raw-water preference only when configured', () => {
  let t = Date.parse('2026-09-26T08:30:00Z');
  const ctl = new DoseController({ db, now: () => t, logger: quiet, autoTick: false, config: { ph: { sensor_equipment_id: 4242 } } });
  const feed = (seconds, { flow = 8820, dosing = true } = {}) => {
    let net = 76281.1; const cons = { 1: 221, 2: 208.25, 3: 192.75, 4: 104 };
    for (let i = 0; i < seconds * 2; i++) {
      t += 500; net += (flow / 3600) * 0.5;
      ctl.ingest({ kind: 'flowmeter', farmId: '1021', receivedMs: t, live: true, values: { flow_lph: flow, net_total_m3: net / 1000, signal_quality: 95, error_flags: 0 } });
      if (i % 2) {
        for (const id of [1, 2, 3]) if (dosing) cons[id] += (flow / 150 / 3600);
        ctl.ingest({ kind: 'dosing', farmId: '1021', receivedMs: t, live: true, tanks: [1, 2, 3, 4].map(id => ({ id, consumed_l: Math.floor(cons[id] * 4) / 4, rate_lph: dosing && id < 4 ? flow / 150 : 0 })).concat([{ id: 5, consumed_l: 0, rate_lph: null }]) });
      }
    }
  };
  assert.equal(ctl.ecRangeHint(4242, 'Water EC'), null, 'no data yet');
  feed(70);
  const h = ctl.ecRangeHint(4242, 'Water EC');
  assert.deepEqual([h.minValue, h.basis], [1000, 'dosing']);
  assert.equal(ctl.ecRangeHint(17, 'Water EC'), null, 'other equipment');
  assert.equal(ctl.ecRangeHint(4242, 'pH'), null, 'other metric');
  feed(70, { dosing: false });
  assert.equal(ctl.ecRangeHint(4242, 'Water EC'), null, 'raw_water_ec_us unset -> continuity');
  const ctl2 = new DoseController({ db, now: () => t, logger: quiet, autoTick: false, config: { ph: { sensor_equipment_id: 4242 }, ec_check: { raw_water_ec_us: 320 } } });
  ctl2._netRing = ctl._netRing; ctl2._doseRing = ctl._doseRing;
  const w = ctl2.ecRangeHint(4242, 'Water EC');
  assert.deepEqual([w.preferValue, w.basis], [320, 'raw_water']);
  feed(70, { flow: 2000 });
  assert.equal(ctl.ecRangeHint(4242, 'Water EC'), null, 'flow below 50 % of expected -> no hint');
  // override without a cycle only logs
  h.onOverride({ basis: 'dosing', raw: 2500, value: 2500, range: 'high', continuity: 250 });
});
