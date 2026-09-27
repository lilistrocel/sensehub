/**
 * Dev-only pseudo-locale: English resources with accented letters, ~35 %
 * padding and brackets, so untranslated (hard-coded) text stands out as plain
 * English and clipped layouts show up before a real translation exists.
 * Interpolations ({{name}}) and Trans tags (<b>…</b>, <1>…</1>) are kept.
 * Enabled with ?lng=pseudo in `vite dev` only (stripped from production).
 */
const MAP = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

// Units and abbreviations stay readable even in pseudo (they are never translated).
const KEEP = /(\{\{[^}]+\}\}|<[^>]+>|\b(?:EC|pH|VPD|RH|mS\/cm|µS\/cm|L\/h|L\/min|m³|°C|kPa|kWh|ON|OFF|ch)\b)/g;

export function pseudoString(str) {
  if (typeof str !== 'string' || !str) return str;
  const parts = str.split(KEEP);
  let letters = 0;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // kept token
    return part.replace(/[A-Za-z]/g, (ch) => { letters += 1; return MAP[ch] || ch; });
  }).join('');
  const pad = '~'.repeat(Math.max(1, Math.round(letters * 0.35)));
  return `[${out} ${pad}]`;
}

export function pseudoResource(obj) {
  if (typeof obj === 'string') return pseudoString(obj);
  if (Array.isArray(obj)) return obj.map(pseudoResource);
  if (obj && typeof obj === 'object') {
    const out = {};
    Object.keys(obj).forEach((k) => { out[k] = pseudoResource(obj[k]); });
    return out;
  }
  return obj;
}
