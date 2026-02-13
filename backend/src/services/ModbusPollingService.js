/**
 * ModbusPollingService - Background service for polling Modbus devices
 *
 * Features:
 * - Per-device polling intervals
 * - Register mapping support
 * - Database updates for current_value and status
 * - Readings history recording
 * - WebSocket broadcasting for real-time UI updates
 * - Exponential backoff for error recovery
 */

const { db } = require('../utils/database');
const { modbusTcpClient } = require('./ModbusTcpClient');

/**
 * Device polling state tracker
 */
class DevicePollingState {
  constructor(equipment) {
    this.equipmentId = equipment.id;
    this.name = equipment.name;
    this.address = equipment.address;
    this.slaveId = equipment.slave_id || 1;
    this.pollingInterval = equipment.polling_interval_ms || 1000;
    this.registerMappings = this.parseRegisterMappings(equipment.register_mappings);

    // Error tracking for exponential backoff
    this.consecutiveErrors = 0;
    this.maxBackoffMs = 60000; // Max 1 minute backoff
    this.baseBackoffMs = 1000; // Start with 1 second
    this.lastErrorTime = null;
    this.isBackingOff = false;

    // Polling state
    this.lastPollTime = null;
    this.isPolling = false;
    this.timerId = null;
  }

  parseRegisterMappings(mappings) {
    if (!mappings) return [];
    if (typeof mappings === 'string') {
      try {
        return JSON.parse(mappings);
      } catch (e) {
        console.error(`[Polling] Invalid register_mappings JSON for equipment ${this.equipmentId}:`, e.message);
        return [];
      }
    }
    return Array.isArray(mappings) ? mappings : [];
  }

  /**
   * Parse address into host and port
   */
  parseAddress() {
    if (!this.address) return null;

    const parts = this.address.split(':');
    if (parts.length !== 2) return null;

    const host = parts[0];
    const port = parseInt(parts[1], 10);

    if (isNaN(port)) return null;

    return { host, port };
  }

  /**
   * Calculate backoff delay based on consecutive errors
   */
  getBackoffDelay() {
    if (this.consecutiveErrors === 0) return 0;

    // Exponential backoff: baseDelay * 2^(errors-1)
    const delay = Math.min(
      this.baseBackoffMs * Math.pow(2, this.consecutiveErrors - 1),
      this.maxBackoffMs
    );

    return delay;
  }

  /**
   * Record successful poll - reset error state
   */
  recordSuccess() {
    this.consecutiveErrors = 0;
    this.lastErrorTime = null;
    this.isBackingOff = false;
  }

  /**
   * Record failed poll - increment error counter
   */
  recordError() {
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();
    this.isBackingOff = true;
  }

  /**
   * Get effective polling interval (includes backoff if applicable)
   */
  getEffectiveInterval() {
    const backoff = this.getBackoffDelay();
    return Math.max(this.pollingInterval, backoff);
  }
}

/**
 * ModbusPollingService - Main service class
 */
class ModbusPollingService {
  constructor() {
    // Map of equipment ID to DevicePollingState
    this.devices = new Map();

    // Service state
    this.isRunning = false;
    this.refreshInterval = null;
    this.deviceRefreshIntervalMs = 30000; // Check for device changes every 30 seconds
  }

  /**
   * Start the polling service
   */
  async start() {
    if (this.isRunning) {
      console.log('[Polling] Service already running');
      return;
    }

    console.log('[Polling] Starting ModbusPollingService...');
    this.isRunning = true;

    // Load initial devices
    await this.loadDevices();

    // Start polling all devices
    this.startAllPolling();

    // Set up periodic device refresh (to pick up new devices or config changes)
    this.refreshInterval = setInterval(() => {
      this.refreshDevices();
    }, this.deviceRefreshIntervalMs);

    console.log(`[Polling] Service started with ${this.devices.size} Modbus devices`);
  }

  /**
   * Stop the polling service
   */
  async stop() {
    if (!this.isRunning) {
      console.log('[Polling] Service not running');
      return;
    }

    console.log('[Polling] Stopping ModbusPollingService...');
    this.isRunning = false;

    // Clear device refresh interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    // Stop all device polling
    for (const [equipmentId, state] of this.devices) {
      this.stopDevicePolling(equipmentId);
    }

    this.devices.clear();
    console.log('[Polling] Service stopped');
  }

  /**
   * Load all enabled Modbus devices from database
   */
  async loadDevices() {
    try {
      const equipment = db.prepare(`
        SELECT * FROM equipment
        WHERE protocol = 'modbus'
        AND enabled = 1
        AND address IS NOT NULL
        AND address != ''
      `).all();

      for (const item of equipment) {
        const state = new DevicePollingState(item);
        this.devices.set(item.id, state);
      }

      console.log(`[Polling] Loaded ${equipment.length} Modbus devices`);
    } catch (error) {
      console.error('[Polling] Error loading devices:', error.message);
    }
  }

  /**
   * Refresh device list (pick up new devices or config changes)
   */
  async refreshDevices() {
    if (!this.isRunning) return;

    try {
      const equipment = db.prepare(`
        SELECT * FROM equipment
        WHERE protocol = 'modbus'
        AND enabled = 1
        AND address IS NOT NULL
        AND address != ''
      `).all();

      const currentIds = new Set(equipment.map(e => e.id));
      const existingIds = new Set(this.devices.keys());

      // Remove devices that no longer exist or are disabled
      for (const id of existingIds) {
        if (!currentIds.has(id)) {
          console.log(`[Polling] Removing device ${id} (no longer active)`);
          this.stopDevicePolling(id);
          this.devices.delete(id);
        }
      }

      // Add new devices or update existing
      for (const item of equipment) {
        if (!existingIds.has(item.id)) {
          console.log(`[Polling] Adding new device ${item.id} (${item.name})`);
          const state = new DevicePollingState(item);
          this.devices.set(item.id, state);
          this.startDevicePolling(item.id);
        } else {
          // Update configuration if changed
          const existingState = this.devices.get(item.id);
          if (existingState.pollingInterval !== item.polling_interval_ms ||
              existingState.address !== item.address ||
              JSON.stringify(existingState.registerMappings) !== item.register_mappings) {
            console.log(`[Polling] Updating device ${item.id} configuration`);
            this.stopDevicePolling(item.id);
            const newState = new DevicePollingState(item);
            newState.consecutiveErrors = existingState.consecutiveErrors;
            this.devices.set(item.id, newState);
            this.startDevicePolling(item.id);
          }
        }
      }
    } catch (error) {
      console.error('[Polling] Error refreshing devices:', error.message);
    }
  }

  /**
   * Start polling all devices
   */
  startAllPolling() {
    for (const [equipmentId, state] of this.devices) {
      this.startDevicePolling(equipmentId);
    }
  }

  /**
   * Start polling a specific device
   */
  startDevicePolling(equipmentId) {
    const state = this.devices.get(equipmentId);
    if (!state) return;

    // Clear existing timer
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }

    // Schedule next poll
    this.scheduleNextPoll(equipmentId);
  }

  /**
   * Stop polling a specific device
   */
  stopDevicePolling(equipmentId) {
    const state = this.devices.get(equipmentId);
    if (!state) return;

    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    state.isPolling = false;
  }

  /**
   * Schedule the next poll for a device
   */
  scheduleNextPoll(equipmentId) {
    if (!this.isRunning) return;

    const state = this.devices.get(equipmentId);
    if (!state) return;

    const interval = state.getEffectiveInterval();

    state.timerId = setTimeout(async () => {
      await this.pollDevice(equipmentId);
      this.scheduleNextPoll(equipmentId);
    }, interval);
  }

  /**
   * Poll a single device - read all configured registers
   */
  async pollDevice(equipmentId) {
    const state = this.devices.get(equipmentId);
    if (!state || state.isPolling) return;

    const addressInfo = state.parseAddress();
    if (!addressInfo) {
      console.error(`[Polling] Invalid address for device ${equipmentId}: ${state.address}`);
      return;
    }

    // Check if device has register mappings configured
    if (state.registerMappings.length === 0) {
      // No register mappings - try to do a basic connectivity check
      await this.pollDeviceBasic(equipmentId, state, addressInfo);
      return;
    }

    state.isPolling = true;
    state.lastPollTime = Date.now();

    try {
      const readings = [];
      const { host, port } = addressInfo;

      // Read each configured register mapping
      for (const mapping of state.registerMappings) {
        try {
          const value = await this.readRegister(host, port, state.slaveId, mapping);

          if (value !== null) {
            readings.push({
              name: mapping.name || `Register ${mapping.address}`,
              value,
              unit: mapping.unit || '',
              registerAddress: mapping.address,
              functionCode: mapping.functionCode || 3
            });
          }
        } catch (regError) {
          console.error(`[Polling] Error reading register ${mapping.address} on device ${equipmentId}:`, regError.message);
        }
      }

      // If we got any readings, update the device
      if (readings.length > 0) {
        await this.updateDeviceWithReadings(equipmentId, state, readings);
        state.recordSuccess();
      } else {
        // No readings obtained - might be a transient error
        throw new Error('No readings obtained from device');
      }

    } catch (error) {
      console.error(`[Polling] Error polling device ${equipmentId}:`, error.message);
      state.recordError();
      await this.handleDeviceError(equipmentId, state, error);
    } finally {
      state.isPolling = false;
    }
  }

  /**
   * Basic poll for devices without register mappings
   */
  async pollDeviceBasic(equipmentId, state, addressInfo) {
    state.isPolling = true;
    state.lastPollTime = Date.now();

    try {
      const { host, port } = addressInfo;

      // Try to read a single holding register to check connectivity
      const data = await modbusTcpClient.readHoldingRegisters(
        host,
        port,
        state.slaveId,
        0, // Address 0
        1, // 1 register
        { timeout: 5000, retries: 1 }
      );

      // Device is reachable - update status
      await this.updateDeviceStatus(equipmentId, 'online');
      state.recordSuccess();

      // Broadcast status update
      this.broadcastDeviceStatus(equipmentId, state.name, 'online');

    } catch (error) {
      console.error(`[Polling] Basic poll failed for device ${equipmentId}:`, error.message);
      state.recordError();
      await this.handleDeviceError(equipmentId, state, error);
    } finally {
      state.isPolling = false;
    }
  }

  /**
   * Read a single register based on mapping configuration
   */
  async readRegister(host, port, unitId, mapping) {
    const address = parseInt(mapping.address, 10);
    const quantity = parseInt(mapping.quantity, 10) || 1;
    const functionCode = parseInt(mapping.functionCode, 10) || 3;

    let data;

    switch (functionCode) {
      case 1: // Read Coils
        data = await modbusTcpClient.readCoils(host, port, unitId, address, quantity);
        return data[0] ? 1 : 0;

      case 2: // Read Discrete Inputs
        data = await modbusTcpClient.readDiscreteInputs(host, port, unitId, address, quantity);
        return data[0] ? 1 : 0;

      case 3: // Read Holding Registers
        data = await modbusTcpClient.readHoldingRegisters(host, port, unitId, address, quantity);
        return this.interpretRegisterValue(data, mapping);

      case 4: // Read Input Registers
        data = await modbusTcpClient.readInputRegisters(host, port, unitId, address, quantity);
        return this.interpretRegisterValue(data, mapping);

      default:
        console.error(`[Polling] Unsupported function code: ${functionCode}`);
        return null;
    }
  }

  /**
   * Interpret register value based on data type configuration
   */
  interpretRegisterValue(data, mapping) {
    if (!data || data.length === 0) return null;

    const dataType = (mapping.dataType || 'uint16').toLowerCase();

    switch (dataType) {
      case 'uint16':
        return data[0];

      case 'int16':
        return data[0] > 32767 ? data[0] - 65536 : data[0];

      case 'uint32':
        if (data.length >= 2) {
          return (data[0] << 16) | data[1];
        }
        return data[0];

      case 'int32':
        if (data.length >= 2) {
          const unsigned = (data[0] << 16) | data[1];
          return unsigned > 2147483647 ? unsigned - 4294967296 : unsigned;
        }
        return data[0];

      case 'float32':
        if (data.length >= 2) {
          const buffer = Buffer.alloc(4);
          buffer.writeUInt16BE(data[0], 0);
          buffer.writeUInt16BE(data[1], 2);
          return buffer.readFloatBE(0);
        }
        return data[0];

      case 'boolean':
        return data[0] !== 0 ? 1 : 0;

      default:
        return data[0];
    }
  }

  /**
   * Apply scaling and calibration to raw value
   */
  applyCalibration(value, equipment, mapping) {
    let result = value;

    // Apply mapping scale factor if present
    if (mapping.scale !== undefined && mapping.scale !== null) {
      result *= parseFloat(mapping.scale);
    }

    // Apply mapping offset if present
    if (mapping.offset !== undefined && mapping.offset !== null) {
      result += parseFloat(mapping.offset);
    }

    // Apply equipment-level calibration
    if (equipment) {
      if (equipment.calibration_scale !== undefined && equipment.calibration_scale !== null) {
        result *= equipment.calibration_scale;
      }
      if (equipment.calibration_offset !== undefined && equipment.calibration_offset !== null) {
        result += equipment.calibration_offset;
      }
    }

    // Round to reasonable precision
    return Math.round(result * 1000) / 1000;
  }

  /**
   * Update device with new readings
   */
  async updateDeviceWithReadings(equipmentId, state, readings) {
    try {
      // Get equipment for calibration values
      const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId);
      if (!equipment) return;

      const timestamp = new Date().toISOString();

      // Find the primary reading (first one, or one marked as primary)
      let primaryReading = readings.find(r => r.isPrimary) || readings[0];

      // Apply calibration to primary reading
      const calibratedValue = this.applyCalibration(
        primaryReading.value,
        equipment,
        state.registerMappings.find(m => m.name === primaryReading.name) || {}
      );

      // Update equipment status and last_reading
      db.prepare(`
        UPDATE equipment
        SET status = 'online',
            last_reading = ?,
            last_communication = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        calibratedValue.toString(),
        timestamp,
        timestamp,
        equipmentId
      );

      // Record readings to history
      for (const reading of readings) {
        const mapping = state.registerMappings.find(m => m.name === reading.name) || {};
        const calibratedReadingValue = this.applyCalibration(reading.value, equipment, mapping);

        db.prepare(`
          INSERT INTO readings (equipment_id, value, unit, timestamp)
          VALUES (?, ?, ?, ?)
        `).run(
          equipmentId,
          calibratedReadingValue,
          reading.unit,
          timestamp
        );
      }

      // Broadcast updates via WebSocket
      const broadcastData = {
        equipmentId,
        name: state.name,
        status: 'online',
        lastReading: calibratedValue,
        readings: readings.map(r => ({
          name: r.name,
          value: this.applyCalibration(
            r.value,
            equipment,
            state.registerMappings.find(m => m.name === r.name) || {}
          ),
          unit: r.unit
        })),
        timestamp
      };

      if (global.broadcast) {
        global.broadcast('equipment_reading', broadcastData);
        global.broadcast('sensor_reading', {
          equipment_id: equipmentId,
          equipment_name: state.name,
          value: calibratedValue,
          unit: readings[0].unit,
          timestamp
        });
      }

    } catch (error) {
      console.error(`[Polling] Error updating device ${equipmentId}:`, error.message);
    }
  }

  /**
   * Update device status in database
   */
  async updateDeviceStatus(equipmentId, status) {
    try {
      const timestamp = new Date().toISOString();

      db.prepare(`
        UPDATE equipment
        SET status = ?,
            last_communication = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, timestamp, timestamp, equipmentId);

    } catch (error) {
      console.error(`[Polling] Error updating status for device ${equipmentId}:`, error.message);
    }
  }

  /**
   * Handle device communication error
   */
  async handleDeviceError(equipmentId, state, error) {
    try {
      const timestamp = new Date().toISOString();
      const backoffDelay = state.getBackoffDelay();

      // Update equipment status to error/warning based on consecutive errors
      const status = state.consecutiveErrors >= 3 ? 'error' : 'warning';

      db.prepare(`
        UPDATE equipment
        SET status = ?,
            error_log = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, error.message, timestamp, equipmentId);

      // Log error to equipment_errors table
      db.prepare(`
        INSERT INTO equipment_errors (equipment_id, error_type, message, details)
        VALUES (?, 'connection', ?, ?)
      `).run(
        equipmentId,
        error.message,
        JSON.stringify({
          consecutiveErrors: state.consecutiveErrors,
          backoffDelay,
          address: state.address,
          slaveId: state.slaveId
        })
      );

      // Broadcast error status
      if (global.broadcast) {
        global.broadcast('equipment_error', {
          equipmentId,
          name: state.name,
          status,
          error: error.message,
          consecutiveErrors: state.consecutiveErrors,
          backoffMs: backoffDelay,
          timestamp
        });
      }

      console.log(`[Polling] Device ${equipmentId} error (${state.consecutiveErrors} consecutive). Next poll in ${backoffDelay}ms`);

    } catch (dbError) {
      console.error(`[Polling] Error handling device error for ${equipmentId}:`, dbError.message);
    }
  }

  /**
   * Broadcast device status update
   */
  broadcastDeviceStatus(equipmentId, name, status) {
    if (global.broadcast) {
      global.broadcast('equipment_status', {
        equipmentId,
        name,
        status,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get service status and statistics
   */
  getStatus() {
    const devices = [];

    for (const [id, state] of this.devices) {
      devices.push({
        equipmentId: id,
        name: state.name,
        address: state.address,
        slaveId: state.slaveId,
        pollingInterval: state.pollingInterval,
        effectiveInterval: state.getEffectiveInterval(),
        registerMappings: state.registerMappings.length,
        consecutiveErrors: state.consecutiveErrors,
        isBackingOff: state.isBackingOff,
        lastPollTime: state.lastPollTime,
        isPolling: state.isPolling
      });
    }

    return {
      isRunning: this.isRunning,
      deviceCount: this.devices.size,
      devices
    };
  }

  /**
   * Force poll a specific device (manual trigger)
   */
  async forcePoll(equipmentId) {
    const state = this.devices.get(equipmentId);
    if (!state) {
      throw new Error(`Device ${equipmentId} not found in polling service`);
    }

    // Reset backoff state for manual poll
    state.consecutiveErrors = 0;
    state.isBackingOff = false;

    await this.pollDevice(equipmentId);
    return { success: true, equipmentId };
  }
}

// Create singleton instance
const modbusPollingService = new ModbusPollingService();

// Export both the class and singleton
module.exports = {
  ModbusPollingService,
  modbusPollingService
};
