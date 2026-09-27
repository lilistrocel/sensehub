import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, STATUS_BOARD_POLL_MS } from './constants';
import { usePoll } from '../../hooks/usePoll';

/** Recount on/total/unknown for a group after its channels changed. */
function recount(group) {
  let on = 0, unknown = 0;
  group.channels.forEach((c) => {
    if (c.state === true) on++;
    if (c.state === null || c.state === undefined) unknown++;
  });
  return { ...group, on, unknown, total: group.channels.length };
}

/**
 * Apply one relay_state_changed event to the relayGroups array.
 * Shapes: { equipmentId, channel, state, confirmed }, { equipmentId, allChannels, state },
 *         { equipmentId, relayStates: { "1": true } }.
 * Unconfirmed / write-only events do NOT move the shown state (rule 4.1).
 */
export function applyRelayEvent(groups, data, nowIso) {
  if (!Array.isArray(groups) || !data) return groups;
  const eqId = Number(data.equipmentId ?? data.equipment_id);
  if (!Number.isFinite(eqId)) return groups;
  const confirmed = !(data.writeOnly || data.confirmed === false);
  let changed = false;
  const next = groups.map((g) => {
    let touched = false;
    const channels = g.channels.map((c) => {
      if (Number(c.equipment_id) !== eqId) return c;
      let state;
      if (data.relayStates && typeof data.relayStates === 'object') {
        const raw = data.relayStates[c.channel] ?? data.relayStates[String(c.channel)];
        if (raw === undefined) return c;
        state = !!raw;
      } else if (data.allChannels) {
        state = !!data.state;
      } else if (Number(data.channel) === Number(c.channel)) {
        state = !!data.state;
      } else {
        return c;
      }
      touched = true;
      if (!confirmed) return { ...c, confirmed: false };
      return { ...c, state, confirmed: true, unknownReason: null, lastChangeTs: nowIso, source: data.source || c.source };
    });
    if (!touched) return g;
    changed = true;
    return recount({ ...g, channels });
  });
  return changed ? next : groups;
}

/** Patch a single-source climate tile from a sensor_reading event. */
export function applySensorReading(climate, data) {
  if (!Array.isArray(climate) || !data) return climate;
  const eqId = Number(data.equipment_id ?? data.equipmentId);
  const metric = data.name ?? data.metric;
  const value = Number(data.value);
  if (!Number.isFinite(eqId) || !metric || !Number.isFinite(value)) return climate;
  let changed = false;
  const next = climate.map((c) => {
    if (Array.isArray(c.equipment_id)) return c; // averaged tile: wait for the poll
    if (Number(c.equipment_id) !== eqId || c.metric !== metric) return c;
    changed = true;
    return { ...c, value, unit: data.unit || c.unit, ts: data.timestamp || new Date().toISOString(), stale: false };
  });
  return changed ? next : climate;
}

/**
 * Status-board data: fetched every 15 s, patched from the WebSocket in between.
 * Also loads the equipment list once (register mappings carry the interlock
 * pairs the board needs to refuse bulk control).
 */
export function useStatusBoard({ token, subscribe, notifyError }) {
  const [board, setBoard] = useState(null);
  const [equipmentById, setEquipmentById] = useState({});
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const inFlight = useRef(false);

  const fetchBoard = useCallback(async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetch(`${API_BASE}/dashboard/status-board`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setBoard(data);
      setFetchedAt(Date.now());
    } catch (e) {
      notifyError?.(`Status board unavailable: ${e.message}`, 'status-board');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [token, notifyError]);

  const fetchEquipment = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API_BASE}/equipment`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      const map = {};
      (Array.isArray(list) ? list : []).forEach((eq) => {
        let mappings = eq.register_mappings;
        if (typeof mappings === 'string') { try { mappings = JSON.parse(mappings); } catch { mappings = []; } }
        map[eq.id] = { id: eq.id, name: eq.name, write_only: !!eq.write_only, mappings: Array.isArray(mappings) ? mappings : [] };
      });
      setEquipmentById(map);
    } catch (e) {
      notifyError?.(`Equipment list unavailable: ${e.message}`, 'equipment-list');
    }
  }, [token, notifyError]);

  // Board: now, every 15 s while visible, once on resume. Equipment list: once.
  usePoll(fetchBoard, STATUS_BOARD_POLL_MS);
  useEffect(() => { fetchEquipment(); }, [fetchEquipment]);

  useEffect(() => {
    if (typeof subscribe !== 'function') return undefined;
    const offRelay = subscribe('relay_state_changed', (data) => {
      setBoard((prev) => {
        if (!prev) return prev;
        const groups = applyRelayEvent(prev.relayGroups, data, new Date().toISOString());
        return groups === prev.relayGroups ? prev : { ...prev, relayGroups: groups };
      });
    });
    const offReading = subscribe('sensor_reading', (data) => {
      setBoard((prev) => {
        if (!prev) return prev;
        const climate = applySensorReading(prev.climate, data);
        return climate === prev.climate ? prev : { ...prev, climate };
      });
    });
    return () => { offRelay(); offReading(); };
  }, [subscribe]);

  const refresh = useCallback(() => Promise.all([fetchBoard(), fetchEquipment()]), [fetchBoard, fetchEquipment]);

  return { board, equipmentById, loading, fetchedAt, refresh };
}

export default useStatusBoard;
