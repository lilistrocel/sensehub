/**
 * Modbus TCP API Routes
 *
 * Exposes ModbusTcpClient functionality through REST API endpoints
 */

const express = require('express');
const router = express.Router();
const { modbusTcpClient } = require('../services/ModbusTcpClient');
const { requireRole } = require('../middleware/auth');

// Helper to validate IP address
const isValidIp = (ip) => {
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipRegex.test(ip);
};

// Helper to validate port
const isValidPort = (port) => {
  const p = parseInt(port, 10);
  return Number.isInteger(p) && p > 0 && p <= 65535;
};

// Middleware to validate modbus request params
const validateModbusParams = (req, res, next) => {
  const { host, port = 502, unitId = 1, address, quantity } = req.body;

  if (!host || !isValidIp(host)) {
    return res.status(400).json({ error: 'Invalid or missing host IP address' });
  }

  if (!isValidPort(port)) {
    return res.status(400).json({ error: 'Invalid port number (1-65535)' });
  }

  const uid = parseInt(unitId, 10);
  if (!Number.isInteger(uid) || uid < 0 || uid > 255) {
    return res.status(400).json({ error: 'Invalid unit ID (0-255)' });
  }

  if (address !== undefined) {
    const addr = parseInt(address, 10);
    if (!Number.isInteger(addr) || addr < 0 || addr > 65535) {
      return res.status(400).json({ error: 'Invalid address (0-65535)' });
    }
  }

  if (quantity !== undefined) {
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 125) {
      return res.status(400).json({ error: 'Invalid quantity (1-125)' });
    }
  }

  // Attach parsed values to request
  req.modbusParams = {
    host,
    port: parseInt(port, 10),
    unitId: parseInt(unitId, 10),
    address: address !== undefined ? parseInt(address, 10) : undefined,
    quantity: quantity !== undefined ? parseInt(quantity, 10) : undefined
  };

  next();
};

// ==========================================
// Read Endpoints
// ==========================================

/**
 * POST /api/modbus/read/coils
 * FC01 - Read Coils
 * Body: { host, port?, unitId?, address, quantity }
 */
router.post('/read/coils', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address, quantity } = req.modbusParams;

    if (address === undefined || quantity === undefined) {
      return res.status(400).json({ error: 'address and quantity are required' });
    }

    const data = await modbusTcpClient.readCoils(host, port, unitId, address, quantity);

    res.json({
      success: true,
      functionCode: 1,
      functionName: 'Read Coils',
      host,
      port,
      unitId,
      address,
      quantity,
      data
    });
  } catch (error) {
    console.error('[Modbus API] Read Coils error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/read/discrete-inputs
 * FC02 - Read Discrete Inputs
 * Body: { host, port?, unitId?, address, quantity }
 */
router.post('/read/discrete-inputs', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address, quantity } = req.modbusParams;

    if (address === undefined || quantity === undefined) {
      return res.status(400).json({ error: 'address and quantity are required' });
    }

    const data = await modbusTcpClient.readDiscreteInputs(host, port, unitId, address, quantity);

    res.json({
      success: true,
      functionCode: 2,
      functionName: 'Read Discrete Inputs',
      host,
      port,
      unitId,
      address,
      quantity,
      data
    });
  } catch (error) {
    console.error('[Modbus API] Read Discrete Inputs error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/read/holding-registers
 * FC03 - Read Holding Registers
 * Body: { host, port?, unitId?, address, quantity }
 */
router.post('/read/holding-registers', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address, quantity } = req.modbusParams;

    if (address === undefined || quantity === undefined) {
      return res.status(400).json({ error: 'address and quantity are required' });
    }

    const data = await modbusTcpClient.readHoldingRegisters(host, port, unitId, address, quantity);

    res.json({
      success: true,
      functionCode: 3,
      functionName: 'Read Holding Registers',
      host,
      port,
      unitId,
      address,
      quantity,
      data
    });
  } catch (error) {
    console.error('[Modbus API] Read Holding Registers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/read/input-registers
 * FC04 - Read Input Registers
 * Body: { host, port?, unitId?, address, quantity }
 */
router.post('/read/input-registers', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address, quantity } = req.modbusParams;

    if (address === undefined || quantity === undefined) {
      return res.status(400).json({ error: 'address and quantity are required' });
    }

    const data = await modbusTcpClient.readInputRegisters(host, port, unitId, address, quantity);

    res.json({
      success: true,
      functionCode: 4,
      functionName: 'Read Input Registers',
      host,
      port,
      unitId,
      address,
      quantity,
      data
    });
  } catch (error) {
    console.error('[Modbus API] Read Input Registers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Write Endpoints
// ==========================================

/**
 * POST /api/modbus/write/coil
 * FC05 - Write Single Coil
 * Body: { host, port?, unitId?, address, value }
 */
router.post('/write/coil', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address } = req.modbusParams;
    const { value } = req.body;

    if (address === undefined) {
      return res.status(400).json({ error: 'address is required' });
    }

    if (value === undefined || typeof value !== 'boolean') {
      return res.status(400).json({ error: 'value must be a boolean (true/false)' });
    }

    const result = await modbusTcpClient.writeSingleCoil(host, port, unitId, address, value);

    res.json({
      success: true,
      functionCode: 5,
      functionName: 'Write Single Coil',
      host,
      port,
      unitId,
      ...result
    });
  } catch (error) {
    console.error('[Modbus API] Write Single Coil error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/write/register
 * FC06 - Write Single Register
 * Body: { host, port?, unitId?, address, value }
 */
router.post('/write/register', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address } = req.modbusParams;
    const { value } = req.body;

    if (address === undefined) {
      return res.status(400).json({ error: 'address is required' });
    }

    const val = parseInt(value, 10);
    if (!Number.isInteger(val) || val < 0 || val > 65535) {
      return res.status(400).json({ error: 'value must be an integer (0-65535)' });
    }

    const result = await modbusTcpClient.writeSingleRegister(host, port, unitId, address, val);

    res.json({
      success: true,
      functionCode: 6,
      functionName: 'Write Single Register',
      host,
      port,
      unitId,
      ...result
    });
  } catch (error) {
    console.error('[Modbus API] Write Single Register error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/write/coils
 * FC15 - Write Multiple Coils
 * Body: { host, port?, unitId?, address, values }
 */
router.post('/write/coils', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address } = req.modbusParams;
    const { values } = req.body;

    if (address === undefined) {
      return res.status(400).json({ error: 'address is required' });
    }

    if (!Array.isArray(values) || values.length === 0 || values.length > 1968) {
      return res.status(400).json({ error: 'values must be an array of booleans (1-1968 items)' });
    }

    if (!values.every(v => typeof v === 'boolean')) {
      return res.status(400).json({ error: 'all values must be booleans (true/false)' });
    }

    const result = await modbusTcpClient.writeMultipleCoils(host, port, unitId, address, values);

    res.json({
      success: true,
      functionCode: 15,
      functionName: 'Write Multiple Coils',
      host,
      port,
      unitId,
      ...result
    });
  } catch (error) {
    console.error('[Modbus API] Write Multiple Coils error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/write/registers
 * FC16 - Write Multiple Registers
 * Body: { host, port?, unitId?, address, values }
 */
router.post('/write/registers', requireRole('admin', 'operator'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId, address } = req.modbusParams;
    const { values } = req.body;

    if (address === undefined) {
      return res.status(400).json({ error: 'address is required' });
    }

    if (!Array.isArray(values) || values.length === 0 || values.length > 123) {
      return res.status(400).json({ error: 'values must be an array of integers (1-123 items)' });
    }

    const parsedValues = values.map(v => parseInt(v, 10));
    if (!parsedValues.every(v => Number.isInteger(v) && v >= 0 && v <= 65535)) {
      return res.status(400).json({ error: 'all values must be integers (0-65535)' });
    }

    const result = await modbusTcpClient.writeMultipleRegisters(host, port, unitId, address, parsedValues);

    res.json({
      success: true,
      functionCode: 16,
      functionName: 'Write Multiple Registers',
      host,
      port,
      unitId,
      ...result
    });
  } catch (error) {
    console.error('[Modbus API] Write Multiple Registers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Connection Management Endpoints
// ==========================================

/**
 * GET /api/modbus/connections
 * Get all active Modbus connections
 */
router.get('/connections', requireRole('admin', 'operator'), (req, res) => {
  try {
    const connections = modbusTcpClient.getActiveConnections();
    res.json({
      success: true,
      connections,
      count: connections.length
    });
  } catch (error) {
    console.error('[Modbus API] Get connections error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/modbus/connection/status
 * Get status of a specific connection
 * Query: ?host=IP&port=PORT&unitId=ID
 */
router.get('/connection/status', requireRole('admin', 'operator'), (req, res) => {
  try {
    const { host, port = 502, unitId = 1 } = req.query;

    if (!host || !isValidIp(host)) {
      return res.status(400).json({ error: 'Invalid or missing host IP address' });
    }

    const status = modbusTcpClient.getConnectionStatus(
      host,
      parseInt(port, 10),
      parseInt(unitId, 10)
    );

    res.json({
      success: true,
      host,
      port: parseInt(port, 10),
      unitId: parseInt(unitId, 10),
      ...status
    });
  } catch (error) {
    console.error('[Modbus API] Get connection status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/modbus/connection/disconnect
 * Force disconnect a specific connection
 * Body: { host, port?, unitId? }
 */
router.post('/connection/disconnect', requireRole('admin'), validateModbusParams, async (req, res) => {
  try {
    const { host, port, unitId } = req.modbusParams;

    const disconnected = await modbusTcpClient.disconnectDevice(host, port, unitId);

    res.json({
      success: true,
      disconnected,
      host,
      port,
      unitId,
      message: disconnected ? 'Connection closed' : 'Connection not found'
    });
  } catch (error) {
    console.error('[Modbus API] Disconnect error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
