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
    "UPDATE equipment SET name = ?, description = ?, type = ?, protocol = ?, address = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
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
  const equipmentId = req.params.id;
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Validate input values
  const calibrationOffset = parseFloat(offset) || 0;
  const calibrationScale = parseFloat(scale) || 1;

  // Save calibration values to database
  db.prepare(
    "UPDATE equipment SET calibration_offset = ?, calibration_scale = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(calibrationOffset, calibrationScale, equipmentId);

  const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
  global.broadcast('equipment_calibrated', updated);

  res.json({
    message: 'Calibration applied',
    offset: calibrationOffset,
    scale: calibrationScale,
    equipment: updated
  });
});

// POST /api/equipment/:id/test-connection - Test equipment connectivity
router.post('/:id/test-connection', requireRole('admin', 'operator'), (req, res) => {
  const equipmentId = req.params.id;
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Simulate connection test based on protocol
  // In a real implementation, this would actually attempt to connect
  const testResult = {
    success: true,
    latency_ms: Math.floor(Math.random() * 50) + 10, // Simulated latency 10-60ms
    protocol: equipment.protocol,
    address: equipment.address
  };

  // Randomly fail some tests to simulate real-world conditions (10% failure rate)
  if (Math.random() < 0.1) {
    testResult.success = false;
    testResult.error = 'Connection timeout - device not responding';
    testResult.latency_ms = null;
  }

  // Update last_communication timestamp on successful test
  if (testResult.success) {
    db.prepare(
      "UPDATE equipment SET last_communication = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?"
    ).run(equipmentId);

    const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
    global.broadcast('equipment_updated', updated);

    testResult.last_communication = new Date().toISOString();
    testResult.message = `Successfully connected to ${equipment.name}`;
  } else {
    // Update status to error on failed test
    db.prepare(
      "UPDATE equipment SET status = 'error', updated_at = datetime('now') WHERE id = ?"
    ).run(equipmentId);

    const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
    global.broadcast('equipment_updated', updated);

    testResult.message = `Failed to connect to ${equipment.name}`;
  }

  res.json(testResult);
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

// GET /api/equipment/:id/errors - Get equipment error logs
router.get('/:id/errors', (req, res) => {
  const { from, limit, resolved } = req.query;
  const equipmentId = req.params.id;

  // First verify equipment exists
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  let query = 'SELECT * FROM equipment_errors WHERE equipment_id = ?';
  const params = [equipmentId];

  if (from) {
    query += ' AND created_at >= ?';
    params.push(from);
  }

  if (resolved !== undefined) {
    query += ' AND resolved = ?';
    params.push(resolved === 'true' ? 1 : 0);
  }

  query += ' ORDER BY created_at DESC';

  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  } else {
    query += ' LIMIT 100'; // Default limit
  }

  const errors = db.prepare(query).all(...params);
  res.json(errors);
});

// POST /api/equipment/:id/errors - Log an error for equipment
router.post('/:id/errors', requireRole('admin', 'operator'), (req, res) => {
  const { error_type, message, details } = req.body;
  const equipmentId = req.params.id;

  // Verify equipment exists
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Bad Request', message: 'Error message is required' });
  }

  const validTypes = ['connection', 'timeout', 'protocol', 'validation', 'hardware', 'other'];
  const type = validTypes.includes(error_type) ? error_type : 'other';

  const result = db.prepare(
    'INSERT INTO equipment_errors (equipment_id, error_type, message, details) VALUES (?, ?, ?, ?)'
  ).run(equipmentId, type, message, details || null);

  const errorLog = db.prepare('SELECT * FROM equipment_errors WHERE id = ?').get(result.lastInsertRowid);

  // Also update equipment status to 'error' if not already
  if (equipment.status !== 'error') {
    db.prepare("UPDATE equipment SET status = 'error', error_log = ?, updated_at = datetime('now') WHERE id = ?")
      .run(message, equipmentId);
    global.broadcast('equipment_error', { equipment_id: equipmentId, error: errorLog });
  }

  res.status(201).json(errorLog);
});

// PUT /api/equipment/:id/errors/:errorId/resolve - Mark an error as resolved
router.put('/:id/errors/:errorId/resolve', requireRole('admin', 'operator'), (req, res) => {
  const { id: equipmentId, errorId } = req.params;

  const errorLog = db.prepare('SELECT * FROM equipment_errors WHERE id = ? AND equipment_id = ?').get(errorId, equipmentId);
  if (!errorLog) {
    return res.status(404).json({ error: 'Not Found', message: 'Error log not found' });
  }

  db.prepare("UPDATE equipment_errors SET resolved = 1, resolved_at = datetime('now') WHERE id = ?").run(errorId);

  // Check if all errors are now resolved
  const unresolvedCount = db.prepare('SELECT COUNT(*) as count FROM equipment_errors WHERE equipment_id = ? AND resolved = 0').get(equipmentId);

  if (unresolvedCount.count === 0) {
    // All errors resolved, update equipment status to online
    db.prepare("UPDATE equipment SET status = 'online', error_log = NULL, updated_at = datetime('now') WHERE id = ?").run(equipmentId);
    const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
    global.broadcast('equipment_updated', equipment);
  }

  const updated = db.prepare('SELECT * FROM equipment_errors WHERE id = ?').get(errorId);
  res.json(updated);
});

module.exports = router;
