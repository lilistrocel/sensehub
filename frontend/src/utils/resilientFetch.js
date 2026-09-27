/**
 * Resume-tolerant window.fetch for /api GET requests.
 *
 * Installed once, before React renders (main.jsx), underneath AuthContext's
 * 401 interceptor, so all ~270 raw fetch() call sites get it without changes.
 *
 * Behaviour for GET/HEAD requests to /api/:
 *  - Steady state (visible, online, not just resumed): a network failure
 *    rejects exactly as before. Desktop behaviour is unchanged.
 *  - Transient (hidden, offline, or < RESUME_GRACE_MS after resume): a network
 *    failure or a gateway status (502/503/504/52x) is NOT returned to the
 *    caller. The request is parked until the page is visible and online, then
 *    retried with backoff. It rejects only if it still fails after at least
 *    MIN_RETRIES retries once the resume window has passed, so a genuinely
 *    down backend still reaches the operator as an error.
 *  - Identical parked GETs (same URL + auth) share one replay, so a poller
 *    that kept ticking in the background does not produce a burst on resume.
 *  - Requests in flight when the page is frozen, goes offline, or (on return)
 *    was hidden for LONG_HIDE_MS are aborted internally and replayed: their
 *    sockets are dead and would otherwise hang or fail after the user is back.
 *
 * Non-GET requests are never retried or replayed (not idempotent); they only
 * feed the connectivity status.
 *
 * Every /api request (any method) also carries `Accept-Language: <ui lang>`
 * unless the caller set one, so server-generated texts (alerts, flow-watch and
 * dose-controller messages, report summaries) come back in the user's language
 * without touching the ~270 call sites. See docs/i18n-guide.md.
 */
import {
  installConnectivity,
  isTransientNow,
  inResumeWindow,
  isNetworkError,
  isGatewayStatus,
  waitUntilActive,
  reportOk,
  reportNetworkFailure,
  reportMutationFailure,
  onHide,
  onResume,
  LONG_HIDE_MS,
} from './connectivity';
import { getApiLanguage } from '../i18n/current';

const MIN_RETRIES = 2;
const MAX_RETRIES = 8;
const RETRY_ATTEMPT_TIMEOUT_MS = 15000; // a retry on a half-open socket must not hang forever
const backoffMs = (n) => Math.min(3000, 400 * (n + 1)); // 0.4, 0.8, 1.2 ... 3 s: fast recovery once the radio is back

// Backoff sleeps end early on resume / back online: the moment the network is
// usable again every parked retry goes at once (coalesced per URL).
const wakers = new Set();
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => {
    clearTimeout(t);
    wakers.delete(done);
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  };
  const t = setTimeout(done, ms);
  const onAbort = () => { clearTimeout(t); wakers.delete(done); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  wakers.add(done);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input && input.url) || String(input || '');
}

function requestMethod(input, init) {
  return String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
}

function isApiUrl(url) {
  if (url.startsWith('/api/')) return true;
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function authKey(input, init) {
  const h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
  if (!h) return '';
  try {
    if (typeof h.get === 'function') return h.get('Authorization') || '';
    return h.Authorization || h.authorization || '';
  } catch {
    return '';
  }
}

/**
 * Copy of `init` with Accept-Language added (headers from `init`, else from a
 * Request `input`). Returns `init` untouched when the caller already set the
 * header or no language is known.
 */
export function withLanguageHeader(input, init, lang) {
  if (!lang) return init;
  const src = (init && init.headers)
    || (input && typeof input === 'object' && !(input instanceof URL) && input.headers)
    || undefined;
  let headers;
  try {
    headers = new Headers(src || undefined);
  } catch {
    return init;
  }
  if (headers.has('Accept-Language')) return init;
  headers.set('Accept-Language', lang);
  return { ...(init || {}), headers };
}

export function installResilientFetch() {
  if (typeof window === 'undefined' || window.__resilientFetchInstalled) return;
  window.__resilientFetchInstalled = true;
  installConnectivity();

  const baseFetch = window.fetch.bind(window);
  const inflight = new Set(); // { ctl, startedAt, killed }
  const parked = new Map();   // key -> Promise<Response> (shared replay)

  const killInflight = (predicate = () => true) => {
    inflight.forEach((rec) => {
      if (!rec.killed && predicate(rec)) {
        rec.killed = true;
        try { rec.ctl.abort(); } catch { /* ignore */ }
      }
    });
  };

  onHide((reason) => {
    if (reason === 'hidden') return;
    // 'freeze' (page about to be suspended) or 'offline': these sockets are dead.
    killInflight();
  });
  onResume(({ hiddenAt, hiddenMs }) => {
    // Back after a long hide / sleep: anything still "in flight" from before is on a dead socket.
    if (hiddenAt && hiddenMs >= LONG_HIDE_MS) killInflight((rec) => rec.startedAt <= hiddenAt);
    // Retry parked requests now rather than at the end of their backoff.
    Array.from(wakers).forEach((wake) => wake());
  });

  // One network attempt, abortable by the caller and by us.
  async function attempt(input, init, callerSignal, timeoutMs) {
    const ctl = new AbortController();
    const rec = { ctl, startedAt: Date.now(), killed: false };
    const onCallerAbort = () => ctl.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError');
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { rec.killed = true; ctl.abort(); }, timeoutMs);
    inflight.add(rec);
    try {
      const res = await baseFetch(input, { ...(init || {}), signal: ctl.signal });
      return { res, rec };
    } catch (err) {
      err.__killedByUs = rec.killed && !(callerSignal && callerSignal.aborted);
      throw err;
    } finally {
      inflight.delete(rec);
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function resilientGet(input, init) {
    const callerSignal = init && init.signal;
    let retries = 0;
    let lastErr = null;
    let lastRes = null;
    let parkKey = null;
    let resolveShared = null;
    let rejectShared = null;

    const settleShared = (res, err) => {
      if (!parkKey) return;
      parked.delete(parkKey);
      if (res) resolveShared(res); else rejectShared(err);
      parkKey = null;
    };

    // Enter the shared-replay map (only requests without a caller signal can share).
    const park = () => {
      if (parkKey || callerSignal) return null;
      const key = `${requestUrl(input)}|${authKey(input, init)}`;
      const existing = parked.get(key);
      if (existing) return existing;
      parkKey = key;
      const p = new Promise((res, rej) => { resolveShared = res; rejectShared = rej; });
      p.catch(() => {}); // sharers attach their own handlers
      parked.set(key, p);
      return null;
    };

    for (;;) {
      try {
        const { res } = await attempt(input, init, callerSignal, retries > 0 ? RETRY_ATTEMPT_TIMEOUT_MS : 0);
        if (isGatewayStatus(res.status) && isTransientNow() && retries < MAX_RETRIES) {
          // The tunnel / proxy answering for a backend we cannot reach yet.
          lastRes = res;
          lastErr = null;
          reportNetworkFailure();
        } else {
          if (isGatewayStatus(res.status)) reportNetworkFailure(); else reportOk();
          if (parkKey) { settleShared(res); return res.clone(); }
          return res;
        }
      } catch (err) {
        if (callerSignal && callerSignal.aborted) { settleShared(null, err); throw err; }
        const killedByUs = !!err.__killedByUs;
        if (!killedByUs && !isNetworkError(err)) { settleShared(null, err); throw err; }
        if (!killedByUs && !isTransientNow() && retries === 0) {
          // Steady state: unchanged behaviour - the caller sees the failure now.
          reportNetworkFailure();
          settleShared(null, err);
          throw err;
        }
        if (!killedByUs) reportNetworkFailure();
        lastErr = err;
        lastRes = null;
      }

      // Transient failure: give up only when the resume window is over and we have retried enough.
      if (retries >= MAX_RETRIES || (retries >= MIN_RETRIES && !isTransientNow())) {
        if (lastRes) {
          const wasParked = !!parkKey;
          settleShared(lastRes);
          return wasParked ? lastRes.clone() : lastRes;
        }
        // Our own abort (dead socket / attempt timeout) surfaces as a network error, not "aborted".
        const finalErr = lastErr && lastErr.__killedByUs ? new TypeError('Failed to fetch (connection lost)') : lastErr;
        settleShared(null, finalErr);
        throw finalErr;
      }

      const shared = park();
      if (shared) return shared.then((r) => r.clone());

      try {
        await waitUntilActive(callerSignal);                 // hidden / offline: wait for the user
        await sleep(backoffMs(retries), callerSignal);
      } catch (abortErr) {
        settleShared(null, abortErr);
        throw abortErr;
      }
      retries += 1;
      if (lastRes && lastRes.body) { // superseded by the next attempt; sharers only ever get the final response
        try { lastRes.body.cancel().catch(() => {}); } catch { /* ignore */ }
      }
    }
  }

  window.fetch = function resilientFetch(input, rawInit) {
    const url = requestUrl(input);
    if (!isApiUrl(url)) return baseFetch(input, rawInit);
    const init = withLanguageHeader(input, rawInit, getApiLanguage());
    const method = requestMethod(input, init);
    if (method === 'GET' || method === 'HEAD') return resilientGet(input, init);
    // Non-idempotent: never retried; only feeds the connectivity status.
    return baseFetch(input, init).then(
      (res) => { if (isGatewayStatus(res.status)) reportNetworkFailure(); else reportOk(); return res; },
      (err) => { if (isNetworkError(err) && !(init && init.signal && init.signal.aborted)) reportMutationFailure(); throw err; },
    );
  };
}

// Exposed for unit tests.
export const __test = { backoffMs, isApiUrl, requestMethod, withLanguageHeader, MIN_RETRIES, MAX_RETRIES, inResumeWindow };

export default installResilientFetch;
