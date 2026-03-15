const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Predefined nutrient options with default units
const NUTRIENT_OPTIONS = [
  // Macronutrients
  { id: 'nitrogen_N', name: 'Nitrogen (N)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'phosphorus_P', name: 'Phosphorus (P)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'potassium_K', name: 'Potassium (K)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'calcium_Ca', name: 'Calcium (Ca)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'magnesium_Mg', name: 'Magnesium (Mg)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'sulfur_S', name: 'Sulfur (S)', category: 'Macronutrient', defaultUnit: 'ppm' },
  // Micronutrients
  { id: 'iron_Fe', name: 'Iron (Fe)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'manganese_Mn', name: 'Manganese (Mn)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'zinc_Zn', name: 'Zinc (Zn)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'copper_Cu', name: 'Copper (Cu)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'boron_B', name: 'Boron (B)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'molybdenum_Mo', name: 'Molybdenum (Mo)', category: 'Micronutrient', defaultUnit: 'ppm' },
  { id: 'chlorine_Cl', name: 'Chlorine (Cl)', category: 'Micronutrient', defaultUnit: 'ppm' },
  // General parameters
  { id: 'pH', name: 'pH', category: 'General', defaultUnit: '' },
  { id: 'EC', name: 'EC (Electrical Conductivity)', category: 'General', defaultUnit: 'mS/cm' },
  { id: 'TDS', name: 'TDS (Total Dissolved Solids)', category: 'General', defaultUnit: 'ppm' },
  { id: 'organic_matter', name: 'Organic Matter', category: 'General', defaultUnit: '%' },
  { id: 'CEC', name: 'CEC (Cation Exchange Capacity)', category: 'General', defaultUnit: 'meq/100g' },
  { id: 'moisture', name: 'Moisture Content', category: 'General', defaultUnit: '%' },
  { id: 'alkalinity', name: 'Alkalinity', category: 'General', defaultUnit: 'ppm' },
  { id: 'hardness', name: 'Hardness', category: 'General', defaultUnit: 'ppm' },
  { id: 'dissolved_oxygen', name: 'Dissolved Oxygen', category: 'General', defaultUnit: 'mg/L' },
  { id: 'nitrate_NO3', name: 'Nitrate (NO3)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'ammonium_NH4', name: 'Ammonium (NH4)', category: 'Macronutrient', defaultUnit: 'ppm' },
  { id: 'phosphate_PO4', name: 'Phosphate (PO4)', category: 'Macronutrient', defaultUnit: 'ppm' },
];

// GET /api/lab-readings/nutrients - Get available nutrient options
router.get('/nutrients', (req, res) => {
  res.json(NUTRIENT_OPTIONS);
});

// GET /api/lab-readings - List lab readings with optional filters
router.get('/', (req, res) => {
  const { nutrient, zone_id, from, to, limit: queryLimit, offset: queryOffset } = req.query;
  const limit = parseInt(queryLimit) || 25;
  const offset = parseInt(queryOffset) || 0;

  let where = 'WHERE 1=1';
  const params = [];

  if (nutrient) {
    where += ' AND lr.nutrient = ?';
    params.push(nutrient);
  }
  if (zone_id) {
    where += ' AND lr.zone_id = ?';
    params.push(zone_id);
  }
  if (from) {
    where += ' AND lr.sample_date >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND lr.sample_date <= ?';
    params.push(to);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as count FROM lab_readings lr ${where}`
  ).get(...params).count;

  const readings = db.prepare(
    `SELECT lr.*, z.name as zone_name
     FROM lab_readings lr
     LEFT JOIN zones z ON lr.zone_id = z.id
     ${where}
     ORDER BY lr.sample_date DESC, lr.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ readings, total, limit, offset });
});

// GET /api/lab-readings/latest - Get latest reading per nutrient per zone (for dashboard)
router.get('/latest', (req, res) => {
  const { zone_id } = req.query;

  if (zone_id) {
    const readings = db.prepare(
      `SELECT lr.*, z.name as zone_name
       FROM lab_readings lr
       LEFT JOIN zones z ON lr.zone_id = z.id
       WHERE lr.id IN (SELECT MAX(id) FROM lab_readings WHERE zone_id = ? GROUP BY nutrient)
       ORDER BY lr.nutrient ASC`
    ).all(zone_id);
    return res.json(readings);
  }

  // No zone filter: return latest per nutrient per zone
  const readings = db.prepare(
    `SELECT lr.*, z.name as zone_name
     FROM lab_readings lr
     LEFT JOIN zones z ON lr.zone_id = z.id
     WHERE lr.id IN (SELECT MAX(id) FROM lab_readings GROUP BY nutrient, COALESCE(zone_id, 0))
     ORDER BY lr.zone_id ASC, lr.nutrient ASC`
  ).all();

  res.json(readings);
});

// GET /api/lab-readings/stats - Get stats per nutrient
router.get('/stats', (req, res) => {
  const { from, to, zone_id } = req.query;
  let where = 'WHERE 1=1';
  const params = [];

  if (zone_id) { where += ' AND zone_id = ?'; params.push(zone_id); }
  if (from) { where += ' AND sample_date >= ?'; params.push(from); }
  if (to) { where += ' AND sample_date <= ?'; params.push(to); }

  const stats = db.prepare(
    `SELECT nutrient, unit, COUNT(*) as count, AVG(value) as avg, MIN(value) as min, MAX(value) as max
     FROM lab_readings ${where}
     GROUP BY nutrient, unit
     ORDER BY nutrient ASC`
  ).all(...params);

  res.json(stats);
});

// GET /api/lab-readings/:id - Get single lab reading
router.get('/:id', (req, res) => {
  const reading = db.prepare(
    `SELECT lr.*, z.name as zone_name
     FROM lab_readings lr
     LEFT JOIN zones z ON lr.zone_id = z.id
     WHERE lr.id = ?`
  ).get(req.params.id);

  if (!reading) {
    return res.status(404).json({ error: 'Not Found', message: 'Lab reading not found' });
  }
  res.json(reading);
});

// POST /api/lab-readings - Create lab reading(s)
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { entries } = req.body;

  // Support both single entry and batch
  const items = entries || [req.body];

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'At least one entry is required' });
  }

  const created = [];
  const errors = [];

  const insertStmt = db.prepare(
    `INSERT INTO lab_readings (sample_date, nutrient, value, unit, zone_id, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const item of items) {
    const { sample_date, nutrient, value, unit, zone_id, notes } = item;

    if (!nutrient || value === undefined || value === null) {
      errors.push({ nutrient, error: 'nutrient and value are required' });
      continue;
    }

    try {
      const result = insertStmt.run(
        sample_date || new Date().toISOString().split('T')[0],
        nutrient,
        parseFloat(value),
        unit || '',
        zone_id || null,
        notes || null
      );
      const row = db.prepare('SELECT * FROM lab_readings WHERE id = ?').get(result.lastInsertRowid);
      created.push(row);
    } catch (err) {
      errors.push({ nutrient, error: err.message });
    }
  }

  global.broadcast('lab_reading_created', { count: created.length });

  res.status(201).json({
    created,
    count: created.length,
    errors: errors.length > 0 ? errors : undefined
  });
});

// PUT /api/lab-readings/:id - Update a lab reading
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { sample_date, nutrient, value, unit, zone_id, notes } = req.body;
  const id = req.params.id;

  const existing = db.prepare('SELECT * FROM lab_readings WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Not Found', message: 'Lab reading not found' });
  }

  db.prepare(
    `UPDATE lab_readings SET sample_date = ?, nutrient = ?, value = ?, unit = ?, zone_id = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    sample_date ?? existing.sample_date,
    nutrient ?? existing.nutrient,
    value !== undefined ? parseFloat(value) : existing.value,
    unit ?? existing.unit,
    zone_id !== undefined ? (zone_id || null) : existing.zone_id,
    notes !== undefined ? (notes || null) : existing.notes,
    id
  );

  const updated = db.prepare('SELECT * FROM lab_readings WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/lab-readings/:id - Delete a lab reading
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM lab_readings WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Lab reading not found' });
  }
  res.json({ message: 'Lab reading deleted successfully' });
});

module.exports = router;
