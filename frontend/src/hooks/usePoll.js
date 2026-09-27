import { useEffect } from 'react';
import { onResume, isHidden } from '../utils/connectivity';

/**
 * Resume-safe replacement for `setInterval(fn, intervalMs)`.
 *  - ticks are skipped while the page is hidden (no requests into a dead
 *    network from a background tab),
 *  - on resume (visible again / back online) `fn` runs ONCE, debounced across
 *    visibilitychange + online, and the interval restarts from there,
 *  - a setTimeout chain instead of setInterval, so a frozen page produces one
 *    overdue tick on unfreeze, not a backlog.
 * Returns a stop function (use it where you would call clearInterval).
 *
 * @param {() => any} fn
 * @param {number} intervalMs
 * @param {{ immediate?: boolean, pauseWhenHidden?: boolean }} [opts]
 *   immediate: also run fn right away (default false, like setInterval)
 */
export function startPolling(fn, intervalMs, { immediate = false, pauseWhenHidden = true } = {}) {
  let stopped = false;
  let timer = null;
  let lastRunAt = 0;

  const run = () => {
    lastRunAt = Date.now();
    try {
      const p = fn();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      console.error('poll error:', e);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  };
  const tick = () => {
    if (stopped) return;
    if (!(pauseWhenHidden && isHidden())) run();
    schedule();
  };

  if (immediate) run();
  schedule();

  const offResume = onResume(() => {
    if (stopped) return;
    // An overdue tick that already fired after the page became visible counts as the refresh.
    if (Date.now() - lastRunAt < 1000) { schedule(); return; }
    run();
    schedule();
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    offResume();
  };
}

/**
 * Hook form: drop-in for
 *   useEffect(() => { fn(); const id = setInterval(fn, ms); return () => clearInterval(id); }, [fn]);
 * with the resume behaviour of startPolling. Like the pattern it replaces, the
 * effect re-runs (and calls `fn` right away) whenever `fn`'s identity changes,
 * so pass a useCallback.
 *
 * @param {() => any} fn
 * @param {number} intervalMs
 * @param {{ enabled?: boolean, immediate?: boolean, pauseWhenHidden?: boolean }} [opts]
 */
export function usePoll(fn, intervalMs, { enabled = true, immediate = true, pauseWhenHidden = true } = {}) {
  useEffect(() => {
    if (!enabled || typeof fn !== 'function') return undefined;
    return startPolling(fn, intervalMs, { immediate, pauseWhenHidden });
  }, [fn, intervalMs, enabled, immediate, pauseWhenHidden]);
}

export default usePoll;
