/**
 * Farm fixture for the crop profile / feed calculator / fertilizer advisor tests:
 * the real tank recipes as mixed on 2026-09-25 (A 100; B MgSO4 51 + MKP 20 + K2SO4 15;
 * C KNO3 38; D Fe-EDDHA 4 + Fetrilon Combi 2 2 kg / 1000 L), dosing ratio 1:200,
 * the cucumber crop transplanted 2026-09-07 in zone 1, Asia/Dubai. In-memory DB only.
 */

const NOW = Date.parse('2026-09-28T12:00:00Z'); // 16:00 in Dubai, day 21 after transplant

const INGREDIENTS = [
  ['Calcium Nitrate', { N: 15.5, Ca: 19 }, null],
  ['Magnesium Sulphate (Epsom, MgSO4·7H2O)', { Mg: 9.8, S: 13 }, null],
  ['MKP', { P: 22.7, K: 28.2 }, null],
  ['Potassium Sulphate', { K: 41.5, S: 18 }, null],
  ['Potassium Nitrate (13-0-46)', { N: 13, K: 38.2 }, null],
  ['Iron EDDHA 6%', { Fe: 6 }, null],
  ['Fetrilon Combi 2 (Compo Expert)', { Fe: 4, Mn: 3, Zn: 4, B: 1.5, Cu: 0.6, Mo: 0.05, N: 3.5 }, 'Manufacturer declaration — verify against the bag in hand.'],
  ['pH Down', {}, 'Typically phosphoric or nitric acid'],
];

const TANKS = [
  { id: 1, name: 'Tank A — Calcium nitrate', role: 'nutrient', channel: 2, items: [['Calcium Nitrate', 100]] },
  { id: 2, name: 'Tank B — Mg + MKP + K2SO4', role: 'nutrient', channel: 3, items: [['Magnesium Sulphate (Epsom, MgSO4·7H2O)', 51], ['MKP', 20], ['Potassium Sulphate', 15]] },
  { id: 3, name: 'Tank C — Potassium nitrate', role: 'nutrient', channel: 4, items: [['Potassium Nitrate (13-0-46)', 38]] },
  { id: 4, name: 'Tank D — Fe EDDHA + Fetrilon Combi 2', role: 'nutrient', channel: 5, items: [['Iron EDDHA 6%', 4], ['Fetrilon Combi 2 (Compo Expert)', 2]] },
  { id: 5, name: 'Tank 5 — pH Down', role: 'ph_down', channel: 1, items: [['pH Down', 10, 'L']] },
];

const IRR_EQ = 101;
const DOSE_EQ = 102;

function setSetting(db, key, value) {
  db.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

function seedFarm(db, { seedProfile = true } = {}) {
  db.exec(`
    DELETE FROM fertigation_dose_program_tanks; DELETE FROM relay_channel_config; DELETE FROM fertigation_tank_refills;
    DELETE FROM fertigation_tanks; DELETE FROM fertigation_mixture_items; DELETE FROM fertigation_mixtures;
  `);
  setSetting(db, 'timezone', { timezone: 'Asia/Dubai' });
  const upIng = db.prepare(`INSERT INTO fertigation_ingredients (name, form, density_kg_per_l, composition, notes) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET composition = excluded.composition, notes = excluded.notes`);
  for (const [name, comp, notes] of INGREDIENTS) upIng.run(name, name === 'pH Down' ? 'liquid' : 'solid', JSON.stringify(comp), notes);
  db.prepare("INSERT OR IGNORE INTO zones (id, name, is_crop_zone) VALUES (1, 'Green House 1', 1)").run();
  db.prepare('UPDATE zones SET is_crop_zone = 1 WHERE id = 1').run();
  const coils = (names) => JSON.stringify(names.map((n, i) => ({ name: n, register: String(i + 1), type: 'coil' })));
  db.prepare("INSERT OR REPLACE INTO equipment (id, name, type, protocol, register_mappings) VALUES (?, 'Waveshare Irrigation 1', 'relay', 'modbus', ?)")
    .run(IRR_EQ, coils(['Irrigation Pump', 'Mixing Pump', 'Irrigation Zone 1', 'Irrigation Zone 2', 'Irrigation Zone 3', 'Irrigation Zone 4']));
  db.prepare("INSERT OR REPLACE INTO equipment (id, name, type, protocol, register_mappings) VALUES (?, 'Waveshare Irrigation 2', 'relay', 'modbus', ?)")
    .run(DOSE_EQ, coils(['pH Down (Tank 5)', 'Tank A — Calcium nitrate', 'Tank B — Mg + MKP + K2SO4', 'Tank C — Potassium nitrate', 'Tank D — Fe EDDHA + Fetrilon', 'Relay 6']));
  const ing = (name) => db.prepare('SELECT id FROM fertigation_ingredients WHERE name = ?').get(name).id;
  for (const t of TANKS) {
    const mix = Number(db.prepare('INSERT INTO fertigation_mixtures (name) VALUES (?)').run(`${t.name} recipe`).lastInsertRowid);
    for (const [n, amount, unit] of t.items) db.prepare('INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit) VALUES (?, ?, 1, ?, ?)').run(mix, ing(n), amount, unit || 'kg');
    db.prepare(`INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role, capacity_liters, water_base_liters, current_stock_liters, mixture_id, active)
      VALUES (?, ?, ?, ?, ?, 1000, 1000, 800, ?, 1)`).run(t.id, t.name, DOSE_EQ, t.channel, t.role, mix);
    db.prepare('INSERT INTO relay_channel_config (equipment_id, channel, mixture_id, flow_rate, tank_id) VALUES (?, ?, ?, ?, ?)').run(DOSE_EQ, t.channel, mix, t.role === 'ph_down' ? 0.99 : 1.1, t.id);
  }
  for (const ch of [3, 4, 5, 6]) db.prepare("INSERT INTO relay_channel_config (equipment_id, channel, ingredient_name, flow_rate) VALUES (?, ?, 'Water', 146.99)").run(IRR_EQ, ch);
  setSetting(db, 'dose_controller', {
    enabled: true,
    nutrients: { mode: 'per_zone_target', ratio: { 1: 200, 2: 200, 3: 200, 4: 200 }, irrigation_equipment_id: IRR_EQ, zone_channels: [3, 4, 5, 6], pump_channel: 1 },
    ph: { setpoint: 5.65, floor_ph: 5.3, max_acid_s_per_cycle: 60, max_acid_s_per_day: 420, acid_lpm_estimate: 1.7 },
  });
  const crop = Number(db.prepare(`INSERT INTO crop_assignments (block_id, zone_id, crop_name, scientific_name, planted_date, current_stage, soil_type, active, created_at, updated_at)
    VALUES ('blk-1', 1, 'Cucumber', 'Cucumis sativus', '2026-09-07T04:00:00Z', 'vegetative', 'Coco Coir', 1, '2026-09-24T16:12:19Z', '2026-09-24T16:12:19Z')`).run().lastInsertRowid);
  let seed = null;
  if (seedProfile) seed = require('../../src/utils/cropNutritionSchema').seedCropNutrition(db, { log: { log() {} } });
  return { cropId: crop, seed };
}

/** An irrigation run (irrigation_runs row) with per-tank litres. */
function addRun(db, { key, startedAt, localDate, water, tanks, ec = 1.95, ph = 6.1, acid = 30, type = 'automated', status = 'ok' }) {
  const detail = {
    tanks: Object.entries(tanks).map(([id, l]) => ({ tank_id: Number(id), dosed_l: l })),
    ec_ms: { avg: ec, samples: 40 }, ph: { avg: ph, samples: 40 }, acid_s: acid,
    achieved_ratio: Math.round(water / (Object.values(tanks).reduce((a, b) => a + b, 0) / Object.keys(tanks).length || 1)),
    avg_flow_lph: 8800,
    zone_visits: [3, 4, 5, 6].map((ch, i) => ({
      channel: ch, name: `Irrigation Zone ${i + 1}`, water_l: water / 4,
      pumped_from: new Date(Date.parse(startedAt) + i * 190000).toISOString(),
      pumped_to: new Date(Date.parse(startedAt) + i * 190000 + (water / 4) / 8800 * 3600000).toISOString(),
    })),
  };
  db.prepare(`INSERT INTO irrigation_runs (run_key, type, status, started_at, local_date, water_l, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(key, type, status, startedAt, localDate, water, JSON.stringify(detail));
}

/** A daily soft-switch irrigation automation: zones 3-6 in turn, `min` minutes each. */
function addSchedule(db, { time, min, programId = null }) {
  const actions = [];
  let t = 0;
  for (const ch of [3, 4, 5, 6]) {
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: ch, delay_seconds: t, duration_seconds: min * 60 + 8 });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, delay_seconds: t + 3, duration_seconds: min * 60 });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, delay_seconds: t + 3, duration_seconds: min * 60 });
    t += min * 60 + 9;
  }
  return Number(db.prepare("INSERT INTO automations (name, enabled, trigger_config, actions, dose_program_id) VALUES (?, 1, ?, ?, ?)")
    .run(`Fertigation ${time}`, JSON.stringify({ type: 'schedule', schedule_type: 'daily', time }), JSON.stringify(actions), programId).lastInsertRowid);
}

module.exports = { NOW, seedFarm, addRun, addSchedule, setSetting, TANKS, IRR_EQ, DOSE_EQ };
