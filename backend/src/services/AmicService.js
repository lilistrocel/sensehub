/**
 * AmicService - Modbus TCP wrapper for NT Sensors AMIC water quality analyzer.
 *
 * Spec: A7-303-MB User Guide V1.3
 * Default address: 192.168.1.104:502 (DHCP, may change)
 *
 * Modbus map (Schneider/Modicon notation in spec → Modbus wire offsets):
 *   Coils (FC05 write):
 *     0  - Measure
 *     2  - Drain
 *     3  - Calibrate
 *     4  - Empty System
 *     5  - Condition
 *   Discrete Inputs (FC02 read):
 *     16-21 - Status: Measuring, ?, Draining, Calibrating, EmptySystem, Conditioning
 *     32-39 - CH1-CH8 Calibration Check (1=passed, 0=error)
 *     40-47 - CH1-CH8 Measurement Check (1=passed, 0=error)
 *   Input Registers (FC04 read, integer ÷100):
 *     40-47 - CH1-CH8 measurements (CH8 = pH)
 *   Holding Registers (FC03/FC06):
 *     9     - PMP_INPUT_TIME (seconds, default 12)
 *     10    - PMP_OUTPUT_TIME (seconds, default 16)
 *     14    - mVpH_Low (sensor mV at pH 4.0, default 170.60)
 *     15    - mVpH_High (sensor mV at pH 7.0, default 0.80)
 */

const ModbusRTU = require('modbus-serial');
const { db } = require('../utils/database');

const DEFAULT_HOST = '192.168.1.104';
const DEFAULT_PORT = 502;

// Coil offsets for commands
const CMD_COILS = {
  measure: 0,
  drain: 2,
  calibrate: 3,
  empty_system: 4,
  condition: 5,
};

// Status discrete input offsets
const STATUS_LABELS = ['measuring', 'unknown', 'draining', 'calibrating', 'empty_system', 'conditioning'];

// Expected cycle durations (minutes). Single source of truth for both backend and frontend display.
const EXPECTED_DURATIONS = {
  measuring: 5,
  calibrating: 20,
  draining: 1,
  empty_system: 5,
  conditioning: 120,
};

// Map trigger method → state name (the discrete-input flag the AMIC sets while the cycle runs)
const TRIGGER_TO_STATE = {
  measure: 'measuring',
  calibrate: 'calibrating',
  drain: 'draining',
  empty_system: 'empty_system',
  condition: 'conditioning',
};

class AmicService {
  constructor() {
    this.config = this._loadConfig();
    // True until the first reconcile after process start. Used to mark cycles detected on
    // boot as 'unknown' (could have been running for hours) vs 'panel' (just transitioned).
    this._firstReconcile = true;
  }

  _loadConfig() {
    try {
      const row = db.prepare("SELECT value FROM system_settings WHERE key = 'amic_config'").get();
      if (row?.value) return JSON.parse(row.value);
    } catch {}
    return { host: DEFAULT_HOST, port: DEFAULT_PORT, slave_id: 1 };
  }

  _saveConfig(cfg) {
    this.config = cfg;
    db.prepare("INSERT INTO system_settings (key, value) VALUES ('amic_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(cfg));
  }

  /** Get the pH offset (added to device-reported pH on display).
   *  Used when calibration buffers aren't standard pH 4 / pH 7.
   *  Computed as: low_buffer_pH - 4 (== high_buffer_pH - 7 when buffers span 3 pH units)
   */
  getPhOffset() {
    try {
      const row = db.prepare("SELECT value FROM system_settings WHERE key = 'amic_ph_offset'").get();
      if (row?.value) {
        const v = JSON.parse(row.value);
        return v;
      }
    } catch {}
    return { offset: 0, buffer_low: 4.0, buffer_high: 7.0, configured: false };
  }

  setPhOffset(bufferLow, bufferHigh) {
    const offsetLow = bufferLow - 4.0;
    const offsetHigh = bufferHigh - 7.0;
    // If buffers don't span exactly 3 pH units, average the two offsets and warn
    const offset = (offsetLow + offsetHigh) / 2;
    const data = {
      offset,
      buffer_low: bufferLow,
      buffer_high: bufferHigh,
      configured: true,
      span_warning: Math.abs(offsetLow - offsetHigh) > 0.05,
      updated_at: new Date().toISOString()
    };
    db.prepare("INSERT INTO system_settings (key, value) VALUES ('amic_ph_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(data));
    return data;
  }

  /** Get channel labels from system_settings, falling back to defaults */
  getChannels() {
    try {
      const row = db.prepare("SELECT value FROM system_settings WHERE key = 'amic_channels'").get();
      if (row?.value) return JSON.parse(row.value);
    } catch {}
    // Default ion mapping per A7-303-MB User Guide V1.3 (page 16, SCADA example).
    // VERIFY against your actual electrode order — the manufacturer ships
    // different electrode combinations per customer.
    return [
      { channel: 1, label: 'Ca²⁺', ion: 'calcium_Ca', enabled: true },
      { channel: 2, label: 'Cl⁻', ion: 'chloride_Cl', enabled: true },
      { channel: 3, label: 'K⁺', ion: 'potassium_K', enabled: true },
      { channel: 4, label: 'Na⁺', ion: 'sodium_Na', enabled: true },
      { channel: 5, label: 'NH₄⁺', ion: 'ammonium_NH4', enabled: true },
      { channel: 6, label: 'NO₃⁻', ion: 'nitrate_NO3', enabled: true },
      { channel: 7, label: 'Mg²⁺', ion: 'magnesium_Mg', enabled: true },
      { channel: 8, label: 'pH', ion: 'pH', enabled: true },
    ];
  }

  saveChannels(channels) {
    db.prepare("INSERT INTO system_settings (key, value) VALUES ('amic_channels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(channels));
  }

  /** Read the persisted current cycle (or null if idle). Survives backend restart and page reload. */
  _getCurrentCycle() {
    try {
      const row = db.prepare("SELECT value FROM system_settings WHERE key = 'amic_current_cycle'").get();
      if (row?.value) return JSON.parse(row.value);
    } catch {}
    return null;
  }

  _setCurrentCycle(stateName, source) {
    if (!stateName) return null;
    const entry = {
      state: stateName,
      started_at: new Date().toISOString(),
      expected_duration_min: EXPECTED_DURATIONS[stateName] || null,
      source: source || 'unknown',
    };
    db.prepare("INSERT INTO system_settings (key, value) VALUES ('amic_current_cycle', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(entry));
    return entry;
  }

  _clearCurrentCycle() {
    db.prepare("DELETE FROM system_settings WHERE key = 'amic_current_cycle'").run();
  }

  /** Resolve the currently active state name from the discrete-input flags, or null if idle. */
  _activeStateName(stateFlags) {
    if (!stateFlags) return null;
    if (stateFlags.measuring) return 'measuring';
    if (stateFlags.calibrating) return 'calibrating';
    if (stateFlags.draining) return 'draining';
    if (stateFlags.empty_system) return 'empty_system';
    if (stateFlags.conditioning) return 'conditioning';
    return null;
  }

  /** Reconcile the persisted cycle against what the device is currently doing.
   *  Returns the reconciled cycle entry (or null if idle). */
  _reconcileCurrentCycle(stateFlags) {
    const active = this._activeStateName(stateFlags);
    const stored = this._getCurrentCycle();
    const firstReconcile = this._firstReconcile;
    this._firstReconcile = false;

    if (!active && !stored) return null;
    if (!active && stored) {
      // Device is idle but we have a stored cycle → cycle ended, clear it
      this._clearCurrentCycle();
      return null;
    }
    if (active && !stored) {
      // Device is running but no stored cycle. Two cases:
      //   - first reconcile after backend boot → could've been running for any length of time
      //   - subsequent reconcile (transition between polls) → started ≤ poll-interval ago, very likely from the panel
      const source = firstReconcile ? 'unknown' : 'panel';
      return this._setCurrentCycle(active, source);
    }
    if (active && stored && stored.state !== active) {
      // Device transitioned to a different cycle between polls (rare)
      return this._setCurrentCycle(active, 'panel');
    }
    // active && stored && stored.state === active → no-op
    return stored;
  }

  async _connect() {
    const c = new ModbusRTU();
    await c.connectTCP(this.config.host, { port: this.config.port });
    c.setID(this.config.slave_id || 1);
    c.setTimeout(5000);
    return c;
  }

  /** Send a command (set coil true, hold 2s, set false). Spec: hold >1s. */
  async _sendCommand(coilOffset) {
    const c = await this._connect();
    try {
      await c.writeCoil(coilOffset, true);
      await new Promise(r => setTimeout(r, 2000));
      await c.writeCoil(coilOffset, false);
    } finally {
      c.close();
    }
  }

  /** Get current status: which cycle is running + cal/measurement check states + measurements */
  async getStatus() {
    const c = await this._connect();
    try {
      const status = await c.readDiscreteInputs(16, 8);
      const calCheck = await c.readDiscreteInputs(32, 8);
      const measCheck = await c.readDiscreteInputs(40, 8);
      const measurements = await c.readInputRegisters(40, 8);
      const timing = await c.readHoldingRegisters(9, 2);
      let phCal = null;
      try {
        const ph = await c.readHoldingRegisters(14, 2);
        const a = ph.data[0] > 32767 ? ph.data[0] - 65536 : ph.data[0];
        const b = ph.data[1] > 32767 ? ph.data[1] - 65536 : ph.data[1];
        phCal = { mv_at_ph4: a, mv_at_ph7: b };
      } catch {}

      // Live pH electrode mV reading (input register 7 = address 3x300008 in spec)
      // The probe outputs negative mV for alkaline solutions (pH > 7), so interpret as int16.
      let phLiveMv = null;
      try {
        const live = await c.readInputRegisters(7, 1);
        const raw = live.data[0];
        phLiveMv = raw > 32767 ? raw - 65536 : raw; // signed × 100 (e.g. 17060 = 170.60 mV, -4470 = -44.70 mV)
      } catch {}

      const channels = this.getChannels();
      const phOffset = this.getPhOffset();

      const stateFlags = {
        measuring: status.data[0],
        draining: status.data[2],
        calibrating: status.data[3],
        empty_system: status.data[4],
        conditioning: status.data[5],
      };

      // Reconcile persisted cycle: detects state transitions even when nobody is watching
      const currentCycle = this._reconcileCurrentCycle(stateFlags);

      return {
        connected: true,
        host: `${this.config.host}:${this.config.port}`,
        state: stateFlags,
        current_cycle: currentCycle,
        calibration_check: calCheck.data.slice(0, 8).map((passed, i) => ({
          channel: i + 1,
          label: channels[i]?.label || `CH${i+1}`,
          passed,
        })),
        measurement_check: measCheck.data.slice(0, 8).map((passed, i) => ({
          channel: i + 1,
          label: channels[i]?.label || `CH${i+1}`,
          passed,
        })),
        measurements: measurements.data.slice(0, 8).map((raw, i) => {
          const isPh = i === 7;
          // Per A7-303-MB User Guide V1.3 page 10:
          //   CH1-CH7 (ions in mg/L) are stored as integer × 100 → divide by 100
          //   CH8 (pH) is stored as integer × 10           → divide by 10
          // Earlier code divided everything by 100, which made every pH reading
          // off by a factor of 10. See docs/features/amic-ph-scale-fix.md.
          const rawValue = isPh ? raw / 10 : raw / 100;
          // Apply pH offset only to the pH channel (CH8)
          const value = isPh && phOffset.configured ? rawValue + phOffset.offset : rawValue;
          return {
            channel: i + 1,
            label: channels[i]?.label || `CH${i+1}`,
            ion: channels[i]?.ion || '',
            raw,
            raw_value: rawValue,
            value,
            offset_applied: isPh && phOffset.configured ? phOffset.offset : 0,
            unit: isPh ? 'pH' : 'mg/L',
            enabled: channels[i]?.enabled !== false,
          };
        }),
        timing: { pump_input_seconds: timing.data[0], pump_output_seconds: timing.data[1] },
        ph_calibration: phCal,
        ph_live_mv: phLiveMv, // signed × 100; ÷100 = mV reading
        ph_offset: phOffset,
      };
    } finally {
      c.close();
    }
  }

  /** Trigger a cycle. Stamps the persisted current_cycle immediately so the UI timer is accurate
   *  from t=0 instead of from the next status poll (up to 15s later). */
  async _trigger(triggerName) {
    const stateName = TRIGGER_TO_STATE[triggerName];
    const coil = CMD_COILS[triggerName];
    if (coil === undefined) throw new Error(`Unknown AMIC trigger: ${triggerName}`);
    this._setCurrentCycle(stateName, 'sensehub');
    try {
      return await this._sendCommand(coil);
    } catch (err) {
      // Modbus write failed — clear the speculative stamp so the UI doesn't show a phantom timer
      this._clearCurrentCycle();
      throw err;
    }
  }

  async triggerMeasure() { return this._trigger('measure'); }
  async triggerDrain() { return this._trigger('drain'); }
  async triggerCalibrate() { return this._trigger('calibrate'); }
  async triggerEmptySystem() { return this._trigger('empty_system'); }
  async triggerCondition() { return this._trigger('condition'); }

  /** Manual pH calibration: write mV readings observed at pH 4.0 and pH 7.0
   *  Values are raw integers (mV × 100), e.g. 17060 = 170.60 mV
   */
  async calibratePh(mvAtPh4, mvAtPh7) {
    const c = await this._connect();
    try {
      await c.writeRegister(14, parseInt(mvAtPh4));
      await c.writeRegister(15, parseInt(mvAtPh7));
      const verify = await c.readHoldingRegisters(14, 2);
      return { mv_at_ph4: verify.data[0], mv_at_ph7: verify.data[1] };
    } finally {
      c.close();
    }
  }

  /** Capture the current live pH mV reading as a calibration point.
   *  Reads input register 7 (live mV × 100) and writes it to either
   *  the low (pH 4.0 → reg 14) or high (pH 7.0 → reg 15) calibration register.
   *
   *  @param point 'low' (pH 4.0) or 'high' (pH 7.0)
   */
  async capturePhCalibration(point) {
    const targetReg = point === 'low' ? 14 : 15;
    const c = await this._connect();
    try {
      const live = await c.readInputRegisters(7, 1);
      const rawUnsigned = live.data[0];
      // Convert to signed for display; write the original unsigned value
      // (the device stores as int16 internally, the wire format is uint16 either way)
      const signed = rawUnsigned > 32767 ? rawUnsigned - 65536 : rawUnsigned;
      await c.writeRegister(targetReg, rawUnsigned);
      const verify = await c.readHoldingRegisters(14, 2);
      return {
        captured_raw: signed,
        captured_mv: signed / 100,
        point,
        mv_at_ph4: verify.data[0] > 32767 ? verify.data[0] - 65536 : verify.data[0],
        mv_at_ph7: verify.data[1] > 32767 ? verify.data[1] - 65536 : verify.data[1],
      };
    } finally {
      c.close();
    }
  }

  /** Read current measurements and persist them as lab_readings entries.
   *  @param zoneId optional zone tag
   *  @param sampleDate optional ISO datetime; defaults to now. Use to backdate samples.
   */
  async saveLastMeasurementToLab(zoneId = null, sampleDate = null) {
    const status = await this.getStatus();
    const ts = sampleDate || new Date().toISOString();
    const channels = this.getChannels();
    const phOffset = status.ph_offset || this.getPhOffset();
    const created = [];

    // Note: pH rows record the offset that was active at save time so historical rows stay
    // reconcilable when calibration buffers change. Non-pH rows leave the columns NULL.
    const insertStmt = db.prepare(
      'INSERT INTO lab_readings (sample_date, nutrient, value, unit, zone_id, notes, ph_offset, ph_buffer_low, ph_buffer_high) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    for (const m of status.measurements) {
      if (!m.enabled || m.value === 0) continue; // skip disabled / unmeasured
      const ch = channels[m.channel - 1];
      if (!ch.ion) continue; // skip channels without configured ion type

      const isPh = m.unit === 'pH';
      const phOffsetVal = isPh ? (phOffset.configured ? phOffset.offset : 0) : null;
      const phBufLow = isPh ? (phOffset.configured ? phOffset.buffer_low : 4.0) : null;
      const phBufHigh = isPh ? (phOffset.configured ? phOffset.buffer_high : 7.0) : null;

      try {
        const r = insertStmt.run(ts, ch.ion, m.value, m.unit, zoneId, `AMIC CH${m.channel} (${ch.label})`,
          phOffsetVal, phBufLow, phBufHigh);
        created.push({ id: r.lastInsertRowid, channel: m.channel, ion: ch.ion, value: m.value, unit: m.unit,
          ph_offset: phOffsetVal, ph_buffer_low: phBufLow, ph_buffer_high: phBufHigh });
      } catch (err) {
        console.error('[AMIC] Failed to save measurement to lab_readings:', err.message);
      }
    }

    return created;
  }
}

const amicService = new AmicService();

module.exports = { amicService };
