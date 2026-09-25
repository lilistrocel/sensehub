/**
 * Downsampling + staleness rules for MQTT live telemetry (pure, clock injected).
 *
 * The monitor publishes flow every 0.5 s and dosing every 1 s while irrigating.
 * Storing that would re-create the 2026-09 readings bloat on a near-full Pi disk,
 * so the readings table gets at most one row per metric per:
 *   - MIN_INTERVAL_ACTIVE_MS (10 s) while irrigating,
 *   - MIN_INTERVAL_IDLE_MS   (30 s) when idle,
 * and, once that minimum has passed, only if the value changed or the
 * HEARTBEAT_MS (5 min) has elapsed — an idle counter that never moves costs
 * one row per metric per 5 min, not one per 30 s.
 * forceAll() (irrigation start/stop) makes the next sample of every metric
 * record immediately, so the history always brackets a state change.
 * The full-rate latest values stay in memory / WebSocket for live display.
 */

const MIN_INTERVAL_ACTIVE_MS = 10 * 1000;
const MIN_INTERVAL_IDLE_MS = 30 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;

class Downsampler {
  constructor(opts = {}) {
    this.minActiveMs = opts.minActiveMs ?? MIN_INTERVAL_ACTIVE_MS;
    this.minIdleMs = opts.minIdleMs ?? MIN_INTERVAL_IDLE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.last = new Map(); // `${equipmentId}|${metric}` -> { ts, value }
    this.forced = new Set(); // keys to record on their next sample regardless of interval
  }

  /** Should this sample be written to the readings table? Records it if so. */
  shouldRecord(equipmentId, metric, value, tsMs, active) {
    const key = `${equipmentId}|${metric}`;
    const prev = this.last.get(key);
    let record;
    if (!prev || this.forced.has(key)) {
      record = true;
    } else {
      const elapsed = tsMs - prev.ts;
      const minMs = active ? this.minActiveMs : this.minIdleMs;
      if (elapsed < minMs) record = false;
      else record = value !== prev.value || elapsed >= this.heartbeatMs;
    }
    if (record) {
      this.last.set(key, { ts: tsMs, value });
      this.forced.delete(key);
    }
    return record;
  }

  /** Force the next sample of every metric of this equipment to be recorded. */
  forceAll(equipmentId) {
    // Per-metric keys, so each metric consumes its own force. Metrics never seen
    // before record anyway (no previous sample).
    for (const key of this.last.keys()) {
      if (key.startsWith(`${equipmentId}|`)) this.forced.add(key);
    }
  }

  /** Filter a list of {name, value, unit} to the ones that should be recorded. */
  filter(equipmentId, metrics, tsMs, active) {
    return metrics.filter(m => this.shouldRecord(equipmentId, m.name, m.value, tsMs, active));
  }
}

/** A monitor is stale when no live message has arrived for this long. */
const STALE_AFTER_MS = 60 * 1000;

/**
 * Equipment status the UI renders, from what we actually know:
 *   - no live data ever, or none for STALE_AFTER_MS  -> 'offline'
 *   - broker says offline (LWT) and no live data since -> 'offline'
 *   - fresh data but non-zero flow-meter error_flags  -> 'warning'
 *   - otherwise                                       -> 'online'
 * Fresh live data outranks a stale 'offline' status: a message that just
 * arrived proves the device is talking.
 */
function effectiveStatus({ lastLiveMs, brokerState, brokerStateMs, errorFlags }, nowMs, staleAfterMs = STALE_AFTER_MS) {
  if (lastLiveMs === null || lastLiveMs === undefined) return 'offline';
  if (nowMs - lastLiveMs > staleAfterMs) return 'offline';
  if (brokerState === 'offline' && brokerStateMs !== null && brokerStateMs !== undefined && brokerStateMs > lastLiveMs) return 'offline';
  if (errorFlags) return 'warning';
  return 'online';
}

module.exports = {
  Downsampler,
  effectiveStatus,
  MIN_INTERVAL_ACTIVE_MS,
  MIN_INTERVAL_IDLE_MS,
  HEARTBEAT_MS,
  STALE_AFTER_MS,
};
