/**
 * RelayCommandLedger - per-channel command generations (operator-approved fix
 * 2026-10-07, "zone-4 pump-off").
 *
 * Every coil command a writer issues gets a monotonically increasing
 * generation number, recorded per (equipment, channel) BEFORE the write goes
 * out. A command can then ask "has a newer command been issued on my channel
 * since mine?" — which is how a stale command is kept from overriding a newer
 * one:
 *
 *   - a timer-driven auto-OFF armed by an older ON must not switch OFF (or
 *     re-write OFF on its read-back retry) a channel that a NEWER ON now owns
 *     and that has its own pending auto-off (bounded);
 *   - the read-back retry of an ON must never re-energise a channel after a
 *     newer command (stop-all, manual OFF, auto-off) was issued on it.
 *
 * Incident 2026-10-07 03:41:18 UTC (run 118, also 2026-09-29 run 106 and
 * 2026-10-02 run 112): zone 3's pump ON came ~6 s late on a busy bus, its
 * auto-off (timed from the actual ON) fired ~3 s after zone 4's pump ON on the
 * shared pump channels; the OFF's read-back saw zone 4's new ON, treated it as
 * a failed OFF and re-wrote OFF -> zone 4 valve open 3.5 min with no pumping.
 *
 * In-memory on purpose: after a restart every channel starts with no history,
 * which only means "no suppression" (the pre-fix behaviour, OFF wins). The
 * ledger never decides to energise anything.
 */

let seq = 0;
const latest = new Map(); // "eq:ch" -> { gen, state, source, automationId, atMs }

const key = (equipmentId, channel) => `${Number(equipmentId)}:${Number(channel)}`;

/**
 * Record a command about to be written. Returns its generation.
 * @param {number} equipmentId
 * @param {number} channel
 * @param {boolean} state - requested state
 * @param {object} [meta] - { source, automationId }
 */
function record(equipmentId, channel, state, meta = {}) {
  const gen = ++seq;
  latest.set(key(equipmentId, channel), {
    gen,
    state: state === true,
    source: meta.source || null,
    automationId: meta.automationId ?? null,
    atMs: Date.now(),
  });
  return gen;
}

/** Record the same state for several channels (FC15 run, stop-all). Returns { channel: gen }. */
function recordMany(equipmentId, channels, state, meta = {}) {
  const out = {};
  for (const ch of channels) out[ch] = record(equipmentId, ch, state, meta);
  return out;
}

/** The newest command issued on a channel, or null. */
function latestCommand(equipmentId, channel) {
  const e = latest.get(key(equipmentId, channel));
  return e ? { ...e } : null;
}

/** The newest command on the channel when it is newer than `gen`, else null. */
function newerThan(equipmentId, channel, gen) {
  const e = latest.get(key(equipmentId, channel));
  return e && Number.isFinite(gen) && e.gen > gen ? { ...e } : null;
}

/** Test helper. */
function _reset() {
  latest.clear();
  seq = 0;
}

module.exports = { record, recordMany, latestCommand, newerThan, _reset };
