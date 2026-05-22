const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_STAGES = ['seedling', 'vegetative', 'flowering', 'fruiting', 'ripening', 'harvested'];

/** Resolve zone_id from block_id.
 *  1. Check zones.block_id explicit mapping
 *  2. Fall back to the primary crop zone (zones.is_crop_zone = 1)
 *  Returns { zone_id, method } or null with error info.
 */
function resolveZoneId(blockId) {
  // Try explicit block_id mapping
  if (blockId) {
    const zone = db.prepare('SELECT id FROM zones WHERE block_id = ?').get(blockId);
    if (zone) return { zone_id: zone.id, method: 'block_mapping' };
  }

  // Fall back to primary crop zone
  const primary = db.prepare('SELECT id FROM zones WHERE is_crop_zone = 1 LIMIT 1').get();
  if (primary) {
    // Auto-bind this block_id to the primary crop zone for future lookups
    if (blockId) {
      db.prepare("UPDATE zones SET block_id = ?, block_configured_at = datetime('now') WHERE id = ?").run(blockId, primary.id);
    }
    return { zone_id: primary.id, method: 'primary_crop_zone' };
  }

  return null;
}

/** Get primary crop zone ID, or null */
function getPrimaryCropZoneId() {
  const z = db.prepare('SELECT id FROM zones WHERE is_crop_zone = 1 LIMIT 1').get();
  return z ? z.id : null;
}

/** Build A64Core-shaped response from a DB row */
function toContractShape(row) {
  if (!row) return null;
  const zone = row.zone_id ? db.prepare('SELECT name FROM zones WHERE id = ?').get(row.zone_id) : null;
  return {
    sensehub_crop_id: String(row.id),
    block_id: row.block_id,
    zone_id: row.zone_id,
    zone_name: zone?.name || null,
    a64core_planting_id: row.a64core_planting_id,
    crop: {
      plant_data_id: row.plant_data_id,
      name: row.crop_name,
      variety: row.variety,
      scientific_name: row.scientific_name
    },
    timing: {
      planted_date: row.planted_date,
      expected_harvest_date: row.expected_harvest_date,
      growth_cycle_days: row.growth_cycle_days
    },
    population: {
      plant_count: row.plant_count,
      max_capacity: row.max_capacity
    },
    substrate: {
      soil_type: row.soil_type,
      volume_l_per_plant: row.substrate_volume_l_per_plant,
    },
    current_stage: row.current_stage,
    optimal_ranges: row.optimal_ranges ? JSON.parse(row.optimal_ranges) : {},
    stage_durations_days: row.stage_durations ? JSON.parse(row.stage_durations) : null,
    active: row.active === 1,
    received_at: row.received_at,
    last_stage_update_at: row.last_stage_update_at,
    // Harvest data (only present if completed)
    ...(row.harvested_at ? {
      harvested_at: row.harvested_at,
      total_yield_kg: row.total_yield_kg,
      average_quality_grade: row.average_quality_grade,
      harvest_count: row.harvest_count
    } : {})
  };
}

// GET /api/crops - List active crop assignments
router.get('/', (req, res) => {
  const { zone_id, block_id, include_inactive } = req.query;
  try {
    let where = include_inactive === 'true' ? '1=1' : 'active = 1';
    const params = [];
    if (zone_id) { where += ' AND zone_id = ?'; params.push(parseInt(zone_id)); }
    if (block_id) { where += ' AND block_id = ?'; params.push(block_id); }

    const rows = db.prepare(`SELECT * FROM crop_assignments WHERE ${where} ORDER BY active DESC, updated_at DESC`).all(...params);
    res.json(rows.map(toContractShape));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crops/by-block/:block_id - Get active crop for a block (A64Core contract)
router.get('/by-block/:block_id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM crop_assignments WHERE block_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1')
      .get(req.params.block_id);
    res.json(toContractShape(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crops/:zone_id/current - Get active crop for a zone (internal)
router.get('/:zone_id/current', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM crop_assignments WHERE zone_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1')
      .get(parseInt(req.params.zone_id));
    const result = toContractShape(row);
    if (result) {
      const now = new Date();
      if (result.timing.planted_date) {
        result.days_since_planting = Math.floor((now - new Date(result.timing.planted_date)) / 86400000);
      }
      if (result.timing.expected_harvest_date) {
        result.days_to_harvest = Math.floor((new Date(result.timing.expected_harvest_date) - now) / 86400000);
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crops - Create/replace crop (A64Core set_crop_data contract)
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { block_id, a64core_planting_id, crop, timing, population,
          current_stage, optimal_ranges, stage_durations_days,
          // Legacy flat fields (manual creation from SenseHub UI)
          zone_id: legacyZoneId, crop_name: legacyCropName, variety: legacyVariety,
          plantation_date, expected_harvest_date, growth_stage, plant_data, source } = req.body;

  // Support both A64Core contract shape and legacy flat shape
  const isContractShape = !!block_id && !!crop;

  let finalBlockId, finalCropName, finalVariety, finalScientificName, finalPlantDataId;
  let finalPlantedDate, finalExpectedHarvest, finalGrowthCycleDays;
  let finalPlantCount, finalMaxCapacity, finalStage;
  let finalOptimalRanges, finalStageDurations, finalPlantingId;

  if (isContractShape) {
    finalBlockId = block_id;
    finalPlantingId = a64core_planting_id;
    finalCropName = crop.name;
    finalVariety = crop.variety;
    finalScientificName = crop.scientific_name;
    finalPlantDataId = crop.plant_data_id;
    finalPlantedDate = timing?.planted_date;
    finalExpectedHarvest = timing?.expected_harvest_date;
    finalGrowthCycleDays = timing?.growth_cycle_days;
    finalPlantCount = population?.plant_count;
    finalMaxCapacity = population?.max_capacity;
    finalStage = current_stage || 'seedling';
    finalOptimalRanges = optimal_ranges;
    finalStageDurations = stage_durations_days;
  } else {
    // Legacy flat shape
    finalBlockId = legacyZoneId ? `zone-${legacyZoneId}` : null;
    finalCropName = legacyCropName;
    finalVariety = legacyVariety;
    finalStage = growth_stage || 'seedling';
    finalPlantedDate = plantation_date;
    finalExpectedHarvest = expected_harvest_date;
    if (plant_data) {
      finalOptimalRanges = {};
      if (plant_data.optimal_ec) finalOptimalRanges.ec = plant_data.optimal_ec;
      if (plant_data.optimal_ph) finalOptimalRanges.ph = plant_data.optimal_ph;
      if (plant_data.optimal_temp) finalOptimalRanges.temperature = plant_data.optimal_temp;
      if (plant_data.optimal_humidity) finalOptimalRanges.humidity = plant_data.optimal_humidity;
      finalPlantCount = plant_data.plant_count;
    }
  }

  if (!finalBlockId || !finalCropName) {
    return res.status(400).json({ error: 'block_id (or zone_id) and crop name are required' });
  }

  if (finalStage && !VALID_STAGES.includes(finalStage)) {
    return res.status(400).json({ error: `Invalid stage "${finalStage}". Valid: ${VALID_STAGES.join(', ')}` });
  }

  try {
    const now = new Date().toISOString();
    const resolved = resolveZoneId(finalBlockId);
    const zoneId = resolved ? resolved.zone_id : (legacyZoneId ? parseInt(legacyZoneId) : null);

    if (!zoneId && !legacyZoneId) {
      return res.status(422).json({
        error: 'No primary crop zone configured for this site',
        hint: 'Configure via SenseHub admin UI: go to Zones and mark one zone as the primary crop zone, or use configure_block_mapping to associate a block_id with a zone.'
      });
    }

    // Deactivate any existing active crop for this block
    db.prepare("UPDATE crop_assignments SET active = 0, updated_at = ? WHERE block_id = ? AND active = 1").run(now, finalBlockId);

    const result = db.prepare(`
      INSERT INTO crop_assignments
        (block_id, zone_id, a64core_planting_id, crop_name, variety, scientific_name, plant_data_id,
         planted_date, expected_harvest_date, growth_cycle_days, plant_count, max_capacity,
         current_stage, optimal_ranges, stage_durations, received_at, last_stage_update_at,
         active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      finalBlockId, zoneId, finalPlantingId || null,
      finalCropName, finalVariety || null, finalScientificName || null, finalPlantDataId || null,
      finalPlantedDate || null, finalExpectedHarvest || null, finalGrowthCycleDays || null,
      finalPlantCount || null, finalMaxCapacity || null,
      finalStage, finalOptimalRanges ? JSON.stringify(finalOptimalRanges) : null,
      finalStageDurations ? JSON.stringify(finalStageDurations) : null,
      now, now, now, now
    );

    global.broadcast('crop_assigned', { block_id: finalBlockId, crop_name: finalCropName, zone_id: zoneId });

    res.status(201).json({ ok: true, sensehub_crop_id: String(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/crops/:id/stage - Update growth stage (A64Core update_growth_stage contract)
router.put('/:id/stage', requireRole('admin', 'operator'), (req, res) => {
  const { growth_stage, stage, block_id, transitioned_at, days_since_planting } = req.body;
  const finalStage = stage || growth_stage;

  if (!finalStage) return res.status(400).json({ error: 'stage is required' });
  if (!VALID_STAGES.includes(finalStage)) {
    return res.status(400).json({ error: `Invalid stage "${finalStage}". Valid: ${VALID_STAGES.join(', ')}` });
  }

  try {
    // Resolve by ID or block_id
    let row;
    if (block_id) {
      row = db.prepare('SELECT id FROM crop_assignments WHERE block_id = ? AND active = 1').get(block_id);
    } else {
      row = db.prepare('SELECT id FROM crop_assignments WHERE id = ?').get(parseInt(req.params.id));
    }
    if (!row) return res.status(404).json({ error: 'No active crop found for this block' });

    db.prepare(`
      UPDATE crop_assignments SET current_stage = ?, transitioned_at = ?, days_since_planting = ?,
        last_stage_update_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(finalStage, transitioned_at || new Date().toISOString(), days_since_planting || null, row.id);

    global.broadcast('crop_stage_updated', { id: row.id, stage: finalStage });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crops/:id/complete - Mark crop as harvested (A64Core complete_crop contract)
router.post('/:id/complete', requireRole('admin', 'operator'), (req, res) => {
  const { block_id, harvested_at, total_yield_kg, average_quality_grade, harvest_count } = req.body;

  try {
    let row;
    if (block_id) {
      row = db.prepare('SELECT id FROM crop_assignments WHERE block_id = ? AND active = 1').get(block_id);
    } else {
      row = db.prepare('SELECT id FROM crop_assignments WHERE id = ?').get(parseInt(req.params.id));
    }
    if (!row) return res.status(404).json({ error: 'No active crop found' });

    db.prepare(`
      UPDATE crop_assignments SET active = 0, current_stage = 'harvested',
        harvested_at = ?, total_yield_kg = ?, average_quality_grade = ?, harvest_count = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      harvested_at || new Date().toISOString(),
      total_yield_kg || null,
      average_quality_grade || null,
      harvest_count || null,
      row.id
    );

    global.broadcast('crop_completed', { id: row.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/crops/:id - General update (internal use)
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const existing = db.prepare('SELECT * FROM crop_assignments WHERE id = ?').get(parseInt(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    crop_name, variety, current_stage, optimal_ranges,
    plant_count, max_capacity, soil_type, substrate_volume_l_per_plant,
  } = req.body;
  try {
    db.prepare(`
      UPDATE crop_assignments SET crop_name = ?, variety = ?, current_stage = ?,
        optimal_ranges = ?, plant_count = ?, max_capacity = ?,
        soil_type = ?, substrate_volume_l_per_plant = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      crop_name ?? existing.crop_name,
      variety !== undefined ? variety : existing.variety,
      current_stage ?? existing.current_stage,
      optimal_ranges ? JSON.stringify(optimal_ranges) : existing.optimal_ranges,
      plant_count ?? existing.plant_count,
      max_capacity ?? existing.max_capacity,
      soil_type !== undefined ? soil_type : existing.soil_type,
      substrate_volume_l_per_plant !== undefined ? substrate_volume_l_per_plant : existing.substrate_volume_l_per_plant,
      existing.id
    );
    res.json(toContractShape(db.prepare('SELECT * FROM crop_assignments WHERE id = ?').get(existing.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crops/configure-block-mapping - Map a zone to an A64Core block (MCP-friendly)
router.post('/configure-block-mapping', requireRole('admin', 'operator'), (req, res) => {
  const { zone_id, block_id, block_code, block_name } = req.body;
  if (!zone_id || !block_id) return res.status(400).json({ error: 'zone_id and block_id are required' });

  try {
    const zone = db.prepare('SELECT id, name, block_id FROM zones WHERE id = ?').get(parseInt(zone_id));
    if (!zone) {
      const available = db.prepare('SELECT id, name FROM zones ORDER BY id').all();
      return res.status(404).json({ error: `Zone ${zone_id} not found`, available_zones: available });
    }

    const previousBlockId = zone.block_id || null;
    const now = new Date().toISOString();

    db.prepare('UPDATE zones SET block_id = ?, block_code = ?, block_configured_at = ?, updated_at = ? WHERE id = ?')
      .run(block_id, block_code || null, now, now, parseInt(zone_id));

    // Optionally update zone name if block_name is provided and zone has a generic name
    if (block_name) {
      db.prepare('UPDATE zones SET name = ?, updated_at = ? WHERE id = ?').run(block_name, now, parseInt(zone_id));
    }

    res.json({ ok: true, previous_block_id: previousBlockId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crops/zone-mappings - List all zone-to-block mappings
router.get('/zone-mappings', (req, res) => {
  try {
    const zones = db.prepare('SELECT id, name, block_id, block_code, block_configured_at, is_crop_zone FROM zones ORDER BY id').all();
    const primaryZone = zones.find(z => z.is_crop_zone === 1);
    res.json({
      primary_crop_zone_id: primaryZone ? primaryZone.id : null,
      mappings: zones.map(z => ({
        zone_id: z.id,
        zone_name: z.name,
        block_id: z.block_id || null,
        block_code: z.block_code || null,
        is_crop_zone: z.is_crop_zone === 1,
        configured_at: z.block_configured_at || null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crops/set-primary-zone - Set the primary crop zone
router.post('/set-primary-zone', requireRole('admin'), (req, res) => {
  const { zone_id } = req.body;
  if (!zone_id) return res.status(400).json({ error: 'zone_id required' });
  try {
    const zone = db.prepare('SELECT id, name FROM zones WHERE id = ?').get(parseInt(zone_id));
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    // Clear previous primary
    db.prepare('UPDATE zones SET is_crop_zone = 0 WHERE is_crop_zone = 1').run();
    // Set new primary
    db.prepare('UPDATE zones SET is_crop_zone = 1 WHERE id = ?').run(parseInt(zone_id));

    res.json({ ok: true, primary_crop_zone: { id: zone.id, name: zone.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
