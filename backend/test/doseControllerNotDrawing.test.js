// Tank not-drawing alarm + automatic second try (requirement 2026-09-29).
//   Incident 07:30 (run 17): Tank D's valve opened at every zone start and stayed open
//   709 s with water flowing; its monitor counter never moved (last movement 2026-09-28
//   17:09), rate 0.0; A/B/C drew normally. Recorded only as 'cant_reach' trips.
//   Incident Tank B zone 3 (2026-09-26 17:00, 09-28 09:30 / 12:30 / 13:45): 0 L with its
//   valve open; closing and re-opening it made it draw at once (~65-70 L/h).
// Simulated plant as in doseControllerPrecision.test.js (soft-switch zones, flow ramp,
// coupled venturis, 0.25 L counters every 1 s with the monitor's lagged / held rate), plus
// dead tanks (venturi draws nothing) and an air-locked tank that draws only after its
// valve is closed and re-opened. Valve writes are a stub; the DB is in memory.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const i18n = src('i18n', 'index.js');
const { DoseController, validateConfigUpdate, DEFAULT_CONFIG, localizeReason } = src('services', 'DoseController.js');

{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const quiet = { log() {}, warn() {}, error() {} };
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();

const IRR_MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' }, { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' }, { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' }, { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Irrigation 1 (draw sim)', 'relay', 'modbus', '192.0.2.97:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('Irrigation 2 (draw sim)', 'relay', 'modbus', '192.0.2.97:502', 2, 'online')").run().lastInsertRowid);
const PH_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO (draw sim)', 'sensor', 'modbus', '192.0.2.97:502', 3, 'online')").run().lastInsertRowid);
const MON_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, status) VALUES ('Irrigation Monitor 1021 (draw sim)', 'sensor', 'mqtt', 'farm/1021', 'online')").run().lastInsertRowid);
const TANK_NAMES = {
  1: 'Tank A — Calcium nitrate', 2: 'Tank B — Mg + MKP + K2SO4', 3: 'Tank C — Potassium nitrate', 4: 'Tank D — Fe EDDHA + Fetrilon Combi 2',
};
for (let id = 1; id <= 4; id++) {
  if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
    db.prepare("UPDATE fertigation_tanks SET name = ?, equipment_id = ?, channel = ?, role = 'nutrient', active = 1 WHERE id = ?").run(TANK_NAMES[id], DOSE_EQ, id + 1, id);
  } else {
    db.prepare("INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role) VALUES (?, ?, ?, ?, 'nutrient')").run(id, TANK_NAMES[id], DOSE_EQ, id + 1);
  }
}
db.prepare("DELETE FROM fertigation_tanks WHERE role = 'ph_down'").run();
// Tank D's counter history: last movement 2026-09-28 17:09 Asia/Dubai (13:09 UTC), then flat at 262.25
db.prepare("INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (?, 'Tank 4 Consumed', 261.75, 'L', '2026-09-28T13:08:31.000Z')").run(MON_EQ);
db.prepare("INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (?, 'Tank 4 Consumed', 262.25, 'L', '2026-09-28T13:09:02.000Z')").run(MON_EQ);

const LEAD = 3; const LAG = 5; const GAP = 1;
const FULL = 8800;

function noiseGen(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const n = (sd) => sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  n.u = u;
  return n;
}

function planActions(D) {
  const actions = []; const zones = []; const pumps = [];
  for (let k = 0; k < 4; k++) {
    const t0 = k * (LEAD + D + LAG + GAP);
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 3 + k, delay_seconds: t0, duration_seconds: D + LEAD + LAG });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, delay_seconds: t0 + LEAD, duration_seconds: D });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, delay_seconds: t0 + LEAD, duration_seconds: D });
    zones.push([t0, t0 + LEAD + D + LAG]);
    pumps.push([t0 + LEAD, t0 + LEAD + D]);
  }
  return { actions, zones, pumps, duration: Math.max(...actions.map(a => a.delay_seconds + a.duration_seconds)) };
}

/**
 * dead:    { tankId: true | [zone indexes] } — that venturi draws nothing (counter flat, rate 0)
 * airlock: { tank, zone } — from that zone's start the tank draws nothing until its valve is
 *          physically closed and re-opened
 */
async function runPlant({
  D = 180, ratio = 200, draws = { 1: 1.10, 2: 1.12, 3: 1.08, 4: 1.05 }, seed = 5,
  nutrients = {}, dead = {}, airlock = null, stuck = [], disarmedAt = null, latencyS = 0.4, holdS = [20, 50],
} = {}) {
  db.prepare('DELETE FROM dose_controller_runs').run();
  db.prepare('DELETE FROM relay_events').run();
  const plan = planActions(D);
  const auto = Number(db.prepare("INSERT INTO automations (name, trigger_config, actions, enabled) VALUES ('Fertigation (draw sim)', '{}', ?, 0)")
    .run(JSON.stringify(plan.actions)).lastInsertRowid);
  const T0 = Date.parse('2026-09-29T03:30:00Z'); // 07:30 Asia/Dubai
  let t = T0;
  let rel = 0;
  const alerts = []; const updates = []; const notifies = [];
  let disarmed = false;
  const ctl = new DoseController({
    db, now: () => t, autoTick: false, logger: quiet, arming: { isDisarmed: () => disarmed }, tz: 'Asia/Dubai',
    createAlert: (a) => { alerts.push({ ...a, rel }); return { id: alerts.length }; },
    updateOpenAlert: (fp, ch) => { updates.push({ fingerprint: fp, ...ch, rel }); return null; },
    notify: (title, body, severity, specs) => { notifies.push({ title, body, severity, specs, rel }); },
    config: {
      ph: { enabled: false, sensor_equipment_id: PH_EQ },
      nutrients: { irrigation_equipment_id: IRR_EQ, expected_flow_lph: FULL, pump_channel: 1, ratio: { 1: ratio, 2: ratio, 3: ratio, 4: ratio }, ...nutrients },
    },
  });
  const noise = noiseGen(seed);
  const phys = {};
  const pending = [];
  const writes = [];   // every write attempt { rel, ch, state, source, refused }
  const tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: TANK_NAMES[id], equipment_id: DOSE_EQ, channel: id + 1, duty_pct: 100, valve_events: [] }));
  ctl.beginCycle({
    cycleLogId: 1, programId: null, automationId: auto, durationSeconds: plan.duration, schedule: { tanks }, tanks, valveStates: {},
    write: async (target, state, opts = {}) => {
      const refused = !!(state && disarmed);
      writes.push({ rel, ch: target.channel, tank: target.channel - 1, state, source: opts.source, refused });
      if (refused) return false;
      pending.push([rel + latencyS, target.channel, state]);
      return true;
    },
    abort: async () => {},
  });

  const consumed = { 1: 397.25, 2: 376.25, 3: 369.25, 4: 262.25 }; // the 07:30 counters
  const monRate = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const held = { 1: null, 2: null, 3: null, 4: null };
  const lastState = {};
  const rampStart = {};
  let flow = 0; let net = 76000;
  const dt = 0.1;
  const zoneOn = (k, r) => r >= plan.zones[k][0] && r < plan.zones[k][1];
  const pumpOn = (r) => plan.pumps.some(([a, b]) => r >= a && r < b);
  const holdFor = () => holdS[0] + (holdS[1] - holdS[0]) * noise.u();
  const lock = { on: false, opens: 0, armed: false };
  const prevPhys = {};
  const end = plan.duration + 15;
  let sekoLast = -Infinity;
  for (let i = 0; i * dt <= end + 1e-9; i++) {
    rel = Math.round(i * dt * 10) / 10;
    t = T0 + Math.round(rel * 1000);
    if (disarmedAt !== null && rel >= disarmedAt) disarmed = true;
    for (let k = 0; k < 4; k++) {
      const on = zoneOn(k, rel);
      if (lastState[`z${k}`] !== on) {
        db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
          .run(IRR_EQ, 3 + k, on ? 1 : 0, on ? 'automation' : 'automation_auto_off', auto, on ? 1 : 0, dbTs(t));
        lastState[`z${k}`] = on;
      }
    }
    const p = pumpOn(rel);
    if (lastState.pump !== p) { lastState.pump = p; lastState.pumpEventAt = rel + 0.3; lastState.pumpEventState = p; if (p) rampStart.at = rel; }
    if (lastState.pumpEventAt !== undefined && rel >= lastState.pumpEventAt - 1e-9) {
      for (const ch of [1, 2]) {
        db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
          .run(IRR_EQ, ch, lastState.pumpEventState ? 1 : 0, lastState.pumpEventState ? 'automation' : 'automation_auto_off', auto, lastState.pumpEventState ? 1 : 0, dbTs(t));
      }
      lastState.pumpEventAt = undefined;
    }
    for (let j = pending.length - 1; j >= 0; j--) {
      if (pending[j][0] > rel + 1e-9) continue;
      phys[pending[j][1]] = pending[j][2];
      pending.splice(j, 1);
    }
    const zk = plan.zones.findIndex((_, k) => zoneOn(k, rel));
    // air lock: set at its zone's start; cleared by a physical close -> re-open
    if (airlock && !lock.armed && rel >= plan.zones[airlock.zone][0]) { lock.armed = true; lock.on = true; lock.opens = phys[airlock.tank + 1] ? 1 : 0; }
    if (airlock && lock.on) {
      const ch = airlock.tank + 1;
      if (phys[ch] && !prevPhys[ch]) { lock.opens++; if (lock.opens >= 2) lock.on = false; }
    }
    for (const ch of [2, 3, 4, 5]) prevPhys[ch] = phys[ch];
    const openZone = [0, 1, 2, 3].filter(k => zoneOn(k, rel) && !stuck.includes(k)).length > 0;
    if (p && openZone) flow = Math.min(FULL, Math.max(flow, FULL * Math.max(0, rel - rampStart.at) / 8)) + (rel - rampStart.at > 8 ? noise(8) : 0);
    else flow *= Math.exp(-dt / 1.5);
    flow = Math.max(0, Math.min(FULL * 1.03, flow));
    net += (flow / 3600) * dt;
    const motive = flow >= 0.2 * FULL ? Math.min(1.03, flow / FULL) : 0;
    const isDead = (id) => dead[id] === true || (Array.isArray(dead[id]) && dead[id].includes(zk))
      || (airlock && lock.on && airlock.tank === id);
    const nOpen = [1, 2, 3, 4].filter(id => phys[id + 1] && !isDead(id)).length;
    for (const id of [1, 2, 3, 4]) {
      const r = phys[id + 1] && !isDead(id) ? draws[id] * motive * (1 + 0.05 * (4 - nOpen)) * (1 + noise(0.015)) : 0; // L/min
      consumed[id] += (r / 60) * dt;
      const target = r * 60;
      if (r > 0) { monRate[id] += (target - monRate[id]) * (1 - Math.exp(-dt / 1.5)); held[id] = null; } else if (monRate[id] > 0) {
        if (!held[id]) held[id] = { value: monRate[id], until: rel + holdFor() };
        if (rel >= held[id].until) { monRate[id] = 0; held[id] = null; }
      }
    }
    if (i % 5 === 0) {
      ctl.ingest({ kind: 'flowmeter', farmId: '1021', equipmentId: MON_EQ, receivedMs: t, live: true,
        values: { flow_lph: Math.round(flow * 10) / 10, net_total_m3: Math.floor(net * 10) / 10000, signal_quality: 95, error_flags: 0 } });
    }
    if (i % 10 === 3) {
      ctl.ingest({ kind: 'dosing', farmId: '1021', equipmentId: MON_EQ, receivedMs: t, live: true,
        tanks: [1, 2, 3, 4].map(id => ({ id, consumed_l: Math.floor(consumed[id] * 4) / 4, rate_lph: Math.round(monRate[id] * 10) / 10 }))
          .concat([{ id: 5, consumed_l: 0, rate_lph: null }]) });
    }
    if (rel - sekoLast >= 10 - 1e-9) {
      sekoLast = rel;
      db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
        .run(JSON.stringify({ values: { pH: { value: 6.0, unit: 'pH' }, 'Water EC': { value: flow < 1000 ? 700 : 1850, unit: 'µS/cm' } } }), iso(t), PH_EQ);
    }
    if (i % 10 === 0 && ctl.cycle) ctl.step(t);
    await ctl.flush();
  }
  const run = await ctl.endCycle({ status: 'completed' });
  ctl.stop();
  const zoneOf = (r) => plan.zones.findIndex(([a, b]) => r >= a && r < b);
  return { run, plan, alerts, updates, notifies, writes, zoneOf, ctl };
}

const retryWrites = (r, ch) => r.writes.filter(w => w.source === 'dose_controller_retry' && (ch === undefined || w.ch === ch));
const byFp = (r, fp) => r.alerts.filter(a => a.fingerprint === fp);
const zoneTank = (r, k, id) => (r.run.zones.find(z => z.channel === 3 + k) || { tanks: [] }).tanks.find(x => x.tank_id === id);

// ─── the 07:30 Tank D signature ─────────────────────────────────────────────

test('07:30 Tank D replay: one re-open per zone (guarded path, source dose_controller_retry, >= min_off_s closed), still nothing -> ONE alarm for the run with the right text + Telegram, run summary "Tank D delivered 0 L"', async () => {
  const r = await runPlant({ dead: { 4: true } });
  const runId = r.run.id;
  // one retry per zone, each: OFF then ON of ch 5, ON >= 10 s after the OFF, never another channel
  const rw = retryWrites(r);
  assert.ok(rw.every(w => w.ch === 5), `retry writes only on Tank D: ${JSON.stringify(rw)}`);
  for (let k = 0; k < 4; k++) {
    const zw = rw.filter(w => r.zoneOf(w.rel) === k);
    assert.equal(zw.length, 2, `zone ${k + 1}: one close + one re-open (${JSON.stringify(zw)})`);
    assert.equal(zw[0].state, false);
    assert.equal(zw[1].state, true);
    assert.ok(zw[1].rel - zw[0].rel >= 10 - 1e-9, `closed >= min_off_s (${zw[1].rel - zw[0].rel} s)`);
    const rec = zoneTank(r, k, 4);
    assert.equal(rec.redraw_retry.result, 'no_draw', `zone ${k + 1} record: ${JSON.stringify(rec.redraw_retry)}`);
  }
  // exactly one alarm row for Tank D this run (critical), with the tank's contents and last draw
  const fp = `dose_controller:not_drawing:4:${runId}`;
  const al = byFp(r, fp);
  assert.equal(al.length, 1, `one alarm: ${JSON.stringify(r.alerts.map(a => a.fingerprint))}`);
  assert.equal(al[0].severity, 'critical');
  assert.match(al[0].message, /^Tank D \(Fe EDDHA \+ Fetrilon Combi 2\) is not drawing: its valve has been open 6[01] s with water flowing but no liquid left the tank \(last draw: 2026-09-28 17:09\)\. Check the tank level, the suction filter\/foot valve and the venturi\.$/);
  assert.equal(al[0].messageKey, 'dose_controller.alert.not_drawing');
  assert.match(i18n.t('tr', al[0].messageKey, al[0].messageParams), /Tank D \(Fe EDDHA \+ Fetrilon Combi 2\) emiş yapmıyor: .* 6[01] sn .*son emiş: 2026-09-28 17:09/);
  assert.match(i18n.t('ar', al[0].messageKey, al[0].messageParams), /لا يسحب.*2026-09-28 17:09/);
  // the alarm waits for the retry window: fired after zone 1's retry failed
  const firstRetryFail = r.run.trips.find(x => x.kind === 'redraw_retry_failed');
  assert.ok(firstRetryFail && Date.parse(firstRetryFail.at) <= Date.parse('2026-09-29T03:30:00Z') + al[0].rel * 1000 + 1);
  // no other tank alarmed, no "no tank drawing" caution
  assert.equal(r.alerts.filter(a => /not_drawing:[123]:/.test(a.fingerprint) || /none_drawing/.test(a.fingerprint)).length, 0);
  // Telegram: the alarm once; the run summary does not repeat it
  assert.equal(r.notifies.length, 1, JSON.stringify(r.notifies.map(n => n.title)));
  assert.equal(r.notifies[0].title, 'Tank D not drawing');
  assert.equal(r.notifies[0].severity, 'critical');
  // run summary
  const rz = byFp(r, `dose_controller:run_zero:4:${runId}`);
  assert.equal(rz.length, 1);
  assert.match(rz[0].message, /^Tank D \(Fe EDDHA \+ Fetrilon Combi 2\) delivered 0 L in this run: valve open \d+ s with [\d.]+ L of water\./);
  const td = r.run.tanks.find(x => x.tank_id === 4);
  assert.equal(td.dosed_l, 0);
  assert.equal(td.delivered_zero, true);
  assert.equal(td.not_drawing.alarms, 1);
  assert.equal(td.redraw_retries.length, 4);
  assert.ok(td.redraw_retries.every(x => x.result === 'no_draw'));
  // A-C unaffected
  for (const id of [1, 2, 3]) {
    const tk = r.run.tanks.find(x => x.tank_id === id);
    assert.ok(tk.dosed_l > 5 && !tk.not_drawing && !tk.redraw_retries, `${tk.name}: ${JSON.stringify(tk)}`);
  }
});

test('Tank B zone-3 signature (air lock): re-open in zone 3 -> draws at once -> no alarm, note in the run record', async () => {
  const r = await runPlant({ airlock: { tank: 2, zone: 2 }, seed: 8 });
  const rw = retryWrites(r);
  assert.equal(rw.length, 2, JSON.stringify(rw));
  assert.deepEqual(rw.map(w => [w.ch, w.state]), [[3, false], [3, true]]);
  assert.ok(rw.every(w => r.zoneOf(w.rel) === 2), 'the retry happened in zone 3');
  const rec = zoneTank(r, 2, 2);
  assert.equal(rec.redraw_retry.result, 'drew', JSON.stringify(rec));
  assert.ok(rec.redraw_retry.drew_after_s <= 20, `drew after ${rec.redraw_retry.drew_after_s} s`);
  assert.ok(r.run.trips.some(x => x.kind === 'redraw_retry_ok' && /^Tank B drew after a valve re-open/.test(x.detail)));
  assert.equal(r.alerts.filter(a => /not_drawing|none_drawing|run_zero/.test(a.fingerprint)).length, 0, JSON.stringify(r.alerts.map(a => a.fingerprint)));
  assert.equal(r.notifies.length, 0);
  for (const k of [0, 1, 3]) assert.equal(zoneTank(r, k, 2).redraw_retry, undefined, `no retry in zone ${k + 1}`);
  // zone 3 still delivered most of Tank B's target after the re-open
  assert.ok(rec.dosed_l >= 0.5 * rec.target_l, `zone 3 Tank B ${rec.dosed_l} of ${rec.target_l} L`);
});

test('no tank drawing but water flows: ONE caution (dosing monitor / venturi manifold), no tank alarms, no retries', async () => {
  const r = await runPlant({ dead: { 1: true, 2: true, 3: true, 4: true } });
  const runId = r.run.id;
  const c = byFp(r, `dose_controller:none_drawing:${runId}`);
  assert.equal(c.length, 1);
  assert.equal(c[0].severity, 'warning');
  assert.match(c[0].message, /^No tank is drawing: Tank A, Tank B, Tank C, Tank D open 6[01] s with water flowing, but no liquid left any tank\. Check the dosing monitor and the venturi manifold\.$/);
  assert.equal(r.alerts.filter(a => /not_drawing:/.test(a.fingerprint)).length, 0);
  assert.equal(retryWrites(r).length, 0, 'no retry without another tank drawing');
  assert.equal(r.notifies.length, 1, 'one Telegram for the caution, none for the per-tank run summaries');
  assert.equal(r.notifies[0].title, 'No dosing tank drawing');
});

test('alarm resolves when the tank draws again ("Tank D is drawing again after N s"); still one alarm row', async () => {
  const r = await runPlant({ dead: { 4: [0, 1] }, seed: 11 });
  const fp = `dose_controller:not_drawing:4:${r.run.id}`;
  assert.equal(byFp(r, fp).length, 1);
  const res = r.updates.filter(u => u.fingerprint === fp);
  assert.equal(res.length, 1, JSON.stringify(r.updates));
  assert.equal(res[0].severity, 'info');
  assert.match(res[0].message, /^Tank D is drawing again after \d+ s\.$/);
  assert.equal(r.zoneOf(res[0].rel), 2, 'resolved in zone 3');
  assert.ok(r.run.trips.some(x => x.kind === 'not_drawing_resolved'));
  assert.equal(byFp(r, `dose_controller:run_zero:4:${r.run.id}`).length, 0, 'Tank D delivered in zones 3-4');
  assert.equal(r.run.tanks.find(x => x.tank_id === 4).not_drawing.open, false);
});

// ─── the retry's limits ─────────────────────────────────────────────────────

test('never the acid tank: a pH Down tank (role ph_down) is never closed / re-opened by the retry, nor alarmed', async () => {
  db.prepare("UPDATE fertigation_tanks SET role = 'ph_down' WHERE id = 4").run();
  try {
    const r = await runPlant({ dead: { 4: true } });
    assert.equal(retryWrites(r).length, 0);
    assert.equal(r.alerts.filter(a => /not_drawing:4|run_zero:4/.test(a.fingerprint)).length, 0);
  } finally {
    db.prepare("UPDATE fertigation_tanks SET role = 'nutrient' WHERE id = 4").run();
  }
});

test('disarm: a retry in progress is abandoned — no re-open (no ON write at all) while disarmed', async () => {
  const base = await runPlant({ dead: { 4: true } });
  const off = retryWrites(base, 5).find(w => w.state === false);
  const r = await runPlant({ dead: { 4: true }, disarmedAt: off.rel + 3 });
  assert.equal(retryWrites(r).filter(w => w.state === true).length, 0, JSON.stringify(retryWrites(r)));
  assert.equal(r.writes.filter(w => w.state === true && w.rel >= off.rel + 3).length, 0, 'nothing energised after the disarm');
  const rec = zoneTank(r, 0, 4);
  assert.equal(rec.redraw_retry.result, 'skipped');
  assert.equal(rec.redraw_retry.detail, 'disarmed');
});

test('zone end: < 25 s of the zone\'s flow left -> no retry (recorded as skipped); the alarm still fires over the run', async () => {
  const r = await runPlant({ D: 40, dead: { 4: true } });
  assert.equal(retryWrites(r).length, 0, JSON.stringify(retryWrites(r)));
  assert.equal(zoneTank(r, 0, 4).redraw_retry.result, 'skipped');
  assert.equal(zoneTank(r, 0, 4).redraw_retry.detail, 'zone end');
  assert.equal(byFp(r, `dose_controller:not_drawing:4:${r.run.id}`).length, 1);
});

test('flow gates: no water in zones 1-2 -> no not-drawing time, no retry, no alarm there; the first retry comes in zone 3', async () => {
  const r = await runPlant({ dead: { 4: true }, stuck: [0, 1] });
  const rw = retryWrites(r);
  assert.ok(rw.length > 0);
  assert.ok(rw.every(w => r.zoneOf(w.rel) >= 2), JSON.stringify(rw));
  const al = byFp(r, `dose_controller:not_drawing:4:${r.run.id}`);
  assert.equal(al.length, 1);
  assert.ok(r.zoneOf(al[0].rel) >= 2, `alarm in zone ${r.zoneOf(al[0].rel) + 1}`);
});

test('redraw_retry false: no valve re-opens, the alarm fires at not_drawing_seconds; not_drawing_alarm false: silent', async () => {
  const r = await runPlant({ dead: { 4: true }, nutrients: { redraw_retry: false } });
  assert.equal(retryWrites(r).length, 0);
  const al = byFp(r, `dose_controller:not_drawing:4:${r.run.id}`);
  assert.equal(al.length, 1);
  const q = await runPlant({ dead: { 4: true }, nutrients: { redraw_retry: false, not_drawing_alarm: false } });
  assert.equal(q.alerts.filter(a => /not_drawing|run_zero|none_drawing/.test(a.fingerprint)).length, 0);
});

test('config: defaults, bounds; status reason localized', () => {
  const n = DEFAULT_CONFIG.nutrients;
  assert.equal(n.not_drawing_alarm, true);
  assert.equal(n.not_drawing_seconds, 60);
  assert.equal(n.redraw_retry, true);
  assert.equal(n.redraw_retry_after_s, 20);
  assert.equal(n.redraw_verify_s, 20);
  assert.equal(n.redraw_min_zone_left_s, 25);
  assert.ok(validateConfigUpdate({ nutrients: { not_drawing_seconds: 10 } }).error);
  assert.ok(validateConfigUpdate({ nutrients: { not_drawing_seconds: 301 } }).error);
  assert.ok(validateConfigUpdate({ nutrients: { redraw_retry: 'yes' } }).error);
  assert.equal(validateConfigUpdate({ nutrients: { not_drawing_seconds: 90, redraw_retry: false } }).error, undefined);
  assert.equal(localizeReason('tr', 'redraw retry'), 'ikinci deneme (vana yeniden açıldı)');
});
