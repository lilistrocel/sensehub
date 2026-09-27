/**
 * Connectivity / page-lifecycle state shared by the fetch layer, the toasts,
 * the WebSocket and the pollers.
 *
 * Why this exists: phones freeze or discard background tabs and drop their
 * sockets. When the user comes back, every request that was in flight rejects
 * with a network error ("Failed to fetch" on Chrome, "Load failed" on Safari),
 * overdue timers fire in a burst while the radio / Cloudflare tunnel is still
 * reconnecting, and the WebSocket is dead. None of that is a real fault, so it
 * must not reach the operator as an error. A failure that is still there once
 * the page has been visible and online for a while IS real and still surfaces.
 *
 * "Transient" = the page is hidden, the browser says it is offline, or the page
 * became visible / came back online less than RESUME_GRACE_MS ago.
 */

export const RESUME_GRACE_MS = 10000;        // after visible/online: network errors are presumed resume noise
export const PERSISTENT_FAILURE_MS = 15000;  // visible + online + still failing this long = real outage
export const LONG_HIDE_MS = 30000;           // hidden this long: sockets opened before the hide are presumed dead
const MUTATION_ERROR_WINDOW_MS = 5000;       // a failed user action's toast is never suppressed
const RESUME_DEBOUNCE_MS = 300;              // visibilitychange + online + focus arrive together: one refresh
const WAKE_TICK_MS = 5000;
const WAKE_GAP_MS = 20000;                   // a 5 s ticker that skipped > 20 s = the device slept

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

const state = {
  hidden: hasDom ? document.visibilityState === 'hidden' : false,
  online: hasDom && typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true,
  hiddenAt: 0,          // when the page last became hidden
  visibleAt: 0,         // when the page last became visible after being hidden (0 = never hidden)
  lastHiddenMs: 0,      // duration of the last hidden period
  onlineAt: 0,          // when the browser last came back online (0 = never went offline)
  lastOkAt: 0,          // last successful /api response
  failingSince: 0,      // first network failure of the current failure streak (0 = none)
  sessionExpiredAt: 0,
  mutationFailedAt: 0,  // last network failure of a non-GET (user action) request
};

const listeners = new Set();
const resumeListeners = new Set();
const hideListeners = new Set();
let snapshot = null;
let ticker = null;
let resumeTimer = null;
let installed = false;
let lastTick = Date.now(); // wake-from-sleep detector (see installConnectivity)

// ---------------------------------------------------------------- queries

export function isHidden() {
  return hasDom ? document.visibilityState === 'hidden' : false;
}

export function isOnline() {
  return state.online;
}

/** Within RESUME_GRACE_MS of becoming visible again or coming back online. */
export function inResumeWindow(now = Date.now()) {
  return (state.visibleAt > 0 && now - state.visibleAt < RESUME_GRACE_MS)
    || (state.onlineAt > 0 && now - state.onlineAt < RESUME_GRACE_MS);
}

/** Hidden, offline, or just resumed: network failures now are not the operator's problem. */
export function isTransientNow(now = Date.now()) {
  return isHidden() || !state.online || inResumeWindow(now);
}

const NETWORK_ERROR_RE = /failed to fetch|load failed|networkerror|network request failed|network error|network connection was lost|err_network|err_internet_disconnected|err_connection|internet connection appears to be offline|unable to connect to the server|the operation was aborted|aborterror|request aborted/i;
// Gateway answers while the tunnel / proxy reconnects (nginx 502/504, Cloudflare 52x/530).
const GATEWAY_TEXT_RE = /\bHTTP (502|503|504|52[0-9]|530)\b|bad gateway|gateway time-?out|service unavailable/i;

/** A fetch rejection caused by the network (not an HTTP status, not a caller abort). */
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'TypeError') return true; // fetch() only rejects with TypeError on network failure
  return NETWORK_ERROR_RE.test(String(err.message || err));
}

export function isGatewayStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

/** Does a user-facing message look like it came from a network failure? */
export function looksLikeNetworkErrorText(text) {
  const s = String(text || '');
  return NETWORK_ERROR_RE.test(s) || GATEWAY_TEXT_RE.test(s);
}

export function sessionRecentlyExpired(now = Date.now(), windowMs = 8000) {
  return state.sessionExpiredAt > 0 && now - state.sessionExpiredAt < windowMs;
}

/**
 * Should an error toast with this text be dropped? Only network-shaped errors
 * during the transient window, or anything raised in the seconds after the
 * session expired (the user is being sent to the login page; the 401 fallout
 * from every poller is noise).
 */
export function shouldSuppressErrorText(text, now = Date.now()) {
  if (sessionRecentlyExpired(now)) return true;
  // A user action (POST/PUT/DELETE: relay, stop, save) that just failed must
  // ALWAYS be reported, resume or not - it is never retried behind the scenes.
  if (state.mutationFailedAt && now - state.mutationFailedAt < MUTATION_ERROR_WINDOW_MS) return false;
  return looksLikeNetworkErrorText(text) && isTransientNow(now);
}

/**
 * 'ok' | 'offline' | 'reconnecting' | 'down'
 * - offline: the browser reports no network
 * - reconnecting: just came back and nothing has answered yet, or failing for < PERSISTENT_FAILURE_MS
 * - down: visible, online, and every request has failed for PERSISTENT_FAILURE_MS
 */
export function getStatus(now = Date.now()) {
  if (!state.online) return 'offline';
  if (state.failingSince) {
    const since = Math.max(state.failingSince, state.visibleAt, state.onlineAt);
    if (!isHidden() && now - since >= PERSISTENT_FAILURE_MS) return 'down';
    return 'reconnecting';
  }
  const resumed = Math.max(state.visibleAt, state.onlineAt);
  if (resumed && now - resumed < RESUME_GRACE_MS && state.lastOkAt < resumed && state.lastHiddenMs >= 2000) {
    return 'reconnecting';
  }
  return 'ok';
}

function computeSnapshot() {
  return {
    status: getStatus(),
    online: state.online,
    hidden: isHidden(),
    lastOkAt: state.lastOkAt,
    failingSince: state.failingSince,
    visibleAt: state.visibleAt,
  };
}

/** useSyncExternalStore-compatible snapshot (stable identity until something changes). */
export function getSnapshot() {
  if (!snapshot) snapshot = computeSnapshot();
  return snapshot;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  const next = computeSnapshot();
  const prev = snapshot;
  if (prev && prev.status === next.status && prev.online === next.online && prev.hidden === next.hidden
    && prev.lastOkAt === next.lastOkAt && prev.failingSince === next.failingSince && prev.visibleAt === next.visibleAt) {
    return;
  }
  snapshot = next;
  listeners.forEach((l) => { try { l(); } catch (e) { console.error('connectivity listener error:', e); } });
  // Re-evaluate time-based status transitions (reconnecting -> down / ok) while not ok.
  if (next.status !== 'ok' || next.failingSince) {
    if (!ticker && hasDom) ticker = setInterval(notify, 1000);
  } else if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

// ---------------------------------------------------------------- reports from the fetch layer

let lastOkNotify = 0;
export function reportOk() {
  const now = Date.now();
  const wasFailing = !!state.failingSince;
  state.lastOkAt = now;
  state.failingSince = 0;
  // lastOkAt changes on every response; only re-render subscribers when it matters.
  if (wasFailing || now - lastOkNotify > 5000 || (snapshot && snapshot.status !== 'ok')) {
    lastOkNotify = now;
    notify();
  }
}

export function reportNetworkFailure() {
  if (!state.failingSince) {
    state.failingSince = Date.now();
    notify();
  }
}

export function reportMutationFailure() {
  state.mutationFailedAt = Date.now();
  reportNetworkFailure();
}

export function markSessionExpired() {
  state.sessionExpiredAt = Date.now();
  notify();
}

export function getSessionExpiredAt() {
  return state.sessionExpiredAt;
}

// ---------------------------------------------------------------- lifecycle events

/**
 * Register a callback run ONCE per resume (page visible again after being
 * hidden, or browser back online), debounced so visibilitychange + online +
 * focus produce a single call. Returns an unsubscribe function.
 */
export function onResume(cb) {
  resumeListeners.add(cb);
  return () => resumeListeners.delete(cb);
}

/** Called when the page is hidden or frozen (e.g. to abort in-flight work). */
export function onHide(cb) {
  hideListeners.add(cb);
  return () => hideListeners.delete(cb);
}

let pendingResume = { hiddenAt: 0, hiddenMs: 0 };
function scheduleResume(info) {
  // Keep the longest hidden period seen since the last dispatch (visibility + online may both fire).
  if (info && info.hiddenMs > pendingResume.hiddenMs) pendingResume = { ...info };
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (isHidden() || !state.online) return;
    const detail = pendingResume;
    pendingResume = { hiddenAt: 0, hiddenMs: 0 };
    resumeListeners.forEach((cb) => { try { cb(detail); } catch (e) { console.error('resume listener error:', e); } });
  }, RESUME_DEBOUNCE_MS);
}

/** Resolves once the page is visible and the browser is online (immediately if already). */
export function waitUntilActive(signal) {
  if (!isHidden() && state.online) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!isHidden() && state.online) { cleanup(); resolve(); }
    };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      window.removeEventListener('pageshow', check);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    window.addEventListener('pageshow', check);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function handleVisibility() {
  const now = Date.now();
  lastTick = now; // hidden-tab timer throttling must not look like a sleep
  if (isHidden()) {
    if (!state.hidden) {
      state.hidden = true;
      state.hiddenAt = now;
      hideListeners.forEach((cb) => { try { cb('hidden'); } catch (e) { console.error(e); } });
    }
  } else if (state.hidden) {
    state.hidden = false;
    state.visibleAt = now;
    state.lastHiddenMs = state.hiddenAt ? now - state.hiddenAt : 0;
    // A failure streak that started while hidden says nothing about the server.
    if (state.failingSince && state.failingSince < now) state.failingSince = 0;
    scheduleResume({ hiddenAt: state.hiddenAt, hiddenMs: state.lastHiddenMs });
  }
  notify();
}

export function installConnectivity() {
  if (installed || !hasDom) return;
  installed = true;
  document.addEventListener('visibilitychange', handleVisibility);
  // Chrome fires `freeze` just before it suspends a background page.
  document.addEventListener('freeze', () => {
    hideListeners.forEach((cb) => { try { cb('freeze'); } catch (e) { console.error(e); } });
  });
  // bfcache restore behaves like a resume.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      const now = Date.now();
      state.visibleAt = now;
      state.lastHiddenMs = LONG_HIDE_MS;
      scheduleResume({ hiddenAt: now - 1, hiddenMs: LONG_HIDE_MS });
      notify();
    }
  });
  window.addEventListener('online', () => {
    state.online = true;
    state.onlineAt = Date.now();
    state.failingSince = 0;
    scheduleResume();
    notify();
  });
  // Wake from sleep while "visible" (laptop lid, phone screen off without a
  // visibilitychange): timers stop, so a large gap between ticks means we were
  // suspended. Treat it exactly like coming back from a hidden tab.
  lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (!isHidden() && !state.hidden && gap > WAKE_GAP_MS) {
      state.hiddenAt = now - gap;
      state.visibleAt = now;
      state.lastHiddenMs = gap;
      state.failingSince = 0;
      scheduleResume({ hiddenAt: state.hiddenAt, hiddenMs: gap });
      notify();
    }
  }, WAKE_TICK_MS);
  window.addEventListener('offline', () => {
    state.online = false;
    hideListeners.forEach((cb) => { try { cb('offline'); } catch (e) { console.error(e); } });
    notify();
  });
}

/** Test-only: reset module state. */
export function __resetConnectivityForTests(overrides = {}) {
  Object.assign(state, {
    hidden: false, online: true, hiddenAt: 0, visibleAt: 0, lastHiddenMs: 0, onlineAt: 0,
    lastOkAt: 0, failingSince: 0, sessionExpiredAt: 0, mutationFailedAt: 0,
  }, overrides);
  snapshot = null;
}

export default {
  isHidden, isOnline, isTransientNow, inResumeWindow, isNetworkError, isGatewayStatus,
  looksLikeNetworkErrorText, shouldSuppressErrorText, getStatus, getSnapshot, subscribe,
  onResume, onHide, waitUntilActive, reportOk, reportNetworkFailure, reportMutationFailure, markSessionExpired,
  installConnectivity,
};
