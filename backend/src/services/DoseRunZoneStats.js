/**
 * DoseRunZoneStats — per-zone feed quality + outcome for dose_controller_runs.
 *
 * Operator request 2026-09-26: "see the last cycle's per-zone stats on the
 * dashboard: water, litres of A B C D, average EC and average pH per zone".
 *
 * Every zone record in dose_controller_runs.zones_json gets:
 *   ec_avg_us, ec_min_us, ec_max_us, ec_samples   feed EC (SEKO, µS/cm)
 *   ph_avg, ph_min, ph_max, samples                feed pH (SEKO); samples = pH samples used
 *   skipped_samples                                SEKO samples dropped (flow < 50 % expected / unknown)
 *   status        'ok' | 'no_water' | 'cut_short' | 'shutdown' | 'not_run'
 *   achieved_ratio  water_l / mean litres of the nutrient tanks (1:N), null if nothing dosed
 *   stats_source  'live' (sampled by the controller) | 'history' (computed on read from readings)
 *
 * A SEKO sample counts for a zone only when it was taken inside the zone
 * window AND the flow at that moment was >= 50 % of the expected flow (the
 * cup is stagnant when the water stops; those samples are not the feed).
 * A zone with no usable sample has null averages (unknown), never 0.
 *
 * Status rules (precedence: shutdown > no_water > cut_short > ok):
 *   shutdown  the run was stopped by the flow-watch pump shutdown
 *             (end source/reason 'flow_watch_shutdown') and this is the zone
 *             that was running at that moment.
 *   no_water  the zone ran >= 10 s but got < 40 % of the water the expected
 *             flow would deliver over the time it was open.
 *   cut_short planned duration known and the zone ended > max(15 s, 10 %)
 *             before it (dose cycle aborted, run stopped).
 *   ok        otherwise.
 *   not_run   (shutdown only) zones the automation planned after the shutdown:
 *             pumps and valves were switched off, so they were not irrigated.
 *             Other aborts (e.g. dosing stopped) do not stop the pumps, so no
 *             not_run rows are added for them.
 *
 * Pure functions + one read-only history query (legacy records written before
 * these fields existed). No writes, no actuation.
 */

const MIN_FLOW_FRACTION = 0.5;       // skip SEKO samples while flow < 50 % expected
const NO_WATER_FRACTION = 0.4;       // < 40 % of expected water over the open time = no water
const NO_WATER_MIN_S = 10;           // shorter zones are never judged "no water" on volume
const CUT_SHORT_MIN_S = 15;
const CUT_SHORT_PCT = 0.1;
const FLOW_HOLD_MS = 120000;         // history: a change-downsampled flow value holds <= 2 min
const SHUTDOWN_SOURCE = 'flow_watch_shutdown';

const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function parseTs(s) {
  if (!s) return null;
  const str = String(s);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function newAcc() {
  return {
    ph: { min: null, max: null, sum: 0, n: 0 },
    ec: { min: null, max: null, sum: 0, n: 0 },
    skipped: 0,
  };
}

function addTo(s, v) {
  s.min = s.min === null ? v : Math.min(s.min, v);
  s.max = s.max === null ? v : Math.max(s.max, v);
  s.sum += v; s.n++;
}

/**
 * Add one SEKO sample. flowLph null = unknown -> skipped.
 * @returns {boolean} true when the sample was used
 */
function addSample(acc, { ph = null, ec = null, flowLph = null, expectedLph = null, phMin = 3, phMax = 9 } = {}) {
  const flowOk = flowLph !== null && flowLph !== undefined && Number.isFinite(flowLph)
    && expectedLph > 0 && flowLph >= expectedLph * MIN_FLOW_FRACTION;
  if (!flowOk) { acc.skipped++; return false; }
  let used = false;
  if (ph !== null && ph !== undefined && Number.isFinite(ph) && ph >= phMin && ph <= phMax) { addTo(acc.ph, ph); used = true; }
  if (ec !== null && ec !== undefined && Number.isFinite(ec) && ec > 0) { addTo(acc.ec, ec); used = true; }
  if (!used) acc.skipped++;
  return used;
}

function accFields(acc) {
  const a = acc || newAcc();
  return {
    ec_avg_us: a.ec.n ? r1(a.ec.sum / a.ec.n) : null,
    ec_min_us: a.ec.min,
    ec_max_us: a.ec.max,
    ec_samples: a.ec.n,
    ph_avg: a.ph.n ? r2(a.ph.sum / a.ph.n) : null,
    ph_min: a.ph.min,
    ph_max: a.ph.max,
    samples: a.ph.n,
    skipped_samples: a.skipped,
  };
}

function isShutdownEnd({ endSource = null, endReason = null } = {}) {
  return endSource === SHUTDOWN_SOURCE || (typeof endReason === 'string' && endReason.startsWith(SHUTDOWN_SOURCE));
}

/** water_l / mean dosed litres of the zone's nutrient tanks (1:N). */
function zoneAchievedRatio(rec) {
  const tanks = (rec && Array.isArray(rec.tanks) ? rec.tanks : []).filter(t => typeof t.dosed_l === 'number' && Number.isFinite(t.dosed_l));
  if (!tanks.length || !(rec.water_l > 0)) return null;
  const mean = tanks.reduce((s, t) => s + Math.max(0, t.dosed_l), 0) / tanks.length;
  return mean > 0 ? Math.round(rec.water_l / mean) : null;
}

function durationS(rec) {
  const a = parseTs(rec.started_at); const b = parseTs(rec.ended_at);
  return a !== null && b !== null && b >= a ? (b - a) / 1000 : null;
}

/**
 * Status of one finished zone record.
 * @param {object} rec
 * @param {object} ctx { expectedLph, last (bool: last record of the run), shutdown (bool, run-level) }
 */
function zoneStatus(rec, { expectedLph = null, last = false, shutdown = false } = {}) {
  if (rec.not_run) return 'not_run';
  if (shutdown && last) return 'shutdown';
  const dur = durationS(rec);
  if (dur !== null && dur >= NO_WATER_MIN_S && expectedLph > 0 && typeof rec.water_l === 'number') {
    const expectedWater = (dur * expectedLph) / 3600;
    if (rec.water_l < expectedWater * NO_WATER_FRACTION) return 'no_water';
  }
  if (dur !== null && rec.planned_s > 0 && dur < rec.planned_s - Math.max(CUT_SHORT_MIN_S, rec.planned_s * CUT_SHORT_PCT)) return 'cut_short';
  return 'ok';
}

function mergeStat(parts, avgKey, nKey, minKey, maxKey, digits) {
  let sum = 0; let n = 0; let mn = null; let mx = null;
  for (const p of parts) {
    if (p[avgKey] !== null && p[avgKey] !== undefined && p[nKey] > 0) { sum += p[avgKey] * p[nKey]; n += p[nKey]; }
    if (p[minKey] !== null && p[minKey] !== undefined) mn = mn === null ? p[minKey] : Math.min(mn, p[minKey]);
    if (p[maxKey] !== null && p[maxKey] !== undefined) mx = mx === null ? p[maxKey] : Math.max(mx, p[maxKey]);
  }
  const avg = n ? (digits === 1 ? r1(sum / n) : r2(sum / n)) : null;
  return { [avgKey]: avg, [nKey]: n, [minKey]: mn, [maxKey]: mx };
}

/**
 * One row per zone visit: consecutive records of the SAME channel are merged.
 * They come from (a) slots_per_zone > 1 (half-zone targets) and (b) the flow
 * watch cold-restart retry (pumps + zone OFF ~10 s, then the same zone back ON
 * with a new open time -> a new controller segment). The merged row sums water
 * and litres and pools the EC/pH samples (analyseZones adds `segments`,
 * `retries` and the statuses).
 */
function mergeZoneVisits(records, { expectedLph = null } = {}) { // eslint-disable-line no-unused-vars
  const out = [];
  for (const rec of records) {
    const prev = out[out.length - 1];
    if (prev && !rec.not_run && !prev.not_run && rec.channel !== null && rec.channel !== undefined && rec.channel === prev.channel) prev._parts.push(rec);
    else out.push({ ...rec, _parts: [rec] });
  }
  return out.map((row) => {
    const parts = row._parts;
    delete row._parts;
    if (parts.length === 1) return row;
    const first = parts[0]; const last = parts[parts.length - 1];
    const tanks = new Map();
    for (const p of parts) {
      for (const t of p.tanks || []) {
        const m = tanks.get(t.tank_id);
        if (!m) { const { achieved_ratio, ...rest } = t; tanks.set(t.tank_id, { ...rest }); continue; }
        m.target_l = r2((m.target_l || 0) + (t.target_l || 0));
        m.dosed_l = r2((m.dosed_l || 0) + (t.dosed_l || 0));
        m.carry_out_l = t.carry_out_l; m.closed_by = t.closed_by; m.closed_at_s = null;
        m.reopens = (m.reopens || 0) + (t.reopens || 0);
        m.cant_reach = !!(m.cant_reach || t.cant_reach);
      }
    }
    const { achieved_ratio, status, ...base } = first;
    return {
      ...base,
      slot: 0,
      started_at: first.started_at,
      ended_at: last.ended_at,
      water_l: r1(parts.reduce((s, p) => s + (p.water_l || 0), 0)),
      tanks: [...tanks.values()],
      ...mergeStat(parts, 'ec_avg_us', 'ec_samples', 'ec_min_us', 'ec_max_us', 1),
      ...mergeStat(parts, 'ph_avg', 'samples', 'ph_min', 'ph_max', 2),
      skipped_samples: parts.reduce((s, p) => s + (p.skipped_samples || 0), 0),
      parts: parts.length,
    };
  });
}

const withRatios = (rec) => {
  const tanks = (rec.tanks || []).map(t => ({
    ...t,
    achieved_ratio: t.achieved_ratio !== undefined ? t.achieved_ratio
      : (t.dosed_l > 0 && rec.water_l > 0 ? Math.round(rec.water_l / t.dosed_l) : null),
  }));
  const next = { ...rec, tanks };
  next.achieved_ratio = zoneAchievedRatio(next);
  return next;
};

/**
 * Status + ratios for a run's zone records, and the per-zone-visit rows.
 *
 *   zones   the controller's segment records as stored (one per segment:
 *           slots_per_zone > 1 and flow-watch retries give several per zone),
 *           each with status / achieved_ratio; + not_run rows after a shutdown.
 *   visits  one row per zone visit (consecutive same-channel segments merged,
 *           see mergeZoneVisits) — what the dashboard table shows.
 *
 * Statuses: a single-segment visit gets the full rules (zoneStatus); in a
 * multi-segment visit each segment is judged on water only (a later slot or a
 * retry runs for the remaining time, its planned_s is the whole zone's) and
 * the visit row gets the full rules on the merged numbers. The zone running
 * when the flow watch shut the run down is 'shutdown' (segment + visit).
 *
 * @param {object[]} records
 * @param {object} ctx { expectedLph, final (bool: run has ended), endSource, endReason,
 *   plan: { [channel]: [{delay, duration}] } + startedAtMs + names -> not_run rows on shutdown.
 *   Without a plan, not_run rows already in `records` are kept. }
 */
function analyseZones(records, { expectedLph = null, final = false, endSource = null, endReason = null, plan = null, startedAtMs = null, names = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  const shutdown = final && isShutdownEnd({ endSource, endReason });
  const raw = list.filter(r => !r.not_run).map(withRatios);
  // group consecutive same-channel records (indices into raw)
  const groups = [];
  raw.forEach((rec, i) => {
    const g = groups[groups.length - 1];
    if (g && rec.channel !== null && rec.channel !== undefined && raw[g[g.length - 1]].channel === rec.channel) g.push(i);
    else groups.push([i]);
  });
  const zones = raw.map(r => ({ ...r }));
  const visits = [];
  groups.forEach((idx, gi) => {
    const lastVisit = gi === groups.length - 1;
    const parts = idx.map(i => raw[i]);
    const visit = withRatios(parts.length === 1 ? { ...parts[0] } : mergeZoneVisits(parts, { expectedLph })[0]);
    visit.status = zoneStatus(visit, { expectedLph, last: final && lastVisit, shutdown });
    if (parts.length === 1) {
      zones[idx[0]].status = visit.status;
    } else {
      idx.forEach((i, k) => {
        const lastPart = lastVisit && k === idx.length - 1;
        zones[i].status = zoneStatus({ ...raw[i], planned_s: null }, { expectedLph, last: final && lastPart, shutdown });
      });
      visit.segments = idx.map((i, k) => ({
        slot: raw[i].slot ?? 0, started_at: raw[i].started_at, ended_at: raw[i].ended_at, water_l: raw[i].water_l,
        status: zones[i].status, retry: k > 0 && (raw[i].slot ?? 0) === 0,
      }));
      visit.retries = visit.segments.filter(sg => sg.retry).length;
    }
    visit.visit = visits.length + 1;
    visits.push(visit);
  });
  let notRun = [];
  if (shutdown && plan && startedAtMs !== null) {
    const lastRec = raw[raw.length - 1];
    const lastStart = lastRec ? parseTs(lastRec.started_at) : startedAtMs;
    const seen = new Set(raw.map(r => r.channel));
    const planned = [];
    for (const [chStr, opts] of Object.entries(plan)) {
      const ch = Number(chStr);
      for (const o of opts || []) {
        const at = startedAtMs + (Number(o.delay) || 0) * 1000;
        if (!seen.has(ch) && at > (lastStart ?? -Infinity)) planned.push({ ch, at, duration: o.duration });
      }
    }
    planned.sort((a, b) => a.at - b.at);
    for (const p of planned) {
      if (seen.has(p.ch)) continue;
      seen.add(p.ch);
      notRun.push({
        zone: raw.length + notRun.length + 1, channel: p.ch, name: (names && names[p.ch]) || `Zone relay ${p.ch}`, slot: 0,
        started_at: null, ended_at: null, planned_s: p.duration ?? null, planned_at: new Date(p.at).toISOString(),
        water_l: null, tanks: [], not_run: true, status: 'not_run', achieved_ratio: null,
        ...accFields(null), samples: 0,
      });
    }
  } else {
    notRun = list.filter(r => r.not_run).map(r => ({ ...r, status: 'not_run' }));
  }
  for (const r of notRun) visits.push({ ...r, visit: visits.length + 1 });
  return { zones: [...zones, ...notRun], visits };
}

/** Status + ratios on the stored segment records (see analyseZones). */
function decorateZones(records, ctx = {}) {
  return analyseZones(records, ctx).zones;
}

/**
 * Run-level totals row for the per-zone table.
 * EC/pH totals are the sample-weighted mean of the zone averages (same sample
 * filter as the zones), falling back to the run-level stats.
 */
function zoneTotals(run, zones) {
  const tanks = (run.tanks || []).map(t => ({ tank_id: t.tank_id, name: t.name, dosed_l: t.dosed_l ?? null }));
  const ran = (zones || []).filter(z => !z.not_run);
  const water = typeof run.water_l === 'number' ? run.water_l
    : ran.reduce((s, z) => s + (z.water_l || 0), 0);
  const dosed = tanks.filter(t => typeof t.dosed_l === 'number');
  const mean = dosed.length ? dosed.reduce((s, t) => s + Math.max(0, t.dosed_l), 0) / dosed.length : 0;
  const wavg = (avgKey, nKey) => {
    let sum = 0; let n = 0;
    for (const z of ran) if (z[avgKey] !== null && z[avgKey] !== undefined && z[nKey] > 0) { sum += z[avgKey] * z[nKey]; n += z[nKey]; }
    return n ? { avg: sum / n, n } : null;
  };
  const ec = wavg('ec_avg_us', 'ec_samples');
  const ph = wavg('ph_avg', 'samples');
  return {
    water_l: r1(water),
    tanks,
    achieved_ratio: mean > 0 && water > 0 ? Math.round(water / mean) : null,
    ec_avg_us: ec ? r1(ec.avg) : (run.ec_us && run.ec_us.avg !== undefined ? run.ec_us.avg : null),
    ph_avg: ph ? r2(ph.avg) : (run.ph && run.ph.avg !== undefined ? run.ph.avg : null),
    samples: ph ? ph.n : 0,
    ec_samples: ec ? ec.n : 0,
    zones_ok: ran.filter(z => z.status === 'ok').length,
    zones_total: (zones || []).length,
  };
}

/**
 * Compute per-zone stats for a finished run from stored readings (legacy runs).
 * Read-only. Returns a Map(recordIndex -> accFields) or null when there is
 * nothing to compute from.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} run  formatted run (started_at, ended_at, zones)
 * @param {object} opts { sensorEquipmentId, phMetric, ecMetric, expectedLph, phMin, phMax }
 */
function statsFromHistory(db, run, { sensorEquipmentId, phMetric = 'pH', ecMetric = 'Water EC', expectedLph, phMin = 3, phMax = 9 } = {}) {
  const zones = (run.zones || []).filter(z => !z.not_run);
  if (!zones.length || !sensorEquipmentId || !(expectedLph > 0)) return null;
  const startMs = parseTs(run.started_at);
  const endMs = parseTs(run.ended_at) ?? Math.max(...zones.map(z => parseTs(z.ended_at) || 0));
  if (startMs === null || !endMs) return null;
  const bounds = (a, b) => {
    const isoA = new Date(a).toISOString(); const isoB = new Date(b).toISOString();
    return [isoA, isoB, isoA.replace('T', ' ').slice(0, 19), isoB.replace('T', ' ').slice(0, 19)];
  };
  const [ia, ib, sa, sb] = bounds(startMs - 1000, endMs + 1000);
  const [fa, fb, fsa, fsb] = bounds(startMs - FLOW_HOLD_MS, endMs + 1000);
  let seko; let flows;
  try {
    seko = db.prepare(`
      SELECT name, value, timestamp FROM readings
      WHERE equipment_id = ? AND name IN (?, ?) AND ((timestamp BETWEEN ? AND ?) OR (timestamp BETWEEN ? AND ?))
    `).all(sensorEquipmentId, phMetric, ecMetric, ia, ib, sa, sb);
    flows = db.prepare(`
      SELECT r.value, r.timestamp FROM readings r JOIN equipment e ON e.id = r.equipment_id
      WHERE r.name = 'Flow Rate' AND LOWER(COALESCE(e.protocol, '')) = 'mqtt' AND ((r.timestamp BETWEEN ? AND ?) OR (r.timestamp BETWEEN ? AND ?))
    `).all(fa, fb, fsa, fsb);
  } catch (_) {
    return null;
  }
  const flowPts = flows.map(f => [parseTs(f.timestamp), Number(f.value)]).filter(p => p[0] !== null && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  const flowAt = (ms) => {
    let lo = 0; let hi = flowPts.length - 1; let best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (flowPts[mid][0] <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0 || ms - flowPts[best][0] > FLOW_HOLD_MS) return null;
    return flowPts[best][1];
  };
  const byTs = new Map();
  for (const r of seko) {
    const ms = parseTs(r.timestamp);
    if (ms === null) continue;
    const s = byTs.get(ms) || { ms, ph: null, ec: null };
    if (r.name === phMetric) s.ph = Number(r.value); else s.ec = Number(r.value);
    byTs.set(ms, s);
  }
  const windows = zones.map(z => [parseTs(z.started_at), parseTs(z.ended_at)]);
  const accs = zones.map(() => newAcc());
  for (const s of [...byTs.values()].sort((a, b) => a.ms - b.ms)) {
    const i = windows.findIndex(([a, b]) => a !== null && b !== null && s.ms >= a && s.ms <= b);
    if (i < 0) continue;
    addSample(accs[i], { ph: s.ph, ec: s.ec, flowLph: flowAt(s.ms), expectedLph, phMin, phMax });
  }
  return accs.map(accFields);
}

module.exports = {
  MIN_FLOW_FRACTION,
  NO_WATER_FRACTION,
  SHUTDOWN_SOURCE,
  newAcc,
  addSample,
  accFields,
  zoneStatus,
  zoneAchievedRatio,
  analyseZones,
  decorateZones,
  mergeZoneVisits,
  zoneTotals,
  statsFromHistory,
  isShutdownEnd,
  parseTs,
};
