const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/zones - List all zones
router.get('/', (req, res) => {
  const zones = db.prepare('SELECT * FROM zones ORDER BY name ASC').all();

  // Add equipment count to each zone
  const zonesWithCount = zones.map(zone => {
    const count = db.prepare('SELECT COUNT(*) as count FROM equipment_zones WHERE zone_id = ?').get(zone.id);
    return { ...zone, equipment_count: count.count };
  });

  res.json(zonesWithCount);
});

// POST /api/zones - Create zone
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, parent_id } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  const result = db.prepare(
    'INSERT INTO zones (name, description, parent_id) VALUES (?, ?, ?)'
  ).run(name, description, parent_id || null);

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(zone);
});

// GET /api/zones/:id - Get zone details
router.get('/:id', (req, res) => {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);

  if (!zone) {
    return res.status(404).json({ error: 'Not Found', message: 'Zone not found' });
  }

  // Get equipment in this zone
  const equipment = db.prepare(
    'SELECT e.* FROM equipment e JOIN equipment_zones ez ON e.id = ez.equipment_id WHERE ez.zone_id = ?'
  ).all(req.params.id);

  // Get child zones
  const children = db.prepare('SELECT * FROM zones WHERE parent_id = ?').all(req.params.id);

  res.json({ ...zone, equipment, children });
});

// PUT /api/zones/:id - Update zone
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, parent_id } = req.body;
  const zoneId = req.params.id;

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);

  if (!zone) {
    return res.status(404).json({ error: 'Not Found', message: 'Zone not found' });
  }

  // Prevent circular reference
  if (parent_id && parseInt(parent_id) === parseInt(zoneId)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Zone cannot be its own parent' });
  }

  db.prepare(
    'UPDATE zones SET name = ?, description = ?, parent_id = ?, updated_at = datetime("now") WHERE id = ?'
  ).run(
    name ?? zone.name,
    description ?? zone.description,
    parent_id !== undefined ? parent_id : zone.parent_id,
    zoneId
  );

  const updated = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
  res.json(updated);
});

// DELETE /api/zones/:id - Delete zone
router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM zones WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Zone not found' });
  }

  res.json({ message: 'Zone deleted successfully' });
});

// POST /api/zones/:id/equipment - Assign equipment to zone
router.post('/:id/equipment', requireRole('admin', 'operator'), (req, res) => {
  const { equipment_id } = req.body;
  const zoneId = req.params.id;

  if (!equipment_id) {
    return res.status(400).json({ error: 'Bad Request', message: 'equipment_id is required' });
  }

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
  if (!zone) {
    return res.status(404).json({ error: 'Not Found', message: 'Zone not found' });
  }

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipment_id);
  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  try {
    db.prepare('INSERT INTO equipment_zones (equipment_id, zone_id) VALUES (?, ?)').run(equipment_id, zoneId);
    res.status(201).json({ message: 'Equipment assigned to zone' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Conflict', message: 'Equipment already in this zone' });
    }
    throw error;
  }
});

// DELETE /api/zones/:id/equipment/:equipmentId - Remove equipment from zone
router.delete('/:id/equipment/:equipmentId', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare(
    'DELETE FROM equipment_zones WHERE zone_id = ? AND equipment_id = ?'
  ).run(req.params.id, req.params.equipmentId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not in this zone' });
  }

  res.json({ message: 'Equipment removed from zone' });
});

module.exports = router;
