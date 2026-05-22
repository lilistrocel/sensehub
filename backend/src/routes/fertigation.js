const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { fertigationDoseScheduler } = require('../services/FertigationDoseScheduler');

const router = express.Router();

// ─── Ingredients ───

// GET /api/fertigation/ingredients - List all ingredients
router.get('/ingredients', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM fertigation_ingredients ORDER BY name').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/ingredients - Create ingredient
// Accepts optional composition fields so the AI agronomist can predict delivered ppm.
router.post('/ingredients', requireRole('admin', 'operator'), (req, res) => {
  const { name, form, density_kg_per_l, compatibility_group, composition, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = db.prepare(`
      INSERT INTO fertigation_ingredients (name, form, density_kg_per_l, compatibility_group, composition, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      form || 'solid',
      density_kg_per_l ?? 1,
      compatibility_group || null,
      composition ? JSON.stringify(composition) : null,
      notes || null,
    );
    res.json(db.prepare('SELECT * FROM fertigation_ingredients WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ingredient already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/ingredients/:id - Edit ingredient (composition, form, group, notes)
router.put('/ingredients/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, form, density_kg_per_l, compatibility_group, composition, notes } = req.body;
  try {
    const cur = db.prepare('SELECT * FROM fertigation_ingredients WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Ingredient not found' });
    db.prepare(`
      UPDATE fertigation_ingredients
      SET name = ?, form = ?, density_kg_per_l = ?, compatibility_group = ?, composition = ?, notes = ?
      WHERE id = ?
    `).run(
      name?.trim() || cur.name,
      form || cur.form,
      density_kg_per_l ?? cur.density_kg_per_l,
      compatibility_group !== undefined ? compatibility_group : cur.compatibility_group,
      composition !== undefined ? (composition ? JSON.stringify(composition) : null) : cur.composition,
      notes !== undefined ? notes : cur.notes,
      req.params.id,
    );
    res.json(db.prepare('SELECT * FROM fertigation_ingredients WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Name already in use' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/ingredients/:id - Remove ingredient
router.delete('/ingredients/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    // Check if used in any mixture
    const used = db.prepare('SELECT COUNT(*) as count FROM fertigation_mixture_items WHERE ingredient_id = ?').get(req.params.id).count;
    if (used > 0) return res.status(409).json({ error: 'Ingredient is used in mixtures. Remove it from mixtures first.' });
    const r = db.prepare('DELETE FROM fertigation_ingredients WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Ingredient not found' });
    res.json({ message: 'Ingredient deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mixtures ───

// GET /api/fertigation/mixtures - List all mixtures with their items
router.get('/mixtures', (req, res) => {
  try {
    const mixtures = db.prepare('SELECT * FROM fertigation_mixtures ORDER BY name').all();
    const items = db.prepare(`
      SELECT mi.*, fi.name as ingredient_name
      FROM fertigation_mixture_items mi
      JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
      ORDER BY mi.mixture_id, fi.name
    `).all();

    // Attach items to their mixtures
    const itemsByMixture = {};
    items.forEach(item => {
      if (!itemsByMixture[item.mixture_id]) itemsByMixture[item.mixture_id] = [];
      itemsByMixture[item.mixture_id].push(item);
    });
    mixtures.forEach(m => { m.items = itemsByMixture[m.id] || []; });

    res.json(mixtures);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/mixtures - Create a mixture
router.post('/mixtures', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, items } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'at least one ingredient item is required' });

  try {
    const result = db.prepare("INSERT INTO fertigation_mixtures (name, description) VALUES (?, ?)").run(name.trim(), description || null);
    const mixtureId = result.lastInsertRowid;

    const insertItem = db.prepare('INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit) VALUES (?, ?, ?, ?, ?)');
    for (const item of items) {
      const parts = item.parts && item.parts > 0 ? item.parts : 1;
      const amount = (item.amount != null && item.amount !== '' && Number.isFinite(parseFloat(item.amount))) ? parseFloat(item.amount) : null;
      if (!item.ingredient_id || (parts <= 0 && amount == null)) continue;
      insertItem.run(mixtureId, item.ingredient_id, parts, amount, item.unit || 'kg');
    }

    // Return full mixture
    const mixture = db.prepare('SELECT * FROM fertigation_mixtures WHERE id = ?').get(mixtureId);
    mixture.items = db.prepare(`
      SELECT mi.*, fi.name as ingredient_name
      FROM fertigation_mixture_items mi
      JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
      WHERE mi.mixture_id = ?
    `).all(mixtureId);

    res.json(mixture);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/mixtures/:id - Update a mixture (full replace of items)
router.put('/mixtures/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, items } = req.body;
  const mixtureId = parseInt(req.params.id);

  const existing = db.prepare('SELECT * FROM fertigation_mixtures WHERE id = ?').get(mixtureId);
  if (!existing) return res.status(404).json({ error: 'Mixture not found' });

  try {
    if (name) db.prepare("UPDATE fertigation_mixtures SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(name.trim(), description ?? existing.description, mixtureId);

    if (items && Array.isArray(items)) {
      // Replace all items
      db.prepare('DELETE FROM fertigation_mixture_items WHERE mixture_id = ?').run(mixtureId);
      const insertItem = db.prepare('INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit) VALUES (?, ?, ?, ?, ?)');
      for (const item of items) {
        const parts = item.parts && item.parts > 0 ? item.parts : 1;
        const amount = (item.amount != null && item.amount !== '' && Number.isFinite(parseFloat(item.amount))) ? parseFloat(item.amount) : null;
        if (!item.ingredient_id || (parts <= 0 && amount == null)) continue;
        insertItem.run(mixtureId, item.ingredient_id, parts, amount, item.unit || 'kg');
      }
    }

    // Return full mixture
    const mixture = db.prepare('SELECT * FROM fertigation_mixtures WHERE id = ?').get(mixtureId);
    mixture.items = db.prepare(`
      SELECT mi.*, fi.name as ingredient_name
      FROM fertigation_mixture_items mi
      JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
      WHERE mi.mixture_id = ?
    `).all(mixtureId);

    res.json(mixture);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/mixtures/:id - Delete a mixture
router.delete('/mixtures/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    // Null out any channel configs referencing this mixture
    db.prepare('UPDATE relay_channel_config SET mixture_id = NULL WHERE mixture_id = ?').run(req.params.id);
    const r = db.prepare('DELETE FROM fertigation_mixtures WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Mixture not found' });
    res.json({ message: 'Mixture deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Channel Config ───

// GET /api/fertigation/channels - List all channel configs with equipment name + mixture/tank info
router.get('/channels', (req, res) => {
  try {
    const channels = db.prepare(`
      SELECT rc.*,
             e.name as equipment_name,
             fm.name as mixture_name,
             ft.name as tank_name,
             ft.role as tank_role
      FROM relay_channel_config rc
      JOIN equipment e ON rc.equipment_id = e.id
      LEFT JOIN fertigation_mixtures fm ON rc.mixture_id = fm.id
      LEFT JOIN fertigation_tanks ft ON rc.tank_id = ft.id
      ORDER BY e.name, rc.channel
    `).all();
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/channels/:equipmentId/:channel - Upsert channel config.
// Accepts one of tank_id (preferred), mixture_id, or ingredient_name. When tank_id is
// supplied the tank's mixture_id is copied over so existing consumption queries that rely
// on mixture_id keep working, and the tank's equipment_id/channel are kept in sync.
router.put('/channels/:equipmentId/:channel', requireRole('admin', 'operator'), (req, res) => {
  const { equipmentId, channel } = req.params;
  const { tank_id, ingredient_name, mixture_id, flow_rate, flow_unit } = req.body;

  if (flow_rate == null) return res.status(400).json({ error: 'flow_rate is required' });
  if (!tank_id && !ingredient_name && !mixture_id) {
    return res.status(400).json({ error: 'Provide tank_id, mixture_id, or ingredient_name' });
  }

  const flowRateNum = parseFloat(flow_rate);
  if (isNaN(flowRateNum) || flowRateNum <= 0) return res.status(400).json({ error: 'flow_rate must be a positive number' });

  const equipment = db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  // Resolve tank binding: pull tank's mixture_id so legacy consumption queries still work.
  let resolvedTankId = tank_id ? parseInt(tank_id) : null;
  let resolvedMixtureId = mixture_id ? parseInt(mixture_id) : null;
  let resolvedIngredient = mixture_id || tank_id ? null : (ingredient_name || null);
  let tankRecord = null;
  if (resolvedTankId) {
    tankRecord = db.prepare('SELECT id, mixture_id FROM fertigation_tanks WHERE id = ?').get(resolvedTankId);
    if (!tankRecord) return res.status(404).json({ error: 'Tank not found' });
    resolvedMixtureId = tankRecord.mixture_id;
  }

  try {
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO relay_channel_config (equipment_id, channel, tank_id, ingredient_name, mixture_id, flow_rate, flow_unit, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(equipment_id, channel)
        DO UPDATE SET tank_id = excluded.tank_id, ingredient_name = excluded.ingredient_name,
                      mixture_id = excluded.mixture_id, flow_rate = excluded.flow_rate,
                      flow_unit = excluded.flow_unit, updated_at = datetime('now')
      `).run(
        parseInt(equipmentId), parseInt(channel),
        resolvedTankId, resolvedIngredient, resolvedMixtureId,
        flowRateNum, flow_unit || 'L/min',
      );

      // Keep the tank's equipment_id/channel mirror in sync when bound.
      if (tankRecord) {
        // Clear any other tank that thought it owned this (equipment, channel) pair.
        db.prepare(`
          UPDATE fertigation_tanks SET equipment_id = NULL, channel = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE equipment_id = ? AND channel = ? AND id != ?
        `).run(parseInt(equipmentId), parseInt(channel), tankRecord.id);
        db.prepare(`
          UPDATE fertigation_tanks SET equipment_id = ?, channel = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(parseInt(equipmentId), parseInt(channel), tankRecord.id);
      }
    });
    tx();

    const config = db.prepare(`
      SELECT rc.*, fm.name as mixture_name, ft.name as tank_name, ft.role as tank_role
      FROM relay_channel_config rc
      LEFT JOIN fertigation_mixtures fm ON rc.mixture_id = fm.id
      LEFT JOIN fertigation_tanks ft ON rc.tank_id = ft.id
      WHERE rc.equipment_id = ? AND rc.channel = ?
    `).get(parseInt(equipmentId), parseInt(channel));

    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/channels/:equipmentId/:channel - Remove channel config
router.delete('/channels/:equipmentId/:channel', requireRole('admin', 'operator'), (req, res) => {
  const { equipmentId, channel } = req.params;
  try {
    const result = db.prepare('DELETE FROM relay_channel_config WHERE equipment_id = ? AND channel = ?')
      .run(parseInt(equipmentId), parseInt(channel));
    if (result.changes === 0) return res.status(404).json({ error: 'Channel config not found' });
    res.json({ message: 'Channel config deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Events ───

// GET /api/fertigation/events - Paginated relay event history
router.get('/events', (req, res) => {
  const { equipment_id, channel, source, limit = 50, offset = 0 } = req.query;

  let where = '1=1';
  const params = [];

  if (equipment_id) { where += ' AND re.equipment_id = ?'; params.push(parseInt(equipment_id)); }
  if (channel != null && channel !== '') { where += ' AND re.channel = ?'; params.push(parseInt(channel)); }
  if (source) { where += ' AND re.source = ?'; params.push(source); }

  try {
    const total = db.prepare(`SELECT COUNT(*) as count FROM relay_events re WHERE ${where}`).get(...params).count;
    const events = db.prepare(`
      SELECT re.*, e.name as equipment_name
      FROM relay_events re
      JOIN equipment e ON re.equipment_id = e.id
      WHERE ${where}
      ORDER BY re.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    res.json({ events, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Consumption ───

// GET /api/fertigation/consumption - Calculate consumption per ingredient
router.get('/consumption', (req, res) => {
  const { from, to, group_by } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query parameters are required (ISO dates)' });
  try {
    res.json(calculateConsumption(from, to, group_by || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/consumption/summary - Today + this week totals
router.get('/consumption/summary', (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset).toISOString();

    res.json({
      today: calculateConsumption(todayStart, todayEnd, null),
      week: calculateConsumption(weekStart, todayEnd, null)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Calculate consumption by walking ON/OFF event pairs.
 * Supports both single-ingredient channels and mixture channels.
 */
function calculateConsumption(from, to, groupBy) {
  const events = db.prepare(`
    SELECT re.equipment_id, re.channel, re.state, re.created_at
    FROM relay_events re
    WHERE re.created_at >= ? AND re.created_at < ?
    ORDER BY re.equipment_id, re.channel, re.created_at
  `).all(from, to);

  // Get channel configs with mixture items
  const configs = db.prepare('SELECT * FROM relay_channel_config').all();
  const configMap = {};
  configs.forEach(c => { configMap[`${c.equipment_id}:${c.channel}`] = c; });

  // Load mixture items for all mixtures referenced
  const mixtureItems = {};
  const allItems = db.prepare(`
    SELECT mi.mixture_id, mi.parts, fi.name as ingredient_name
    FROM fertigation_mixture_items mi
    JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
  `).all();
  allItems.forEach(item => {
    if (!mixtureItems[item.mixture_id]) mixtureItems[item.mixture_id] = [];
    mixtureItems[item.mixture_id].push(item);
  });

  // Walk events to calculate durations per channel
  const durations = {};
  const openTimers = {};

  // Check for ON state before range start
  const channelKeys = new Set(events.map(e => `${e.equipment_id}:${e.channel}`));
  for (const key of channelKeys) {
    const [eqId, ch] = key.split(':').map(Number);
    const priorEvent = db.prepare(`
      SELECT state, created_at FROM relay_events
      WHERE equipment_id = ? AND channel = ? AND created_at < ?
      ORDER BY created_at DESC LIMIT 1
    `).get(eqId, ch, from);
    if (priorEvent && priorEvent.state === 1) openTimers[key] = from;
  }

  for (const event of events) {
    const key = `${event.equipment_id}:${event.channel}`;
    if (!durations[key]) durations[key] = [];
    if (event.state === 1) {
      openTimers[key] = event.created_at;
    } else if (openTimers[key]) {
      const start = new Date(openTimers[key]).getTime();
      const end = new Date(event.created_at).getTime();
      durations[key].push({ start: openTimers[key], end: event.created_at, duration_ms: end - start });
      delete openTimers[key];
    }
  }

  // Close still-open timers at range end
  for (const [key, startTime] of Object.entries(openTimers)) {
    if (!durations[key]) durations[key] = [];
    durations[key].push({ start: startTime, end: to, duration_ms: new Date(to).getTime() - new Date(startTime).getTime() });
  }

  // Calculate volumes — split by mixture proportions or use single ingredient
  const ingredientTotals = {};
  const dailyBreakdown = {};
  const unconfigured = [];

  const addToIngredient = (name, volume, unit, durationMinutes, day) => {
    if (!ingredientTotals[name]) ingredientTotals[name] = { volume: 0, unit, duration_minutes: 0 };
    ingredientTotals[name].volume += volume;
    ingredientTotals[name].duration_minutes += durationMinutes;

    if (groupBy === 'day' && day) {
      if (!dailyBreakdown[day]) dailyBreakdown[day] = {};
      if (!dailyBreakdown[day][name]) dailyBreakdown[day][name] = { volume: 0, unit, duration_minutes: 0 };
      dailyBreakdown[day][name].volume += volume;
      dailyBreakdown[day][name].duration_minutes += durationMinutes;
    }
  };

  for (const [key, intervals] of Object.entries(durations)) {
    const config = configMap[key];
    if (!config) {
      const [eqId, ch] = key.split(':').map(Number);
      if (intervals.length > 0) unconfigured.push({ equipment_id: eqId, channel: ch });
      continue;
    }

    const volumeUnit = config.flow_unit.replace('/min', '').replace('/hr', '');

    for (const interval of intervals) {
      const durationMinutes = interval.duration_ms / 60000;
      const totalVolume = durationMinutes * config.flow_rate;
      const day = groupBy === 'day' ? interval.start.substring(0, 10) : null;

      if (config.mixture_id && mixtureItems[config.mixture_id]) {
        // Mixture mode — split by parts proportions
        const items = mixtureItems[config.mixture_id];
        const totalParts = items.reduce((sum, i) => sum + i.parts, 0);
        for (const item of items) {
          const proportion = item.parts / totalParts;
          addToIngredient(item.ingredient_name, totalVolume * proportion, volumeUnit, durationMinutes * proportion, day);
        }
      } else if (config.ingredient_name) {
        // Single ingredient mode (legacy)
        addToIngredient(config.ingredient_name, totalVolume, volumeUnit, durationMinutes, day);
      }
    }
  }

  const ingredients = Object.entries(ingredientTotals).map(([name, data]) => ({
    name,
    volume: Math.round(data.volume * 1000) / 1000,
    unit: data.unit,
    duration_minutes: Math.round(data.duration_minutes * 100) / 100
  }));

  const result = { ingredients, unconfigured };

  if (groupBy === 'day') {
    result.daily = {};
    for (const [day, ingMap] of Object.entries(dailyBreakdown)) {
      result.daily[day] = Object.entries(ingMap).map(([name, data]) => ({
        name,
        volume: Math.round(data.volume * 1000) / 1000,
        unit: data.unit,
        duration_minutes: Math.round(data.duration_minutes * 100) / 100
      }));
    }
  }

  return result;
}

// ─── Tanks ───
//
// A fertigation tank is a physical stock container (typically 1000 L) wired to a
// fertigation pump channel. The tank holds a finished solution (water + dissolved
// ingredients) recorded via refill events; the pump doses from it into the irrigation
// line. The stock level depletes as the pump runs.

const ELEMENTS = ['N','P','K','Ca','Mg','S','Fe','Cu','Mn','Mo','Zn','B','Cl','Na'];

function loadMixtureItems(mixtureId) {
  if (!mixtureId) return [];
  return db.prepare(`
    SELECT mi.ingredient_id, mi.parts, mi.amount, mi.unit,
           fi.name, fi.form, fi.density_kg_per_l, fi.compatibility_group, fi.composition
    FROM fertigation_mixture_items mi
    JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
    WHERE mi.mixture_id = ?
  `).all(mixtureId);
}

// Compute milligrams of each element delivered by 1 L of finished stock solution.
// For solids: amount_kg * (composition_pct / 100) * 1e6 mg / water_base_liters
// For liquids: amount_L * density_kg_per_l * (composition_g_per_L equivalent / 100) * 1e6 / water_base_liters
// (We treat composition values uniformly as % by weight; for liquids the operator's reported
//  amount in L is converted to kg via density. This is a simplification — refine if a liquid
//  supplier label gives g/L directly.)
function stockElementalMgPerL(items, waterBaseLiters) {
  const out = {};
  if (!waterBaseLiters || waterBaseLiters <= 0) return out;
  for (const it of items) {
    if (!it.amount || it.amount <= 0) continue;
    const massKg = (it.unit === 'L' || it.unit === 'mL')
      ? (it.unit === 'mL' ? it.amount / 1000 : it.amount) * (it.density_kg_per_l || 1)
      : (it.unit === 'g' ? it.amount / 1000 : it.amount); // assume kg if not specified
    let comp = {};
    try { comp = it.composition ? JSON.parse(it.composition) : {}; } catch (_) {}
    for (const [el, pct] of Object.entries(comp)) {
      if (!ELEMENTS.includes(el)) continue;
      const mg = massKg * (pct / 100) * 1e6; // total mg of element in the whole tank
      out[el] = (out[el] || 0) + mg / waterBaseLiters;
    }
  }
  return out;
}

// Round all values in an object to N decimal places.
function round(obj, dp = 2) {
  const f = Math.pow(10, dp);
  const r = {};
  for (const [k, v] of Object.entries(obj)) r[k] = Math.round(v * f) / f;
  return r;
}

function attachTankComputed(tank) {
  const items = loadMixtureItems(tank.mixture_id);
  const stockMgPerL = stockElementalMgPerL(items, tank.water_base_liters);
  return {
    ...tank,
    items,
    stock_mg_per_l: round(stockMgPerL),
  };
}

// GET /api/fertigation/tanks - List all tanks with computed stock composition
router.get('/tanks', (req, res) => {
  try {
    const tanks = db.prepare(`
      SELECT t.*, e.name as equipment_name, m.name as mixture_name
      FROM fertigation_tanks t
      LEFT JOIN equipment e ON t.equipment_id = e.id
      LEFT JOIN fertigation_mixtures m ON t.mixture_id = m.id
      ORDER BY t.id
    `).all();
    res.json(tanks.map(attachTankComputed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/tanks/:id - Tank detail + recent refill history
router.get('/tanks/:id', (req, res) => {
  try {
    const tank = db.prepare(`
      SELECT t.*, e.name as equipment_name, m.name as mixture_name
      FROM fertigation_tanks t
      LEFT JOIN equipment e ON t.equipment_id = e.id
      LEFT JOIN fertigation_mixtures m ON t.mixture_id = m.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Tank not found' });
    const refills = db.prepare(`
      SELECT r.*, u.email as user_email
      FROM fertigation_tank_refills r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.tank_id = ?
      ORDER BY r.refilled_at DESC
      LIMIT 50
    `).all(req.params.id).map(r => ({
      ...r,
      composition_snapshot: r.composition_snapshot ? JSON.parse(r.composition_snapshot) : null,
    }));
    res.json({ ...attachTankComputed(tank), refills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/tanks - Create tank
router.post('/tanks', requireRole('admin', 'operator'), (req, res) => {
  const { name, equipment_id, channel, role, capacity_liters, water_base_liters, current_stock_liters, mixture_id, active, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const r = db.prepare(`
      INSERT INTO fertigation_tanks
        (name, equipment_id, channel, role, capacity_liters, water_base_liters, current_stock_liters, mixture_id, active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      equipment_id ?? null,
      channel ?? null,
      role || 'nutrient',
      capacity_liters ?? 1000,
      water_base_liters ?? (capacity_liters ?? 1000),
      current_stock_liters ?? 0,
      mixture_id ?? null,
      active === 0 ? 0 : 1,
      notes || null,
    );
    res.json(db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A tank is already assigned to that equipment/channel' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/tanks/:id - Update tank
router.put('/tanks/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const cur = db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Tank not found' });
    const f = (k, fallback) => req.body[k] !== undefined ? req.body[k] : fallback;
    db.prepare(`
      UPDATE fertigation_tanks SET
        name = ?, equipment_id = ?, channel = ?, role = ?,
        capacity_liters = ?, water_base_liters = ?, current_stock_liters = ?,
        mixture_id = ?, active = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      f('name', cur.name)?.trim?.() || cur.name,
      f('equipment_id', cur.equipment_id),
      f('channel', cur.channel),
      f('role', cur.role),
      f('capacity_liters', cur.capacity_liters),
      f('water_base_liters', cur.water_base_liters),
      f('current_stock_liters', cur.current_stock_liters),
      f('mixture_id', cur.mixture_id),
      f('active', cur.active),
      f('notes', cur.notes),
      req.params.id,
    );
    res.json(db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A tank is already assigned to that equipment/channel' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/tanks/:id - Remove tank (refills cascade)
router.delete('/tanks/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const r = db.prepare('DELETE FROM fertigation_tanks WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Tank not found' });
    res.json({ message: 'Tank deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/tanks/:id/refill
// Records a refill event and resets the tank's current_stock_liters. The recipe at refill
// time is snapshotted as JSON so historical batches stay accurate even if the recipe later
// changes. Body: { water_liters_added, mixture_id?, notes? }. If mixture_id is omitted the
// tank's currently configured mixture is used.
router.post('/tanks/:id/refill', requireRole('admin', 'operator'), (req, res) => {
  const { water_liters_added, mixture_id, notes, use_pending_mixture } = req.body;
  const liters = parseFloat(water_liters_added);
  if (!Number.isFinite(liters) || liters <= 0) {
    return res.status(400).json({ error: 'water_liters_added must be a positive number' });
  }
  try {
    const tank = db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Tank not found' });
    // Three sources of recipe at refill time, in priority order:
    //   1. caller explicitly passed mixture_id → use that
    //   2. use_pending_mixture=true → adopt the pending recipe (and clear the pointer)
    //   3. otherwise keep the tank's current mixture
    let mixId = mixture_id ?? null;
    let adoptedPending = false;
    if (mixId == null && use_pending_mixture && tank.pending_mixture_id) {
      mixId = tank.pending_mixture_id;
      adoptedPending = true;
    }
    if (mixId == null) mixId = tank.mixture_id;
    const items = loadMixtureItems(mixId);
    const snapshot = {
      mixture_id: mixId,
      water_liters: liters,
      items: items.map(it => ({
        ingredient_id: it.ingredient_id,
        name: it.name,
        amount: it.amount,
        unit: it.unit,
        composition: it.composition ? JSON.parse(it.composition) : null,
      })),
    };
    const newStock = Math.min(tank.capacity_liters || liters, (tank.current_stock_liters || 0) + liters);
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO fertigation_tank_refills
          (tank_id, water_liters_added, total_volume_after, mixture_id, composition_snapshot, user_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        liters,
        newStock,
        mixId,
        JSON.stringify(snapshot),
        req.user?.id || null,
        notes || null,
      );
      db.prepare(`
        UPDATE fertigation_tanks SET
          current_stock_liters = ?,
          water_base_liters = ?,
          mixture_id = COALESCE(?, mixture_id),
          pending_mixture_id = CASE WHEN ? = 1 THEN NULL ELSE pending_mixture_id END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newStock, liters, mixId, adoptedPending ? 1 : 0, req.params.id);
      return result.lastInsertRowid;
    });
    const refillId = tx();
    res.json({
      refill_id: refillId,
      tank: db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/tanks/:id/ppm-preview
//
// Predict element ppm in the irrigation line. The dose ratio is the Venturi pump's
// flow rate divided by the irrigation water pump's flow rate (both in L/min):
//
//   dilution = venturi_flow_lpm / water_flow_lpm   (e.g. 1.7 / 257.5 ≈ 1:151)
//   irrigation_ppm[el] = stock_mg_per_l[el] × dilution
//
// Defaults:
//   - venturi_flow_lpm: pulled from the tank's bound channel config (relay_channel_config.flow_rate)
//   - water_flow_lpm: average flow_rate of relay_channel_config rows whose ingredient_name = 'Water',
//                     or the value supplied via query string. Caller can override either.
// Query overrides: ?venturi_lpm=1.7&water_lpm=257.5
router.get('/tanks/:id/ppm-preview', (req, res) => {
  try {
    const tank = db.prepare('SELECT * FROM fertigation_tanks WHERE id = ?').get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Tank not found' });

    let venturi = parseFloat(req.query.venturi_lpm);
    if (!Number.isFinite(venturi) || venturi <= 0) {
      if (tank.equipment_id && tank.channel) {
        const ch = db.prepare(`
          SELECT flow_rate FROM relay_channel_config
          WHERE equipment_id = ? AND channel = ?
        `).get(tank.equipment_id, tank.channel);
        if (ch && ch.flow_rate > 0) venturi = ch.flow_rate;
      }
    }

    let water = parseFloat(req.query.water_lpm);
    if (!Number.isFinite(water) || water <= 0) {
      const row = db.prepare(`
        SELECT AVG(flow_rate) as avg_flow FROM relay_channel_config
        WHERE ingredient_name = 'Water' AND flow_rate > 0
      `).get();
      if (row && row.avg_flow > 0) water = row.avg_flow;
    }

    const items = loadMixtureItems(tank.mixture_id);
    const stock = stockElementalMgPerL(items, tank.water_base_liters);

    let dilution = null;
    const irrigation = {};
    if (venturi > 0 && water > 0) {
      dilution = venturi / water;
      for (const [el, mgPerL] of Object.entries(stock)) irrigation[el] = mgPerL * dilution;
    }

    res.json({
      tank_id: tank.id,
      water_base_liters: tank.water_base_liters,
      venturi_lpm: Number.isFinite(venturi) ? venturi : null,
      water_lpm: Number.isFinite(water) ? water : null,
      dilution_ratio: dilution,
      stock_mg_per_l: round(stock),
      irrigation_ppm: dilution ? round(irrigation, 3) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dose Programs ───
//
// A dose program is a reusable "during a fertigation cycle, what % of the time should
// each tank's injector valve be open?" recipe. Operator and AI planner both consume
// the same library. Planner picks among status='published' only.

function loadProgramTanks(programId) {
  return db.prepare(`
    SELECT pt.*, t.name as tank_name, t.role as tank_role, t.equipment_id, t.channel,
           t.mixture_id, t.water_base_liters
    FROM fertigation_dose_program_tanks pt
    JOIN fertigation_tanks t ON pt.tank_id = t.id
    WHERE pt.program_id = ?
    ORDER BY pt.priority, pt.tank_id
  `).all(programId);
}

function attachProgramComputed(prog) {
  if (!prog) return prog;
  let target_ppm = null;
  try { target_ppm = prog.target_ppm ? JSON.parse(prog.target_ppm) : null; } catch (_) {}
  return {
    ...prog,
    target_ppm,
    tanks: loadProgramTanks(prog.id),
  };
}

// GET /api/fertigation/dose-programs
router.get('/dose-programs', (req, res) => {
  try {
    const status = req.query.status; // optional filter: 'draft', 'published', 'archived'
    const where = status ? 'WHERE status = ?' : '';
    const args = status ? [status] : [];
    const rows = db.prepare(`SELECT * FROM fertigation_dose_programs ${where} ORDER BY status, name`).all(...args);
    res.json(rows.map(attachProgramComputed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/dose-programs/:id
router.get('/dose-programs/:id', (req, res) => {
  try {
    const prog = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(req.params.id);
    if (!prog) return res.status(404).json({ error: 'Dose program not found' });
    res.json(attachProgramComputed(prog));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function writeProgramTanks(programId, tanks) {
  db.prepare('DELETE FROM fertigation_dose_program_tanks WHERE program_id = ?').run(programId);
  if (!Array.isArray(tanks)) return;
  const ins = db.prepare(`
    INSERT INTO fertigation_dose_program_tanks (program_id, tank_id, duty_pct, priority, compatibility_slot)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const t of tanks) {
    if (!t.tank_id) continue;
    const duty = Math.max(0, Math.min(100, parseFloat(t.duty_pct ?? 0) || 0));
    ins.run(programId, t.tank_id, duty, t.priority ?? 0, t.compatibility_slot ?? null);
  }
}

// POST /api/fertigation/dose-programs
router.post('/dose-programs', requireRole('admin', 'operator'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO fertigation_dose_programs
          (name, description, window_seconds, min_valve_on_seconds, min_valve_off_seconds,
           target_ec, target_ph, target_ppm, compatibility_strategy, status, created_by, origin, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(b.name).trim(),
        b.description || null,
        Math.max(5, parseInt(b.window_seconds) || 60),
        Math.max(1, parseInt(b.min_valve_on_seconds) || 5),
        Math.max(1, parseInt(b.min_valve_off_seconds) || 5),
        b.target_ec ?? null,
        b.target_ph ?? null,
        b.target_ppm ? JSON.stringify(b.target_ppm) : null,
        ['permissive', 'time_slice'].includes(b.compatibility_strategy) ? b.compatibility_strategy : 'permissive',
        ['draft', 'published', 'archived'].includes(b.status) ? b.status : 'draft',
        req.user?.id || null,
        ['manual', 'planner', 'agronomist'].includes(b.origin) ? b.origin : 'manual',
        b.notes || null,
      );
      writeProgramTanks(r.lastInsertRowid, b.tanks);
      return r.lastInsertRowid;
    });
    const id = tx();
    res.json(attachProgramComputed(db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/dose-programs/:id
router.put('/dose-programs/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(req.params.id);
  const cur = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Dose program not found' });
  const b = req.body || {};
  const f = (k, fallback) => b[k] !== undefined ? b[k] : fallback;
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE fertigation_dose_programs SET
          name = ?, description = ?, window_seconds = ?,
          min_valve_on_seconds = ?, min_valve_off_seconds = ?,
          target_ec = ?, target_ph = ?, target_ppm = ?,
          compatibility_strategy = ?, status = ?, notes = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        (f('name', cur.name) || '').trim() || cur.name,
        f('description', cur.description),
        Math.max(5, parseInt(f('window_seconds', cur.window_seconds)) || 60),
        Math.max(1, parseInt(f('min_valve_on_seconds', cur.min_valve_on_seconds)) || 5),
        Math.max(1, parseInt(f('min_valve_off_seconds', cur.min_valve_off_seconds)) || 5),
        f('target_ec', cur.target_ec),
        f('target_ph', cur.target_ph),
        b.target_ppm !== undefined ? (b.target_ppm ? JSON.stringify(b.target_ppm) : null) : cur.target_ppm,
        ['permissive', 'time_slice'].includes(f('compatibility_strategy', cur.compatibility_strategy)) ? f('compatibility_strategy', cur.compatibility_strategy) : cur.compatibility_strategy,
        ['draft', 'published', 'archived'].includes(f('status', cur.status)) ? f('status', cur.status) : cur.status,
        f('notes', cur.notes),
        id,
      );
      if (Array.isArray(b.tanks)) writeProgramTanks(id, b.tanks);
    });
    tx();
    res.json(attachProgramComputed(db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/dose-programs/:id
router.delete('/dose-programs/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const r = db.prepare('DELETE FROM fertigation_dose_programs WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Dose program not found' });
    res.json({ message: 'Dose program deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/dose-programs/:id/publish — convenience: flip status to published
router.post('/dose-programs/:id/publish', requireRole('admin', 'operator'), (req, res) => {
  try {
    const r = db.prepare("UPDATE fertigation_dose_programs SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Dose program not found' });
    res.json(attachProgramComputed(db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/dose-programs/:id/ppm-preview?water_lpm=257.5
//
// Predicted irrigation ppm with this program: for each tank in the program with
// duty>0, compute stock_mg/L × (venturi/water) × (duty/100), sum per element.
// venturi = bound channel's flow_rate; water = avg of "Water" channels.
router.get('/dose-programs/:id/ppm-preview', (req, res) => {
  try {
    const prog = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(req.params.id);
    if (!prog) return res.status(404).json({ error: 'Dose program not found' });

    let waterLpm = parseFloat(req.query.water_lpm);
    if (!Number.isFinite(waterLpm) || waterLpm <= 0) {
      const row = db.prepare(`
        SELECT AVG(flow_rate) as avg_flow FROM relay_channel_config
        WHERE ingredient_name = 'Water' AND flow_rate > 0
      `).get();
      if (row && row.avg_flow > 0) waterLpm = row.avg_flow;
    }

    const tanks = loadProgramTanks(prog.id);
    const totalPpm = {};
    const perTank = [];
    for (const t of tanks) {
      if (!t.duty_pct || !t.mixture_id) {
        perTank.push({ tank_id: t.tank_id, tank_name: t.tank_name, duty_pct: t.duty_pct, irrigation_ppm: null, reason: 'No recipe or duty=0' });
        continue;
      }
      const venturi = t.equipment_id && t.channel ? db.prepare(`
        SELECT flow_rate FROM relay_channel_config WHERE equipment_id = ? AND channel = ?
      `).get(t.equipment_id, t.channel)?.flow_rate : null;
      if (!venturi || !waterLpm) {
        perTank.push({ tank_id: t.tank_id, tank_name: t.tank_name, duty_pct: t.duty_pct, irrigation_ppm: null, reason: 'Unbound channel or no water flow rate' });
        continue;
      }
      const items = loadMixtureItems(t.mixture_id);
      const stock = stockElementalMgPerL(items, t.water_base_liters);
      const dilution = (venturi / waterLpm) * (t.duty_pct / 100);
      const irrPpm = {};
      for (const [el, mgPerL] of Object.entries(stock)) {
        const ppm = mgPerL * dilution;
        irrPpm[el] = ppm;
        totalPpm[el] = (totalPpm[el] || 0) + ppm;
      }
      perTank.push({
        tank_id: t.tank_id,
        tank_name: t.tank_name,
        duty_pct: t.duty_pct,
        venturi_lpm: venturi,
        irrigation_ppm: round(irrPpm, 3),
      });
    }

    res.json({
      program_id: prog.id,
      water_lpm: waterLpm || null,
      window_seconds: prog.window_seconds,
      compatibility_strategy: prog.compatibility_strategy,
      per_tank: perTank,
      total_irrigation_ppm: round(totalPpm, 3),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Element Targets ───
//
// Per-element ppm bounds + priority that the AI planner uses when picking duty
// cycles or proposing mixture changes. Rows with crop_assignment_id=NULL +
// growth_stage=NULL are system-wide defaults. The planner resolves a target for
// crop X / stage Y by trying (X, Y) → (X, NULL) → (NULL, NULL).

const ELEMENT_WHITELIST = [
  // Elemental forms (used by tank-composition / dose-program math)
  'N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Cu', 'Mn', 'Mo', 'Zn', 'B', 'Cl', 'Na',
  // Ionic forms (emitted by AMIC — labels match lab_readings.nutrient values)
  'nitrate_NO3', 'ammonium_NH4', 'potassium_K', 'calcium_Ca', 'magnesium_Mg',
  'sulfate_SO4', 'phosphate_PO4', 'chloride_Cl', 'sodium_Na',
];

// GET /api/fertigation/element-targets?crop_assignment_id=...
router.get('/element-targets', (req, res) => {
  try {
    const cropId = req.query.crop_assignment_id;
    const where = [];
    const args = [];
    if (cropId === 'null' || cropId === '') {
      where.push('crop_assignment_id IS NULL');
    } else if (cropId) {
      where.push('crop_assignment_id = ?'); args.push(parseInt(cropId));
    }
    const sql = `SELECT * FROM crop_element_targets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY crop_assignment_id, growth_stage, element`;
    res.json(db.prepare(sql).all(...args));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/element-targets — upsert (idempotent by (crop, stage, element))
router.post('/element-targets', requireRole('admin', 'operator'), (req, res) => {
  const b = req.body || {};
  if (!b.element || !ELEMENT_WHITELIST.includes(b.element)) return res.status(400).json({ error: 'element must be one of ' + ELEMENT_WHITELIST.join(', ') });
  const priority = Math.max(1, Math.min(5, parseInt(b.priority) || 3));
  try {
    db.prepare(`
      INSERT INTO crop_element_targets
        (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(crop_assignment_id, growth_stage, element)
      DO UPDATE SET
        hard_min = excluded.hard_min,
        soft_target = excluded.soft_target,
        hard_max = excluded.hard_max,
        priority = excluded.priority,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      b.crop_assignment_id ?? null,
      b.growth_stage ?? null,
      b.element,
      b.hard_min ?? null,
      b.soft_target ?? null,
      b.hard_max ?? null,
      priority,
      b.notes ?? null,
    );
    const row = db.prepare(`
      SELECT * FROM crop_element_targets
      WHERE COALESCE(crop_assignment_id,-1) = COALESCE(?,-1)
        AND COALESCE(growth_stage,'') = COALESCE(?,'')
        AND element = ?
    `).get(b.crop_assignment_id ?? null, b.growth_stage ?? null, b.element);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fertigation/element-targets/:id
router.delete('/element-targets/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const r = db.prepare('DELETE FROM crop_element_targets WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Target not found' });
    res.json({ message: 'Target deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/tanks/:id/apply-pending-mixture
// Swap the tank's active mixture to its pending one, clear the pending pointer.
// Typically called from the refill flow once the operator physically mixes the
// new recipe. Idempotent — no-op if there's no pending mixture.
router.post('/tanks/:id/apply-pending-mixture', requireRole('admin', 'operator'), (req, res) => {
  try {
    const tank = db.prepare('SELECT id, pending_mixture_id, mixture_id FROM fertigation_tanks WHERE id = ?').get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Tank not found' });
    if (!tank.pending_mixture_id) return res.json({ changed: false, message: 'No pending mixture' });
    db.prepare(`
      UPDATE fertigation_tanks
      SET mixture_id = pending_mixture_id, pending_mixture_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
    res.json({ changed: true, previous_mixture_id: tank.mixture_id, active_mixture_id: tank.pending_mixture_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dose Cycle Control ───
//
// The dose scheduler drives Waveshare valve relays during a fertigation cycle.
// These endpoints are the surface for previewing a cycle, kicking one off manually
// (e.g. for testing), and aborting one mid-cycle. The actual production trigger
// will come from the automation system via a new template (next step).

// POST /api/fertigation/dose-cycle/preview
// Body: { program_id, duration_seconds }
// Returns the deterministic per-valve schedule without writing anything.
router.post('/dose-cycle/preview', (req, res) => {
  const { program_id, duration_seconds } = req.body || {};
  if (!program_id || !duration_seconds) return res.status(400).json({ error: 'program_id and duration_seconds required' });
  try {
    const prog = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(program_id);
    if (!prog) return res.status(404).json({ error: 'Dose program not found' });
    const tanks = db.prepare(`
      SELECT pt.*, t.equipment_id, t.channel, t.name as tank_name
      FROM fertigation_dose_program_tanks pt
      JOIN fertigation_tanks t ON pt.tank_id = t.id
      WHERE pt.program_id = ?
      ORDER BY pt.priority, pt.tank_id
    `).all(program_id);
    const schedule = fertigationDoseScheduler.computeSchedule({ ...prog, tanks }, parseFloat(duration_seconds));
    res.json({ program_id, duration_seconds: parseFloat(duration_seconds), schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fertigation/dose-cycle/start
// Body: { program_id, duration_seconds, dry_run? }
// Begins a live cycle. Errors if a cycle is already running.
router.post('/dose-cycle/start', requireRole('admin', 'operator'), async (req, res) => {
  const { program_id, duration_seconds, dry_run } = req.body || {};
  if (!program_id || !duration_seconds) return res.status(400).json({ error: 'program_id and duration_seconds required' });
  try {
    const result = await fertigationDoseScheduler.startCycle({
      programId: parseInt(program_id),
      durationSeconds: parseFloat(duration_seconds),
      dryRun: !!dry_run,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/fertigation/dose-cycle/abort
router.post('/dose-cycle/abort', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const aborted = await fertigationDoseScheduler.abortCycle(req.body?.reason || 'manual stop');
    res.json({ aborted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fertigation/dose-cycle/status
// Returns enriched cycle state for the UI: program/automation names, progress,
// per-tank live valve states + next toggle time. Polled at ~2s by the live banner.
router.get('/dose-cycle/status', (req, res) => {
  const running = fertigationDoseScheduler.isRunning();
  const cycle = fertigationDoseScheduler.currentCycle();
  if (!running || !cycle) return res.json({ running: false });

  const program = cycle.programId
    ? db.prepare('SELECT id, name FROM fertigation_dose_programs WHERE id = ?').get(cycle.programId)
    : null;
  const automation = cycle.automationId
    ? db.prepare('SELECT id, name FROM automations WHERE id = ?').get(cycle.automationId)
    : null;

  const nowMs = Date.now();
  const elapsed = Math.max(0, Math.floor((nowMs - cycle.startedAt) / 1000));
  const duration = Math.floor((cycle.endsAt - cycle.startedAt) / 1000);
  const remaining = Math.max(0, duration - elapsed);

  // For each tank in the schedule, look up the next valve event after "now"
  // and derive the current state from valveStates map.
  const tanks = (cycle.schedule?.tanks || []).map(t => {
    const stateKey = `${t.equipment_id}:${t.channel}`;
    const currentState = !!cycle.valveStates?.[stateKey];
    // Find next event after current elapsed time.
    const nextEv = (t.valve_events || []).find(ev => ev.at_sec > elapsed);
    return {
      tank_id: t.tank_id,
      tank_name: t.tank_name,
      equipment_id: t.equipment_id,
      channel: t.channel,
      duty_pct: t.duty_pct,
      slot: t.slot,
      current_state: currentState,
      next_toggle_at_sec: nextEv?.at_sec ?? null,
      next_toggle_state: nextEv?.state ?? null,
      seconds_until_next: nextEv ? Math.max(0, nextEv.at_sec - elapsed) : null,
    };
  });

  res.json({
    running: true,
    cycle_log_id: cycle.cycleLogId,
    program,
    automation,
    started_at: new Date(cycle.startedAt).toISOString(),
    ends_at: new Date(cycle.endsAt).toISOString(),
    duration_seconds: duration,
    elapsed_seconds: elapsed,
    remaining_seconds: remaining,
    progress_pct: duration > 0 ? Math.round((elapsed / duration) * 100) : 0,
    compatibility_strategy: cycle.schedule?.compatibility_strategy,
    window_seconds: cycle.schedule?.window_seconds,
    tanks,
  });
});

// GET /api/fertigation/dose-cycle/history?limit=20
// Recent dose-cycle log rows enriched with program and automation names for the UI table.
router.get('/dose-cycle/history', (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  try {
    const rows = db.prepare(`
      SELECT
        dcl.id,
        dcl.cycle_started_at,
        dcl.cycle_ended_at,
        dcl.duration_seconds,
        dcl.status,
        dcl.notes,
        dcl.ec_trim_applied,
        dcl.effective_duty_pcts,
        dcl.program_id,
        dcl.automation_id,
        p.name AS program_name,
        a.name AS automation_name
      FROM fertigation_dose_cycle_log dcl
      LEFT JOIN fertigation_dose_programs p ON p.id = dcl.program_id
      LEFT JOIN automations a ON a.id = dcl.automation_id
      ORDER BY dcl.cycle_started_at DESC
      LIMIT ?
    `).all(limit);
    res.json(rows.map(r => ({
      ...r,
      effective_duty_pcts: (() => { try { return r.effective_duty_pcts ? JSON.parse(r.effective_duty_pcts) : null; } catch { return null; } })(),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
