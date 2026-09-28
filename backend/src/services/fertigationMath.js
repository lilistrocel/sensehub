/**
 * fertigationMath — the stock-solution / delivered-ppm math shared by
 * routes/fertigation.js (tank + dose-program ppm previews) and the crop
 * nutrition feed calculator (services/FeedCalculator.js).
 *
 * Ingredient analyses (fertigation_ingredients.composition) are % w/w per
 * element. Solids: amount in kg (g accepted); liquids: amount in L (mL
 * accepted) converted to kg by density_kg_per_l. A stock tank's elemental
 * concentration is total mg of the element / water_base_liters.
 *
 *   irrigation ppm (mg/L) = stock mg/L × concentrate L ÷ water L
 *
 * Pure except loadMixtureItems(), which takes the db handle.
 */

const ELEMENTS = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Cu', 'Mn', 'Mo', 'Zn', 'B', 'Cl', 'Na'];

function parseComposition(c) {
  if (!c) return {};
  if (typeof c === 'object') return c;
  try { const v = JSON.parse(c); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

/** Mixture items with their ingredient analysis. */
function loadMixtureItems(db, mixtureId) {
  if (!mixtureId) return [];
  return db.prepare(`
    SELECT mi.ingredient_id, mi.parts, mi.amount, mi.unit,
           fi.name, fi.form, fi.density_kg_per_l, fi.compatibility_group, fi.composition, fi.notes
    FROM fertigation_mixture_items mi
    JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
    WHERE mi.mixture_id = ?
  `).all(mixtureId);
}

/** Item amount → kg of product. */
function itemMassKg(it) {
  const amount = Number(it.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (it.unit === 'L' || it.unit === 'mL') {
    return (it.unit === 'mL' ? amount / 1000 : amount) * (Number(it.density_kg_per_l) || 1);
  }
  return it.unit === 'g' ? amount / 1000 : amount; // kg if not specified
}

/**
 * mg of each element per litre of finished stock solution.
 * (Liquids: amount in L → kg via density, composition treated as % w/w.)
 */
function stockElementalMgPerL(items, waterBaseLiters) {
  const out = {};
  if (!waterBaseLiters || waterBaseLiters <= 0) return out;
  for (const it of items || []) {
    const massKg = itemMassKg(it);
    if (!massKg) continue;
    const comp = parseComposition(it.composition);
    for (const [el, pct] of Object.entries(comp)) {
      if (!ELEMENTS.includes(el)) continue;
      const mg = massKg * (Number(pct) / 100) * 1e6; // total mg of element in the whole tank
      out[el] = (out[el] || 0) + mg / waterBaseLiters;
    }
  }
  return out;
}

// Share of an ingredient's N that is ammonium (NH4-N), when the analysis has no
// explicit NH4_N / NO3_N keys. Greenhouse-grade calcium nitrate 15.5-0-0 is
// 14.4 NO3-N + 1.1 NH4-N; Fetrilon Combi 2 declares its N as NH4-N; nitrates of
// K / Mg are all nitrate. Anything else: assumed nitrate (stated in the output).
const NH4_SHARE_BY_NAME = [
  { re: /calcium\s*nitrate|ca\(no3\)|calcinit/i, share: 1.1 / 15.5, basis: 'calcium nitrate 15.5 N = 14.4 NO3-N + 1.1 NH4-N (typical label)' },
  { re: /fetrilon/i, share: 1, basis: 'label declares N as NH4-N' },
  { re: /ammonium|\bmap\b|\bdap\b|urea/i, share: 1, basis: 'ammonium / urea source' },
];

/**
 * NH4-N and NO3-N mg per litre of stock (same basis as stockElementalMgPerL).
 * @returns {{ nh4: number, no3: number, assumptions: string[] }}
 */
function stockNitrogenForms(items, waterBaseLiters) {
  let nh4 = 0; let no3 = 0; const assumptions = [];
  if (!waterBaseLiters || waterBaseLiters <= 0) return { nh4, no3, assumptions };
  for (const it of items || []) {
    const massKg = itemMassKg(it);
    if (!massKg) continue;
    const comp = parseComposition(it.composition);
    const nPct = Number(comp.N) || 0;
    if (!nPct && comp.NH4_N == null && comp.NO3_N == null) continue;
    let nh4Pct; let no3Pct;
    if (comp.NH4_N != null || comp.NO3_N != null) {
      nh4Pct = Number(comp.NH4_N) || 0;
      no3Pct = comp.NO3_N != null ? Number(comp.NO3_N) || 0 : Math.max(0, nPct - nh4Pct);
    } else {
      const rule = NH4_SHARE_BY_NAME.find(r => r.re.test(String(it.name || '')));
      const share = rule ? rule.share : 0;
      nh4Pct = nPct * share;
      no3Pct = nPct - nh4Pct;
      assumptions.push(`${it.name}: ${rule ? rule.basis : 'N assumed all nitrate'}`);
    }
    nh4 += massKg * (nh4Pct / 100) * 1e6 / waterBaseLiters;
    no3 += massKg * (no3Pct / 100) * 1e6 / waterBaseLiters;
  }
  return { nh4, no3, assumptions };
}

/** Round every numeric value of an object to dp decimals. */
function round(obj, dp = 2) {
  const f = Math.pow(10, dp);
  const r = {};
  for (const [k, v] of Object.entries(obj || {})) r[k] = Math.round(v * f) / f;
  return r;
}

function roundTo(v, dp = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const f = Math.pow(10, dp);
  return Math.round(Number(v) * f) / f;
}

module.exports = {
  ELEMENTS,
  parseComposition,
  loadMixtureItems,
  itemMassKg,
  stockElementalMgPerL,
  stockNitrogenForms,
  NH4_SHARE_BY_NAME,
  round,
  roundTo,
};
