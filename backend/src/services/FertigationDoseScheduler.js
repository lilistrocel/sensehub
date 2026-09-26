/**
 * FertigationDoseScheduler
 *
 * Runs a fertigation "dose program" during an irrigation cycle: opens / closes each
 * tank's injector valve so each tank's effective contribution matches its duty%.
 *
 * # Mental model
 *
 * - The water pump and Venturi mixing pump always run for the cycle's duration.
 *   The automation that triggers fertigation handles those — they are NOT this
 *   service's responsibility. This service only modulates the **injector valves**
 *   on Waveshare Irrigation 2 (one valve per tank).
 *
 * - Each tank in the program has a duty_pct ∈ [0, 100]. The cycle is sliced into
 *   `window_seconds` chunks; within each chunk the valve is open for
 *   `duty_pct/100 × window_seconds`, then closed for the remainder. We repeat
 *   the chunk pattern until the cycle ends.
 *
 * - compatibility_strategy == 'time_slice' adds an extra constraint: tanks with
 *   different `compatibility_slot` values never have their valves open at the
 *   same time. We do this by partitioning each window into N slots (one per
 *   distinct compatibility_slot), and only running each tank inside its slot's
 *   sub-window. Tanks with slot = null run in every slot.
 *
 * # Safety
 *
 * - Only one cycle may run at a time. `startCycle` throws if a cycle is active.
 * - Cycle is aborted (all valves closed) if any Modbus write throws.
 * - `stopCycle()` forces all valves shut and clears pending timers.
 * - All valve writes go through the same ModbusTcpClient + RelayEventLogger as
 *   AutomationExecutor, so events appear in the existing relay_events log and
 *   the safety watchdog can see them.
 *
 * # Scaffold scope
 *
 * computeSchedule() is a pure function and fully implemented. startCycle / stopCycle
 * are implemented and will drive real coils. There is no UI wiring or automation-
 * action wiring yet — those are next steps. Use the API endpoints in
 * routes/fertigation.js or call this service directly from a test.
 */

const { db } = require('../utils/database');
const { modbusTcpClient } = require('./ModbusTcpClient');
const interlock = require('./RelayInterlockService');
const { logRelayEvent } = require('./RelayEventLogger');
const { automationArmingService } = require('./AutomationArmingService');

class FertigationDoseScheduler {
  constructor() {
    this._active = null; // { programId, automationId, startedAt, endsAt, timers: [], schedule, valveStates }
  }

  isRunning() {
    return !!this._active;
  }

  currentCycle() {
    if (!this._active) return null;
    const { programId, automationId, cycleLogId, startedAt, endsAt, schedule, valveStates, dryRun } = this._active;
    return { programId, automationId, cycleLogId, startedAt, endsAt, schedule, valveStates, dryRun: !!dryRun };
  }

  /**
   * Compute the deterministic per-valve schedule for a program over a cycle.
   *
   * Returns:
   *   {
   *     window_seconds, total_windows, duration_seconds,
   *     compatibility_strategy, slots, tanks: [{
   *       tank_id, duty_pct, slot, open_seconds_per_window, on_offset, valve_events: [{at_sec, state}]
   *     }]
   *   }
   *
   * Pure: no DB writes, no coil writes. Safe to call from preview endpoints.
   */
  computeSchedule(program, durationSeconds) {
    if (!program || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('computeSchedule: program and positive durationSeconds required');
    }
    const win = Math.max(5, parseInt(program.window_seconds) || 60);
    const minOn = Math.max(1, parseInt(program.min_valve_on_seconds) || 5);
    const minOff = Math.max(1, parseInt(program.min_valve_off_seconds) || 5);
    const tanks = (program.tanks || []).filter(t => t && t.duty_pct > 0);
    if (tanks.length === 0) {
      return { window_seconds: win, total_windows: 0, duration_seconds: durationSeconds, compatibility_strategy: program.compatibility_strategy, slots: [], tanks: [] };
    }

    // Compatibility slots: list of distinct non-null compatibility_slot values.
    // Tanks with slot=null run in every slot.
    const slots = [...new Set(tanks
      .map(t => t.compatibility_slot)
      .filter(s => s != null))].sort((a, b) => a - b);
    const usingSlots = program.compatibility_strategy === 'time_slice' && slots.length > 1;
    const slotCount = usingSlots ? slots.length : 1;
    const slotSecs = win / slotCount;

    const tanksOut = [];
    for (const t of tanks) {
      // Effective slot index for this tank (column in the round-robin)
      const tankSlotIdx = (usingSlots && t.compatibility_slot != null)
        ? slots.indexOf(t.compatibility_slot)
        : -1; // -1 == runs in every slot
      // Per-window on-time: duty% applied to either the full window (permissive /
      // slot-agnostic tank) or just to this tank's slot (time-slice mode).
      const tankWindow = (tankSlotIdx === -1) ? win : slotSecs;
      let openSecsPerWindow = (t.duty_pct / 100) * tankWindow;
      // Clamp to min on / min off (refuse to chatter below mechanical limits).
      if (openSecsPerWindow < minOn) openSecsPerWindow = 0;
      else if (tankWindow - openSecsPerWindow < minOff && tankWindow - openSecsPerWindow > 0) {
        openSecsPerWindow = tankWindow - minOff;
      }

      // Emit valve_events: at the start of each "on" period, state=true; at the
      // start of the matching "off" period, state=false. The events list is what
      // startCycle will schedule with setTimeout.
      //
      // Two cases:
      //  - Slot-agnostic tank (tankSlotIdx === -1): one on/off pair per full window.
      //  - Slotted tank: one on/off pair per matching slot within each window.
      const events = [];
      let cycle_t = 0;
      while (cycle_t < durationSeconds && openSecsPerWindow > 0) {
        if (tankSlotIdx === -1) {
          const onAt = cycle_t;
          const offAt = Math.min(cycle_t + openSecsPerWindow, durationSeconds);
          if (onAt < durationSeconds) events.push({ at_sec: onAt, state: true });
          if (offAt < durationSeconds) events.push({ at_sec: offAt, state: false });
        } else {
          const slotStart = cycle_t + tankSlotIdx * slotSecs;
          if (slotStart < durationSeconds) {
            const offAt = Math.min(slotStart + openSecsPerWindow, durationSeconds);
            events.push({ at_sec: slotStart, state: true });
            if (offAt < durationSeconds) events.push({ at_sec: offAt, state: false });
          }
        }
        cycle_t += win;
      }

      tanksOut.push({
        tank_id: t.tank_id,
        tank_name: t.tank_name,
        equipment_id: t.equipment_id,
        channel: t.channel,
        duty_pct: t.duty_pct,
        slot: t.compatibility_slot,
        slot_index: tankSlotIdx,
        open_seconds_per_window: Math.round(openSecsPerWindow * 100) / 100,
        valve_events: events,
      });
    }

    return {
      window_seconds: win,
      slot_seconds: slotSecs,
      total_windows: Math.ceil(durationSeconds / win),
      duration_seconds: durationSeconds,
      compatibility_strategy: program.compatibility_strategy,
      slots,
      using_time_slice: usingSlots,
      tanks: tanksOut,
    };
  }

  /**
   * Begin executing a dose program. Resolves once all initial valve commands have
   * been issued; the cycle then runs autonomously via setTimeout until the
   * duration elapses or stopCycle() is called.
   *
   * options:
   *   programId        (required)
   *   durationSeconds  (required)
   *   automationId     (optional) for logging
   *   dryRun           if true, computes schedule + logs but doesn't write coils
   */
  async startCycle({ programId, durationSeconds, automationId = null, dryRun = false }) {
    // Emergency stop gate. A dose cycle is an unattended multi-minute program
    // that keeps toggling injector valves on its own setTimeout timers, so it
    // must not be startable while automations are disarmed — by an automation
    // OR by the manual POST /api/fertigation/dose-cycle/start route, which
    // surfaces this throw as a 400. A dry run writes no coils, so it is allowed.
    if (!dryRun) {
      const arming = automationArmingService.getState();
      if (arming.disarmed) {
        throw new Error(
          `Automations are DISARMED (emergency stop)${automationArmingService.describe(arming)} — re-arm before starting a dose cycle`
        );
      }
    }
    if (this._active) throw new Error('A fertigation dose cycle is already running');
    if (!programId || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('startCycle: programId and positive durationSeconds required');
    }

    const prog = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(programId);
    if (!prog) throw new Error(`Dose program ${programId} not found`);
    const tanks = db.prepare(`
      SELECT pt.*, t.equipment_id, t.channel, t.name as tank_name
      FROM fertigation_dose_program_tanks pt
      JOIN fertigation_tanks t ON pt.tank_id = t.id
      WHERE pt.program_id = ?
      ORDER BY pt.priority, pt.tank_id
    `).all(programId);

    const schedule = this.computeSchedule({ ...prog, tanks }, durationSeconds);

    // Build a flat list of (at_ms, fn) so we can schedule with setTimeout.
    const cycleStartedAt = Date.now();
    const cycleEndsAt = cycleStartedAt + durationSeconds * 1000;
    const valveStates = {};
    const timers = [];

    // Pre-flight: every tank with non-zero duty must be bound to a channel.
    const unboundTanks = schedule.tanks.filter(t => !t.equipment_id || t.channel == null);
    if (unboundTanks.length > 0) {
      throw new Error(`Tank(s) in this program have no bound channel: ${unboundTanks.map(t => t.tank_name).join(', ')}`);
    }

    // Resolve each tank's Modbus coordinates once up-front.
    const equipmentById = {};
    for (const t of schedule.tanks) {
      if (!equipmentById[t.equipment_id]) {
        const eq = db.prepare('SELECT id, name, address, slave_id, write_only, register_mappings FROM equipment WHERE id = ?').get(t.equipment_id);
        if (!eq) throw new Error(`Equipment ${t.equipment_id} not found for tank ${t.tank_name}`);
        const [host, portStr] = (eq.address || '').split(':');
        const port = parseInt(portStr, 10);
        if (!host || !Number.isFinite(port)) throw new Error(`Tank ${t.tank_name} bound to equipment with invalid address: ${eq.address}`);
        equipmentById[t.equipment_id] = { ...eq, host, port, unitId: eq.slave_id || 1 };
      }
    }

    // Log the cycle start row.
    const logResult = db.prepare(`
      INSERT INTO fertigation_dose_cycle_log
        (program_id, automation_id, cycle_started_at, duration_seconds, effective_duty_pcts, status)
      VALUES (?, ?, datetime('now'), ?, ?, 'running')
    `).run(
      programId,
      automationId,
      durationSeconds,
      JSON.stringify(Object.fromEntries(schedule.tanks.map(t => [t.tank_id, t.duty_pct]))),
    );
    const cycleLogId = logResult.lastInsertRowid;

    this._active = {
      programId, automationId, cycleLogId,
      startedAt: cycleStartedAt, endsAt: cycleEndsAt,
      schedule, valveStates, timers, dryRun,
    };

    // Drive a single valve toggle. Closes over equipmentById + dryRun.
    const toggleValve = async (tank, state) => {
      const eq = equipmentById[tank.equipment_id];
      valveStates[`${tank.equipment_id}:${tank.channel}`] = state;
      if (dryRun) return;
      try {
        // Hard interlock: partner OFF + read-back before energising a valve coil.
        if (state === true) {
          await interlock.guardEnergise(eq, tank.channel, modbusTcpClient, { source: 'dose_program', automationId });
        }
        if (eq.write_only) {
          await modbusTcpClient.writeSingleCoilFireAndForget(eq.host, eq.port, eq.unitId, tank.channel, state);
        } else {
          await modbusTcpClient.writeSingleCoil(eq.host, eq.port, eq.unitId, tank.channel, state);
        }
        logRelayEvent(tank.equipment_id, tank.channel, state, 'dose_program', automationId);
      } catch (err) {
        console.error(`[DoseScheduler] coil write failed for ${tank.tank_name} (eq ${tank.equipment_id} ch ${tank.channel}):`, err.message);
        this.abortCycle(`coil write failed: ${err.message}`).catch(() => {});
        throw err;
      }
    };

    // Schedule all events.
    for (const tank of schedule.tanks) {
      for (const ev of tank.valve_events) {
        const fireAtMs = cycleStartedAt + ev.at_sec * 1000;
        const delay = Math.max(0, fireAtMs - Date.now());
        const timer = setTimeout(() => { toggleValve(tank, ev.state).catch(() => {}); }, delay);
        timers.push(timer);
      }
    }

    // End-of-cycle: close every valve we touched, mark cycle completed.
    const endTimer = setTimeout(() => { this._completeCycle().catch(err => console.error('[DoseScheduler] complete failed:', err.message)); }, durationSeconds * 1000);
    timers.push(endTimer);

    return {
      cycleLogId,
      schedule,
      started_at: new Date(cycleStartedAt).toISOString(),
      ends_at: new Date(cycleEndsAt).toISOString(),
      dry_run: !!dryRun,
    };
  }

  /** End the cycle gracefully: close every valve, mark completed. */
  async _completeCycle() {
    if (!this._active) return;
    const { schedule, dryRun, cycleLogId, timers } = this._active;
    for (const t of timers) clearTimeout(t);
    if (!dryRun) {
      // Close every valve that was part of this program.
      const equipmentById = {};
      for (const tank of schedule.tanks) {
        if (!equipmentById[tank.equipment_id]) {
          const eq = db.prepare('SELECT id, address, slave_id, write_only FROM equipment WHERE id = ?').get(tank.equipment_id);
          if (!eq) continue;
          const [host, portStr] = (eq.address || '').split(':');
          equipmentById[tank.equipment_id] = { ...eq, host, port: parseInt(portStr, 10), unitId: eq.slave_id || 1 };
        }
        const eq = equipmentById[tank.equipment_id];
        if (!eq?.host) continue;
        try {
          if (eq.write_only) await modbusTcpClient.writeSingleCoilFireAndForget(eq.host, eq.port, eq.unitId, tank.channel, false);
          else await modbusTcpClient.writeSingleCoil(eq.host, eq.port, eq.unitId, tank.channel, false);
          logRelayEvent(tank.equipment_id, tank.channel, false, 'dose_program_end', this._active.automationId);
        } catch (_) { /* best-effort */ }
      }
    }
    db.prepare("UPDATE fertigation_dose_cycle_log SET cycle_ended_at = datetime('now'), status = 'completed' WHERE id = ?")
      .run(cycleLogId);
    this._active = null;
  }

  /**
   * Abort the cycle immediately. Closes all valves, marks aborted.
   *
   * @param {string} [reason]        stored in fertigation_dose_cycle_log.notes
   * @param {object} [opts]
   * @param {string} [opts.source]   relay_events source for the valve-close writes
   *                                 (default 'dose_program_abort'; the irrigation
   *                                 flow watch passes 'flow_watch')
   */
  async abortCycle(reason = 'manual stop', opts = {}) {
    if (!this._active) return false;
    const source = (opts && opts.source) || 'dose_program_abort';
    const { cycleLogId, timers, schedule, dryRun } = this._active;
    for (const t of timers) clearTimeout(t);
    if (!dryRun) {
      for (const tank of schedule.tanks) {
        try {
          const eq = db.prepare('SELECT address, slave_id, write_only FROM equipment WHERE id = ?').get(tank.equipment_id);
          if (!eq) continue;
          const [host, portStr] = (eq.address || '').split(':');
          const port = parseInt(portStr, 10);
          const unitId = eq.slave_id || 1;
          if (eq.write_only) await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, tank.channel, false);
          else await modbusTcpClient.writeSingleCoil(host, port, unitId, tank.channel, false);
          logRelayEvent(tank.equipment_id, tank.channel, false, source, this._active.automationId);
        } catch (_) {}
      }
    }
    db.prepare("UPDATE fertigation_dose_cycle_log SET cycle_ended_at = datetime('now'), status = 'aborted', notes = ? WHERE id = ?")
      .run(reason, cycleLogId);
    this._active = null;
    return true;
  }
}

const fertigationDoseScheduler = new FertigationDoseScheduler();

module.exports = { FertigationDoseScheduler, fertigationDoseScheduler };
