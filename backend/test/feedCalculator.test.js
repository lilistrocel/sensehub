/**
 * Feed calculator: delivered ppm from the real recipes (hand-computed values),
 * EC estimate (cations meq/L / 10), ratios, comparison statuses, tanks vs the
 * protocol recipe, measured (irrigation_runs) vs configured-ratio fallback.
 * In-memory DB only.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const FC = src('services', 'FeedCalculator.js');
const P = src('services', 'cropProtocol.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { FertigationSystemView } = src('services', 'FertigationSystemView.js');
const { NOW, seedFarm, addRun, addSchedule } = require('./fixtures/nutritionFarm');

const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);
const mix = (tanks, ratio) => FC.mixPpm(tanks.map(t => ({ tank: t, fraction: 1 / ratio })));

test('protocol VEGETATIVE recipe at 1:150: hand-computed ppm (and the operator sanity values)', () => {
  const { ppm } = mix(P.recipeTanks(null, 'vegetative'), 150);
  // hand: kg × % ÷ 1000 L ÷ 150 × 1e6 mg
  // N = (100×15.5 + 58×13 + 3×3.5)/150×10 = 154.30 ; P = 20×22.7/15 = 30.27 ; K = (10×41.5 + 20×28.2 + 58×38.2)/15 = 212.97
  // Ca = 100×19/15 = 126.67 ; Mg = 40×9.8/15 = 26.13 ; S = (40×13 + 10×18)/15 = 46.67 ; Fe = (2×6 + 3×4)/15 = 1.60
  near(ppm.N, 154.3, 0.01, 'N'); near(ppm.P, 30.27, 0.01, 'P'); near(ppm.K, 212.97, 0.01, 'K');
  near(ppm.Ca, 126.67, 0.01, 'Ca'); near(ppm.Mg, 26.13, 0.01, 'Mg'); near(ppm.S, 46.67, 0.01, 'S');
  near(ppm.Fe, 1.6, 0.001, 'Fe'); near(ppm.Mn, 0.6, 0.001, 'Mn'); near(ppm.Zn, 0.8, 0.001, 'Zn'); near(ppm.B, 0.3, 0.001, 'B');
  near(ppm.Cu, 0.12, 0.001, 'Cu'); near(ppm.Mo, 0.01, 0.001, 'Mo');
  // operator sanity values (≈ N 157, P 30, K 216, Ca 127, Mg 26, S 47): within 3 %
  for (const [el, v] of Object.entries({ N: 157, P: 30, K: 216, Ca: 127, Mg: 26, S: 47 })) near(ppm[el], v, v * 0.03, `sanity ${el}`);
  // NH4-N: Ca nitrate 1.1 % + Fetrilon 3.5 % (label) → (100×1.1 + 3×3.5)/15 = 8.03
  near(ppm.NH4_N, 8.03, 0.01, 'NH4-N');
  near(ppm.NO3_N, 146.27, 0.01, 'NO3-N');
});

test('protocol FRUITING recipe at 1:150', () => {
  const { ppm } = mix(P.recipeTanks(null, 'fruiting'), 150);
  // Ca 90×19/15 = 114.0 ; K (15×41.5 + 18×28.2 + 68×38.2)/15 = 248.51 ; N (90×15.5 + 68×13 + 3×3.5)/15 = 152.63 ; P 18×22.7/15 = 27.24
  near(ppm.Ca, 114, 0.01, 'Ca'); near(ppm.K, 248.51, 0.01, 'K'); near(ppm.N, 152.63, 0.01, 'N'); near(ppm.P, 27.24, 0.01, 'P');
});

test('current tanks (mixed 2026-09-25) at 1:200: hand-computed, proportionally lower than the protocol', () => {
  seedFarm(db);
  const tanks = FC.loadCurrentTanks(db).filter(t => t.role === 'nutrient');
  assert.deepEqual(tanks.map(t => t.letter), ['A', 'B', 'C', 'D']);
  const { ppm } = mix(tanks, 200);
  // N = (100×15.5 + 38×13 + 2×3.5)/200×10 = 102.55 ; K = (20×28.2 + 15×41.5 + 38×38.2)/20 = 131.905
  // Ca = 95.0 ; Mg = 51×9.8/20 = 24.99 ; S = (51×13 + 15×18)/20 = 46.65 ; P = 22.7 ; Fe = (4×6 + 2×4)/20 = 1.6
  near(ppm.N, 102.55, 0.01, 'N'); near(ppm.K, 131.905, 0.01, 'K'); near(ppm.Ca, 95, 0.01, 'Ca');
  near(ppm.Mg, 24.99, 0.01, 'Mg'); near(ppm.S, 46.65, 0.01, 'S'); near(ppm.P, 22.7, 0.01, 'P'); near(ppm.Fe, 1.6, 0.001, 'Fe');
  const proto = mix(P.recipeTanks(null, 'vegetative'), 150).ppm;
  assert.ok(ppm.N < proto.N && ppm.K < proto.K && ppm.Ca < proto.Ca, 'lower than the protocol veg feed');
  // EC estimate: cations Ca 95/20.039 + Mg 24.99/12.153 + K 131.905/39.098 + NH4 5.85/14.007 = 10.589 meq/L → 1.06 mS/cm
  const ec = FC.ecEstimate(ppm);
  near(ec.cations_meq_l, 10.59, 0.01, 'cations');
  near(ec.ec_ms_cm, 1.06, 0.005, 'EC');
  assert.ok(Math.abs(ec.balance_pct) < 2, `ion balance ${ec.balance_pct}`);
  const r = FC.elementRatios(ppm);
  near(r.N_K, 0.78, 0.005, 'N:K'); near(r.K_Ca, 1.39, 0.005, 'K:Ca'); near(r.K_Mg, 5.28, 0.005, 'K:Mg'); near(r.Ca_Mg, 3.8, 0.005, 'Ca:Mg');
  near(r.nh4_share_pct, 5.7, 0.05, 'NH4 share');
});

test('comparison statuses: ok / low / high / unknown, alarm beyond 25 %, target-only band ±10 %', () => {
  assert.deepEqual(FC.compareBand(100, { min: 90, target: 100, max: 110 }).status, 'ok');
  const low = FC.compareBand(80, { min: 90, target: 100, max: 110 });
  assert.equal(low.status, 'low'); assert.equal(low.severity, 'caution'); assert.equal(low.pct, -20);
  assert.equal(FC.compareBand(60, { min: 90, max: 110 }).severity, 'alarm');
  assert.equal(FC.compareBand(140, { min: 90, max: 110 }).severity, 'alarm');
  assert.equal(FC.compareBand(115, { min: 90, max: 110 }).status, 'high');
  const t = FC.compareBand(1.99, { target: 1.7 });
  assert.equal(t.status, 'high'); assert.equal(t.band_assumed, true); assert.equal(t.pct, 17.1);
  assert.equal(FC.compareBand(null, { target: 1 }).status, 'unknown');
  assert.equal(FC.compareBand(1, null).reason, 'no_target');
  const els = FC.compareElements({ N: 102.55, K: 250 }, [{ element: 'N', hard_min: 131.2, soft_target: 154.3, hard_max: 177.4 }, { element: 'K', hard_min: 181, soft_target: 213, hard_max: 244.9 }]);
  assert.equal(els.find(e => e.element === 'N').status, 'low');
  assert.equal(els.find(e => e.element === 'K').status, 'high');
  assert.equal(els.find(e => e.element === 'Mg').status, 'unknown');
  assert.equal(els.length, 12);
});

test('tanks vs protocol recipe (facts: C KNO3 38 vs 58 kg, B MgSO4 51 vs 40 kg)', () => {
  const cur = FC.loadCurrentTanks(db).filter(t => t.role === 'nutrient');
  const cmp = FC.compareRecipes(cur, P.recipeTanks(null, 'vegetative'));
  const line = (letter, lib) => cmp.find(t => t.letter === letter).lines.find(l => l.library_name === lib);
  assert.deepEqual([line('C', 'Potassium Nitrate (13-0-46)').current_kg, line('C', 'Potassium Nitrate (13-0-46)').protocol_kg, line('C', 'Potassium Nitrate (13-0-46)').diff_kg], [38, 58, -20]);
  assert.equal(line('B', 'Magnesium Sulphate (Epsom, MgSO4·7H2O)').diff_kg, 11);
  assert.equal(line('B', 'Potassium Sulphate').diff_kg, 5);
  assert.equal(line('A', 'Calcium Nitrate').diff_kg, 0);
  assert.equal(line('D', 'Fetrilon Combi 2 (Compo Expert)').diff_kg, -1);
});

test('feed report: measured litres from irrigation_runs (all runs), weighted EC/pH, water per plant; fallback to the configured ratio', () => {
  const svc = new CropProfileService({ db, now: () => NOW });
  let profile = svc.getActive();
  // no runs yet → configured 1:200
  let rep = FC.buildFeedReport(db, { profile, period: 'today', nowMs: NOW, tz: 'Asia/Dubai', protocolData: profile.protocol.data });
  assert.equal(rep.basis, 'configured_ratio');
  near(rep.ppm.N, 102.55, 0.01, 'N fallback');
  assert.equal(rep.comparisons.drain.reason, 'not_measured');
  // two measured runs today: 2000 L at 1:200 (10 L each) and 1000 L at 1:250 (4 L each)
  addRun(db, { key: 'r1', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 }, ec: 2.0, ph: 6.1, acid: 60 });
  addRun(db, { key: 'r2', startedAt: '2026-09-28T05:30:00Z', localDate: '2026-09-28', water: 1000, tanks: { 1: 4, 2: 4, 3: 4, 4: 4 }, ec: 1.7, ph: 6.4, acid: 30 });
  addRun(db, { key: 'old', startedAt: '2026-09-20T05:30:00Z', localDate: '2026-09-20', water: 1000, tanks: { 1: 50, 2: 50, 3: 50, 4: 50 } });
  svc.update(profile.id, { plants_per_section: 1000 });
  profile = svc.getActive();
  rep = FC.buildFeedReport(db, { profile, period: 'today', nowMs: NOW, tz: 'Asia/Dubai', protocolData: profile.protocol.data });
  assert.equal(rep.basis, 'measured');
  assert.equal(rep.runs_count, 2);
  assert.equal(rep.water_l, 3000);
  // 14 L per tank in 3000 L = 1:214.3 → N = 102.55 × 200/214.29
  near(rep.ppm.N, 102.55 * 200 * 14 / 3000, 0.01, 'measured N');
  assert.equal(rep.tanks.find(t => t.letter === 'A').achieved_ratio, 214);
  near(rep.ec.measured_ms_cm, (2.0 * 2000 + 1.7 * 1000) / 3000, 0.005, 'water-weighted EC');
  near(rep.ph_measured, (6.1 * 2000 + 6.4 * 1000) / 3000, 0.005, 'water-weighted pH');
  assert.equal(rep.acid_s, 90);
  near(rep.acid_est_l, 90 / 60 * 1.7, 0.01, 'acid estimate');
  assert.equal(rep.ml_per_plant_day, 750, '3000 L / 4000 plants');
  assert.equal(rep.comparisons.ml_per_plant_day.reason, 'partial_day');
  assert.equal(rep.comparisons.ec.status, 'high', '1.9 vs 1.7 target (±10 % band)');
  assert.equal(rep.comparisons.ph.status, 'high', '6.2 vs 5.5-5.8');
  assert.equal(rep.comparisons.elements.find(e => e.element === 'N').status, 'low');
  assert.equal(rep.protocol.recipe, 'vegetative');
  near(rep.protocol.ec_at_design, 1.45, 0.01, 'protocol EC at 1:150');
  const last = FC.buildFeedReport(db, { profile, period: 'last_run', nowMs: NOW, tz: 'Asia/Dubai' });
  assert.equal(last.runs_count, 1);
  assert.equal(last.ml_per_plant_run, 250);
  assert.equal(last.ml_per_plant_day, null);
  const week = FC.buildFeedReport(db, { profile, period: '7d', nowMs: NOW, tz: 'Asia/Dubai' });
  assert.equal(week.runs_count, 2, 'the 2026-09-20 run is outside the 7 days');
});

test('dose_controller_runs fallback when irrigation_runs has nothing', () => {
  db.exec('DELETE FROM irrigation_runs');
  db.prepare(`INSERT INTO dose_controller_runs (started_at, local_date, status, water_l, tanks_json, ec_avg, ph_avg, acid_s)
    VALUES ('2026-09-28T07:00:00Z', '2026-09-28', 'completed', 1000, ?, 1950, 6.0, 20)`).run(JSON.stringify([1, 2, 3, 4].map(id => ({ tank_id: id, dosed_l: 5 }))));
  const rep = FC.buildFeedReport(db, { profile: null, period: 'today', nowMs: NOW, tz: 'Asia/Dubai' });
  assert.equal(rep.measured_source, 'dose_controller_runs');
  assert.equal(rep.basis, 'measured');
  near(rep.ec.measured_ms_cm, 1.95, 0.001, 'µS/cm → mS/cm');
  near(rep.ppm.Ca, 95, 0.01, '5 L in 1000 L = 1:200');
});

test('live system view: tanks, schedule minutes per section from pump ON time, soft-switch lead/lag, dripper mL', () => {
  addSchedule(db, { time: '07:30', min: 3 });
  addSchedule(db, { time: '09:30', min: 4 });
  const svc = new CropProfileService({ db, now: () => NOW });
  const view = new FertigationSystemView({ db, now: () => NOW }).build({ profile: svc.getActive() });
  assert.equal(view.source, 'live_system');
  assert.deepEqual(view.tanks.map(t => t.letter), ['A', 'B', 'C', 'D', '5']);
  assert.equal(view.tanks[0].relay.label, 'Tank A — Calcium nitrate');
  assert.equal(view.tanks[0].target_ratio, 200);
  assert.equal(view.ph_line.setpoint, 5.65);
  assert.equal(view.ph_line.acid_metered, false);
  assert.equal(view.schedule.runs.length, 2);
  const r = view.schedule.runs[0];
  assert.equal(r.time, '07:30');
  assert.equal(r.minutes_per_section, 3);
  assert.deepEqual([r.zones[0].lead_s, r.zones[0].lag_s], [3, 5]);
  assert.equal(view.schedule.minutes_per_section_per_day, 7);
  assert.equal(view.schedule.ml_per_plant_day_from_dripper, 233, '7 min × 2 L/h');
  assert.equal(view.sections.length, 4);
  assert.equal(view.sections[0].name, 'Irrigation Zone 1');
});
