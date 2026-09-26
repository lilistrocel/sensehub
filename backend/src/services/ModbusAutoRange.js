'use strict';
/**
 * ModbusAutoRange — decode a register whose device switches its own range.
 *
 * Incident 2026-09-26 "EC 10x too low": the SEKO Kontrol 800 (equipment 17)
 * reports EC on FC04 register 1005 as raw = µS x 10 below ~2000 µS (0.1 µS
 * resolution, max 19999) and raw = µS x 1 (i.e. mS x 1000) at/above ~2000 µS.
 * Its range/divisor registers (1175/1176) answer exception 2 on this firmware,
 * so the range has to be inferred. A fixed scale 0.1 showed 340 µS/cm while the
 * panel read 3156 µS (operator photo); the first switch in history is
 * 2026-09-25T13:00:52Z (raw 17502 -> 2859) when the first real fertigation run
 * started.
 *
 * Mapping option (register_mappings entry):
 *   autoRange: { lowScale: 0.1, highScale: 1, switchAt: 2000 }
 * The decoded value is in engineering units (µS/cm here); mapping.scale is NOT
 * applied on top (offset and equipment calibration still are).
 *
 * RULE (per equipment + metric, state = { range, value }):
 *   Both readings of the raw word are candidates: low = raw x lowScale,
 *   high = raw x highScale. The high candidate is only possible when
 *   high >= highMinFrac x switchAt (the device leaves the low range only near
 *   switchAt). Stay in the current range unless the other candidate is closer
 *   to the previous decoded value in log space by more than `margin`
 *   (ln units; 0.3 ~ 1.35x). Nearest-in-log follows fast real changes (fresh
 *   water flush, dosing ramp, 30 s samples: 1750 -> 2859 µS at 13:00:52,
 *   2172 -> 1398 µS at 13:10:27, 922 -> 2321 µS at 03:31:04) where fixed
 *   "previous >= 1800" thresholds would have missed the real switch
 *   (previous was 1750). When neither candidate is clearly closer and the
 *   step is > 2x either way (e.g. raw 9000 after 3000 µS: 9000 or 900?), the
 *   range is kept and `ambiguous` is set so the caller can warn once.
 *   With no state, raw is read high if high is possible and < 3 x switchAt
 *   (the 2000-5999 feed pattern), else low.
 * Known limit: a single-sample drop from the high range to far below switchAt
 * (e.g. 3000 -> 300 µS) produces a raw that also reads as a plausible
 * high-range value; it decodes high until the next switch pattern.
 *
 * PLAUSIBILITY HINT (optional 4th argument, from the live irrigation monitor —
 * DoseController.ecRangeHint): the SEKO status bits carry no range flag, and at
 * a run start the <= 50 L buffer flushes in ~15 s, so EC can cross 2000 µS
 * between two samples unseen. The hint overrides continuity:
 *   { minValue }   feed is being fertilised (>= 2 metered tanks at 1:80-1:250,
 *                  water flowing): EC must be > minValue, so a low reading below
 *                  it is re-read HIGH when the high candidate is possible.
 *   { preferValue } water flows but nothing has dosed for the window: pick the
 *                  candidate closest (log) to the raw-water EC.
 * `overridden` names the hint basis when it changed the continuity choice.
 */

const DEFAULTS = Object.freeze({ lowScale: 0.1, highScale: 1, switchAt: 2000, highMinFrac: 0.9, margin: 0.3 });

/** Normalise a mapping's autoRange option. Returns null when absent/invalid. */
function normaliseAutoRange(opt) {
  if (!opt || typeof opt !== 'object') return null;
  const cfg = { ...DEFAULTS, ...opt };
  for (const k of ['lowScale', 'highScale', 'switchAt', 'highMinFrac', 'margin']) {
    cfg[k] = Number(cfg[k]);
    if (!Number.isFinite(cfg[k]) || cfg[k] < 0) return null;
  }
  if (!(cfg.lowScale > 0 && cfg.highScale > cfg.lowScale && cfg.switchAt > 0)) return null;
  return cfg;
}

const logDist = (a, b) => (a > 0 && b > 0 ? Math.abs(Math.log(a / b)) : Infinity);
const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Decode one raw word. prev = { range: 'low'|'high', value } or null.
 * Returns { value, range, switched, ambiguous, assumed }.
 */
function decodeAutoRange(raw, prev, opt, hint = null) {
  const cfg = normaliseAutoRange(opt) || DEFAULTS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return { value: null, range: prev ? prev.range : null, switched: false, ambiguous: false, assumed: false };
  }
  const low = raw * cfg.lowScale;
  const high = raw * cfg.highScale;
  const highOk = high >= cfg.highMinFrac * cfg.switchAt;
  let range;
  let ambiguous = false;
  let assumed = false;
  if (!prev || (prev.range !== 'low' && prev.range !== 'high')) {
    range = highOk && high < 3 * cfg.switchAt ? 'high' : 'low';
    assumed = true;
  } else if (!(prev.value > 0)) {
    range = prev.range === 'high' && !highOk ? 'low' : prev.range;
  } else {
    const dl = logDist(low, prev.value);
    const dh = highOk ? logDist(high, prev.value) : Infinity;
    const dCur = prev.range === 'high' ? dh : dl;
    const dOther = prev.range === 'high' ? dl : dh;
    if (dCur === Infinity && dOther !== Infinity) range = prev.range === 'high' ? 'low' : 'high';
    else if (dOther + cfg.margin < dCur) range = prev.range === 'high' ? 'low' : 'high';
    else {
      range = prev.range;
      if (Math.abs(dOther - dCur) <= cfg.margin && Math.min(dl, dh) > Math.LN2) ambiguous = true;
    }
  }
  let overridden = null;
  if (hint && typeof hint === 'object') {
    if (hint.minValue > 0 && range === 'low' && low < hint.minValue && highOk) {
      range = 'high'; overridden = hint.basis || 'fertilised';
    } else if (!(hint.minValue > 0) && hint.preferValue > 0) {
      const want = highOk && logDist(high, hint.preferValue) < logDist(low, hint.preferValue) ? 'high' : 'low';
      if (want !== range) { range = want; overridden = hint.basis || 'raw_water'; }
    }
    if (overridden) { ambiguous = false; assumed = false; }
  }
  const value = round(range === 'high' ? high : low);
  return { value, range, switched: !!prev && !!prev.range && range !== prev.range, ambiguous, assumed, overridden };
}

/**
 * Seed the range state from stored history (chronological values as stored).
 * Values stored before auto-range decoding existed are raw x oldScale (< switchAt
 * always, since raw <= 19999); a stored value >= switchAt can only be an
 * auto-range high decode. Post-fix low-range values equal raw x lowScale, so
 * both invert with raw = v / oldScale when oldScale === lowScale.
 */
function seedFromHistory(values, opt, oldScale) {
  const cfg = normaliseAutoRange(opt) || DEFAULTS;
  const inv = Number(oldScale) > 0 ? Number(oldScale) : cfg.lowScale;
  let st = null;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    if (v >= cfg.switchAt) { st = { range: 'high', value: v }; continue; }
    const d = decodeAutoRange(Math.round(v / inv), st, cfg);
    st = { range: d.range, value: d.value };
  }
  return st;
}

module.exports = { decodeAutoRange, seedFromHistory, normaliseAutoRange, AUTO_RANGE_DEFAULTS: DEFAULTS };
