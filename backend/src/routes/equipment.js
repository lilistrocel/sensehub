const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/equipment - List all equipment
router.get('/', (req, res) => {
  const { status, search, zone } = req.query;

  let query = 'SELECT * FROM equipment';
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (search) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY name ASC';

  const equipment = db.prepare(query).all(...params);
  res.json(equipment);
});

// POST /api/equipment - Create equipment
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, type, protocol, address } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  const result = db.prepare(
    'INSERT INTO equipment (name, description, type, protocol, address) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description, type, protocol, address);

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(result.lastInsertRowid);

  global.broadcast('equipment_created', equipment);

  res.status(201).json(equipment);
});

// GET /api/equipment/:id - Get equipment details
router.get('/:id', (req, res) => {
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Get zones for this equipment
  const zones = db.prepare(
    'SELECT z.* FROM zones z JOIN equipment_zones ez ON z.id = ez.zone_id WHERE ez.equipment_id = ?'
  ).all(req.params.id);

  res.json({ ...equipment, zones });
});

// PUT /api/equipment/:id - Update equipment
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, type, protocol, address, enabled } = req.body;
  const equipmentId = req.params.id;

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  db.prepare(
    'UPDATE equipment SET name = ?, description = ?, type = ?, protocol = ?, address = ?, enabled = ?, updated_at = datetime("now") WHERE id = ?'
  ).run(
    name ?? equipment.name,
    description ?? equipment.description,
    type ?? equipment.type,
    protocol ?? equipment.protocol,
    address ?? equipment.address,
    enabled !== undefined ? (enabled ? 1 : 0) : equipment.enabled,
    equipmentId
  );

  const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
  global.broadcast('equipment_updated', updated);

  res.json(updated);
});

// DELETE /api/equipment/:id - Delete equipment
router.delete('/:id', requireRole('admin'), (req, res) => {
  const result = db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  global.broadcast('equipment_deleted', { id: parseInt(req.params.id) });

  res.json({ message: 'Equipment deleted successfully' });
});

// POST /api/equipment/scan - Discover equipment
router.post('/scan', requireRole('admin', 'operator'), (req, res) => {
  // Simulate equipment discovery
  res.json({
    message: 'Scan initiated',
    discovered: []
  });
});

// POST /api/equipment/:id/control - Control equipment
router.post('/:id/control', requireRole('admin', 'operator'), (req, res) => {
  const { action, value } = req.body;
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Log the control action
  console.log(`Control action: ${action} on equipment ${equipment.name}`);

  global.broadcast('equipment_control', { id: equipment.id, action, value });

  res.json({ message: 'Control command sent', action, equipment: equipment.name });
});

// POST /api/equipment/:id/calibrate - Calibrate equipment
router.post('/:id/calibrate', requireRole('admin'), (req, res) => {
  const { offset, scale } = req.body;
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  res.json({ message: 'Calibration applied', offset, scale });
});

// GET /api/equipment/:id/history - Get equipment history
router.get('/:id/history', (req, res) => {
  const { from, to, limit } = req.query;
  const equipmentId = req.params.id;

  let query = 'SELECT * FROM readings WHERE equipment_id = ?';
  const params = [equipmentId];

  if (from) {
    query += ' AND timestamp >= ?';
    params.push(from);
  }

  if (to) {
    query += ' AND timestamp <= ?';
    params.push(to);
  }

  query += ' ORDER BY timestamp DESC';

  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  }

  const readings = db.prepare(query).all(...params);
  res.json(readings);
});

module.exports = router;
