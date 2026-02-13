const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { modbusTcpClient } = require('../services/ModbusTcpClient');

const router = express.Router();

// Helper function to add item to sync queue
const queueForSync = (entityType, entityId, action, payload = null) => {
  try {
    db.prepare(`
      INSERT INTO sync_queue (entity_type, entity_id, action, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `).run(entityType, entityId, action, payload ? JSON.stringify(payload) : null);
  } catch (err) {
    console.error('Error queuing for sync:', err);
  }
};

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

  // Parse register_mappings JSON for each equipment
  equipment.forEach(item => {
    if (item.register_mappings) {
      try {
        item.register_mappings = JSON.parse(item.register_mappings);
      } catch (e) {
        // Keep as string if not valid JSON
      }
    }
  });

  res.json(equipment);
});

// POST /api/equipment - Create equipment
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, type, protocol, address, slave_id, polling_interval_ms, register_mappings } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  // Validate Modbus-specific fields if protocol is Modbus
  if (protocol === 'modbus') {
    if (slave_id !== undefined && slave_id !== null && slave_id !== '') {
      const slaveIdNum = parseInt(slave_id);
      if (isNaN(slaveIdNum) || slaveIdNum < 1 || slaveIdNum > 247) {
        return res.status(400).json({ error: 'Bad Request', message: 'Modbus slave ID must be between 1 and 247' });
      }
    }
    if (polling_interval_ms !== undefined && polling_interval_ms !== null && polling_interval_ms !== '') {
      const pollingMs = parseInt(polling_interval_ms);
      if (isNaN(pollingMs) || pollingMs < 100 || pollingMs > 60000) {
        return res.status(400).json({ error: 'Bad Request', message: 'Polling interval must be between 100ms and 60000ms' });
      }
    }
  }

  // Serialize register_mappings to JSON if it's an array/object
  const registerMappingsJson = register_mappings ?
    (typeof register_mappings === 'string' ? register_mappings : JSON.stringify(register_mappings)) : null;

  const result = db.prepare(
    'INSERT INTO equipment (name, description, type, protocol, address, slave_id, polling_interval_ms, register_mappings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    name,
    description,
    type,
    protocol,
    address,
    slave_id ? parseInt(slave_id) : null,
    polling_interval_ms ? parseInt(polling_interval_ms) : 1000,
    registerMappingsJson
  );

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(result.lastInsertRowid);

  // Parse register_mappings for response
  if (equipment.register_mappings) {
    try {
      equipment.register_mappings = JSON.parse(equipment.register_mappings);
    } catch (e) {
      // Keep as string if not valid JSON
    }
  }

  // Queue for cloud sync
  queueForSync('equipment', equipment.id, 'create', equipment);

  global.broadcast('equipment_created', equipment);

  res.status(201).json(equipment);
});

// GET /api/equipment/:id - Get equipment details
router.get('/:id', (req, res) => {
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Parse register_mappings JSON if present
  if (equipment.register_mappings) {
    try {
      equipment.register_mappings = JSON.parse(equipment.register_mappings);
    } catch (e) {
      // Keep as string if not valid JSON
    }
  }

  // Get zones for this equipment
  const zones = db.prepare(
    'SELECT z.* FROM zones z JOIN equipment_zones ez ON z.id = ez.zone_id WHERE ez.equipment_id = ?'
  ).all(req.params.id);

  res.json({ ...equipment, zones });
});

// PUT /api/equipment/:id - Update equipment
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, type, protocol, address, enabled, slave_id, polling_interval_ms, register_mappings } = req.body;
  const equipmentId = req.params.id;

  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Determine the effective protocol for validation
  const effectiveProtocol = protocol ?? equipment.protocol;

  // Validate Modbus-specific fields if protocol is Modbus
  if (effectiveProtocol === 'modbus') {
    if (slave_id !== undefined && slave_id !== null && slave_id !== '') {
      const slaveIdNum = parseInt(slave_id);
      if (isNaN(slaveIdNum) || slaveIdNum < 1 || slaveIdNum > 247) {
        return res.status(400).json({ error: 'Bad Request', message: 'Modbus slave ID must be between 1 and 247' });
      }
    }
    if (polling_interval_ms !== undefined && polling_interval_ms !== null && polling_interval_ms !== '') {
      const pollingMs = parseInt(polling_interval_ms);
      if (isNaN(pollingMs) || pollingMs < 100 || pollingMs > 60000) {
        return res.status(400).json({ error: 'Bad Request', message: 'Polling interval must be between 100ms and 60000ms' });
      }
    }
  }

  // Serialize register_mappings to JSON if it's an array/object
  let registerMappingsJson = equipment.register_mappings;
  if (register_mappings !== undefined) {
    registerMappingsJson = register_mappings ?
      (typeof register_mappings === 'string' ? register_mappings : JSON.stringify(register_mappings)) : null;
  }

  db.prepare(
    "UPDATE equipment SET name = ?, description = ?, type = ?, protocol = ?, address = ?, enabled = ?, slave_id = ?, polling_interval_ms = ?, register_mappings = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    name ?? equipment.name,
    description ?? equipment.description,
    type ?? equipment.type,
    protocol ?? equipment.protocol,
    address ?? equipment.address,
    enabled !== undefined ? (enabled ? 1 : 0) : equipment.enabled,
    slave_id !== undefined ? (slave_id ? parseInt(slave_id) : null) : equipment.slave_id,
    polling_interval_ms !== undefined ? (polling_interval_ms ? parseInt(polling_interval_ms) : 1000) : equipment.polling_interval_ms,
    registerMappingsJson,
    equipmentId
  );

  const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  // Parse register_mappings for response
  if (updated.register_mappings) {
    try {
      updated.register_mappings = JSON.parse(updated.register_mappings);
    } catch (e) {
      // Keep as string if not valid JSON
    }
  }

  // Queue for cloud sync
  queueForSync('equipment', updated.id, 'update', updated);

  global.broadcast('equipment_updated', updated);

  res.json(updated);
});

// DELETE /api/equipment/:id - Delete equipment
router.delete('/:id', requireRole('admin'), (req, res) => {
  const equipmentId = parseInt(req.params.id);

  // Get equipment info before deletion for sync queue
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);

  const result = db.prepare('DELETE FROM equipment WHERE id = ?').run(equipmentId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  // Queue for cloud sync
  if (equipment) {
    queueForSync('equipment', equipmentId, 'delete', { id: equipmentId, name: equipment.name });
  }

  global.broadcast('equipment_deleted', { id: equipmentId });

  res.json({ message: 'Equipment deleted successfully' });
});

// POST /api/equipment/scan - Discover equipment (Modbus TCP Scanner)
router.post('/scan', requireRole('admin', 'operator'), async (req, res) => {
  const { subnet, ports, timeout, scanType = 'network' } = req.body;

  try {
    const { scanNetwork, quickScan, getLocalNetworks } = require('../services/modbusScanner');

    let discovered = [];
    let scanInfo = {};

    if (scanType === 'quick' && subnet) {
      // Quick scan of a specific IP or range
      discovered = await quickScan(subnet, { ports, timeout });
      scanInfo = {
        type: 'quick',
        target: subnet
      };
    } else {
      // Full network scan
      const networks = getLocalNetworks();
      scanInfo = {
        type: 'network',
        networks: networks.map(n => n.cidr || `${n.address}/${n.netmask}`)
      };

      discovered = await scanNetwork({
        subnet,
        ports,
        timeout: timeout || 1000
      });
    }

    // Get existing equipment addresses to filter out already-added devices
    const existingEquipment = db.prepare('SELECT address FROM equipment WHERE address IS NOT NULL').all();
    const existingAddresses = new Set(existingEquipment.map(e => e.address));

    // Transform discovered devices to a more useful format
    const devices = discovered.map(device => {
      const address = `${device.ip}:${device.port}`;
      return {
        ip: device.ip,
        port: device.port,
        address,
        protocol: 'modbus',
        responsive: device.responsive,
        deviceInfo: device.deviceInfo,
        alreadyAdded: existingAddresses.has(address),
        suggestedName: device.deviceInfo?.ProductName ||
                       device.deviceInfo?.VendorName ||
                       `Modbus Device (${device.ip})`
      };
    });

    // Filter out already added devices by default, but include the info
    const newDevices = devices.filter(d => !d.alreadyAdded);
    const existingDevicesFound = devices.filter(d => d.alreadyAdded);

    res.json({
      message: `Scan completed. Found ${devices.length} Modbus device(s).`,
      discovered: newDevices,
      existingDevicesFound: existingDevicesFound.length,
      scanInfo,
      totalFound: devices.length
    });

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({
      error: 'Scan Failed',
      message: err.message || 'Failed to scan for Modbus devices'
    });
  }
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

// POST /api/equipment/:id/readings - Submit a new sensor reading
router.post('/:id/readings', requireRole('admin', 'operator'), (req, res) => {
  const { value, unit } = req.body;
  const equipmentId = req.params.id;

  // Verify equipment exists
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment) {
    return res.status(404).json({ error: 'Not Found', message: 'Equipment not found' });
  }

  if (value === undefined) {
    return res.status(400).json({ error: 'Bad Request', message: 'Value is required' });
  }

  const timestamp = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO readings (equipment_id, value, unit, timestamp) VALUES (?, ?, ?, ?)'
  ).run(equipmentId, value, unit || '', timestamp);

  const reading = {
    id: result.lastInsertRowid,
    equipment_id: parseInt(equipmentId),
    equipment_name: equipment.name,
    equipment_status: equipment.status,
    value,
    unit: unit || '',
    timestamp
  };

  // Broadcast the new reading to all WebSocket clients
  global.broadcast('sensor_reading', reading);

  res.status(201).json(reading);
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

// POST /api/equipment/scan-slaves - Scan for Modbus slave devices
// Scans slave IDs 1-247 (or custom range) to discover RTU devices behind a gateway
router.post('/scan-slaves', requireRole('admin', 'operator'), async (req, res) => {
  const {
    host,
    port = 502,
    startSlaveId = 1,
    endSlaveId = 247,
    timeout = 500,
    batchSize = 10
  } = req.body;

  // Validate host
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (!host || !ipRegex.test(host)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid host IP address is required' });
  }

  // Validate port
  const portNum = parseInt(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'Bad Request', message: 'Port must be between 1 and 65535' });
  }

  // Validate slave ID range
  const startId = parseInt(startSlaveId);
  const endId = parseInt(endSlaveId);
  if (isNaN(startId) || startId < 1 || startId > 247) {
    return res.status(400).json({ error: 'Bad Request', message: 'Start slave ID must be between 1 and 247' });
  }
  if (isNaN(endId) || endId < 1 || endId > 247) {
    return res.status(400).json({ error: 'Bad Request', message: 'End slave ID must be between 1 and 247' });
  }
  if (startId > endId) {
    return res.status(400).json({ error: 'Bad Request', message: 'Start slave ID must be less than or equal to end slave ID' });
  }

  // Validate timeout
  const timeoutMs = parseInt(timeout);
  if (isNaN(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    return res.status(400).json({ error: 'Bad Request', message: 'Timeout must be between 100ms and 5000ms' });
  }

  console.log(`[Modbus Scan] Starting slave scan on ${host}:${portNum} for IDs ${startId}-${endId}`);

  const discoveredSlaves = [];
  const totalToScan = endId - startId + 1;
  let scannedCount = 0;

  // Scan function for a single slave ID
  const scanSlave = async (slaveId) => {
    const startTime = Date.now();
    try {
      // Try to read holding registers at address 0 (common identification area)
      // Using a short timeout for quick scanning
      const data = await modbusTcpClient.readHoldingRegisters(
        host,
        portNum,
        slaveId,
        0, // Starting address
        1, // Read just 1 register to check if device responds
        { timeout: timeoutMs, retries: 1 }
      );

      const responseTime = Date.now() - startTime;
      console.log(`[Modbus Scan] Slave ${slaveId} responded in ${responseTime}ms`);

      return {
        slaveId,
        responding: true,
        responseTime,
        sampleData: data
      };
    } catch (error) {
      // Device didn't respond or error occurred
      return {
        slaveId,
        responding: false,
        error: error.message
      };
    }
  };

  // Process slaves in batches for efficiency
  const batchSizeNum = Math.min(parseInt(batchSize) || 10, 50);

  for (let i = startId; i <= endId; i += batchSizeNum) {
    const batchEnd = Math.min(i + batchSizeNum - 1, endId);
    const batch = [];

    for (let slaveId = i; slaveId <= batchEnd; slaveId++) {
      batch.push(scanSlave(slaveId));
    }

    // Wait for batch to complete
    const results = await Promise.all(batch);

    // Add responding slaves to discovered list
    for (const result of results) {
      scannedCount++;
      if (result.responding) {
        discoveredSlaves.push(result);
      }
    }
  }

  console.log(`[Modbus Scan] Scan complete. Found ${discoveredSlaves.length} responding slaves out of ${totalToScan} scanned`);

  // Disconnect after scan to clean up connection
  await modbusTcpClient.disconnectDevice(host, portNum, 1);

  res.json({
    success: true,
    host,
    port: portNum,
    scanned: {
      start: startId,
      end: endId,
      total: totalToScan
    },
    discovered: discoveredSlaves,
    count: discoveredSlaves.length
  });
});

// POST /api/equipment/scan-slaves/create-bulk - Create equipment entries from discovered slaves
router.post('/scan-slaves/create-bulk', requireRole('admin', 'operator'), (req, res) => {
  const { host, port, slaves, namePrefix = 'Modbus Device' } = req.body;

  if (!host || !Array.isArray(slaves) || slaves.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Host and slaves array are required' });
  }

  const createdEquipment = [];
  const errors = [];

  for (const slave of slaves) {
    const slaveId = parseInt(slave.slaveId);
    if (isNaN(slaveId) || slaveId < 1 || slaveId > 247) {
      errors.push({ slaveId: slave.slaveId, error: 'Invalid slave ID' });
      continue;
    }

    // Check if equipment with same address and slave ID already exists
    const existing = db.prepare(
      'SELECT id FROM equipment WHERE address = ? AND slave_id = ?'
    ).get(`${host}:${port}`, slaveId);

    if (existing) {
      errors.push({ slaveId, error: 'Equipment with this address and slave ID already exists' });
      continue;
    }

    try {
      const name = slave.name || `${namePrefix} ${slaveId}`;
      const result = db.prepare(
        'INSERT INTO equipment (name, description, type, protocol, address, slave_id, status, polling_interval_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        name,
        slave.description || `Modbus device discovered at slave ID ${slaveId}`,
        slave.type || 'sensor',
        'modbus',
        `${host}:${port}`,
        slaveId,
        'offline',
        slave.pollingInterval || 1000
      );

      const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(result.lastInsertRowid);
      createdEquipment.push(equipment);

      // Queue for cloud sync
      queueForSync('equipment', equipment.id, 'create', equipment);
    } catch (error) {
      errors.push({ slaveId, error: error.message });
    }
  }

  res.status(201).json({
    success: true,
    created: createdEquipment,
    count: createdEquipment.length,
    errors: errors.length > 0 ? errors : undefined
  });
});

module.exports = router;
