// Scale a (value, unit) pair up the SI ladder so big numbers display compactly.
// 20244 W → 20.244 kW, 1500 µS/cm → 1.5 mS/cm, 5000 kWh → 5 MWh, etc.
// Only scales upward — small numbers keep their existing unit.

// Bases that can carry an SI prefix. New base unit? Add it here.
const SCALEABLE_BASES = [
  'W', 'Wh',
  'VA', 'VAh',
  'var', 'varh',
  'A', 'V', 'Hz', 'Pa',
  'S/cm',
];

// Ordered low → high. Used both to detect the current prefix and to step up.
const PREFIX_LADDER = ['µ', 'm', '', 'k', 'M', 'G'];

function parseUnit(unit) {
  for (const p of ['µ', 'm', 'k', 'M', 'G']) {
    if (unit.startsWith(p) && SCALEABLE_BASES.includes(unit.slice(p.length))) {
      return { prefix: p, base: unit.slice(p.length) };
    }
  }
  if (SCALEABLE_BASES.includes(unit)) return { prefix: '', base: unit };
  return null;
}

export function scaleValueAndUnit(value, unit) {
  if (typeof value !== 'number' || !isFinite(value) || !unit) return { value, unit };
  const parsed = parseUnit(unit);
  if (!parsed) return { value, unit };

  let v = value;
  let idx = PREFIX_LADDER.indexOf(parsed.prefix);
  while (Math.abs(v) >= 1000 && idx < PREFIX_LADDER.length - 1) {
    v = v / 1000;
    idx += 1;
  }
  return { value: v, unit: PREFIX_LADDER[idx] + parsed.base };
}

// Convenience: pick a sensible decimal count for the magnitude so we don't
// turn 0.74 into "0.7" or 1234 into "1234.0". Mirrors what `toFixed` would do
// but adapts to the value's scale after unit conversion.
export function formatScaled(value, unit) {
  const { value: v, unit: u } = scaleValueAndUnit(value, unit);
  if (typeof v !== 'number' || !isFinite(v)) return { value: v, unit: u };
  const abs = Math.abs(v);
  let decimals;
  if (abs >= 100) decimals = 1;
  else if (abs >= 10) decimals = 1;
  else if (abs >= 1) decimals = 2;
  else decimals = 3;
  return { value: v.toFixed(decimals), unit: u };
}
