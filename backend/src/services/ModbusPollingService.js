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
const interlock = require('./RelayInterlockService');
const blockReads = require('./ModbusBlockReads');

/**
 * Errors that mean the whole device (not one register) is unreachable.
 * When one of these is hit mid-cycle there is no point trying the remaining
 * registers — each attempt would just burn another connect timeout.
 * (Defined in ModbusBlockReads so the block reader bails out the same way.)
 */
const CONNECTION_ERROR_RE = blockReads.CONNECTION_ERROR_RE;

/** Clamp a stored request_gap_ms to what the API accepts (0-5000). */
function normalizeGapMs(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(5000, n);
}

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
    this.writeOnly = !!equipment.write_only;

    // Pause between consecutive Modbus requests to this device. Some
    // controllers (SEKO Kontrol 800) drop back-to-back frames.
    this.requestGapMs = normalizeGapMs(equipment.request_gap_ms);

    // Fallback read mode per block ('split' / 'single') for blocks this
    // device would not answer whole. A new state (config reload) resets it.
    this.runModes = new Map();

    // Relay boards (any coil / FC01 mapping). The v2 relay firmware latches
    // every relay OFF after 60 s without a Modbus frame addressed to it, and
    // this service's coil poll is the only heartbeat — so these devices are
    // NEVER paused. Same predicate as updateDeviceWithReadings().
    this.hasCoils = this.registerMappings.some(
      m => m && (m.type === 'coil' || parseInt(m.functionCode, 10) === 1)
    );

    // Error tracking for exponential backoff
    this.consecutiveErrors = 0;
    this.maxBackoffMs = 600000; // Max 10 minute backoff for dead devices
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

    // Pause state (in-memory only - a backend restart resumes polling)
    this.isPaused = false;
    this.pausedAt = null;
    this.pausedBy = null;
    this.pauseReason = null;
    this.autoResumeAt = null;
    this.autoResumeTimer = null;
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

    // Clear any pause state so a stop/start cycle never leaves the service
    // stuck in a stale "paused" condition
    this.clearPauseState();

    // Stop all device polling
    for (const [equipmentId, state] of this.devices) {
      this.stopDevicePolling(equipmentId);
    }

    this.devices.clear();
    console.log('[Polling] Service stopped');
  }

  /**
   * Temporarily pause all automatic polling.
   *
   * Unlike stop(), this keeps the device inventory intact (and the 30s refresh
   * sweep running) so resume() can pick straight back up. Pause state lives in
   * memory only - a backend restart resumes polling by design.
   *
   * A safety-net auto-resume timer un-pauses after autoResumeMinutes so a
   * forgotten pause can't silently kill data collection.
   *
   * @param {Object} options
   * @param {string} options.by - Who requested the pause (email/name)
   * @param {string} options.reason - Optional free-text reason
   * @param {number} options.autoResumeMinutes - Minutes until auto-resume (1-480).
   *                 0/null/non-finite disables auto-resume. Defaults to 30.
   */
  pause({ by = null, reason = null, autoResumeMinutes = 30 } = {}) {
    if (this.isPaused) {
      console.log('[Polling] Service already paused');
      return { alreadyPaused: true, ...this.getStatus() };
    }

    // Resolve the auto-resume window. 0 / null / garbage = no auto-resume.
    let minutes = Number(autoResumeMinutes);
    if (!minutes || !Number.isFinite(minutes)) {
      minutes = null;
    } else {
      minutes = Math.min(480, Math.max(1, minutes));
    }

    this.isPaused = true;
    this.pausedAt = new Date().toISOString();
    this.pausedBy = by;
    this.pauseReason = reason;
    this.autoResumeAt = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;

    // Cancel the timers of sensor devices, but keep the map entries so
    // getStatus() still reports the real device inventory.
    //
    // SAFETY: relay boards (hasCoils) are deliberately left running. Their
    // 15 s coil poll is the heartbeat that keeps the firmware fail-safe from
    // latching every relay OFF — a pause longer than 60 s would otherwise drop
    // all relays while the cache still said ON.
    let heartbeatCount = 0;
    for (const state of this.devices.values()) {
      if (state.hasCoils) {
        if (!state.writeOnly) heartbeatCount++;
        continue;
      }
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
    }

    // Arm the safety-net auto-resume
    if (minutes) {
      this.autoResumeTimer = setTimeout(() => {
        this.autoResumeTimer = null;
        this.resume({ by: 'auto-resume' });
      }, minutes * 60000);
    }

    console.log(`[Polling] Paused by ${by || 'unknown'}${reason ? ` (${reason})` : ''}` +
      `${minutes ? ` - auto-resume in ${minutes} min` : ' - no auto-resume'}` +
      ` - ${heartbeatCount} relay board(s) keep heartbeat polling`);

    this.broadcastPauseState();
    return this.getStatus();
  }

  /**
   * Number of enabled relay boards (hasCoils, readable) that keep polling
   * through a pause as the firmware fail-safe heartbeat.
   */
  getHeartbeatDeviceCount() {
    let n = 0;
    for (const state of this.devices.values()) {
      if (state.hasCoils && !state.writeOnly) n++;
    }
    return n;
  }

  /**
   * Resume automatic polling after a pause
   *
   * @param {Object} options
   * @param {string} options.by - Who requested the resume ('auto-resume' for the safety net)
   */
  resume({ by = null } = {}) {
    if (!this.isPaused) {
      console.log('[Polling] Service not paused');
      return { alreadyRunning: true, ...this.getStatus() };
    }

    this.clearPauseState();

    // Reschedule every known device (startDevicePolling clears + reschedules).
    // If the service isn't running, leave everything stopped.
    if (this.isRunning) {
      for (const equipmentId of this.devices.keys()) {
        this.startDevicePolling(equipmentId);
      }
    }

    console.log(`[Polling] Resumed by ${by || 'unknown'} - ${this.devices.size} devices rescheduled`);

    this.broadcastPauseState();
    return this.getStatus();
  }

  /**
   * Reset all pause state and cancel the auto-resume timer
   */
  clearPauseState() {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
    this.isPaused = false;
    this.pausedAt = null;
    this.pausedBy = null;
    this.pauseReason = null;
    this.autoResumeAt = null;
  }

  /**
   * Broadcast the current pause state to connected UI clients
   */
  broadcastPauseState() {
    if (global.broadcast) {
      global.broadcast('polling_state_changed', {
        isPaused: this.isPaused,
        pausedAt: this.pausedAt,
        pausedBy: this.pausedBy,
        pauseReason: this.pauseReason,
        autoResumeAt: this.autoResumeAt,
        deviceCount: this.devices.size,
        heartbeatDeviceCount: this.getHeartbeatDeviceCount()
      });
    }
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
        this.applyRequestGap(state);
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
          const gone = this.devices.get(id);
          this.devices.delete(id);
          if (gone) { gone.requestGapMs = 0; this.applyRequestGap(gone); }
        }
      }

      // Add new devices or update existing
      for (const item of equipment) {
        if (!existingIds.has(item.id)) {
          console.log(`[Polling] Adding new device ${item.id} (${item.name})`);
          const state = new DevicePollingState(item);
          this.devices.set(item.id, state);
          this.applyRequestGap(state);
          this.startDevicePolling(item.id);
        } else {
          // Update configuration if changed
          const existingState = this.devices.get(item.id);
          if (existingState.pollingInterval !== item.polling_interval_ms ||
              existingState.address !== item.address ||
              existingState.slaveId !== (item.slave_id || 1) ||
              existingState.requestGapMs !== normalizeGapMs(item.request_gap_ms) ||
              JSON.stringify(existingState.registerMappings) !== item.register_mappings) {
            console.log(`[Polling] Updating device ${item.id} configuration`);
            this.stopDevicePolling(item.id);
            const newState = new DevicePollingState(item);
            newState.consecutiveErrors = existingState.consecutiveErrors;
            this.devices.set(item.id, newState);
            this.applyRequestGap(newState);
            this.startDevicePolling(item.id);
          }
        }
      }
    } catch (error) {
      console.error('[Polling] Error refreshing devices:', error.message);
    }
  }

  /**
   * Tell the shared Modbus client about this device's inter-request gap so
   * manual reads (/api/modbus) and relay writes to the same host:port:unit
   * respect it too, not just the poller.
   */
  applyRequestGap(state) {
    const addressInfo = state.parseAddress();
    if (!addressInfo) return;
    try {
      modbusTcpClient.setRequestGap(addressInfo.host, addressInfo.port, state.slaveId, state.requestGapMs);
    } catch (e) {
      console.error(`[Polling] Could not apply request gap for device ${state.equipmentId}:`, e.message);
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

    // Never (re)arm a sensor timer while paused - the 30s refreshDevices()
    // sweep calls this for new/changed devices and would otherwise resurrect
    // polling. Relay boards (hasCoils) are exempt: their poll is the firmware
    // fail-safe heartbeat and must keep running through a pause.
    if (this.isPaused && !state.hasCoils) return;

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

    // Paused: sensors stop here; relay boards keep their heartbeat cadence
    if (this.isPaused && !state.hasCoils) return;

    const interval = state.getEffectiveInterval();

    // Drop any timer already armed for this device so a poll that was still
    // in flight across a pause/resume can't leave two chains running
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }

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

    // Skip polling for write-only devices (they can't send responses)
    if (state.writeOnly) {
      return;
    }

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
      const { host, port } = addressInfo;

      // Read every enabled mapping with contiguous block reads (one request
      // per run of adjacent registers / coils per function code). Per-cycle
      // error bookkeeping stays per mapping: ONE log line per failed cycle
      // (in handleDeviceError), never one per register. A connection-level
      // error aborts the cycle instead of paying a connect timeout per read;
      // a Modbus exception on a block falls back to per-mapping reads.
      const result = await blockReads.readMappings(
        modbusTcpClient,
        { host, port, unitId: state.slaveId },
        state.registerMappings,
        {
          interpret: (words, mapping) => this.interpretRegisterValue(words, mapping),
          runModes: state.runModes,
          gapMs: state.requestGapMs,
          log: (msg) => console.warn(`[Polling] Device ${equipmentId} (${state.name}): ${msg}`),
        }
      );

      const readings = result.readings.map(r => ({
        name: r.mapping.name || `Register ${r.mapping.address ?? r.mapping.register}`,
        value: r.value,
        unit: r.mapping.unit || '',
        registerAddress: r.mapping.address ?? r.mapping.register,
        functionCode: r.functionCode
      }));

      // If we got any readings, update the device
      if (readings.length > 0) {
        if (result.failed > 0) {
          console.warn(`[Polling] Device ${equipmentId} (${state.name}): ${result.failed}/${result.attempted} register(s) failed this cycle: ${result.lastError?.message}`);
        }
        await this.updateDeviceWithReadings(equipmentId, state, readings);
        state.recordSuccess();
      } else {
        // No readings obtained - surface the real cause (connection error if
        // there was one) so the error log is useful
        throw result.connectionError || result.lastError || new Error('No readings obtained from device');
      }

    } catch (error) {
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
      state.recordError();
      await this.handleDeviceError(equipmentId, state, error);
    } finally {
      state.isPolling = false;
    }
  }

  /**
   * Determine the Modbus function code from a register mapping.
   * Supports both explicit functionCode and type-based lookup.
   */
  getFunctionCode(mapping) {
    return blockReads.getFunctionCode(mapping);
  }

  /**
   * Read a single register based on mapping configuration.
   * Supports both mapping formats:
   *   - {address, functionCode, quantity} (explicit)
   *   - {register, type, dataType}        (equipment template style)
   *
   * The polling cycle now goes through ModbusBlockReads.readMappings; this
   * stays for one-off callers that want a single mapping read.
   */
  async readRegister(host, port, unitId, mapping) {
    const address = parseInt(mapping.address ?? mapping.register, 10);
    const quantity = parseInt(mapping.quantity, 10) || 1;
    const functionCode = this.getFunctionCode(mapping);

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
        // 16-bit unsigned: data[0] is already 0..65535 from the Modbus reader.
        return data[0] & 0xFFFF;

      case 'int16':
        return data[0] > 32767 ? data[0] - 65536 : data[0];

      case 'uint32':
        if (data.length >= 2) {
          // Assemble the 4-byte word per byteOrder, then read as UNSIGNED.
          // (Avoids JS bitwise ops which are signed-32 and would yield a
          //  negative number when the high bit is set.)
          return this.assemble32(data, mapping).readUInt32BE(0);
        }
        return data[0] & 0xFFFF;

      case 'int32':
        if (data.length >= 2) {
          return this.assemble32(data, mapping).readInt32BE(0);
        }
        return data[0] > 32767 ? data[0] - 65536 : data[0];

      case 'float32':
        if (data.length >= 2) {
          return this.assemble32(data, mapping).readFloatBE(0);
        }
        return data[0];

      case 'boolean':
        return data[0] !== 0 ? 1 : 0;

      default:
        return data[0];
    }
  }

  /**
   * Assemble two 16-bit registers into a 4-byte big-endian Buffer, honoring
   * the per-mapping byteOrder. The bytes A,B,C,D refer to the standard
   * big-endian byte sequence of the value (A = most significant byte):
   *   - data[0] (high word) = bytes A,B   (A = high byte, B = low byte)
   *   - data[1] (low word)  = bytes C,D   (C = high byte, D = low byte)
   *
   * byteOrder values:
   *   ABCD (default) - high word first, big-endian within word (current behavior)
   *   CDAB           - word swap (low word first)
   *   BADC           - byte swap within each word
   *   DCBA           - full reverse
   *
   * The returned buffer is always laid out big-endian so callers can use
   * readUInt32BE / readInt32BE / readFloatBE.
   */
  assemble32(data, mapping) {
    const order = String(mapping.byteOrder || 'ABCD').toUpperCase();
    // Source bytes in canonical big-endian (ABCD) order.
    const A = (data[0] >> 8) & 0xFF; // high byte of high word
    const B = data[0] & 0xFF;        // low byte of high word
    const C = (data[1] >> 8) & 0xFF; // high byte of low word
    const D = data[1] & 0xFF;        // low byte of low word

    let bytes;
    switch (order) {
      case 'CDAB': bytes = [C, D, A, B]; break;
      case 'BADC': bytes = [B, A, D, C]; break;
      case 'DCBA': bytes = [D, C, B, A]; break;
      case 'ABCD':
      default:     bytes = [A, B, C, D]; break;
    }
    return Buffer.from(bytes);
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
   * Compute Vapour Pressure Deficit (kPa) from a calibrated values map.
   * Magnus/Tetens saturation-vapour-pressure equation.
   * Returns { air, leaf } or null if temperature/humidity is missing/invalid.
   *
   * Air VPD is measured directly from the SHT20. Leaf VPD assumes the canopy
   * sits LEAF_TEMP_OFFSET °C below air (horticultural standard ~2°C); it's an
   * estimate unless an IR leaf-temperature sensor is added.
   */
  computeVPD(values) {
    const LEAF_TEMP_OFFSET = 2; // °C below air for the leaf-VPD estimate

    let tAir = null, rh = null;
    for (const [name, v] of Object.entries(values)) {
      if (!v || v.value == null || isNaN(v.value)) continue;
      const n = name.toLowerCase();
      if (n.includes('vpd')) continue; // never feed a derived value back in
      if (tAir === null && /temp/.test(n)) tAir = Number(v.value);
      else if (rh === null && /(humid|\brh\b)/.test(n)) rh = Number(v.value);
    }
    if (tAir === null || rh === null) return null;
    if (rh < 0 || rh > 100) return null;

    const svp = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3)); // kPa
    const avp = svp(tAir) * (rh / 100);               // actual vapour pressure
    const air  = Math.max(0, Math.round((svp(tAir) - avp) * 100) / 100);
    const leaf = Math.max(0, Math.round((svp(tAir - LEAF_TEMP_OFFSET) - avp) * 100) / 100);
    return { air, leaf };
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

      // For relay devices, store coil states as JSON in last_reading
      const isRelayDevice = equipment.type === 'relay' ||
        state.registerMappings.some(m => (m.type === 'coil' || parseInt(m.functionCode, 10) === 1));

      const derivedReadings = []; // synthetic metrics (e.g. VPD) from calibrated values
      let lastReadingValue;
      if (isRelayDevice) {
        const relayStates = {};
        for (const reading of readings) {
          const addr = reading.registerAddress;
          relayStates[addr] = reading.value === 1;
        }

        // Hard interlock watchdog: both members of a pair ON in hardware is a
        // fault — force BOTH OFF (verified by read-back) and raise a critical alert.
        try {
          if (interlock.checkHardwareConflict(equipment, relayStates).length > 0) {
            const { turnedOff } = await interlock.resolveHardwareConflict(equipment, relayStates, modbusTcpClient, { source: 'polling' });
            for (const ch of turnedOff) {
              relayStates[ch] = false;
              const r = readings.find(x => x.registerAddress === ch);
              if (r) r.value = 0;
            }
          }
        } catch (e) {
          console.error(`[Interlock] conflict check failed for ${equipment.name}:`, e.message);
        }
        lastReadingValue = JSON.stringify({ relayStates });

        // Drift detection: compare with previous cached state
        // If a coil is ON now but the last relay_event said OFF (or vice versa),
        // and there's been no recent ON command, log it for debugging.
        try {
          let prevStates = {};
          if (equipment.last_reading) {
            const prev = JSON.parse(equipment.last_reading);
            prevStates = prev.relayStates || {};
          }

          for (const [addr, nowOn] of Object.entries(relayStates)) {
            const prevOn = prevStates[addr] === true;
            if (prevOn !== nowOn) {
              // State changed — check if this matches a known software command
              const recentEvent = db.prepare(`
                SELECT state, source, automation_id, created_at FROM relay_events
                WHERE equipment_id = ? AND channel = ?
                ORDER BY created_at DESC LIMIT 1
              `).get(equipmentId, parseInt(addr));

              const expectedState = recentEvent ? recentEvent.state : null;
              const actualStateInt = nowOn ? 1 : 0;

              // Drift = hardware state doesn't match the last known commanded state
              if (recentEvent && expectedState !== actualStateInt) {
                const gapSec = Math.round((Date.now() - new Date(recentEvent.created_at + 'Z').getTime()) / 1000);
                const detail = JSON.stringify({
                  last_event: recentEvent,
                  prev_polled: prevOn,
                  now_polled: nowOn,
                  seconds_since_last_event: gapSec
                });
                try {
                  db.prepare(`
                    INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                  `).run(equipmentId, equipment.name, parseInt(addr), expectedState, actualStateInt, 'polling_drift', detail);
                  console.warn(`[Drift] ${equipment.name} ch${addr}: expected ${expectedState?'ON':'OFF'} but hardware is ${nowOn?'ON':'OFF'} (last event ${gapSec}s ago: ${recentEvent.source})`);
                } catch (e) { /* ignore */ }
              }
            }
          }
        } catch (e) { /* drift detection failure shouldn't break polling */ }
      } else {
        // Store all calibrated readings as JSON so multi-metric sensors are preserved
        const values = {};
        for (const reading of readings) {
          const mapping = state.registerMappings.find(m => m.name === reading.name) || {};
          const calibrated = this.applyCalibration(reading.value, equipment, mapping);
          values[reading.name] = { value: calibrated, unit: reading.unit || '' };
        }

        // Derive VPD (kPa) — both Air and Leaf — when this device exposes
        // air temperature and relative humidity. Each temp/RH device yields
        // its own pair, so two SHT20s give two independent Air+Leaf readings.
        const vpd = this.computeVPD(values);
        if (vpd) {
          values['VPD Air']  = { value: vpd.air,  unit: 'kPa' };
          values['VPD Leaf'] = { value: vpd.leaf, unit: 'kPa' };
          derivedReadings.push({ name: 'VPD Air',  value: vpd.air,  unit: 'kPa' });
          derivedReadings.push({ name: 'VPD Leaf', value: vpd.leaf, unit: 'kPa' });
        }

        lastReadingValue = JSON.stringify({ values });
      }

      // Update equipment status and last_reading
      db.prepare(`
        UPDATE equipment
        SET status = 'online',
            last_reading = ?,
            last_communication = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        lastReadingValue,
        timestamp,
        timestamp,
        equipmentId
      );

      // Record readings to history (skip for relay/coil devices to avoid database bloat)
      if (!isRelayDevice) {
        for (const reading of readings) {
          const mapping = state.registerMappings.find(m => m.name === reading.name) || {};
          const calibratedReadingValue = this.applyCalibration(reading.value, equipment, mapping);

          db.prepare(`
            INSERT INTO readings (equipment_id, name, value, unit, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            equipmentId,
            reading.name || null,
            calibratedReadingValue,
            reading.unit,
            timestamp
          );
        }

        // Persist derived metrics — already calibrated, so insert directly
        for (const d of derivedReadings) {
          db.prepare(`
            INSERT INTO readings (equipment_id, name, value, unit, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `).run(equipmentId, d.name, d.value, d.unit, timestamp);
        }
      }

      // Broadcast updates via WebSocket
      const broadcastData = {
        equipmentId,
        name: state.name,
        status: 'online',
        lastReading: lastReadingValue,
        readings: readings.map(r => ({
          name: r.name,
          value: r.value,
          unit: r.unit
        })),
        timestamp
      };

      if (global.broadcast) {
        global.broadcast('equipment_reading', broadcastData);
        if (isRelayDevice) {
          // Broadcast relay-specific state for UI
          const relayStates = {};
          for (const reading of readings) {
            relayStates[reading.registerAddress] = reading.value === 1;
          }
          global.broadcast('relay_state_changed', {
            equipmentId,
            relayStates,
            timestamp
          });
        } else {
          // Broadcast individual reading per metric for multi-metric sensors
          for (const reading of readings) {
            const mapping = state.registerMappings.find(m => m.name === reading.name) || {};
            const calibrated = this.applyCalibration(reading.value, equipment, mapping);
            global.broadcast('sensor_reading', {
              equipment_id: equipmentId,
              equipment_name: state.name,
              name: reading.name || null,
              value: calibrated,
              unit: reading.unit,
              timestamp
            });
          }
          // Broadcast derived metrics (VPD Air / VPD Leaf) live
          for (const d of derivedReadings) {
            global.broadcast('sensor_reading', {
              equipment_id: equipmentId,
              equipment_name: state.name,
              name: d.name,
              value: d.value,
              unit: d.unit,
              timestamp
            });
          }
        }
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

      // Log to equipment_errors on the FIRST failure and then every 20th, so a
      // dead device doesn't insert a row every cycle (status / counters above
      // are still updated every time).
      const n = state.consecutiveErrors;
      if (n === 1 || n % 20 === 0) {
        db.prepare(`
          INSERT INTO equipment_errors (equipment_id, error_type, message, details)
          VALUES (?, 'connection', ?, ?)
        `).run(
          equipmentId,
          error.message,
          JSON.stringify({
            consecutiveErrors: n,
            backoffDelay,
            address: state.address,
            slaveId: state.slaveId
          })
        );
      }

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

      // The single log line for this failed cycle
      console.log(`[Polling] Device ${equipmentId} (${state.name}) poll failed: ${error.message} (${state.consecutiveErrors} consecutive). Next poll in ${backoffDelay}ms`);

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
        requestGapMs: state.requestGapMs,
        blockFallbacks: state.runModes.size,
        registerMappings: state.registerMappings.length,
        hasCoils: state.hasCoils,
        consecutiveErrors: state.consecutiveErrors,
        isBackingOff: state.isBackingOff,
        lastPollTime: state.lastPollTime,
        isPolling: state.isPolling
      });
    }

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      pausedAt: this.pausedAt,
      pausedBy: this.pausedBy,
      pauseReason: this.pauseReason,
      autoResumeAt: this.autoResumeAt,
      deviceCount: this.devices.size,
      heartbeatDeviceCount: this.getHeartbeatDeviceCount(),
      devices
    };
  }

  /**
   * Force poll a specific device (manual trigger)
   *
   * Intentionally works while paused: a single-device read is an explicit
   * operator action, and pausing is often done precisely to free the RS485 bus
   * for manual probing.
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
