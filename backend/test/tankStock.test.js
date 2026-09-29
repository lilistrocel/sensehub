// Tank stock countdown (requirement 2026-09-29: current_stock_liters never decreased —
// every tank still read 1000 L four days after the 2026-09-25 remix).
// Ledger idempotence, refill reset (route), every run type counted, backfill since the
// last refill, the estimated acid line, days-left math, low-stock thresholds + alerts.
// In-memory DB, loopback HTTP only, no timers.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const i18n = src('i18n', 'index.js');
const TS = src('services', 'TankStockService.js');
const { TankStockService, validateConfig, stockState, thresholdsFor, DEFAULTS } = TS;

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 86400000;
const NOW = Date.parse('2026-09-29T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const dbTs = (ms) => iso(ms).replace('T', ' ').slice(0, 19);
const dubai = (ms) => { const d = new Date(ms + 4 * 3600000).toISOString().slice(0, 19); return `${d}+04:00`; };

const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('Irrigation 2 (stock test)', 'relay', 'modbus', '192.0.2.96:502', 2, 'online')").run().lastInsertRowid);
const NAMES = { 1: 'Tank A — Calcium nitrate', 2: 'Tank B — Mg + MKP + K2SO4', 3: 'Tank C — Potassium nitrate', 4: 'Tank D — Fe EDDHA + Fetrilon Combi 2', 5: 'Tank 5 — pH Down' };

function reset() {
  db.prepare('DELETE FROM tank_stock_ledger').run();
  db.prepare('DELETE FROM fertigation_tank_refills').run();
  db.prepare('DELETE FROM irrigation_cycles').run();
  db.prepare('DELETE FROM relay_events').run();
  db.prepare("DELETE FROM system_settings WHERE key IN ('tank_stock', 'tank_stock_alert_state', 'mqtt_monitor_settings')").run();
  for (let id = 1; id <= 5; id++) {
    const role = id === 5 ? 'ph_down' : 'nutrient';
    if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
      db.prepare('UPDATE fertigation_tanks SET name = ?, role = ?, equipment_id = ?, channel = ?, capacity_liters = 1000, current_stock_liters = 1000, active = 1 WHERE id = ?')
        .run(NAMES[id], role, DOSE_EQ, id === 5 ? 1 : id + 1, id);
    } else {
      db.prepare('INSERT INTO fertigation_tanks (id, name, role, equipment_id, channel, capacity_liters, current_stock_liters) VALUES (?, ?, ?, ?, ?, 1000, 1000)')
        .run(id, NAMES[id], role, DOSE_EQ, id === 5 ? 1 : id + 1);
    }
  }
}

function refill(tankId, atMs, level = 1000) {
  return Number(db.prepare('INSERT INTO fertigation_tank_refills (tank_id, refilled_at, water_liters_added, total_volume_after) VALUES (?, ?, ?, ?)')
    .run(tankId, dbTs(atMs), level, level).lastInsertRowid);
}

let cycleSeq = 0;
function cycle(startMs, durS, litres, { farm = '1021', id = null } = {}) {
  const cid = id || `C${++cycleSeq}`;
  const dosing = [1, 2, 3, 4].map(n => ({ id: n, consumed_l: litres[n] ?? 0 })).concat([{ id: 5, consumed_l: 0 }]);
  db.prepare(`INSERT INTO irrigation_cycles (farm_id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json, raw_payload, received_at)
    VALUES (?, ?, ?, ?, ?, 0.5, ?, '{}', ?)
    ON CONFLICT(farm_id, cycle_id) DO UPDATE SET dosing_json = excluded.dosing_json, updated_at = excluded.received_at`)
    .run(farm, cid, dubai(startMs), dubai(startMs + durS * 1000), durS, JSON.stringify(dosing), iso(startMs + durS * 1000 + 5000));
  return cid;
}

function acidPulse(onMs, secs, { src = 'ph_controller' } = {}) {
  const ins = db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, created_at) VALUES (?, 1, ?, ?, ?)');
  ins.run(DOSE_EQ, 1, src, dbTs(onMs));
  ins.run(DOSE_EQ, 0, src, dbTs(onMs + secs * 1000));
}

function service(now = NOW) {
  const alerts = []; const updates = []; const notifies = [];
  const svc = new TankStockService({
    db, now: () => now, logger: quiet, setTimer: () => null,
    createAlert: (a) => { alerts.push(a); return { id: alerts.length }; },
    updateOpenAlert: (fp, ch) => { updates.push({ fingerprint: fp, ...ch }); return null; },
    notify: (title, body, severity) => notifies.push({ title, body, severity }),
  });
  return { svc, alerts, updates, notifies };
}
const byId = (views, id) => views.find(v => v.tank_id === id);

test('ledger: monitor litres per cycle counted once — re-syncing and re-processing change nothing; a re-reported cycle updates its row', () => {
  reset();
  refill(1, NOW - 4 * DAY); refill(2, NOW - 4 * DAY); refill(3, NOW - 4 * DAY); refill(4, NOW - 4 * DAY);
  cycle(NOW - 2 * DAY, 240, { 1: 3, 2: 2.75, 3: 3, 4: 0 });
  const re = cycle(NOW - DAY, 240, { 1: 2.5, 2: 2.5, 3: 2.5, 4: 2.25 });
  const { svc } = service();
  svc.sync({ backfill: true });
  const n0 = db.prepare('SELECT COUNT(*) AS n FROM tank_stock_ledger').get().n;
  let v = svc.viewAll();
  assert.equal(byId(v, 1).level_l, 994.5);
  assert.equal(byId(v, 4).level_l, 997.8); // 2.25 L -> 997.75 shown to 0.1
  assert.equal(db.prepare('SELECT current_stock_liters AS l FROM fertigation_tanks WHERE id = 1').get().l, 994.5, 'current_stock_liters follows the ledger');
  // idempotent: again (backfill and incremental), nothing changes
  const r2 = svc.sync({ backfill: true });
  const r3 = svc.sync({ fromMs: NOW - 3 * DAY });
  assert.equal(r2.cycles + r3.cycles, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tank_stock_ledger').get().n, n0);
  assert.equal(byId(svc.viewAll(), 1).level_l, 994.5);
  // the monitor re-reports a cycle (2.5 -> 3.0 L): its row is updated, not added
  cycle(NOW - DAY, 240, { 1: 3, 2: 2.5, 3: 2.5, 4: 2.25 }, { id: re });
  svc.sync();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tank_stock_ledger').get().n, n0);
  assert.equal(byId(svc.viewAll(), 1).level_l, 994);
  // zero-litre tanks get no row (Tank D cycle 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE tank_id = 4 AND kind = 'cycle'").get().n, 1);
});

test('every run type counts: cycles of automated, manual-app and manual-panel runs (no automation, no dose run) all draw from the stock', () => {
  reset();
  refill(1, NOW - 3 * DAY);
  cycle(NOW - 50 * 3600000, 600, { 1: 10 });          // automated (07:30)
  cycle(NOW - 30 * 3600000, 300, { 1: 4.25 });        // manual app
  cycle(NOW - 20 * 3600000, 120, { 1: 1.5 });         // manual panel: no relay event, no dose controller run
  const { svc } = service();
  svc.sync({ backfill: true });
  const v = byId(svc.viewAll(), 1);
  assert.equal(v.level_l, 984.3);
  assert.equal(v.used_since_anchor_l, 15.8);
  assert.equal(v.source, 'measured');
});

test('backfill since the LAST refill: draws before it stay in the ledger (audit) but do not count; a tank without any refill starts at its stored level', () => {
  reset();
  refill(1, NOW - 20 * DAY);
  cycle(NOW - 10 * DAY, 600, { 1: 40, 3: 5 });
  refill(1, NOW - 4 * DAY);                           // the 2026-09-25 remix
  cycle(NOW - 2 * DAY, 600, { 1: 12, 3: 7 });
  const { svc } = service();
  svc.sync({ backfill: true });
  const v = svc.viewAll();
  assert.equal(byId(v, 1).level_l, 988);
  assert.equal(byId(v, 1).anchor.kind, 'refill');
  assert.equal(byId(v, 1).used_since_anchor_l, 12, 'the draw before the last refill does not count');
  // Tank C has no refill record: anchored at its stored 1000 L now; earlier cycles are not subtracted
  assert.equal(byId(v, 3).anchor.kind, 'anchor');
  assert.equal(byId(v, 3).level_l, 1000);
  cycle(NOW + 60000, 300, { 3: 2 });
  const later = service(NOW + 10 * 60000).svc;
  later.sync();
  assert.equal(byId(later.viewAll(), 3).level_l, 998);
});

test('unmetered gap: refill before the first monitor cycle is flagged (with the dose cycles in it), never guessed', () => {
  reset();
  const refillMs = Date.parse('2026-09-25T12:13:02Z');
  refill(4, refillMs);
  db.prepare("INSERT INTO fertigation_dose_cycle_log (program_id, cycle_started_at, duration_seconds, status) VALUES (NULL, '2026-09-25 13:00:10', 480, 'completed')").run();
  cycle(Date.parse('2026-09-26T05:30:28Z'), 600, { 4: 16.25 });
  const { svc } = service();
  svc.sync({ backfill: true });
  const v = byId(svc.viewAll(), 4);
  assert.equal(v.level_l, 983.8);
  assert.deepEqual(v.unmetered_gap, { from: '2026-09-25T12:13:02.000Z', to: '2026-09-26T05:30:28.000Z', dose_cycles: 1 });
  db.prepare('DELETE FROM fertigation_dose_cycle_log').run();
});

test('pH Down (not metered): valve open seconds x acid_lpm_estimate, flagged estimated; pulses counted once', () => {
  reset();
  refill(5, NOW - 3 * DAY);
  acidPulse(NOW - 2 * DAY, 10);
  acidPulse(NOW - 2 * DAY + 60000, 6);
  acidPulse(NOW - DAY, 30);
  const { svc } = service();
  svc.sync({ backfill: true });
  svc.sync({ backfill: true });
  const v = byId(svc.viewAll(), 5);
  // 46 s x 1.7 L/min = 1.30 L
  assert.equal(v.source, 'estimated');
  assert.equal(v.estimated, true);
  assert.equal(v.level_l, 998.7);
  assert.equal(v.estimated_since_anchor_l, 1.3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE tank_id = 5 AND kind = 'acid' AND estimated = 1").get().n, 3);
});

test('days left = level / average daily use over the last 3 days', () => {
  reset();
  refill(2, NOW - 10 * DAY, 1000);
  for (let d = 1; d <= 6; d++) cycle(NOW - d * DAY + 3600000, 600, { 2: 50 }); // 50 L/day
  const { svc } = service();
  svc.sync({ backfill: true });
  const v = byId(svc.viewAll(), 2);
  assert.equal(v.level_l, 700);
  assert.equal(v.avg_daily_l, 50);      // 3 cycles in the last 72 h
  assert.equal(v.avg_span_days, 3);
  assert.equal(v.days_left, 14);
  // monitor coverage shorter than 3 days: the average uses the covered span (>= 12 h)
  reset();
  refill(2, NOW - 10 * DAY, 1000);
  cycle(NOW - DAY, 600, { 2: 40 });
  const s2 = service().svc;
  s2.sync({ backfill: true });
  const w = byId(s2.viewAll(), 2);
  assert.ok(Math.abs(w.avg_span_days - 1) < 0.01, `span ${w.avg_span_days}`);
  assert.equal(w.avg_daily_l, 40);
});

test('thresholds: caution < 20 %, alarm < 10 % or < 1 day of use; estimated levels cap at caution; per-tank overrides', () => {
  const th = thresholdsFor(DEFAULTS, 1);
  assert.deepEqual(th, { caution_pct: 20, alarm_pct: 10, alarm_days: 1 });
  const s = (level, daysLeft = null, estimated = false) => stockState({ level, capacity: 1000, daysLeft, estimated, source: estimated ? 'estimated' : 'measured' }, th);
  assert.equal(s(500), 'ok');
  assert.equal(s(200), 'ok');
  assert.equal(s(199), 'caution');
  assert.equal(s(99), 'alarm');
  assert.equal(s(400, 0.8), 'alarm', '< 1 day of use left');
  assert.equal(s(50, null, true), 'caution', 'an estimate never raises an alarm');
  assert.equal(stockState({ level: 10, capacity: 1000, source: 'manual' }, th), 'unknown');
  assert.deepEqual(thresholdsFor({ ...DEFAULTS, per_tank: { 4: { caution_pct: 35 } } }, 4), { caution_pct: 35, alarm_pct: 10, alarm_days: 1 });
  assert.ok(validateConfig({ caution_pct: 0 }).error);
  assert.ok(validateConfig({ per_tank: { x: {} } }).error);
  assert.ok(validateConfig({ per_tank: { 4: { bogus: 1 } } }).error);
  assert.equal(validateConfig({ caution_pct: 25, per_tank: { 4: { alarm_days: 2 } } }).error, undefined);
});

test('low-stock alerts: caution (warning) then ALARM (critical) with Telegram on each worsening; a restart does not re-send; refill resolves; texts in en/tr/ar', () => {
  reset();
  refill(4, NOW - 6 * DAY, 1000);
  cycle(NOW - 4.5 * DAY, 600, { 4: 820 });          // before the 3-day window
  cycle(NOW - DAY, 600, { 4: 30 });                 // 150 L left (15 %), 10 L/day -> 15 days
  let { svc, alerts, notifies } = service();
  svc.sync({ backfill: true });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].fingerprint, 'tank_stock:4');
  assert.equal(alerts[0].severity, 'warning');
  assert.equal(alerts[0].source, 'tank_stock');
  assert.equal(alerts[0].message, 'Tank D (Fe EDDHA + Fetrilon Combi 2) is running low: 150 L left (15.0 % of 1000 L), about 15.0 days of use left. Mix a new batch before it runs dry.');
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].title, 'Tank D running low');
  // a restart (fresh service) with the same level: nothing new
  ({ svc, alerts, notifies } = service());
  svc.sync();
  assert.equal(alerts.length + notifies.length, 0);
  // below 10 %: ALARM
  cycle(NOW - 0.5 * DAY, 600, { 4: 70 });           // 80 L
  ({ svc, alerts, notifies } = service());
  svc.sync();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.match(alerts[0].message, /^Tank D \(Fe EDDHA \+ Fetrilon Combi 2\) is almost empty: 80 L left \(8\.0 % of 1000 L\), .*Refill it now/);
  assert.match(i18n.t('tr', alerts[0].messageKey, alerts[0].messageParams), /neredeyse boş: 80 L kaldı/);
  assert.match(i18n.t('ar', alerts[0].messageKey, alerts[0].messageParams), /شبه فارغ: تبقّى 80 L/);
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].title, 'Tank D almost empty');
  assert.equal(notifies[0].severity, 'critical');
  // refill through the service: resolved (info), no new alert
  const rid = refill(4, NOW + 1000, 1000);
  const after = service(NOW + 5000);
  after.svc.recordRefill(rid);
  assert.equal(after.alerts.length, 0);
  const res = after.updates.filter(u => u.fingerprint === 'tank_stock:4');
  assert.equal(res.length, 1);
  assert.equal(res[0].severity, 'info');
  assert.match(res[0].message, /^Tank D \(Fe EDDHA \+ Fetrilon Combi 2\) stock is back to 1000 L \(100\.0 %\)\.$/);
});

test('low stock by days: 30 % left but < 1 day of use -> ALARM; the estimated acid line: caution only, text says estimated', () => {
  reset();
  refill(1, NOW - 3 * DAY, 1000);
  cycle(NOW - 20 * 3600000, 600, { 1: 700 });       // 300 L left, ~700 L/day
  refill(5, NOW - 3 * DAY, 60);                     // acid 60 L (6 %)
  const { svc, alerts } = service();
  svc.sync({ backfill: true });
  const a1 = alerts.find(a => a.fingerprint === 'tank_stock:1');
  assert.equal(a1.severity, 'critical');
  assert.match(a1.message, /almost empty: 300 L left \(30\.0 % of 1000 L\), about 0\.\d days of use left/);
  const a5 = alerts.find(a => a.fingerprint === 'tank_stock:5');
  assert.equal(a5.severity, 'warning');
  assert.match(a5.message, /^Tank 5 \(pH Down\) is running low: 60 L left \(6\.0 % of 1000 L\), .*Estimated from the pH Down valve open time/);
});

test('API: /tanks carries stock; /tanks/stock; ledger paginated; refill resets per the existing semantics and records a ledger row; a typed level is an anchor', async () => {
  reset();
  refill(1, NOW - 4 * DAY);
  cycle(NOW - DAY, 600, { 1: 120 });
  const router = src('routes', 'fertigation.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: null, email: `${role}@farm.test`, role }; next(); });
  app.use('/api/fertigation', router);
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/fertigation`;
  const get = async (p) => (await fetch(`${base}${p}`, { headers: { 'x-role': 'viewer' } })).json();
  const send = async (method, p, body, role = 'operator') => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify(body) });
  try {
    TS.getTankStockService().sync({ backfill: true });
    const tanks = await get('/tanks');
    const t1 = tanks.find(t => t.id === 1);
    assert.ok(t1.stock, 'stock attached');
    assert.equal(t1.stock.source, 'measured');
    assert.ok(t1.stock.level_l <= 880 + 0.01);
    assert.equal(t1.current_stock_liters, t1.stock.level_l);
    const s = await get('/tanks/stock');
    assert.equal(s.tanks.length, 5);
    assert.equal(s.config.caution_pct, 20);
    const led = await get('/tanks/1/ledger?limit=1');
    assert.equal(led.limit, 1);
    assert.ok(led.total >= 2);
    assert.equal(led.entries.length, 1);
    // refill: newStock = min(capacity, current + added) — here 880 + 1000 -> 1000; ledger 'refill' row
    const r = await send('POST', '/tanks/1/refill', { water_liters_added: 1000 });
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.equal(body.tank.current_stock_liters, 1000);
    assert.equal(body.stock.level_l, 1000);
    assert.equal(body.stock.anchor.kind, 'refill');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE tank_id = 1 AND kind = 'refill' AND ref = ?").get(`refill:${body.refill_id}`).n, 1);
    // a partial top-up after more use: 1000 - 300 + 200 = 900
    db.prepare('UPDATE fertigation_tank_refills SET refilled_at = ? WHERE id = ?').run(dbTs(Date.now() - 60000), body.refill_id);
    cycle(Date.now() - 30000, 20, { 1: 300 });
    TS.getTankStockService().sync({ fromMs: Date.now() - DAY });
    const r2 = await (await send('POST', '/tanks/1/refill', { water_liters_added: 200 })).json();
    assert.equal(r2.tank.current_stock_liters, 900);
    // a typed level (tank edit) becomes an 'adjust' anchor that later draws count from
    const put = await send('PUT', '/tanks/2', { current_stock_liters: 640 });
    assert.equal(put.status, 200);
    const v2 = (await get('/tanks/stock')).tanks.find(t => t.tank_id === 2);
    assert.equal(v2.level_l, 640);
    assert.equal(v2.anchor.kind, 'adjust');
    // an unchanged level in the same PUT is not an adjust
    const n = db.prepare("SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE kind = 'adjust'").get().n;
    await send('PUT', '/tanks/2', { notes: 'x', current_stock_liters: 640 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tank_stock_ledger WHERE kind = 'adjust'").get().n, n);
    // config: viewer cannot change it, admin can; bad values rejected
    assert.equal((await send('PUT', '/tank-stock/config', { caution_pct: 30 }, 'operator')).status, 403);
    assert.equal((await send('PUT', '/tank-stock/config', { caution_pct: 500 }, 'admin')).status, 400);
    const ok = await send('PUT', '/tank-stock/config', { per_tank: { 4: { caution_pct: 30 } } }, 'admin');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).per_tank['4'].caution_pct, 30);
  } finally {
    await new Promise(res => server.close(res));
  }
});
