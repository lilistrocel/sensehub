/**
 * Irrigation card: constants and pure derivation (no React, no fetch) so the
 * mismatch / freshness rules can be unit-tested.
 *
 * Data sources (all GET, read-only):
 *   - monitor snapshot  GET /api/mqtt/monitors, patched live by the
 *                       `irrigation_monitor_live` WebSocket event (1 Hz)
 *   - relay states      status-board relayGroups (equipment 1 valves/pumps,
 *                       equipment 2 dosing relays)
 *   - expected flow     GET /api/fertigation/channels (relay_channel_config.flow_rate)
 *   - today / tank map  GET /api/reports/daily?days=1 (measured section, tank_map)
 *   - sparkline seed    GET /api/equipment/:id/history/chart (metric "Flow Rate")
 *
 * Everything here is display logic. The backend flow-watch alerts are separate;
 * nothing on this card writes anything.
 */

export const IRRIGATION = {
  monitorEquipmentId: 19,     // "Irrigation Monitor 1021" (preferred when several monitors exist)
  valveEquipmentId: 1,        // Waveshare Irrigation 1: pumps + zone valves
  dosingEquipmentId: 2,       // Waveshare Irrigation 2: pH down + tanks A-D
  zoneLabelRe: /zone/i,
  pumpLabelRe: /pump/i,

  flowZeroLph: 200,           // below this the line counts as "no flow" (~2 % of one zone)
  flowNoZoneLph: 1000,        // flow above this with every zone valve shut is a mismatch
  zoneNoFlowGraceS: 20,       // zone ON + no flow for longer than this -> caution
  flowNoZoneGraceS: 10,       // valves just closed: let the line drain before flagging
  dosingNoFlowGraceS: 10,     // tank rates lag the flow meter at cycle end
  deviationGraceS: 20,        // flow ramps for a few seconds after a zone opens
  dosingActiveLph: 0.5,       // a tank rate above this counts as dosing
  signalMin: 60,              // flow-meter signal quality (%) below this = meter fault
  defaultDeviationPct: 15,    // used until the daily report supplies its threshold
  monitorStaleS: 60,          // mirrors backend MqttDownsampler STALE_AFTER_MS

  sparkWindowMs: 10 * 60 * 1000,
  sparkGapMs: 6 * 60 * 1000,  // history is downsampled with a 5 min heartbeat

  pollMs: 3000,               // poll cadence when the WebSocket is quiet
  wsQuietMs: 5000,            // no live event for this long -> poll
  slowPollMs: 30000,          // refresh last_cycle even while the WS is live
  reportPollMs: 3 * 60 * 1000,
  configPollMs: 10 * 60 * 1000,
};

const FLOW_UNIT_TO_LPH = { 'l/min': 60, 'lpm': 60, 'l/h': 1, 'lph': 1, 'm3/h': 1000, 'm³/h': 1000 };

export function toMs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  let s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** relay_channel_config flow_rate in L/h (null when missing / zero). */
export function configFlowLph(row) {
  if (!row) return null;
  const rate = num(row.flow_rate);
  if (!(rate > 0)) return null;
  const factor = FLOW_UNIT_TO_LPH[String(row.flow_unit || 'L/min').toLowerCase()] ?? 60;
  return rate * factor;
}

/** "Tank A — Calcium nitrate" -> { letter: 'A', desc: 'Calcium nitrate' }. */
export function splitTankName(name, fallbackId) {
  const s = String(name || '').trim();
  const m = s.match(/^tank\s+(\S+)(?:\s*[—–-]\s*(.+))?$/i);
  if (m) return { letter: m[1], desc: m[2] || s };
  if (s) return { letter: String(fallbackId ?? '?'), desc: s };
  return { letter: String(fallbackId ?? '?'), desc: `Tank ${fallbackId ?? '?'}` };
}

/** "Irrigation Zone 1" -> "Zone 1". */
export function shortZoneLabel(label) {
  return String(label || '').replace(/^irrigation\s+/i, '').trim() || String(label || '');
}

/** Pick the monitor to show: equipment 19 first, else the first one listed. */
export function pickMonitor(monitors, equipmentId = IRRIGATION.monitorEquipmentId) {
  if (!Array.isArray(monitors) || monitors.length === 0) return null;
  return monitors.find((m) => Number(m.equipment_id) === Number(equipmentId)) || monitors[0];
}

/** Server clock minus local clock, from a snapshot received at `localMs`. */
export function skewFromSnapshot(snap, localMs) {
  const seen = toMs(snap?.last_seen);
  const age = num(snap?.age_s);
  if (seen === null || age === null) return null;
  return seen + age * 1000 - localMs;
}

/** Flow point {t, v} from a snapshot (device ts preferred), or null. */
export function flowPointOf(snap) {
  const f = snap?.flowmeter;
  if (!f) return null;
  const v = num(f.flow_lph);
  const t = toMs(f.ts) ?? toMs(f.received_at);
  if (v === null || t === null) return null;
  return { t, v };
}

/** Merge points into a sorted, de-duplicated ring buffer trimmed to the window. */
export function mergeFlowPoints(buffer, points, nowMs, windowMs = IRRIGATION.sparkWindowMs) {
  const byT = new Map();
  for (const p of buffer || []) byT.set(p.t, p);
  for (const p of points || []) if (p && Number.isFinite(p.t) && Number.isFinite(p.v)) byT.set(p.t, p);
  // Keep one point before the window so the step line starts at the left edge.
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
  const cutoff = nowMs - windowMs;
  let firstIn = sorted.findIndex((p) => p.t >= cutoff);
  if (firstIn === -1) firstIn = sorted.length;
  return sorted.slice(Math.max(0, firstIn - 1));
}

/** Latest buffer timestamp at which flow was at/above the "no flow" threshold (null if never). */
export function lastFlowAboveMs(buffer, threshold = IRRIGATION.flowZeroLph) {
  for (let i = (buffer || []).length - 1; i >= 0; i--) {
    if (buffer[i].v >= threshold) return buffer[i].t;
  }
  return null;
}

/**
 * How long (s) the flow has been below the threshold, or null when unknown.
 * Bounded by the buffer: if every buffered point is below, the first one is
 * the earliest time we can vouch for.
 */
export function noFlowForS(buffer, serverNowMs, threshold = IRRIGATION.flowZeroLph) {
  if (!buffer || buffer.length === 0) return null;
  const last = buffer[buffer.length - 1];
  if (last.v >= threshold) return 0;
  const above = lastFlowAboveMs(buffer, threshold);
  // The first point after the last "above" one is when flow dropped.
  let dropMs;
  if (above === null) dropMs = buffer[0].t;
  else {
    const next = buffer.find((p) => p.t > above);
    dropMs = next ? next.t : last.t;
  }
  return Math.max(0, (serverNowMs - dropMs) / 1000);
}

function channelsOf(board, equipmentId) {
  const out = [];
  for (const g of board?.relayGroups || []) {
    for (const c of g.channels || []) {
      if (Number(c.equipment_id) === Number(equipmentId)) out.push(c);
    }
  }
  return out.sort((a, b) => a.channel - b.channel);
}

function relayStateOf(c) {
  if (!c) return 'unknown';
  if (c.state === true) return 'on';
  if (c.state === false) return 'off';
  return 'unknown';
}

/**
 * Build everything the card renders. `serverNowMs` is the local clock
 * corrected by the server skew so device timestamps compare fairly.
 */
export function deriveIrrigationView({
  monitor,
  board,
  channelConfig,
  report,
  flowBuffer,
  serverNowMs,
  firstSeenOnMs = {},
}) {
  const now = serverNowMs;
  const C = IRRIGATION;

  // ── monitor freshness ─────────────────────────────────────────────────
  const lastSeenMs = toMs(monitor?.last_seen);
  const ageS = lastSeenMs === null ? null : Math.max(0, (now - lastSeenMs) / 1000);
  const brokerOffline = monitor?.broker_state === 'offline';
  let monitorState = 'ok';
  if (!monitor) monitorState = 'none';
  else if (monitor.enabled === false) monitorState = 'disabled';
  else if (lastSeenMs === null || ageS > C.monitorStaleS) monitorState = brokerOffline || lastSeenMs === null ? 'offline' : 'stale';
  else if (monitor.status === 'offline') monitorState = 'offline';
  const live = monitorState === 'ok';

  const flow = monitor?.flowmeter || null;
  const flowRecvMs = toMs(flow?.received_at) ?? toMs(flow?.ts);
  const flowFresh = live && flowRecvMs !== null && now - flowRecvMs <= C.monitorStaleS * 1000;
  const flowLph = flowFresh ? num(flow.flow_lph) : null;
  const signal = num(flow?.signal_quality);
  const errorFlags = num(flow?.error_flags ?? monitor?.error_flags);

  const dosing = monitor?.dosing || null;
  const dosingRecvMs = toMs(dosing?.received_at) ?? toMs(dosing?.ts);
  const dosingFresh = live && dosingRecvMs !== null && now - dosingRecvMs <= C.monitorStaleS * 1000;

  const noFlow = flowLph !== null && flowLph < C.flowZeroLph;
  const noFlowS = noFlow ? (noFlowForS(flowBuffer, now) ?? 0) : 0;

  // ── meter fault ──────────────────────────────────────────────────────
  // `faultReasons` (English) for logs/tests; `faults` (key + value) for the UI.
  const faultReasons = [];
  const faults = [];
  if (flowFresh && errorFlags !== null && errorFlags !== 0) {
    const hex = `0x${errorFlags.toString(16).toUpperCase()}`;
    faultReasons.push(`error flags ${hex}`);
    faults.push({ key: 'errorFlags', value: hex });
  }
  if (flowFresh && signal !== null && signal < C.signalMin) {
    faultReasons.push(`signal ${Math.round(signal)} %`);
    faults.push({ key: 'signal', value: Math.round(signal) });
  }
  const meterFault = faultReasons.length > 0;

  // ── irrigation active ─────────────────────────────────────────────────
  const irrigating = live && !!monitor?.irrigation?.active;
  const sinceMs = irrigating ? toMs(monitor.irrigation.since) : null;
  const elapsedS = sinceMs !== null ? Math.max(0, (now - sinceMs) / 1000) : null;

  // ── valves and pumps (equipment 1) ────────────────────────────────────
  const valveChannels = channelsOf(board, C.valveEquipmentId);
  const zones = valveChannels.filter((c) => C.zoneLabelRe.test(c.label || '')).map((c) => ({
    key: `${c.equipment_id}:${c.channel}`,
    channel: c.channel,
    label: shortZoneLabel(c.label),
    fullLabel: c.label,
    state: relayStateOf(c),
    confirmed: c.confirmed !== false,
    lastChangeMs: toMs(c.lastChangeTs),
    expectedLph: configFlowLph((channelConfig || []).find((r) => Number(r.equipment_id) === Number(c.equipment_id) && Number(r.channel) === Number(c.channel))),
  }));
  const pumps = valveChannels.filter((c) => C.pumpLabelRe.test(c.label || '')).map((c) => ({
    key: `${c.equipment_id}:${c.channel}`,
    label: c.label,
    state: relayStateOf(c),
    confirmed: c.confirmed !== false,
  }));
  const boardKnown = !!board && zones.length > 0;
  const openZones = zones.filter((z) => z.state === 'on');
  const zonesUnknown = !boardKnown || zones.some((z) => z.state === 'unknown');

  const expectedLph = openZones.length > 0 && openZones.every((z) => z.expectedLph !== null)
    ? openZones.reduce((s, z) => s + z.expectedLph, 0)
    : null;
  const deviationPct = expectedLph && flowLph !== null ? ((flowLph - expectedLph) / expectedLph) * 100 : null;
  const threshold = num(report?.deviation_threshold_pct) ?? C.defaultDeviationPct;

  // When did the current set of open zones start (server ms)?
  const zoneOpenMs = openZones.length === 0 ? null : Math.max(...openZones.map((z) => z.lastChangeMs ?? firstSeenOnMs[z.key] ?? now));
  const zoneOpenS = zoneOpenMs === null ? null : Math.max(0, (now - zoneOpenMs) / 1000);
  const lastZoneChangeMs = zones.reduce((m, z) => (z.lastChangeMs !== null && z.lastChangeMs > m ? z.lastChangeMs : m), -Infinity);
  const sinceZonesClosedS = openZones.length === 0 && Number.isFinite(lastZoneChangeMs) ? (now - lastZoneChangeMs) / 1000 : Infinity;

  // ── visual mismatch hints (backend flow-watch alerts are separate) ────
  // `text` is the English reference; the card renders
  // irrigation:hint.<key> with `params` (zone labels are equipment data).
  const hints = [];
  const zoneList = openZones.map((z) => z.label).join(', ');
  if (boardKnown && openZones.length > 1) {
    hints.push({
      key: 'multi-zone', level: 'caution', params: { count: openZones.length, zones: zoneList },
      text: `${openZones.length} zones open at once (${zoneList}) — zones normally run one at a time`,
    });
  }
  if (openZones.length > 0 && noFlow) {
    const s = Math.min(noFlowS, zoneOpenS ?? noFlowS);
    if (s > C.zoneNoFlowGraceS) {
      hints.push({
        key: 'zone-no-flow', level: 'caution', params: { zones: zoneList, seconds: s },
        text: `${zoneList} open but no flow for ${formatDuration(s)}`,
      });
    }
  }
  if (flowLph !== null && flowLph > C.flowNoZoneLph && boardKnown && !zonesUnknown && openZones.length === 0 && sinceZonesClosedS > C.flowNoZoneGraceS) {
    hints.push({
      key: 'flow-no-zone', level: 'caution', params: { flowLph },
      text: `Flow ${formatInt(flowLph)} L/h with every zone valve shut`,
    });
  }
  if (flowLph !== null && openZones.length > 0 && deviationPct !== null && Math.abs(deviationPct) > threshold
      && (zoneOpenS ?? 0) > C.deviationGraceS && !noFlow) {
    hints.push({
      key: 'deviation', level: 'caution', params: { pct: Math.round(deviationPct), zones: zoneList },
      text: `Flow ${deviationPct > 0 ? '+' : ''}${deviationPct.toFixed(0)} % vs expected for ${zoneList}`,
    });
  }

  // ── dosing (equipment 2 relays, monitor tanks) ────────────────────────
  const tankMap = Array.isArray(report?.monitor?.tank_map) && report.monitor.tank_map.length
    ? report.monitor.tank_map
    : [1, 2, 3, 4, 5].map((n) => ({ monitor_tank: n, tank_id: n, tank_name: null, metered: n !== 5 }));
  const day = Array.isArray(report?.report) && report.report.length ? report.report[report.report.length - 1] : null;
  const measured = day?.measured?.available ? day.measured : null;
  const dosingChannels = channelsOf(board, C.dosingEquipmentId);
  const liveTanks = Array.isArray(dosing?.tanks) ? dosing.tanks : [];

  const tanks = tankMap.map((tm) => {
    const liveTank = liveTanks.find((t) => Number(t.id) === Number(tm.monitor_tank)) || null;
    const cfg = (channelConfig || []).find((r) => Number(r.equipment_id) === C.dosingEquipmentId && Number(r.tank_id) === Number(tm.tank_id));
    const measuredTank = measured?.tanks?.find((t) => Number(t.monitor_tank) === Number(tm.monitor_tank)) || null;
    const channelNo = cfg ? Number(cfg.channel) : (measuredTank ? Number(measuredTank.channel) : null);
    const relay = channelNo !== null ? dosingChannels.find((c) => Number(c.channel) === channelNo) : null;
    const name = tm.tank_name || cfg?.tank_name || relay?.label || `Tank ${tm.monitor_tank}`;
    const { letter, desc } = splitTankName(name, tm.monitor_tank);
    const metered = tm.metered !== false;
    const rate = metered && dosingFresh ? num(liveTank?.rate_lph) : null;
    const dosingNow = rate !== null && rate > C.dosingActiveLph;
    const alarm = metered && dosingNow && noFlow && noFlowS > C.dosingNoFlowGraceS;
    return {
      monitorTank: tm.monitor_tank,
      tankId: tm.tank_id,
      letter,
      desc,
      name,
      metered,
      rateLph: rate,
      rateStale: metered && !dosingFresh,
      todayL: metered ? num(measuredTank?.measured_liters) : null,
      relay: relay ? relayStateOf(relay) : 'unknown',
      relayConfirmed: relay ? relay.confirmed !== false : false,
      channel: channelNo,
      alarm,
    };
  });
  const dosingAlarm = tanks.some((t) => t.alarm);
  if (dosingAlarm) {
    const alarmTanks = tanks.filter((t) => t.alarm).map((t) => t.letter);
    hints.unshift({
      key: 'dosing-no-flow', level: 'alarm', params: { tanks: alarmTanks.join(', ') },
      text: `Dosing with no water flow: ${alarmTanks.map((l) => `Tank ${l}`).join(', ')}`,
    });
  }

  // ── today (measured) ──────────────────────────────────────────────────
  const today = {
    available: !!measured,
    // `reason` is server text (localized by the backend); reasonKey marks our own states.
    reason: day?.measured && !day.measured.available ? (day.measured.reason || 'not available') : (report ? null : 'loading'),
    reasonKey: day?.measured && !day.measured.available ? (day.measured.reason ? null : 'notAvailable') : (report ? null : 'loading'),
    waterM3: measured ? num(measured.water?.liters) / 1000 : null,
    cycles: measured ? (num(measured.water?.cycles_count) ?? (Array.isArray(measured.cycles) ? measured.cycles.length : null)) : null,
    fertL: measured ? num(measured.fertigation_liters) : null,
    coverageFrom: measured?.coverage && measured.coverage.complete === false ? measured.coverage.first_reading : null,
  };

  const lc = monitor?.last_cycle || null;
  const lastCycle = lc ? {
    id: lc.id,
    startMs: toMs(lc.start),
    endMs: toMs(lc.end),
    durationS: num(lc.duration_s),
    waterL: num(lc.water_m3) !== null ? num(lc.water_m3) * 1000 : null,
    tanks: (Array.isArray(lc.dosing) ? lc.dosing : []).map((d) => {
      const t = tanks.find((x) => Number(x.monitorTank) === Number(d.id));
      return { id: d.id, letter: t ? t.letter : String(d.id), metered: t ? t.metered : true, liters: num(d.consumed_l) };
    }).filter((t) => t.metered),
  } : null;

  // ── header state ──────────────────────────────────────────────────────
  // `key` -> irrigation:headline.<key>; `text` is the English reference.
  let headline;
  if (monitorState === 'none') headline = { key: 'noMonitor', state: 'idle', filled: false, text: 'No monitor', unknown: true };
  else if (monitorState === 'disabled') headline = { key: 'monitorDisabled', state: 'idle', filled: false, text: 'Monitor disabled', unknown: true };
  else if (monitorState === 'offline') headline = { key: 'monitorOffline', state: 'idle', filled: false, text: 'Monitor offline', unknown: true };
  else if (monitorState === 'stale') headline = { key: 'monitorStale', state: 'idle', filled: false, text: 'Monitor stale', unknown: true };
  else if (irrigating) headline = { key: 'irrigating', state: 'water', filled: true, text: 'Irrigating', unknown: false };
  else headline = { key: 'idle', state: 'idle', filled: true, text: 'Idle', unknown: false };

  let rail;
  if (!live) rail = 'stale';
  else if (dosingAlarm) rail = 'alarm';
  else if (meterFault || hints.length > 0) rail = 'caution';
  else if (irrigating) rail = 'water';
  else rail = 'idle';

  return {
    live,
    monitorState,
    ageS,
    lastSeenMs,
    headline,
    rail,
    meterFault,
    faultReasons,
    faults,
    irrigating,
    sinceMs,
    elapsedS,
    flow: {
      lph: flowLph,
      fresh: flowFresh,
      stale: !flowFresh && !!flow,
      unknown: !flow,
      receivedMs: flowRecvMs,
      signal,
      errorFlags,
      netTotalM3: flowFresh ? num(flow.net_total_m3) : null,
      expectedLph,
      deviationPct,
      threshold,
      noFlow,
    },
    zones,
    pumps,
    openZones,
    zoneOpenS,
    zonesUnknown,
    boardKnown,
    tanks,
    dosingFresh,
    dosingReceivedMs: dosingRecvMs,
    hints,
    today,
    lastCycle,
  };
}

// ── formatting ──────────────────────────────────────────────────────────
// English-only helpers kept for the pure derivation above and its tests. UI
// code formats with src/i18n/format.js (useFormat), which is language-aware.

export function formatInt(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Math.round(Number(v)).toLocaleString('en-US');
}

export function formatNum(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 8 -> "8 s", 372 -> "6 min 12 s", 3900 -> "1 h 05 min". */
export function formatDuration(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  if (t < 3600) {
    const m = Math.floor(t / 60);
    const r = t % 60;
    return r ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
  }
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}
