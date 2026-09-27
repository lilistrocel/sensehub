import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from './constants';
import { usePoll } from '../../hooks/usePoll';
import { onResume } from '../../utils/connectivity';
import {
  IRRIGATION,
  flowPointOf,
  mergeFlowPoints,
  pickMonitor,
  skewFromSnapshot,
  toMs,
} from './irrigationLive';

/**
 * Live data for the dashboard Irrigation card. Read-only: every request is a GET.
 *
 * - Monitor snapshot: GET /api/mqtt/monitors on mount, then patched by the
 *   `irrigation_monitor_live` WebSocket event (the ingest service pushes it at
 *   most 1 Hz). When no live event has arrived for IRRIGATION.wsQuietMs the
 *   hook polls every IRRIGATION.pollMs instead; last_cycle (not in the WS
 *   payload) is refreshed every IRRIGATION.slowPollMs. Polling pauses while
 *   the tab is hidden.
 * - Flow ring buffer (10 min) seeded from /api/equipment/:id/history/chart.
 * - Channel config (expected flow, tank -> relay channel) every 10 min.
 * - Daily report (measured totals, tank map) every 3 min and after a cycle ends.
 * - Last irrigation RUN of any type (scheduled / manual app / manual panel:
 *   per-zone water, A-D, ratio, EC, pH) with the report:
 *   GET /api/irrigation/runs/last; older backends: /api/dose-controller/runs/last
 *   (then status.last_run). Today's runs: GET /api/irrigation/runs?date=today.
 *   Both refresh on the `irrigation_runs_updated` WebSocket event.
 */
export function useIrrigationLive({ token, subscribe }) {
  const [monitor, setMonitor] = useState(null);
  const [skewMs, setSkewMs] = useState(0);
  const [flowBuffer, setFlowBuffer] = useState([]);
  const [channelConfig, setChannelConfig] = useState(null);
  const [report, setReport] = useState(null);
  const [lastRun, setLastRun] = useState(undefined); // undefined = not loaded, null = none
  const [todayRuns, setTodayRuns] = useState(undefined); // { total, water_l, runs } | null (old backend)
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [firstSeenOnMs, setFirstSeenOnMs] = useState({});

  const lastWsAt = useRef(0);
  const lastFetchAt = useRef(0);
  const inFlight = useRef(false);
  const seededFor = useRef(null);
  const skewRef = useRef(0);
  const monitorRef = useRef(null);
  const lastCycleIdRef = useRef(undefined);
  const wasActiveRef = useRef(null);

  const auth = useCallback(() => ({ headers: { Authorization: `Bearer ${token}` } }), [token]);

  const ingestSnapshot = useCallback((snap, skew) => {
    if (!snap) return;
    if (skew !== null && skew !== undefined && Number.isFinite(skew)) {
      skewRef.current = skew;
      setSkewMs(skew);
    }
    const p = flowPointOf(snap);
    if (p) setFlowBuffer((prev) => mergeFlowPoints(prev, [p], Date.now() + skewRef.current));
  }, []);

  const fetchReport = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API_BASE}/reports/daily?days=1`, auth());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReport(await r.json());
    } catch (e) {
      // The card shows "—" for today's totals; not worth a toast.
      setReport((prev) => prev || { error: e.message });
    }
  }, [token, auth]);

  const fetchLastRun = useCallback(async () => {
    if (!token) return;
    try {
      const ir = await fetch(`${API_BASE}/irrigation/runs/last`, auth());
      if (ir.ok) {
        const body = await ir.json();
        if (body && body.run) { setLastRun(body.run); return; }
      }
    } catch (e) { /* fall back to the dose-controller record */ }
    try {
      let r = await fetch(`${API_BASE}/dose-controller/runs/last`, auth());
      if (r.status === 404) {
        r = await fetch(`${API_BASE}/dose-controller/status`, auth());
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.json();
        setLastRun(s && s.last_run ? s.last_run : null);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      setLastRun(body && body.run ? body.run : null);
    } catch (e) {
      setLastRun((prev) => (prev === undefined ? null : prev));
    }
  }, [token, auth]);

  const fetchTodayRuns = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API_BASE}/irrigation/runs?date=today&limit=30`, auth());
      if (r.status === 404) { setTodayRuns(null); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTodayRuns(await r.json());
    } catch (e) {
      setTodayRuns((prev) => (prev === undefined ? null : prev));
    }
  }, [token, auth]);

  const fetchConfig = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API_BASE}/fertigation/channels`, auth());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      setChannelConfig(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setChannelConfig((prev) => prev || []);
    }
  }, [token, auth]);

  const seedFlow = useCallback(async (equipmentId) => {
    if (!token || !equipmentId || seededFor.current === equipmentId) return;
    seededFor.current = equipmentId;
    try {
      const from = new Date(Date.now() + skewRef.current - IRRIGATION.sparkWindowMs).toISOString();
      const r = await fetch(`${API_BASE}/equipment/${equipmentId}/history/chart?from=${encodeURIComponent(from)}`, auth());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      const pts = (Array.isArray(rows) ? rows : [])
        .filter((row) => row.name === 'Flow Rate')
        .map((row) => ({ t: toMs(row.timestamp), v: Number(row.avg_value) }))
        .filter((p) => p.t !== null && Number.isFinite(p.v));
      if (pts.length) setFlowBuffer((prev) => mergeFlowPoints(prev, pts, Date.now() + skewRef.current));
    } catch (e) {
      seededFor.current = null; // retry on the next poll
    }
  }, [token, auth]);

  const fetchMonitors = useCallback(async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    lastFetchAt.current = Date.now();
    try {
      const r = await fetch(`${API_BASE}/mqtt/monitors`, auth());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const localMs = Date.now();
      const m = pickMonitor(body.monitors);
      const serverNow = toMs(body.now);
      ingestSnapshot(m, serverNow !== null ? serverNow - localMs : null);
      monitorRef.current = m;
      setMonitor(m);
      setError(null);
      if (m?.equipment_id) seedFlow(m.equipment_id);
    } catch (e) {
      // Raw message; IrrigationCard renders it inside a translated sentence.
      setError(e.message || String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [token, auth, ingestSnapshot, seedFlow]);

  // Initial loads + periodic refreshes of the slow sources (paused while hidden,
  // refreshed once on resume).
  useEffect(() => { fetchMonitors(); }, [fetchMonitors]);
  usePoll(fetchConfig, IRRIGATION.configPollMs);
  const fetchReports = useCallback(() => { fetchReport(); fetchLastRun(); fetchTodayRuns(); }, [fetchReport, fetchLastRun, fetchTodayRuns]);
  usePoll(fetchReports, IRRIGATION.reportPollMs);

  // Runs regrouped by the backend (new cycle report / run closed): refresh both.
  useEffect(() => {
    if (typeof subscribe !== 'function') return undefined;
    let t = null;
    const off = subscribe('irrigation_runs_updated', () => {
      if (t) return;
      t = setTimeout(() => { t = null; fetchLastRun(); fetchTodayRuns(); }, 1000);
    });
    return () => { if (t) clearTimeout(t); if (typeof off === 'function') off(); };
  }, [subscribe, fetchLastRun, fetchTodayRuns]);

  // Poll when the WebSocket is quiet; always refresh last_cycle every 30 s.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const wsLive = now - lastWsAt.current < IRRIGATION.wsQuietMs;
      if (!wsLive || now - lastFetchAt.current >= IRRIGATION.slowPollMs) fetchMonitors();
    }, IRRIGATION.pollMs);
    // Back from the background: one refresh once visible AND online (debounced),
    // not a request into a network that is still waking up.
    const offResume = onResume(() => fetchMonitors());
    return () => { clearInterval(id); offResume(); };
  }, [fetchMonitors]);

  // Live WebSocket patch.
  useEffect(() => {
    if (typeof subscribe !== 'function') return undefined;
    return subscribe('irrigation_monitor_live', (snap) => {
      if (!snap) return;
      const current = monitorRef.current;
      if (current && String(snap.farm_id) !== String(current.farm_id)) return;
      if (!current && Number(snap.equipment_id) !== IRRIGATION.monitorEquipmentId) return;
      lastWsAt.current = Date.now();
      ingestSnapshot(snap, skewFromSnapshot(snap, Date.now()));
      const next = { ...snap, last_cycle: current?.last_cycle ?? null };
      monitorRef.current = next;
      setMonitor(next);
    });
  }, [subscribe, ingestSnapshot]);

  // A cycle just ended (active -> idle) or a new cycle report landed:
  // pull last_cycle and today's measured totals.
  useEffect(() => {
    const active = !!monitor?.irrigation?.active;
    if (wasActiveRef.current === true && !active) {
      const t = setTimeout(() => { fetchMonitors(); fetchReport(); fetchLastRun(); fetchTodayRuns(); }, 4000);
      wasActiveRef.current = active;
      return () => clearTimeout(t);
    }
    wasActiveRef.current = active;
    return undefined;
  }, [monitor?.irrigation?.active, fetchMonitors, fetchReport, fetchLastRun, fetchTodayRuns]);

  useEffect(() => {
    const id = monitor?.last_cycle?.id;
    if (id === undefined) return;
    if (lastCycleIdRef.current !== undefined && lastCycleIdRef.current !== id) { fetchReport(); fetchLastRun(); fetchTodayRuns(); }
    lastCycleIdRef.current = id;
  }, [monitor?.last_cycle?.id, fetchReport, fetchLastRun, fetchTodayRuns]);

  // Remember when a zone was first seen ON (fallback when the board has no lastChangeTs).
  const noteZoneStates = useCallback((zones) => {
    setFirstSeenOnMs((prev) => {
      let changed = false;
      const next = { ...prev };
      const serverNow = Date.now() + skewRef.current;
      for (const z of zones) {
        if (z.state === 'on' && next[z.key] === undefined) { next[z.key] = serverNow; changed = true; }
        if (z.state !== 'on' && next[z.key] !== undefined) { delete next[z.key]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  return { monitor, skewMs, flowBuffer, channelConfig, report, lastRun, todayRuns, error, loading, firstSeenOnMs, noteZoneStates, refresh: fetchMonitors };
}

export default useIrrigationLive;
