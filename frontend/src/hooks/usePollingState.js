import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { isNetworkError, isTransientNow, onResume } from '../utils/connectivity';

const API_BASE = '/api';

// Shape of the polling state mirrored from GET /api/modbus/polling/status.
// Keys listed here are the ONLY keys merged from a status payload or from the
// `polling_state_changed` WebSocket event, so unrelated fields (success,
// message, devices[], ...) never leak into component state.
const INITIAL_STATE = {
  isPaused: false,
  pausedAt: null,
  pausedBy: null,
  pauseReason: null,
  autoResumeAt: null,
  deviceCount: 0
};

const STATE_KEYS = Object.keys(INITIAL_STATE);

/**
 * Format a remaining-second count as MM:SS (H:MM:SS once past an hour).
 */
export function formatCountdown(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) {
    return null;
  }
  const secs = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Global sensor-polling (Modbus) pause/resume state.
 *
 * `supported` is false whenever the status endpoint is unreachable or refuses
 * us (403 for viewers, 404 on a backend without this feature). Callers should
 * render nothing at all in that case rather than surfacing an error - this is
 * an admin+operator endpoint and the app has viewer accounts.
 *
 * IMPORTANT (hook ordering): every useCallback/useMemo below is declared BEFORE
 * any useEffect that names it in a dependency array. A dependency array is
 * evaluated during render, so referencing a `const` arrow function declared
 * further down throws a temporal-dead-zone ReferenceError that blanks the whole
 * app while still building cleanly. Keep this ordering when editing.
 */
export function usePollingState() {
  const { token } = useAuth();
  const { connected, subscribe } = useWebSocket();

  const [state, setState] = useState(INITIAL_STATE);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [secondsRemaining, setSecondsRemaining] = useState(null);

  // Tracks the previous WebSocket connectivity so we can resync exactly on the
  // false -> true edge (a reconnect may have missed pause/resume events).
  const prevConnectedRef = useRef(connected);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }), [token]);

  // Merge a partial status payload into state, ignoring unknown/undefined keys.
  const mergeStatus = useCallback((data) => {
    if (!data || typeof data !== 'object') return;
    setState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of STATE_KEYS) {
        if (data[key] !== undefined && data[key] !== prev[key]) {
          next[key] = data[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!token) {
      setSupported(false);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/modbus/polling/status`, { headers });
      if (!res.ok) {
        // 403 (viewer), 404 (older backend), 5xx - hide the control entirely.
        setSupported(false);
        return;
      }
      const data = await res.json();
      mergeStatus(data);
      setSupported(true);
    } catch (err) {
      // A network blip (tab resume, radio waking up) is not "unsupported":
      // keep the control and the last known state instead of hiding them.
      if (isNetworkError(err) && isTransientNow()) return;
      console.error('Failed to fetch polling status:', err);
      setSupported(false);
    } finally {
      setLoading(false);
    }
  }, [token, headers, mergeStatus]);

  /**
   * Pause polling. `autoResumeMinutes` of 0 means "until manually resumed";
   * omitting it lets the backend apply its 30 minute default.
   * Rethrows on failure so the caller can toast.
   */
  const pause = useCallback(async (autoResumeMinutes, reason) => {
    const body = {};
    if (autoResumeMinutes !== undefined && autoResumeMinutes !== null) {
      body.autoResumeMinutes = autoResumeMinutes;
    }
    if (reason) body.reason = reason;

    const res = await fetch(`${API_BASE}/modbus/polling/pause`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Failed to pause polling');
    }
    mergeStatus(data);
    return data;
  }, [headers, mergeStatus]);

  /** Resume polling immediately. Rethrows on failure so the caller can toast. */
  const resume = useCallback(async () => {
    const res = await fetch(`${API_BASE}/modbus/polling/resume`, {
      method: 'POST',
      headers
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Failed to resume polling');
    }
    mergeStatus(data);
    return data;
  }, [headers, mergeStatus]);

  // --- Effects (all callbacks above are already declared) -------------------

  // Initial load, and reload whenever the token changes.
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Live updates pushed by the backend.
  useEffect(() => {
    const unsubscribe = subscribe('polling_state_changed', (data) => {
      mergeStatus(data);
      setSupported(true);
    });
    return () => unsubscribe();
  }, [subscribe, mergeStatus]);

  // Resync once when the tab comes back (pause/resume events may have been missed).
  useEffect(() => onResume(() => { fetchStatus(); }), [fetchStatus]);

  // Resync after a WebSocket reconnect (events during the outage were missed).
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = connected;
    if (connected && !wasConnected) {
      fetchStatus();
    }
  }, [connected, fetchStatus]);

  // Single 1s countdown ticker, alive only while paused with an auto-resume.
  useEffect(() => {
    if (!state.isPaused || !state.autoResumeAt) {
      setSecondsRemaining(null);
      return undefined;
    }

    const target = new Date(state.autoResumeAt).getTime();
    if (Number.isNaN(target)) {
      setSecondsRemaining(null);
      return undefined;
    }

    // The backend timer is authoritative: on reaching zero we re-fetch once
    // instead of assuming polling resumed.
    let expiredHandled = false;
    const tick = () => {
      const remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
      setSecondsRemaining(remaining);
      if (remaining === 0 && !expiredHandled) {
        expiredHandled = true;
        fetchStatus();
      }
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [state.isPaused, state.autoResumeAt, fetchStatus]);

  return {
    ...state,
    loading,
    supported,
    secondsRemaining,
    countdownLabel: formatCountdown(secondsRemaining),
    pause,
    resume,
    refresh: fetchStatus
  };
}

export default usePollingState;
