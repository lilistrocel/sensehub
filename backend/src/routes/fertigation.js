const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

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
router.post('/ingredients', requireRole('admin', 'operator'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = db.prepare('INSERT INTO fertigation_ingredients (name) VALUES (?)').run(name.trim());
    res.json({ id: result.lastInsertRowid, name: name.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ingredient already exists' });
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

    const insertItem = db.prepare('INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts) VALUES (?, ?, ?)');
    for (const item of items) {
      if (!item.ingredient_id || !item.parts || item.parts <= 0) continue;
      insertItem.run(mixtureId, item.ingredient_id, item.parts);
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
      const insertItem = db.prepare('INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts) VALUES (?, ?, ?)');
      for (const item of items) {
        if (!item.ingredient_id || !item.parts || item.parts <= 0) continue;
        insertItem.run(mixtureId, item.ingredient_id, item.parts);
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

// GET /api/fertigation/channels - List all channel configs with equipment name + mixture info
router.get('/channels', (req, res) => {
  try {
    const channels = db.prepare(`
      SELECT rc.*, e.name as equipment_name, fm.name as mixture_name
      FROM relay_channel_config rc
      JOIN equipment e ON rc.equipment_id = e.id
      LEFT JOIN fertigation_mixtures fm ON rc.mixture_id = fm.id
      ORDER BY e.name, rc.channel
    `).all();
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fertigation/channels/:equipmentId/:channel - Upsert channel config
router.put('/channels/:equipmentId/:channel', requireRole('admin', 'operator'), (req, res) => {
  const { equipmentId, channel } = req.params;
  const { ingredient_name, mixture_id, flow_rate, flow_unit } = req.body;

  if (flow_rate == null) return res.status(400).json({ error: 'flow_rate is required' });
  if (!ingredient_name && !mixture_id) return res.status(400).json({ error: 'Either ingredient_name or mixture_id is required' });

  const flowRateNum = parseFloat(flow_rate);
  if (isNaN(flowRateNum) || flowRateNum <= 0) return res.status(400).json({ error: 'flow_rate must be a positive number' });

  const equipment = db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

  try {
    db.prepare(`
      INSERT INTO relay_channel_config (equipment_id, channel, ingredient_name, mixture_id, flow_rate, flow_unit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(equipment_id, channel)
      DO UPDATE SET ingredient_name = excluded.ingredient_name, mixture_id = excluded.mixture_id, flow_rate = excluded.flow_rate, flow_unit = excluded.flow_unit, updated_at = datetime('now')
    `).run(parseInt(equipmentId), parseInt(channel), mixture_id ? null : (ingredient_name || null), mixture_id ? parseInt(mixture_id) : null, flowRateNum, flow_unit || 'L/min');

    const config = db.prepare(`
      SELECT rc.*, fm.name as mixture_name
      FROM relay_channel_config rc
      LEFT JOIN fertigation_mixtures fm ON rc.mixture_id = fm.id
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

module.exports = router;
