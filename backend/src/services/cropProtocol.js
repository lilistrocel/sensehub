/**
 * cropProtocol — the HUMAN agronomist's protocol, stored as a named, read-only
 * baseline (crop_protocols row). Operator decision 2026-09-28: the targets and
 * recipe prefill are the human agronomist's protocol exactly as sent; the AI
 * fertilizer advisor gives a second opinion against it and never overrides it.
 *
 * Source: operator's document "cucumber_1021 protokol" (Sept 2026) + the updated
 * daily program table of 2026-09-28. Values are transcribed as given; anything
 * SenseHub adds for its own calculations is marked `senseHub*` / `*_note`.
 *
 * Pure data + pure helpers (no DB).
 */

const PROTOCOL_NAME = 'Human agronomist protocol (2026-09-28)';
const PROTOCOL_KEY = 'cucumber_1021_2026_09_28';

// Ingredient analyses used by the protocol recipes. `library` = the name in
// fertigation_ingredients (the live analysis wins when that row exists, so a
// corrected label updates both the delivered and the protocol side); the
// composition here is the fallback (fresh installs / tests). % w/w per element;
// NH4_N = ammonium share of N where the label declares it.
const INGREDIENTS = {
  ca_nitrate: { label: 'Calcium nitrate', library: 'Calcium Nitrate', composition: { N: 15.5, Ca: 19, NH4_N: 1.1 } },
  mgso4: { label: 'Magnesium sulphate (MgSO4·7H2O)', library: 'Magnesium Sulphate (Epsom, MgSO4·7H2O)', composition: { Mg: 9.8, S: 13 } },
  k2so4: { label: 'Potassium sulphate (K2SO4)', library: 'Potassium Sulphate', composition: { K: 41.5, S: 18 } },
  mkp: { label: 'Monopotassium phosphate (MKP)', library: 'MKP', composition: { P: 22.7, K: 28.2 } },
  kno3: { label: 'Potassium nitrate (KNO3)', library: 'Potassium Nitrate (13-0-46)', composition: { N: 13, K: 38.2 } },
  fe_eddha: { label: 'Fe-EDDHA 6 %', library: 'Iron EDDHA 6%', composition: { Fe: 6 } },
  fetrilon: {
    label: 'Fetrilon Combi 2', library: 'Fetrilon Combi 2 (Compo Expert)',
    composition: { Fe: 4, Mn: 3, Zn: 4, B: 1.5, Cu: 0.6, Mo: 0.05, N: 3.5, NH4_N: 3.5 },
    note: 'analysis to be confirmed against the bag in hand',
  },
};

const item = (key, kg) => ({ ingredient: key, kg });

// Stock recipes per 1000 L of stock water, per tank letter.
const RECIPES = {
  vegetative: {
    per_liters: 1000,
    tanks: {
      A: [item('ca_nitrate', 100)],
      B: [item('mgso4', 40), item('k2so4', 10), item('mkp', 20)],
      C: [item('kno3', 58)],
      D: [item('fe_eddha', 2), item('fetrilon', 3)],
    },
  },
  fruiting: {
    per_liters: 1000,
    tanks: {
      A: [item('ca_nitrate', 90)],
      B: [item('mgso4', 40), item('k2so4', 15), item('mkp', 18)],
      C: [item('kno3', 68)],
      D: [item('fe_eddha', 2), item('fetrilon', 3)],
    },
  },
};

// Which recipe the protocol feeds in each stage (fruit set keeps the vegetative recipe
// until the switch to the fruiting recipe between day 30 and 40).
const STAGE_RECIPE = { vegetative: 'vegetative', flowering: 'vegetative', fruiting: 'fruiting' };

const DAILY_PROGRAM_2026_09_28 = {
  stage: 'vegetative',
  runs: [
    { time: '07:30', minutes: 3 },
    { time: '09:30', minutes: 4 },
    { time: '10:30', minutes: 3.5, new_in_table: true },
    { time: '11:30', minutes: 4.5 },
    { time: '12:30', minutes: 4 },
    { time: '13:45', minutes: 4 },
    { time: '15:30', minutes: 3 },
    { time: '17:00', minutes: 2 },
  ],
  minutes_per_section: 28,
  ml_per_plant_day: 930,
  note: 'Each section runs in turn; 1 min = 33 mL/plant (2 L/h dripper). From day 25 durations are increased by drain.',
};

// Per-stage targets as the protocol states them (null = the protocol gives no number).
const STAGE_TARGETS = {
  vegetative: {
    input_ec: { target: 1.7 },
    input_ph: { min: 5.5, max: 5.8 },
    drain_pct: { min: 20, target: 25, max: 30 },
    drain_ec_delta_max: 0.6,
    drain_ph_alarm: { min: 5.0, max: 6.8 },
    ml_per_plant_day: { target: 930 },
  },
  flowering: {
    input_ec: { target: 1.7 },
    input_ph: { min: 5.5, max: 5.8 },
    drain_pct: { min: 20, target: 25, max: 30 },
    drain_ec_delta_max: 0.6,
    drain_ph_alarm: { min: 5.0, max: 6.8 },
    ml_per_plant_day: { min: 930, note: 'durations increased by drain' },
  },
  fruiting: {
    input_ec: { min: 2.0, max: 2.2 },
    input_ph: { min: 5.5, max: 5.8 },
    drain_pct: { min: 20, target: 25, max: 30 },
    drain_ec_delta_max: 0.6,
    drain_ph_alarm: { min: 5.0, max: 6.8 },
    ml_per_plant_day: { min: 2000, max: 3000 },
  },
};

const CLIMATE = {
  day_c: { min: 25, max: 28 }, day_alarm_above_c: 30,
  night_c: { min: 18, max: 20 }, night_alarm_below_c: 16,
  rh_pct: { min: 65, max: 80 }, rh_alarm_below_pct: 55, rh_alarm_above_pct: 90,
};

const TIMELINE = [
  { from_day: 18, to_day: 25, text: 'Vegetative: clip, clean nodes 1-5.' },
  { from_day: 25, to_day: 32, text: 'First fruits setting: irrigation durations increased by drain.' },
  { from_day: 30, to_day: 40, text: 'Switch to the FRUITING recipe (EC 2.0-2.2); first harvest.' },
  { from_day: 40, to_day: null, text: 'Fruiting: 2-3 L/plant/day.' },
];

// SenseHub stage timeline prefill (days after transplant, editable in the profile).
// The protocol starts its timeline at day 18; establishment before that is fed the
// vegetative recipe, so vegetative starts at day 0.
const STAGE_TIMELINE = [
  { stage: 'vegetative', from_day: 0, note: 'Protocol: day 18-25 clip, clean nodes 1-5 (vegetative recipe from transplant).' },
  { stage: 'flowering', from_day: 25, note: 'Protocol: day 25-32 first fruits setting; durations increased by drain.' },
  { stage: 'fruiting', from_day: 30, note: 'Protocol: switch to the fruiting recipe between day 30 and 40 (EC 2.0-2.2).' },
];

const PROTOCOL = {
  key: PROTOCOL_KEY,
  name: PROTOCOL_NAME,
  source: "Operator's document 'cucumber_1021 protokol' (Sept 2026) + updated daily program table of 2026-09-28",
  source_date: '2026-09-28',
  author: 'human agronomist',
  crop: 'Cucumber',
  variety: 'S13-06 F1',
  breeder: 'Sakata',
  data: {
    planting: {
      plants_per_ha: 35000,
      plants_per_m2: 3.5,
      substrate: 'Cocopeat',
      sections: 4,
      sections_run: 'in turn',
      dripper_flow_lph: 2,
      drippers_per_plant: 1,
      ml_per_plant_per_min: 33,
    },
    stage_targets: STAGE_TARGETS,
    stage_recipe: STAGE_RECIPE,
    recipes: RECIPES,
    ingredients: INGREDIENTS,
    daily_program: DAILY_PROGRAM_2026_09_28,
    climate: CLIMATE,
    timeline: TIMELINE,
    stage_timeline: STAGE_TIMELINE,
    // Not in the protocol: SenseHub assumption used only to turn the per-1000 L stock
    // recipes into a feed ppm prefill for the element targets.
    senseHub_design_dilution: 150,
    senseHub_design_dilution_note: 'SenseHub prefill assumption: protocol stock recipes diluted 1:150 per tank (≈ EC 1.7 design). The protocol itself gives recipes per 1000 L.',
  },
};

// ─── Protocol revision 2026-09-30 (operator request 2026-09-30) ─────────────
// The agronomist feeds the fruit-set recipe (same stock recipe as `fruiting`) from
// fruit set on, i.e. in the flowering stage, and the new sheet states the resulting
// feed solution "at 1:100". That dilution is STATED BY THE PROTOCOL (provenance:
// human protocol), unlike the 1:150 SenseHub assumption of the 2026-09-28 version,
// which still applies to recipes without a stated dilution. 2026-09-28 is kept
// intact (history / traceability of advice given against it).

const PROTOCOL_NAME_2026_09_30 = 'Human agronomist protocol (2026-09-30)';
const PROTOCOL_KEY_2026_09_30 = 'cucumber_1021_2026_09_30';

const RECIPES_2026_09_30 = {
  vegetative: RECIPES.vegetative,
  fruit_set: {
    per_liters: 1000,
    tanks: {
      A: [item('ca_nitrate', 90)],
      B: [item('mgso4', 40), item('k2so4', 15), item('mkp', 18)],
      C: [item('kno3', 68)],
      D: [item('fe_eddha', 2), item('fetrilon', 3)],
    },
    // Stated by the protocol sheet ("Resulting solution (at 1:100)"): not a SenseHub assumption.
    stated_dilution: 100,
    stated_dilution_note: "Protocol sheet 2026-09-30: 'Resulting solution (at 1:100)'",
    notes: 'Tank A alone; Tank D: pre-dissolve Fe-EDDHA and Fetrilon in a bucket; acid tank by pH setpoint.',
  },
  fruiting: RECIPES.fruiting,
};

const STAGE_RECIPE_2026_09_30 = { vegetative: 'vegetative', flowering: 'fruit_set', fruiting: 'fruiting' };

const DAILY_PROGRAM_2026_10_01 = {
  stage: 'flowering',
  effective_from: '2026-10-01',
  sections_order: [1, 2, 3, 4],
  runs: [
    { time: '07:30', minutes: 3, ml_per_plant: 100 },
    { time: '08:45', minutes: 3, ml_per_plant: 100, new_in_table: true },
    { time: '09:45', minutes: 3, ml_per_plant: 100 },
    { time: '10:30', minutes: 3.5, ml_per_plant: 117 },
    { time: '11:15', minutes: 3.5, ml_per_plant: 117, new_in_table: true },
    { time: '12:00', minutes: 3.5, ml_per_plant: 117, new_in_table: true },
    { time: '12:45', minutes: 3.5, ml_per_plant: 117 },
    { time: '13:30', minutes: 3.5, ml_per_plant: 117 },
    { time: '14:15', minutes: 3, ml_per_plant: 100, new_in_table: true },
    { time: '15:15', minutes: 3, ml_per_plant: 100 },
    { time: '17:00', minutes: 2, ml_per_plant: 67, last: true },
  ],
  minutes_per_section: 34.5,
  ml_per_plant_day: 1150,
  note: "Each run waters the 4 sections back-to-back ('Parti 1-4', order 1 -> 4). 1 min = 33 mL/plant (2 L/h dripper). Program from 2026-10-01.",
};

const PROTOCOL_2026_09_30 = {
  key: PROTOCOL_KEY_2026_09_30,
  name: PROTOCOL_NAME_2026_09_30,
  source: "Revision of 'cucumber_1021 protokol': fruit-set recipe sheet ('Resulting solution (at 1:100)') + daily program table from 2026-10-01 (operator request 2026-09-30)",
  source_date: '2026-09-30',
  author: 'human agronomist',
  crop: 'Cucumber',
  variety: 'S13-06 F1',
  breeder: 'Sakata',
  data: {
    ...PROTOCOL.data,
    stage_recipe: STAGE_RECIPE_2026_09_30,
    recipes: RECIPES_2026_09_30,
    daily_program: DAILY_PROGRAM_2026_10_01,
    previous_version: PROTOCOL_KEY,
    changes: [
      'Flowering (fruit set) is fed the fruit-set recipe (was: the vegetative recipe).',
      'Fruit-set recipe dilution 1:100 is stated by the protocol sheet.',
      'Daily program from 2026-10-01: 11 runs, 34.5 min per section, ~1,150 mL/plant/day.',
    ],
  },
};

/** Every protocol version SenseHub knows, oldest first (a changed protocol is a NEW row). */
const PROTOCOLS = [PROTOCOL, PROTOCOL_2026_09_30];

/**
 * Dilution used to turn a recipe into feed ppm: the protocol's own stated dilution for
 * that recipe when it gives one (provenance 'protocol'), otherwise the SenseHub design
 * assumption (senseHub_design_dilution, default 1:150; provenance 'sensehub_assumption').
 * @returns {{ dilution: number, source: 'protocol'|'sensehub_assumption', note: string|null }}
 */
function recipeDilution(protocolData, recipeKey) {
  const data = protocolData || PROTOCOL.data;
  const recipe = data.recipes && data.recipes[recipeKey];
  const stated = recipe ? Number(recipe.stated_dilution) : NaN;
  if (Number.isFinite(stated) && stated > 0) {
    return { dilution: stated, source: 'protocol', note: recipe.stated_dilution_note || null };
  }
  return { dilution: Number(data.senseHub_design_dilution) || 150, source: 'sensehub_assumption', note: data.senseHub_design_dilution_note || null };
}

/**
 * Resolve a protocol recipe into calculator tanks: [{ letter, water_base_liters, items }]
 * where items have the fertigationMath item shape. `library(name)` returns the live
 * ingredient row (composition, form, density) or null → built-in fallback analysis.
 */
function recipeTanks(protocolData, recipeKey, library = () => null) {
  const data = protocolData || PROTOCOL.data;
  const recipe = data.recipes && data.recipes[recipeKey];
  if (!recipe) return [];
  const ingredients = data.ingredients || INGREDIENTS;
  return Object.entries(recipe.tanks).map(([letter, lines]) => ({
    letter,
    water_base_liters: recipe.per_liters || 1000,
    items: lines.map(l => {
      const def = ingredients[l.ingredient] || { label: l.ingredient, composition: {} };
      const live = def.library ? library(def.library) : null;
      let comp = def.composition || {};
      if (live && live.composition) {
        let liveComp = live.composition;
        if (typeof liveComp === 'string') { try { liveComp = JSON.parse(liveComp); } catch (_) { liveComp = null; } }
        // live analysis wins; keep the protocol's declared NH4 share when the library has none
        if (liveComp && Object.keys(liveComp).length) comp = { ...(def.composition.NH4_N != null && liveComp.NH4_N == null ? { NH4_N: def.composition.NH4_N } : {}), ...liveComp };
      }
      return {
        key: l.ingredient,
        name: def.library || def.label,
        label: def.label,
        amount: l.kg,
        unit: 'kg',
        form: 'solid',
        density_kg_per_l: 1,
        composition: comp,
        analysis_source: live && live.composition ? 'library' : 'protocol_default',
      };
    }),
  }));
}

module.exports = {
  PROTOCOL,
  PROTOCOLS,
  PROTOCOL_2026_09_30,
  PROTOCOL_NAME_2026_09_30,
  PROTOCOL_KEY_2026_09_30,
  STAGE_RECIPE_2026_09_30,
  DAILY_PROGRAM_2026_10_01,
  recipeDilution,
  PROTOCOL_NAME,
  PROTOCOL_KEY,
  INGREDIENTS,
  RECIPES,
  STAGE_RECIPE,
  STAGE_TARGETS,
  STAGE_TIMELINE,
  DAILY_PROGRAM_2026_09_28,
  CLIMATE,
  TIMELINE,
  recipeTanks,
};
