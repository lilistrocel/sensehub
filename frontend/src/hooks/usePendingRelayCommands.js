import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a relay command stays "pending" before we give up waiting for confirmation. */
export const PENDING_TIMEOUT_MS = 20000;

export const relayKey = (equipmentId, channel) => `${equipmentId}:${channel}`;

/**
 * Tracks relay commands that were accepted by the API (HTTP 200) but not yet
 * confirmed by the device.
 *
 * A key `${equipmentId}:${channel}` is marked pending when a command is sent
 * and cleared when:
 *   - a `relay_state_changed` WebSocket event confirms that key, or
 *   - PENDING_TIMEOUT_MS elapses.
 *
 * Two backend payload shapes are handled (the backend uses camelCase
 * `equipmentId`; `equipment_id` is accepted too):
 *   - executor / manual route: { equipmentId, channel, state, confirmed?, writeOnly? }
 *                              { equipmentId, allChannels: true, state, confirmed?, writeOnly? }
 *   - polling readback:        { equipmentId, relayStates: { "1": true, ... } }
 *
 * Events flagged `writeOnly` or `confirmed === false` are NOT treated as
 * confirmation - write-only devices have no readback, so their keys simply
 * expire on the timeout (the UI shows "sent" rather than a warning).
 *
 * @param {(type: string, cb: Function) => Function} subscribe  from useWebSocket()
 * @param {number} timeoutMs
 */
export function usePendingRelayCommands(subscribe, timeoutMs = PENDING_TIMEOUT_MS) {
  // key -> { writeOnly: boolean, sentAt: number }
  const [pending, setPending] = useState(() => new Map());
  const pendingRef = useRef(pending);
  const timersRef = useRef(new Map());

  useEffect(() => { pendingRef.current = pending; }, [pending]);

  const clearKeys = useCallback((keys) => {
    if (!keys || keys.length === 0) return;
    keys.forEach((k) => {
      const t = timersRef.current.get(k);
      if (t) {
        clearTimeout(t);
        timersRef.current.delete(k);
      }
    });
    setPending((prev) => {
      let changed = false;
      const next = new Map(prev);
      keys.forEach((k) => { if (next.delete(k)) changed = true; });
      return changed ? next : prev;
    });
  }, []);

  /** Clear every pending key belonging to one equipment id. */
  const clearEquipment = useCallback((equipmentId) => {
    const prefix = `${equipmentId}:`;
    const keys = Array.from(pendingRef.current.keys()).filter((k) => k.startsWith(prefix));
    clearKeys(keys);
  }, [clearKeys]);

  /**
   * Mark one or more channels as pending.
   * @param {number|string} equipmentId
   * @param {number|string|Array<number|string>} channels
   * @param {{ writeOnly?: boolean }} opts
   */
  const markPending = useCallback((equipmentId, channels, opts = {}) => {
    const list = Array.isArray(channels) ? channels : [channels];
    const writeOnly = !!opts.writeOnly;
    const keys = list.map((ch) => relayKey(equipmentId, ch));
    setPending((prev) => {
      const next = new Map(prev);
      keys.forEach((k) => next.set(k, { writeOnly, sentAt: Date.now() }));
      return next;
    });
    keys.forEach((k) => {
      const old = timersRef.current.get(k);
      if (old) clearTimeout(old);
      timersRef.current.set(k, setTimeout(() => clearKeys([k]), timeoutMs));
    });
  }, [clearKeys, timeoutMs]);

  // Listen for device confirmations
  useEffect(() => {
    if (typeof subscribe !== 'function') return undefined;
    const unsubscribe = subscribe('relay_state_changed', (data) => {
      if (!data) return;
      const eqId = data.equipmentId ?? data.equipment_id;
      if (eqId === undefined || eqId === null) return;

      // Polling readback: authoritative device state for every listed coil.
      if (data.relayStates && typeof data.relayStates === 'object') {
        clearKeys(Object.keys(data.relayStates).map((ch) => relayKey(eqId, ch)));
        return;
      }

      // Write-only devices never confirm; unconfirmed writes stay pending until timeout.
      if (data.writeOnly || data.confirmed === false) return;

      if (data.allChannels) {
        clearEquipment(eqId);
      } else if (data.channel !== undefined && data.channel !== null) {
        clearKeys([relayKey(eqId, data.channel)]);
      }
    });
    return unsubscribe;
  }, [subscribe, clearKeys, clearEquipment]);

  // Clear all timers on unmount
  useEffect(() => () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
  }, []);

  /** @returns {{writeOnly:boolean, sentAt:number}|undefined} */
  const getPending = useCallback(
    (equipmentId, channel) => pending.get(relayKey(equipmentId, channel)),
    [pending]
  );

  return { pending, markPending, clearPending: clearKeys, clearEquipment, getPending };
}

export default usePendingRelayCommands;
