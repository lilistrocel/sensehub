import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Sidebar from './Sidebar';
import Breadcrumb from './Breadcrumb';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { useWebSocket } from '../context/WebSocketContext';
import { usePollingState, formatCountdown } from '../hooks/usePollingState';

const API_BASE = '/api';

// Durations offered by the "pause polling" popover. 0 = no auto-resume.
const PAUSE_DURATIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: 'Until I resume', minutes: 0 }
];

// How long an EMERGENCY STOP keeps automations disarmed. 0 = until manually
// re-armed. This is not a confirmation step: it is the one piece of information
// the action needs, so the popover is the fastest way to ask for it.
const EMERGENCY_RE_ARM_DURATIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: 'Until I re-arm', minutes: 0 }
];

// Human labels for the timer kinds returned by GET /api/automations/timers.
const TIMER_TYPE_LABELS = {
  delay: 'Delayed start',
  off: 'Auto-off',
  raw: 'Transition revert'
};

// How often the header re-reads pending relay timers. Matches the alert-badge
// cadence rather than the 30s cloud-status one: an armed timer can energise a
// pump, so it must not sit unseen for half a minute.
const TIMERS_POLL_INTERVAL_MS = 10000;

// Minimum gap between the equipment-name lookups used to label those timers.
const EQUIPMENT_NAME_REFRESH_MS = 60000;

// The stop endpoints answer within 15 s: 200 with the final summary, or 202
// with the summary-so-far while the relay sweep keeps running, in which case
// the final summary arrives as a `stop_all_progress` WebSocket event. If that
// event never comes, give up after this long and report the stop unconfirmed.
const STOP_CONFIRM_TIMEOUT_MS = 60000;

// Board progress carried by a 202 body or a stop_all_progress event.
const stopProgressOf = (data) => ({
  boardsDone: Number(data?.boardsDone) || 0,
  boardsTotal: Number(data?.boardsTotal) || 0
});

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Identity of a timer list, so a poll that changed nothing keeps the previous
// array reference (no re-render, no re-run of the equipment-name lookup).
const timersSignature = (timers) => timers.map(t => `${t.key}@${t.firesAt}`).join('|');

// Shape mirrored from GET /api/automations/armed-state. Armed is the safe
// default: a backend that does not answer must never make the banner claim a
// state it has not confirmed.
const ARMED_STATE_DEFAULT = {
  disarmed: false,
  at: null,
  by: null,
  reason: null,
  autoReArmAt: null
};

const normalizeArmedState = (data) => ({
  disarmed: Boolean(data?.disarmed),
  at: data?.at ?? null,
  by: data?.by ?? null,
  reason: data?.reason ?? null,
  autoReArmAt: data?.autoReArmAt ?? null
});

// Identity of an armed-state, so a poll that changed nothing keeps the previous
// object reference (no re-render, no restart of the countdown ticker).
const armedSignature = (s) => `${s.disarmed}|${s.at}|${s.by}|${s.reason}|${s.autoReArmAt}`;

// `by` is expected to be a display name, but tolerate the user-object shape some
// endpoints return so the banner never prints "[object Object]".
const describeActor = (by) => {
  if (!by) return null;
  if (typeof by === 'string') return by;
  return by.name || by.email || by.username || null;
};

// Shared wording for a stop request the controller refused or never received.
// Never reassuring: an unconfirmed stop means relays may still be energised.
const stopErrorMessage = (status, data) => {
  if (status === 403) {
    return 'Your account is not permitted to run this action. Nothing was switched off.';
  }
  if (status === 404) {
    return 'This controller build does not support that action yet. Nothing was switched off.';
  }
  return `${data.message || data.error || `Request failed (HTTP ${status})`}. `
    + 'Relays may still be energised - stop them at the panel.';
};

export default function Layout({ children }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // NOTE on the header: the two stop buttons must survive a 390 px phone with
  // the body's overflow hidden, so the control group wraps under the breadcrumb
  // rather than clipping, and everything non-safety hides below lg:.
  const { user, token } = useAuth();
  const { isDarkMode, toggleTheme } = useTheme();
  const { formatDateTime } = useSettings();
  const { showSuccess, showError, addToast } = useToast();
  const { subscribe } = useWebSocket();
  const polling = usePollingState();
  const isAdmin = user?.role === 'admin';
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [pollingBusy, setPollingBusy] = useState(false);
  const pauseMenuRef = useRef(null);
  const [cloudStatus, setCloudStatus] = useState({
    configured: false,
    connected: false,
    lastSync: null,
    pendingItems: 0
  });
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  // null = unknown (no successful response yet), true/false = last known reachability.
  // Derived from the existing cloud-status fetch below; a successful API response is
  // genuine evidence the backend (and the SQLite DB it queries) is reachable.
  const [backendReachable, setBackendReachable] = useState(null);

  // --- Stop controls + pending relay timers ---------------------------------
  // Unlike the polling pause (admin only) stopping output is an operator's job
  // too; viewers get neither button nor the ability to trigger one. The armed
  // state itself is readable by every role, so the banner reaches viewers.
  const canEmergencyStop = user?.role === 'admin' || user?.role === 'operator';
  // null when idle, otherwise 'stop-all' | 'emergency' - identifies which of the
  // two buttons is in flight while disabling both (no interleaved stops).
  const [stopBusy, setStopBusy] = useState(null);
  // { boardsDone, boardsTotal } while a stop the backend answered 202 for is
  // still sweeping boards; null otherwise. Drives the "Stopping… (n/m)" label.
  const [stopProgress, setStopProgress] = useState(null);
  // The 202-pending stop awaiting its stop_all_progress summary:
  // { kind, label, suffix, timeoutId, progress }. A ref, not state: the
  // WebSocket listener and the safety timeout must read the latest value
  // without being re-subscribed on every render.
  const pendingStopRef = useRef(null);
  // True from the moment a stop request is sent until it is fully reported.
  // Lets a final summary that overtakes its own 202 response be kept rather
  // than dropped (the sweep can finish a few ms after the HTTP deadline).
  const stopInFlightRef = useRef(false);
  const earlyStopSummaryRef = useRef(null);
  const [stopMenuOpen, setStopMenuOpen] = useState(false);
  const stopMenuRef = useRef(null);
  const [armedState, setArmedState] = useState(ARMED_STATE_DEFAULT);
  const [reArmBusy, setReArmBusy] = useState(false);
  const [reArmSeconds, setReArmSeconds] = useState(null);
  const [pendingTimers, setPendingTimers] = useState([]);
  const [timersMenuOpen, setTimersMenuOpen] = useState(false);
  const timersMenuRef = useRef(null);
  // equipment id -> name, used only to label the pending-timer list readably.
  const [equipmentNames, setEquipmentNames] = useState({});
  const equipmentNamesFetchedAt = useRef(0);

  // Fetch cloud status on mount and periodically
  useEffect(() => {
    const fetchCloudStatus = async () => {
      try {
        const response = await fetch(`${API_BASE}/cloud/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setCloudStatus(data);
          setBackendReachable(true);
        } else {
          setBackendReachable(false);
        }
      } catch (err) {
        console.error('Failed to fetch cloud status:', err);
        setBackendReachable(false);
      }
    };

    fetchCloudStatus();
    // Refresh cloud status every 30 seconds
    const interval = setInterval(fetchCloudStatus, 30000);
    return () => clearInterval(interval);
  }, [token]);

  // Fetch unacknowledged alert count
  useEffect(() => {
    const fetchUnacknowledgedCount = async () => {
      try {
        const response = await fetch(`${API_BASE}/alerts/unacknowledged/count`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setUnacknowledgedCount(data.count);
        }
      } catch (err) {
        console.error('Failed to fetch unacknowledged count:', err);
      }
    };

    fetchUnacknowledgedCount();
    // Refresh every 10 seconds for real-time updates
    const interval = setInterval(fetchUnacknowledgedCount, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // --- Global sensor-polling pause/resume -----------------------------------
  // NOTE: these useCallbacks are declared BEFORE every useEffect below that
  // could reference them. A const in a dependency array is evaluated during
  // render, so a later declaration throws a temporal-dead-zone ReferenceError
  // that blanks the whole app despite building cleanly. Keep this ordering.
  const handlePauseSelect = useCallback(async (minutes) => {
    setPauseMenuOpen(false);
    setPollingBusy(true);
    try {
      await polling.pause(minutes, null);
      showSuccess(
        minutes === 0
          ? 'Sensor polling paused until you resume it.'
          : `Sensor polling paused. Auto-resumes in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      );
    } catch (err) {
      showError(err.message || 'Failed to pause sensor polling');
    } finally {
      setPollingBusy(false);
    }
  }, [polling, showSuccess, showError]);

  const handleResumePolling = useCallback(async () => {
    setPauseMenuOpen(false);
    setPollingBusy(true);
    try {
      await polling.resume();
      showSuccess('Sensor polling resumed.');
    } catch (err) {
      showError(err.message || 'Failed to resume sensor polling');
    } finally {
      setPollingBusy(false);
    }
  }, [polling, showSuccess, showError]);

  // --- Stop all / emergency stop --------------------------------------------
  // Same temporal-dead-zone rule as above: these callbacks are declared BEFORE
  // every effect that names them in a dependency array, and before every other
  // callback that names them.
  const fetchPendingTimers = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE}/automations/timers`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        // 404 on a backend without this endpoint - show nothing rather than an error.
        setPendingTimers(prev => (prev.length === 0 ? prev : []));
        return;
      }
      const data = await response.json();
      const next = Array.isArray(data) ? data : [];
      setPendingTimers(prev => (timersSignature(prev) === timersSignature(next) ? prev : next));
    } catch (err) {
      // Keep the last known list on a network blip: silently dropping the badge
      // for a timer that is still armed is the dangerous way to fail.
      console.error('Failed to fetch pending relay timers:', err);
    }
  }, [token]);

  const applyArmedState = useCallback((data) => {
    if (!data || typeof data !== 'object') return;
    const next = normalizeArmedState(data);
    setArmedState(prev => (armedSignature(prev) === armedSignature(next) ? prev : next));
  }, []);

  const fetchArmedState = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE}/automations/armed-state`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        // 404 on a backend without this endpoint. Keep the last known state:
        // silently dropping a "disarmed" banner is the dangerous way to fail.
        return;
      }
      const data = await response.json();
      // Tolerate either the bare state or a { armedState } envelope - failing to
      // recognise a disarm is the dangerous direction to get this wrong.
      applyArmedState(data?.armedState || data);
    } catch (err) {
      console.error('Failed to fetch automation armed state:', err);
    }
  }, [token, applyArmedState]);

  // Both stop endpoints return the same result shape, so both report it the same
  // way. A partial stop must never read as success - the listed channels may
  // still be energised, so that toast stays until dismissed by hand (duration 0).
  const reportStopResult = useCallback((data, label, suffix = '') => {
    const timersCancelled = Number(data.timersCancelled) || 0;
    const channelsTurnedOff = Number(data.channelsTurnedOff ?? data.succeeded) || 0;
    const doseNote = data.doseCycleAborted ? ' Fertigation dose cycle aborted.' : '';

    // Per-board failures (`failed`) name the board; fall back to the legacy
    // per-channel list (`failures`) for an older backend.
    const failedBoards = Array.isArray(data.failed) ? data.failed : [];
    const legacyFailures = Array.isArray(data.failures) ? data.failures : [];
    let detail = '';
    let failedSummary = '';
    if (failedBoards.length > 0) {
      detail = failedBoards
        .map((f) => {
          const name = f.name || `equipment #${f.equipment_id}`;
          const channels = Array.isArray(f.channels) && f.channels.length > 0 ? ` ch ${f.channels.join(', ')}` : '';
          return `${name}${channels}${f.error ? ` (${f.error})` : ''}`;
        })
        .join('; ');
      failedSummary = plural(failedBoards.length, 'board');
    } else if (legacyFailures.length > 0) {
      detail = legacyFailures
        .map(f => `${f.equipment || `equipment #${f.equipment_id}`} channel ${f.channel ?? '?'}`)
        .join('; ');
      failedSummary = plural(legacyFailures.length, 'channel');
    }

    const counts = `${plural(channelsTurnedOff, 'channel')} switched off, ${plural(timersCancelled, 'timer')} cancelled.${doseNote}`;

    if (detail) {
      addToast({
        type: 'error',
        title: `${label} INCOMPLETE`,
        duration: 0,
        message: `${counts} ${failedSummary} did NOT confirm all channels off and may still be energised: ${detail}. Check them physically.${suffix}`
      });
    } else if (data.ok === false || data.partial || data.error) {
      // The sweep aborted or never finished without naming a board.
      addToast({
        type: 'error',
        title: `${label} INCOMPLETE`,
        duration: 0,
        message: `${counts} The relay sweep did not complete${data.error ? ` (${data.error})` : ''}. `
          + `Relays may still be energised - stop them at the panel.${suffix}`
      });
    } else {
      showSuccess(
        `${plural(channelsTurnedOff, 'channel')} switched off, ${plural(timersCancelled, 'pending timer')} cancelled.${doseNote}${suffix}`,
        `${label} complete`
      );
    }
  }, [showSuccess, addToast]);

  // Settle a 202-pending stop. `data` is the final stop_all_progress summary,
  // or null when the safety timeout fired first - in which case the stop is
  // reported UNCONFIRMED rather than assumed complete.
  const finishPendingStop = useCallback((data) => {
    const pending = pendingStopRef.current;
    if (!pending) return;
    pendingStopRef.current = null;
    stopInFlightRef.current = false;
    earlyStopSummaryRef.current = null;
    clearTimeout(pending.timeoutId);
    setStopProgress(null);
    setStopBusy(null);

    if (data) {
      if (data.armedState) applyArmedState(data.armedState);
      reportStopResult(data, pending.label, pending.suffix);
    } else {
      const { boardsDone, boardsTotal } = pending.progress;
      addToast({
        type: 'error',
        title: `${pending.label} UNCONFIRMED`,
        duration: 0,
        message: `The controller accepted the stop but never reported the result `
          + `(${boardsDone}/${boardsTotal} boards confirmed before it went quiet). `
          + `Relays may still be energised - check them at the panel.${pending.suffix}`
      });
    }

    fetchPendingTimers();
    if (pending.kind === 'emergency') fetchArmedState();
  }, [applyArmedState, reportStopResult, addToast, fetchPendingTimers, fetchArmedState]);

  // Park a stop that came back 202 until its summary arrives (or the safety
  // timeout gives up). Returns true if the summary had already overtaken the
  // response and the stop is therefore settled immediately.
  const beginPendingStop = useCallback((kind, label, suffix, data) => {
    const timeoutId = setTimeout(() => finishPendingStop(null), STOP_CONFIRM_TIMEOUT_MS);
    pendingStopRef.current = { kind, label, suffix, timeoutId, progress: stopProgressOf(data) };
    setStopProgress(stopProgressOf(data));

    const early = earlyStopSummaryRef.current;
    if (early) {
      finishPendingStop(early);
      return true;
    }
    return false;
  }, [finishPendingStop]);

  // stop_all_progress listener. Ignores events for stops this client did not
  // start (another operator's stop is reported to them, not here).
  const handleStopProgress = useCallback((data) => {
    if (!data || typeof data !== 'object') return;
    const pending = pendingStopRef.current;

    if (!pending) {
      // Final summary arrived before our own 202 did - keep it for beginPendingStop.
      if (stopInFlightRef.current && !data.inProgress) earlyStopSummaryRef.current = data;
      return;
    }

    if (data.inProgress) {
      pending.progress = stopProgressOf(data);
      setStopProgress(pending.progress);
      return;
    }
    finishPendingStop(data);
  }, [finishPendingStop]);

  // Stop all: one-shot. Stops what is running now and cancels pending timers,
  // but leaves automations armed - they may re-fire on their own schedule.
  // Deliberately NO confirmation dialog: a delayed stop is worse than an
  // accidental one, and an accidental stop is recoverable by re-running the
  // automation. Double-firing is prevented by the button's disabled state.
  const handleStopAll = useCallback(async () => {
    const suffix = ' Automations stay armed and may re-fire.';
    setStopMenuOpen(false);
    setStopBusy('stop-all');
    stopInFlightRef.current = true;
    earlyStopSummaryRef.current = null;
    // Set when the backend answered 202: the sweep is still running and the
    // button stays in "Stopping…" until stop_all_progress settles it.
    let pending = false;
    try {
      const response = await fetch(`${API_BASE}/automations/stop-all`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showError(stopErrorMessage(response.status, data), 'Stop all FAILED');
        return;
      }

      if (response.status === 202 || data.inProgress) {
        pending = !beginPendingStop('stop-all', 'Stop all', suffix, data);
        return;
      }

      reportStopResult(data, 'Stop all', suffix);
    } catch (err) {
      showError(
        `Could not reach the controller (${err.message || 'network error'}). Nothing is confirmed stopped - use the physical panel.`,
        'Stop all FAILED'
      );
    } finally {
      if (!pending) {
        stopInFlightRef.current = false;
        earlyStopSummaryRef.current = null;
        setStopBusy(null);
        fetchPendingTimers();
      }
    }
  }, [token, showError, reportStopResult, beginPendingStop, fetchPendingTimers]);

  // Emergency stop: everything "stop all" does, plus disarming automations so
  // nothing re-fires until re-armed. `duration` is one entry of
  // EMERGENCY_RE_ARM_DURATIONS; minutes 0 means "until manually re-armed".
  const handleEmergencyStop = useCallback(async (duration) => {
    const autoReArmMinutes = Number(duration?.minutes) || 0;
    const suffix = autoReArmMinutes > 0
      ? ` Automations are disarmed for ${duration?.label?.toLowerCase() || `${autoReArmMinutes} minutes`}.`
      : ' Automations stay disarmed until you re-arm them.';
    setStopMenuOpen(false);
    setStopBusy('emergency');
    stopInFlightRef.current = true;
    earlyStopSummaryRef.current = null;
    let pending = false;
    try {
      const response = await fetch(`${API_BASE}/automations/emergency-stop`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ autoReArmMinutes })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // A 500 here can still carry armedState: the disarm stands even when
        // the sweep failed, and the banner must say so.
        if (data.armedState) applyArmedState(data.armedState);
        showError(stopErrorMessage(response.status, data), 'Emergency stop FAILED');
        return;
      }

      // Show the banner from the response rather than waiting up to 10s for the
      // next poll - the operator must see the disarm land immediately.
      if (data.armedState) applyArmedState(data.armedState);

      if (response.status === 202 || data.inProgress) {
        pending = !beginPendingStop('emergency', 'Emergency stop', suffix, data);
        return;
      }

      reportStopResult(data, 'Emergency stop', suffix);
    } catch (err) {
      showError(
        `Could not reach the controller (${err.message || 'network error'}). Nothing is confirmed stopped and automations may still be armed - use the physical panel.`,
        'Emergency stop FAILED'
      );
    } finally {
      if (!pending) {
        stopInFlightRef.current = false;
        earlyStopSummaryRef.current = null;
        setStopBusy(null);
        fetchPendingTimers();
        fetchArmedState();
      }
    }
  }, [token, showError, reportStopResult, applyArmedState, beginPendingStop, fetchPendingTimers, fetchArmedState]);

  const handleReArm = useCallback(async () => {
    setReArmBusy(true);
    try {
      const response = await fetch(`${API_BASE}/automations/re-arm`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showError(
          response.status === 403
            ? 'Your account is not permitted to re-arm automations. They are still disarmed.'
            : `${data.message || data.error || `Request failed (HTTP ${response.status})`}. Automations are still disarmed.`,
          'Re-arm FAILED'
        );
        return;
      }

      applyArmedState(data.armedState || data);
      showSuccess('Automations are armed again and will run on schedule.', 'Re-armed');
    } catch (err) {
      showError(
        `Could not reach the controller (${err.message || 'network error'}). Automations are still disarmed.`,
        'Re-arm FAILED'
      );
    } finally {
      setReArmBusy(false);
      fetchArmedState();
    }
  }, [token, showSuccess, showError, applyArmedState, fetchArmedState]);

  // Final (or interim) summaries for a stop that came back 202. Subscribed for
  // the component's whole life so a summary can never slip past between the
  // 202 response and a later subscription.
  useEffect(() => {
    const unsubscribe = subscribe('stop_all_progress', handleStopProgress);
    return () => unsubscribe();
  }, [subscribe, handleStopProgress]);

  // Unmount: drop the safety timeout of a still-pending stop so it cannot fire
  // setState on a dead component. The stop itself continues on the backend.
  useEffect(() => () => {
    if (pendingStopRef.current) {
      clearTimeout(pendingStopRef.current.timeoutId);
      pendingStopRef.current = null;
    }
  }, []);

  // Close the pause-duration popover on outside click or Escape.
  useEffect(() => {
    if (!pauseMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (pauseMenuRef.current && !pauseMenuRef.current.contains(event.target)) {
        setPauseMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setPauseMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pauseMenuOpen]);

  // Never leave the popover open once polling is already paused.
  useEffect(() => {
    if (polling.isPaused) setPauseMenuOpen(false);
  }, [polling.isPaused]);

  // Poll the pending relay timers that feed the header badge, and the armed
  // state behind the disarmed banner. One interval, one cadence: both answer
  // the same question ("can something energise a relay without me?").
  useEffect(() => {
    const refresh = () => {
      fetchPendingTimers();
      fetchArmedState();
    };
    refresh();
    const interval = setInterval(refresh, TIMERS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPendingTimers, fetchArmedState]);

  // Single 1s ticker for the banner countdown, alive only while disarmed with an
  // auto re-arm set. The backend timer is authoritative: on reaching zero we
  // re-fetch once instead of assuming automations re-armed themselves.
  useEffect(() => {
    if (!armedState.disarmed || !armedState.autoReArmAt) {
      setReArmSeconds(null);
      return undefined;
    }

    const target = new Date(armedState.autoReArmAt).getTime();
    if (Number.isNaN(target)) {
      setReArmSeconds(null);
      return undefined;
    }

    let expiredHandled = false;
    const tick = () => {
      const remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
      setReArmSeconds(remaining);
      if (remaining === 0 && !expiredHandled) {
        expiredHandled = true;
        fetchArmedState();
      }
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [armedState.disarmed, armedState.autoReArmAt, fetchArmedState]);

  // Close the emergency-stop duration popover on outside click or Escape.
  useEffect(() => {
    if (!stopMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (stopMenuRef.current && !stopMenuRef.current.contains(event.target)) {
        setStopMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setStopMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [stopMenuOpen]);

  // Resolve equipment ids to names so the timer list reads like equipment rather
  // than database rows. Fetched lazily (only while timers are armed) and
  // rate-limited so the header never hammers /api/equipment.
  useEffect(() => {
    if (!token) return undefined;

    const hasUnknown = pendingTimers.some(
      t => t.equipmentId !== null && t.equipmentId !== undefined && equipmentNames[t.equipmentId] === undefined
    );
    if (!hasUnknown) return undefined;

    const now = Date.now();
    if (now - equipmentNamesFetchedAt.current < EQUIPMENT_NAME_REFRESH_MS) return undefined;
    equipmentNamesFetchedAt.current = now;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/equipment`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !Array.isArray(data)) return;
        const names = {};
        data.forEach((eq) => { names[eq.id] = eq.name; });
        setEquipmentNames(names);
      } catch (err) {
        console.error('Failed to fetch equipment names for the timer list:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [token, pendingTimers, equipmentNames]);

  // Close the timer popover on outside click or Escape.
  useEffect(() => {
    if (!timersMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (timersMenuRef.current && !timersMenuRef.current.contains(event.target)) {
        setTimersMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setTimersMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [timersMenuOpen]);

  // Never leave the timer popover open once nothing is armed.
  useEffect(() => {
    if (pendingTimers.length === 0) setTimersMenuOpen(false);
  }, [pendingTimers.length]);

  const showPollingControl = isAdmin && polling.supported;

  // Banner copy derived from the armed state (render-time only - never named in
  // a dependency array, so the ordering rule above does not apply here).
  const disarmedBy = describeActor(armedState.by);
  const reArmCountdownLabel = formatCountdown(reArmSeconds);

  // Determine cloud status display
  const getCloudStatusDisplay = () => {
    if (!cloudStatus.configured) {
      return {
        color: 'bg-gray-400',
        text: 'Not Configured',
        title: 'Cloud: Not Configured'
      };
    }
    if (cloudStatus.connected) {
      return {
        color: 'bg-green-500',
        text: cloudStatus.pendingItems > 0
          ? `Connected (${cloudStatus.pendingItems} pending)`
          : 'Connected',
        title: `Cloud: Connected${cloudStatus.lastSync ? ` - Last sync: ${formatDateTime(cloudStatus.lastSync)}` : ''}`
      };
    }
    return {
      color: 'bg-yellow-400',
      text: 'Offline Mode',
      title: 'Cloud: Disconnected'
    };
  };

  const cloudDisplay = getCloudStatusDisplay();

  // One-line description of a pending relay timer (type, equipment, channel, when).
  const describeTimer = (timer) => {
    const label = TIMER_TYPE_LABELS[timer.type] || timer.type || 'Timer';
    const name = equipmentNames[timer.equipmentId] || `Equipment #${timer.equipmentId}`;
    const channel = timer.channel !== null && timer.channel !== undefined ? ` ch ${timer.channel}` : '';
    return `${label}: ${name}${channel} - fires ${formatDateTime(timer.firesAt)}`;
  };

  // Native-title fallback so the list is also readable on plain hover.
  const timersTooltip = pendingTimers.length === 0
    ? ''
    : [`${plural(pendingTimers.length, 'relay timer')} armed:`]
      .concat(pendingTimers.map(describeTimer))
      .join('\n');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex">
      <Sidebar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 md:px-6 md:py-4">
          {/* The row wraps: when the breadcrumb cannot keep at least 10rem
              beside the control group (phones, tablets), the controls drop to
              a second line instead of overflowing the clipped body and hiding
              E-STOP. */}
          <div className="flex flex-wrap items-center justify-between gap-y-2">
            {/* Spacer for mobile menu button */}
            <div className="w-10 shrink-0 md:hidden" />

            {/* Breadcrumb navigation */}
            <div className="grow shrink basis-40 min-w-0 ml-4 md:ml-0">
              <Breadcrumb />
            </div>

            {/* User info and status. Safety buttons are always shown; the
                lower-priority items hide below lg: so the two stops fit a
                390 px phone, and a tablet beside the 256 px sidebar, on one
                line with room to tap. */}
            <div className="flex flex-wrap items-center justify-end gap-2 md:gap-4 min-w-0 ml-auto">
              {/* Dark mode toggle (desktop only - theme is also in Settings) */}
              <button
                onClick={toggleTheme}
                className="hidden lg:block p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {isDarkMode ? (
                  <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                  </svg>
                )}
              </button>

              {/* Unacknowledged alerts badge */}
              {unacknowledgedCount > 0 && (
                <Link
                  to="/alerts"
                  className="flex items-center text-sm hover:opacity-80"
                  title={`${unacknowledgedCount} unacknowledged alert${unacknowledgedCount !== 1 ? 's' : ''}`}
                >
                  <span className="relative">
                    <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    <span className="absolute -top-2 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold leading-none text-white bg-red-500 rounded-full min-w-[18px]">
                      {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
                    </span>
                  </span>
                </Link>
              )}

              {/* Sensor polling pause/resume (admin only) */}
              {showPollingControl && (
                <div className="relative" ref={pauseMenuRef}>
                  {polling.isPaused ? (
                    <button
                      onClick={handleResumePolling}
                      disabled={pollingBusy}
                      className="flex items-center px-3 py-2 text-sm font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      title={`Sensor polling is paused${polling.pauseReason ? ` (${polling.pauseReason})` : ''} - click to resume`}
                      aria-label="Resume sensor polling"
                    >
                      {/* Play glyph */}
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                      </svg>
                      <span className="ml-2 tabular-nums">
                        {polling.autoResumeAt ? (polling.countdownLabel || 'Paused') : 'Paused'}
                      </span>
                    </button>
                  ) : (
                    <button
                      onClick={() => setPauseMenuOpen(open => !open)}
                      disabled={pollingBusy}
                      className="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      title="Pause sensor polling"
                      aria-label="Pause sensor polling"
                      aria-haspopup="menu"
                      aria-expanded={pauseMenuOpen}
                    >
                      {/* Pause glyph */}
                      <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                        <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </button>
                  )}

                  {pauseMenuOpen && !polling.isPaused && (
                    <div
                      role="menu"
                      aria-label="Pause sensor polling for"
                      className="absolute right-0 mt-2 w-64 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2"
                    >
                      <p className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                        Pauses sensor polling. Relay boards keep their 15 s heartbeat poll so the firmware fail-safe cannot trip.
                      </p>
                      <p className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                        Pause for
                      </p>
                      {PAUSE_DURATIONS.map(({ label, minutes }) => (
                        <button
                          key={minutes}
                          role="menuitem"
                          onClick={() => handlePauseSelect(minutes)}
                          disabled={pollingBusy}
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Armed relay timers + emergency stop */}
              {(canEmergencyStop || pendingTimers.length > 0) && (
                <div className="flex items-center gap-2 shrink-0">
                  {/* Pending relay timers - hidden entirely when nothing is armed */}
                  {pendingTimers.length > 0 && (
                    <div className="relative" ref={timersMenuRef}>
                      <button
                        onClick={() => setTimersMenuOpen(open => !open)}
                        className="flex items-center px-2 py-1.5 text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 rounded-full hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                        title={timersTooltip}
                        aria-label={`${plural(pendingTimers.length, 'relay timer')} armed - show details`}
                        aria-haspopup="menu"
                        aria-expanded={timersMenuOpen}
                      >
                        {/* Clock glyph */}
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                        </svg>
                        <span className="ml-1 tabular-nums">{pendingTimers.length}</span>
                        <span className="ml-1 hidden md:inline font-medium">armed</span>
                      </button>

                      {timersMenuOpen && (
                        <div
                          role="menu"
                          aria-label="Pending relay timers"
                          className="absolute right-0 mt-2 w-72 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2"
                        >
                          <p className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                            These relays are scheduled to switch by themselves. Either stop button cancels all of them.
                          </p>
                          <ul className="max-h-64 overflow-auto">
                            {pendingTimers.map((timer) => (
                              <li
                                key={timer.key}
                                className="px-3 py-2 text-xs border-b border-gray-50 dark:border-gray-700/50 last:border-b-0"
                              >
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="font-medium text-gray-700 dark:text-gray-200">
                                    {TIMER_TYPE_LABELS[timer.type] || timer.type || 'Timer'}
                                  </span>
                                  <span className="tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                    {formatDateTime(timer.firesAt)}
                                  </span>
                                </div>
                                <div className="text-gray-500 dark:text-gray-400">
                                  {equipmentNames[timer.equipmentId] || `Equipment #${timer.equipmentId}`}
                                  {timer.channel !== null && timer.channel !== undefined && ` - channel ${timer.channel}`}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Stop all (admin + operator). One click, no confirmation.
                      Amber, deliberately NOT red: it stops what is running now
                      but automations stay armed and may re-fire. */}
                  {canEmergencyStop && (
                    <button
                      onClick={handleStopAll}
                      disabled={Boolean(stopBusy)}
                      className="flex items-center min-h-[44px] px-3 py-2 text-sm font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-900/60 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 dark:focus:ring-offset-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      title="Stop all - switches every relay OFF and cancels all pending timers. Automations stay armed and may re-fire."
                      aria-label="Stop all: switch relays off and cancel pending timers, leaving automations armed"
                    >
                      {/* Hollow stop-square glyph - lighter than the E-stop's filled one */}
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      <span className="ml-2 whitespace-nowrap">
                        {stopBusy === 'stop-all'
                          ? (stopProgress ? `Stopping… (${stopProgress.boardsDone}/${stopProgress.boardsTotal})` : 'Stopping…')
                          : <>Stop<span className="hidden sm:inline"> All</span></>}
                      </span>
                    </button>
                  )}

                  {/* EMERGENCY STOP (admin + operator). Stops everything AND
                      disarms automations; the popover asks only for how long. */}
                  {canEmergencyStop && (
                    <div className="relative" ref={stopMenuRef}>
                      <button
                        onClick={() => setStopMenuOpen(open => !open)}
                        disabled={Boolean(stopBusy)}
                        className={`flex items-center min-h-[44px] px-3 py-2 text-sm font-bold uppercase tracking-wide text-white bg-red-600 dark:bg-red-700 border border-red-700 dark:border-red-600 rounded-lg shadow-sm hover:bg-red-700 dark:hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 dark:focus:ring-offset-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed${
                          armedState.disarmed ? ' ring-2 ring-red-400 dark:ring-red-500 ring-offset-1 dark:ring-offset-gray-800' : ''
                        }`}
                        title={armedState.disarmed
                          ? 'Automations are DISARMED. Choosing a duration stops everything again and extends the disarm.'
                          : 'EMERGENCY STOP - switches all relays OFF, cancels every pending timer, and disarms automations so nothing re-fires'}
                        aria-label="Emergency stop: switch all relays off and disarm automations"
                        aria-haspopup="menu"
                        aria-expanded={stopMenuOpen}
                      >
                        {/* Filled stop glyph */}
                        <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 7a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1H8a1 1 0 01-1-1V7z" clipRule="evenodd" />
                        </svg>
                        <span className="ml-2 whitespace-nowrap">
                          {stopBusy === 'emergency'
                            ? (stopProgress ? `Stopping… (${stopProgress.boardsDone}/${stopProgress.boardsTotal})` : 'Stopping…')
                            : <><span className="hidden sm:inline">Emergency </span><span className="sm:hidden">E-</span>Stop</>}
                        </span>
                        {armedState.disarmed && (
                          <span className="ml-2 flex items-center flex-shrink-0" aria-hidden="true">
                            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                            <span className="ml-1 hidden lg:inline text-[10px] tracking-wider">Disarmed</span>
                          </span>
                        )}
                      </button>

                      {stopMenuOpen && (
                        <div
                          role="menu"
                          aria-label="Emergency stop - keep automations disarmed for"
                          className="absolute right-0 mt-2 w-72 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2"
                        >
                          <p className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                            Switches every relay off, cancels all pending timers, and{' '}
                            <span className="font-semibold text-red-600 dark:text-red-400">disarms automations</span>{' '}
                            so nothing re-fires. No climate control or irrigation runs while disarmed.
                          </p>
                          <p className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                            Keep disarmed for
                          </p>
                          {EMERGENCY_RE_ARM_DURATIONS.map((duration) => (
                            <button
                              key={duration.minutes}
                              role="menuitem"
                              onClick={() => handleEmergencyStop(duration)}
                              disabled={Boolean(stopBusy)}
                              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              {duration.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Cloud status indicator */}
              <div className="flex items-center text-sm shrink-0" title={cloudDisplay.title} aria-label={cloudDisplay.title}>
                <span className={`w-2 h-2 rounded-full ${cloudDisplay.color} lg:mr-2`}></span>
                <span className="hidden lg:inline text-gray-500 dark:text-gray-400">{cloudDisplay.text}</span>
              </div>

              {/* User badge (role pill from lg:, name from xl:) */}
              <div className="hidden lg:flex items-center">
                <span className="hidden xl:inline text-sm text-gray-500 dark:text-gray-400 mr-2">{user?.name}</span>
                <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300 capitalize">
                  {user?.role}
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* Automations disarmed banner. Shown to EVERY role (the armed state is
            readable by all) and deliberately not dismissible: while disarmed
            there is no climate control, so this must stay in the operator's
            face until it is untrue. Sits above the polling banner because it is
            the more consequential of the two. */}
        {armedState.disarmed && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-50 dark:bg-red-950/60 border-b-2 border-red-500 dark:border-red-600 px-4 py-3 md:px-6 text-sm text-red-800 dark:text-red-200"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <svg className="w-5 h-5 flex-shrink-0 text-red-600 dark:text-red-400" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>
                <span className="font-bold uppercase tracking-wide">Automations are disarmed.</span>{' '}
                Nothing will re-fire — no climate control, irrigation or fertigation is running until they are re-armed.
              </span>
              {disarmedBy && (
                <span className="text-red-700 dark:text-red-300/90">— disarmed by {disarmedBy}</span>
              )}
              {armedState.at && (
                <span className="text-red-700 dark:text-red-300/90 tabular-nums">— {formatDateTime(armedState.at)}</span>
              )}
              {armedState.reason && (
                <span className="text-red-700 dark:text-red-300/90">— {armedState.reason}</span>
              )}
              <span className="font-semibold tabular-nums">
                — {armedState.autoReArmAt
                  ? `Auto re-arms in ${reArmCountdownLabel || '--:--'}`
                  : 'Disarmed until manually re-armed'}
              </span>
              {canEmergencyStop && (
                <button
                  onClick={handleReArm}
                  disabled={reArmBusy}
                  className="ml-auto px-3 py-1 text-sm font-semibold bg-white dark:bg-gray-800 text-red-700 dark:text-red-200 border border-red-400 dark:border-red-600 rounded-lg hover:bg-red-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 dark:focus:ring-offset-gray-900 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {reArmBusy ? 'Re-arming…' : 'Re-arm now'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Global paused banner (hidden for roles that cannot read polling status) */}
        {polling.supported && polling.isPaused && (
          <div
            role="status"
            className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-300 dark:border-amber-700 px-4 py-2 md:px-6 text-sm text-amber-800 dark:text-amber-200"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>
                <span className="font-semibold">Sensor polling is paused.</span>{' '}
                Sensor readings are not being recorded. Relay boards keep their 15 s heartbeat poll so the firmware fail-safe cannot trip.
              </span>
              {polling.pausedBy && (
                <span className="text-amber-700 dark:text-amber-300/80">— paused by {polling.pausedBy}</span>
              )}
              {polling.pauseReason && (
                <span className="text-amber-700 dark:text-amber-300/80">— {polling.pauseReason}</span>
              )}
              <span className="italic text-amber-700 dark:text-amber-300/80 tabular-nums">
                — {polling.autoResumeAt
                  ? `Auto-resumes in ${polling.countdownLabel || '--:--'}`
                  : 'Paused until manually resumed'}
              </span>
              {isAdmin && (
                <button
                  onClick={handleResumePolling}
                  disabled={pollingBusy}
                  className="ml-auto px-3 py-1 text-sm font-medium bg-white dark:bg-gray-800 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Resume now
                </button>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 p-4 md:p-6 overflow-auto">
          {children}
        </main>

        {/* Footer with system status */}
        <footer className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between">
            <span>A20Core - SenseHub v1.0.0</span>
            <div className="flex items-center space-x-4">
              <span className="flex items-center" title={
                backendReachable === null
                  ? 'Checking backend connectivity...'
                  : backendReachable
                    ? 'Backend reachable'
                    : 'Backend unreachable'
              }>
                <span className={`w-2 h-2 rounded-full mr-1 ${
                  backendReachable === null ? 'bg-gray-400'
                    : backendReachable ? 'bg-green-500' : 'bg-red-500'
                }`}></span>
                {backendReachable === null ? 'Checking…' : backendReachable ? 'System OK' : 'System Unreachable'}
              </span>
              <span className="flex items-center" title={
                backendReachable === null
                  ? 'Database status unknown'
                  : backendReachable
                    ? 'Database responding'
                    : 'No response from database'
              }>
                <span className={`w-2 h-2 rounded-full mr-1 ${
                  backendReachable === null ? 'bg-gray-400'
                    : backendReachable ? 'bg-green-500' : 'bg-red-500'
                }`}></span>
                {backendReachable === null ? 'DB Unknown' : backendReachable ? 'DB Connected' : 'DB Unreachable'}
              </span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
