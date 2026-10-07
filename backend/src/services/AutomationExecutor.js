/**
 * AutomationExecutor - Shared action execution logic for automations.
 *
 * Used by both the REST trigger endpoint and the background scheduler.
 */

const { db } = require('../utils/database');
const { createAlert } = require('../utils/alertBroadcast');
const { modbusTcpClient } = require('./ModbusTcpClient');
const { relayTimerService } = require('./RelayTimerService');
const { logRelayEvent } = require('./RelayEventLogger');
const { fertigationDoseScheduler } = require('./FertigationDoseScheduler');
const { automationArmingService } = require('./AutomationArmingService');
const interlock = require('./RelayInterlockService');
const commandLedger = require('./RelayCommandLedger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parse an equipment "host:port" address. Returns { host, port } or null when
 * the address is missing/malformed (non-Modbus rows, blank addresses, bad port).
 */
function parseHostPort(address) {
  const parts = String(address || '').trim().split(':');
  if (parts.length !== 2) return null;
  const host = parts[0].trim();
  const port = parseInt(parts[1], 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Group coil writes into contiguous address runs so each run can go out as a
 * single FC15 (Write Multiple Coils) frame.
 *
 * @param {Array<{channel:number, state:boolean, name?:string}>} items
 * @returns {Array<{start:number, values:boolean[], items:Array}>} runs, plus
 *          the channel-sorted item list as `.sorted` on the returned array.
 */
function buildCoilRuns(items) {
  const sorted = items
    .map(t => ({ channel: parseInt(t.channel, 10), state: !!t.state, name: t.name || `Coil ${t.channel}` }))
    .filter(t => Number.isFinite(t.channel))
    .sort((a, b) => a.channel - b.channel);

  const runs = [];
  let current = null;
  for (const t of sorted) {
    if (current && t.channel === current.start + current.values.length) {
      current.values.push(t.state);
      current.items.push(t);
    } else {
      if (current) runs.push(current);
      current = { start: t.channel, values: [t.state], items: [t] };
    }
  }
  if (current) runs.push(current);
  runs.sorted = sorted;
  return runs;
}

// Per-channel bookkeeping after a coil write (cache = READ-BACK value, relay_events
// row with confirmed/readback_state, relay_state_changed broadcast). Lives in
// RelayStateCache so the manual / raw relay routes share the exact same path.
const { applyRelayCache } = require('./RelayStateCache');
const readback = require('./RelayReadback');

/**
 * Is the command with generation `sinceGen` on (eq, ch) superseded by a newer
 * command, so that re-writing (or writing) it would override that newer
 * command? (operator-approved fix 2026-10-07, zone-4 pump-off)
 *
 *  - requested ON: ANY newer command wins — an ON is never re-energised after
 *    a newer OFF (stop-all, manual, auto-off) or ON was issued on the channel.
 *  - requested OFF: only when the caller is a stale timer OFF (`staleOff`),
 *    the newer command is an ON, and that ON is BOUNDED by its own pending
 *    auto-off on the channel. An OFF is never suppressed in favour of an ON
 *    that nothing would switch off again; a newer OFF never suppresses an OFF.
 *
 * @returns {object|null} the superseding ledger entry, or null
 */
function supersedingCommand(equipmentId, channel, requested, sinceGen, { staleOff = false } = {}) {
  const newer = commandLedger.newerThan(equipmentId, channel, sinceGen);
  if (!newer) return null;
  if (requested === true) return newer;
  if (staleOff && newer.state === true && relayTimerService.getOffTimer(equipmentId, channel)) return newer;
  return null;
}

/**
 * Write one coil, read it back (FC01, unless write-only), and return the
 * confirmation result. A disagreeing read-back triggers ONE re-write + re-read
 * before the result is decided; genuine disagreement raises a warning alert.
 *
 * Every write is recorded in the RelayCommandLedger first (context.gen when the
 * caller already recorded it). The re-write is skipped when a newer command on
 * the channel explains the disagreeing read-back (see supersedingCommand); the
 * result then carries `superseded` (the newer command), `retried: false` and
 * raises no unconfirmed alert.
 */
async function writeCoilConfirmed(equipment, target, address, value, context = {}, writeOptions = undefined) {
  const { host, port, unitId } = target;
  const sendWrite = async () => {
    if (equipment.write_only) {
      await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, address, value);
    } else {
      await modbusTcpClient.writeSingleCoil(host, port, unitId, address, value, writeOptions);
    }
  };
  const gen = Number.isFinite(context.gen) ? context.gen
    : commandLedger.record(equipment.id, address, value, { source: context.source, automationId: context.automationId });
  let superseded = null;
  const retry = async () => {
    superseded = supersedingCommand(equipment.id, address, value === true, gen, { staleOff: !!context.staleOff });
    if (superseded) {
      console.warn(`[Relay] ${equipment.name} ch ${address}: read-back disagrees with ${value ? 'ON' : 'OFF'} (gen ${gen}) but a newer ${superseded.state ? 'ON' : 'OFF'} (gen ${superseded.gen}, ${superseded.source || '?'}) owns the channel — not re-writing`);
      return;
    }
    await sendWrite();
  };
  await sendWrite();
  let rb = await readback.confirmCoilWrite(modbusTcpClient, target, address, value, {
    writeOnly: !!equipment.write_only,
    retry
  });
  if (superseded) return { ...rb, retried: false, superseded, gen };
  if (rb.source === 'readback' && !rb.confirmed) {
    readback.reportUnconfirmed(equipment, address, value, rb.readback, context);
  } else if (rb.source === 'readback_failed') {
    console.warn(`[Relay] read-back unavailable for ${equipment.name} ch ${address} (requested ${value ? 'ON' : 'OFF'}) — logged as unconfirmed`);
  }
  return { ...rb, superseded: null, gen };
}

/**
 * Write a contiguous run of coils (FC15), read the run back and return the
 * per-channel confirmation. Same retry / alert policy as writeCoilConfirmed().
 * Every channel is recorded in the RelayCommandLedger; the run is NOT re-sent
 * when a disagreeing channel requested ON has a newer command since this write
 * (an FC15 re-send rewrites the whole run, so it is skipped as a whole). Those
 * channels are listed in `superseded` and raise no unconfirmed alert.
 */
async function writeCoilsConfirmed(equipment, target, start, values, context = {}, writeOptions = undefined) {
  const { host, port, unitId } = target;
  const sendWrite = async () => {
    if (equipment.write_only) {
      await modbusTcpClient.writeMultipleCoilsFireAndForget(host, port, unitId, start, values);
    } else {
      await modbusTcpClient.writeMultipleCoils(host, port, unitId, start, values, writeOptions);
    }
  };
  const gens = values.map((v, i) => commandLedger.record(equipment.id, start + i, v === true, { source: context.source, automationId: context.automationId }));
  const superseded = [];
  const retry = async (firstReadback) => {
    for (let i = 0; i < values.length; i++) {
      const req = values[i] === true;
      if (!req || !Array.isArray(firstReadback) || firstReadback[i] === req) continue;
      const newer = supersedingCommand(equipment.id, start + i, true, gens[i]);
      if (newer) superseded.push({ channel: start + i, by: newer });
    }
    if (superseded.length) {
      console.warn(`[Relay] ${equipment.name} coils ${start}..${start + values.length - 1}: not re-sending — newer command(s) on ch ${superseded.map(s => s.channel).join(',')}`);
      return;
    }
    await sendWrite();
  };
  await sendWrite();
  const rb = await readback.confirmWrite(modbusTcpClient, target, start, values, {
    writeOnly: !!equipment.write_only,
    retry
  });
  const skip = new Set(superseded.map(s => s.channel));
  if (rb.source === 'readback') {
    for (const it of rb.items) {
      if (!it.confirmed && !skip.has(it.channel)) readback.reportUnconfirmed(equipment, it.channel, it.requested, it.readback, context);
    }
  } else if (rb.source === 'readback_failed') {
    console.warn(`[Relay] read-back unavailable for ${equipment.name} coils ${start}..${start + values.length - 1} — logged as unconfirmed`);
  }
  if (superseded.length) return { ...rb, retried: false, superseded };
  return { ...rb, superseded };
}

/**
 * Evaluate action dependencies. Returns { passed: bool, reason: string, evaluated: [...] }.
 *
 * Dependency types:
 *   - sensor:            uses raw value from equipment.last_reading
 *   - calibrated_sensor: uses calibration to estimate real value from raw
 *   - lab_reading:       uses most recent lab_readings entry for a nutrient
 *
 * Common fields:
 *   { type, operator: gt|gte|lt|lte|eq|neq, value, max_age_minutes? }
 *
 * Sensor-specific:
 *   { equipment_id, metric }   // metric = mapping name like "Conductivity (EC)"
 *
 * Lab-specific:
 *   { nutrient, zone_id? }
 */
function evaluateDependencies(deps) {
  if (!Array.isArray(deps) || deps.length === 0) {
    return { passed: true, reason: 'no dependencies', evaluated: [] };
  }

  const evaluated = [];
  const compare = (a, op, b) => {
    switch (op) {
      case 'gt':  return a > b;
      case 'gte': return a >= b;
      case 'lt':  return a < b;
      case 'lte': return a <= b;
      case 'eq':  return a === b;
      case 'neq': return a !== b;
      default:    return false;
    }
  };

  for (const dep of deps) {
    let currentValue = null;
    let valueAgeSec = null;
    let source = '';

    try {
      if (dep.type === 'sensor' || dep.type === 'calibrated_sensor') {
        const eq = db.prepare('SELECT id, name, last_reading, last_communication FROM equipment WHERE id = ?').get(dep.equipment_id);
        if (eq && eq.last_reading) {
          const parsed = JSON.parse(eq.last_reading);
          if (parsed.values && parsed.values[dep.metric]) {
            currentValue = parseFloat(parsed.values[dep.metric].value);
          } else if (parsed[dep.metric] !== undefined) {
            currentValue = parseFloat(parsed[dep.metric]);
          }
          if (eq.last_communication) {
            valueAgeSec = Math.round((Date.now() - new Date(eq.last_communication).getTime()) / 1000);
          }
          source = `${eq.name}/${dep.metric}`;

          // Apply calibration if requested
          if (dep.type === 'calibrated_sensor' && currentValue !== null) {
            const { calibrationService } = require('./CalibrationService');
            const est = calibrationService.estimate(dep.equipment_id, dep.metric, currentValue);
            currentValue = est.calibrated;
            source += ' (calibrated)';
          }
        }
      } else if (dep.type === 'lab_reading') {
        let q = "SELECT value, sample_date FROM lab_readings WHERE nutrient = ?";
        const params = [dep.nutrient];
        if (dep.zone_id) {
          q += " AND zone_id = ?";
          params.push(dep.zone_id);
        }
        q += " ORDER BY sample_date DESC LIMIT 1";
        const row = db.prepare(q).get(...params);
        if (row) {
          currentValue = row.value;
          valueAgeSec = Math.round((Date.now() - new Date(row.sample_date.includes('T') ? row.sample_date : row.sample_date + 'T12:00:00Z').getTime()) / 1000);
          source = `lab:${dep.nutrient}`;
        }
      }
    } catch (err) {
      evaluated.push({ ...dep, currentValue: null, passed: false, error: err.message });
      return { passed: false, reason: `Dep eval error: ${err.message}`, evaluated };
    }

    if (currentValue === null || isNaN(currentValue)) {
      evaluated.push({ ...dep, currentValue: null, passed: false, reason: 'no data' });
      return { passed: false, reason: `No data for ${source || dep.type}`, evaluated };
    }

    // Check freshness
    if (dep.max_age_minutes && valueAgeSec !== null && valueAgeSec > dep.max_age_minutes * 60) {
      evaluated.push({ ...dep, currentValue, age_seconds: valueAgeSec, passed: false, reason: 'stale data' });
      return { passed: false, reason: `${source} data is ${valueAgeSec}s old (max ${dep.max_age_minutes}min)`, evaluated };
    }

    const threshold = parseFloat(dep.value);
    const ok = compare(currentValue, dep.operator, threshold);
    evaluated.push({ ...dep, currentValue, age_seconds: valueAgeSec, passed: ok, source });

    if (!ok) {
      const opSym = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' }[dep.operator] || dep.operator;
      return { passed: false, reason: `${source} = ${currentValue} not ${opSym} ${threshold}`, evaluated };
    }
  }

  return { passed: true, reason: 'all deps passed', evaluated };
}

/**
 * Length of the dose cycle an automation run starts: max(delay + duration) over
 * the control actions that ran (not errored / skipped by a dependency). Equals
 * max(duration) when no action is delayed; covers every zone of a soft-switch run
 * (one delayed pump window per zone). 0 = no timed control action ran.
 */
function doseCycleSeconds(executedActions) {
  const ran = (executedActions || [])
    .filter(a => a && a.type === 'control' && a.status !== 'error' && a.status !== 'skipped_dependency');
  return Math.max(0, ...ran.map(a => {
    const dur = parseFloat(a.duration_seconds) || 0;
    return dur > 0 ? (parseFloat(a.delay_seconds) || 0) + dur : 0;
  }));
}

/**
 * Execute all actions for an automation.
 *
 * @param {object} automation - The automation row from the database
 * @param {string} source - 'manual' | 'scheduler' — for logging
 * @returns {Promise<{executedActions: Array, error: string|null}>}
 */
async function executeAutomation(automation, source = 'manual') {
  // Emergency stop backstop. Every known caller (scheduler, manual trigger
  // route, watchdog auto-rearm) gates on the disarm flag itself; this is the
  // single choke point that catches any caller added later. stopAllRelays()
  // does NOT come through here — it calls executeControlAction directly — so
  // the emergency stop itself still works while disarmed.
  const arming = automationArmingService.getState();
  if (arming.disarmed) {
    automationArmingService.noteSkip(
      'executor',
      `[Automation] Automations DISARMED — refusing to execute "${automation?.name}" (id=${automation?.id}, source=${source})${automationArmingService.describe(arming)}`
    );
    return { executedActions: [], skipped: true, reason: 'automations_disarmed' };
  }

  // Parse actions
  let actions;
  try {
    actions = typeof automation.actions === 'string'
      ? JSON.parse(automation.actions)
      : automation.actions || [];
  } catch (e) {
    actions = [];
  }

  const executedActions = [];
  let actionIdx = -1;

  for (const action of actions) {
    actionIdx++;
    // Evaluate dependencies (if any) before executing
    if (action.dependencies && Array.isArray(action.dependencies) && action.dependencies.length > 0) {
      const depResult = evaluateDependencies(action.dependencies);
      if (!depResult.passed) {
        console.log(`[Automation] Action skipped (deps): ${depResult.reason}`);
        executedActions.push({
          type: action.type,
          status: 'skipped_dependency',
          action: action.action,
          reason: depResult.reason,
          evaluated: depResult.evaluated
        });
        continue;
      }
    }

    if (action.type === 'alert') {
      // Default fingerprint = source|automation_id|message, so an alert automation
      // firing repeatedly bumps occurrence_count instead of inserting a new row.
      createAlert({
        severity: action.severity || 'info',
        source: 'automation',
        automation_id: automation.id,
        // A user-written alert text is stored as typed (not translated); only the default is a catalog key.
        ...(action.message ? { message: action.message } : { messageKey: 'automation.default_alert' }),
      });
      executedActions.push({ type: 'alert', status: 'executed', message: action.message });

    } else if (action.type === 'log') {
      executedActions.push({ type: 'log', status: 'executed', message: action.message || 'Event logged' });

    } else if (action.type === 'control') {
      const result = await executeControlAction(action, automation, { actionIdx });
      executedActions.push(result);

    } else if (action.type === 'transition') {
      const result = await executeTransitionAction(action, automation, actionIdx);
      executedActions.push(result);
    }
  }

  // If this automation references a fertigation dose program, kick off the dose
  // scheduler for the duration of the longest control action that actually ran.
  // The water pump + venturi pump actions handle themselves via duration_seconds;
  // the dose scheduler just modulates the injector valves alongside them.
  if (automation.dose_program_id) {
    try {
      // The dose cycle must cover the whole run: max(delay + duration) over the
      // control actions that ran. Identical to max(duration) when no action is
      // delayed; with soft-switch runs (one delayed pump window per zone) a plain
      // max(duration) would end dosing after the first zone (Part D, 2026-09-26).
      const cycleSeconds = doseCycleSeconds(executedActions);
      const ranControl = cycleSeconds > 0;
      if (ranControl && cycleSeconds > 0 && !fertigationDoseScheduler.isRunning()) {
        fertigationDoseScheduler.startCycle({
          programId: automation.dose_program_id,
          durationSeconds: cycleSeconds,
          automationId: automation.id,
        }).catch(err => {
          console.error(`[Automation ${automation.id}] dose scheduler refused to start: ${err.message}`);
        });
      } else if (fertigationDoseScheduler.isRunning()) {
        console.warn(`[Automation ${automation.id}] dose program ${automation.dose_program_id} skipped: scheduler busy with another cycle`);
      }
    } catch (err) {
      console.error(`[Automation ${automation.id}] dose scheduler hook failed:`, err.message);
    }
  }

  // Log the automation run (include skipped action count if any)
  const skippedCount = executedActions.filter(a => a.status === 'skipped_dependency').length;
  const logMessage = skippedCount > 0
    ? `${source} trigger executed (${skippedCount} action(s) skipped by dependency)`
    : `${source} trigger executed`;
  db.prepare(
    "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run(automation.id, 'success', logMessage);

  // Update run count and last_run
  db.prepare(
    "UPDATE automations SET run_count = COALESCE(run_count, 0) + 1, last_run = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(automation.id);

  // Broadcast automation executed event
  global.broadcast('automation_executed', {
    automationId: automation.id,
    automationName: automation.name,
    source,
    actionsCount: executedActions.length,
    timestamp: new Date().toISOString()
  });

  return { executedActions };
}

// Never arm an auto-off shorter than this, however late the ON was.
const MIN_AUTO_OFF_S = 1;

/**
 * Auto-off delay for a timed ON: what is left of the PLANNED window
 * (plannedStart + duration) at `nowMs`, clamped to [MIN_AUTO_OFF_S, duration].
 * Never longer than the configured duration, so max-on stays bounded.
 */
function autoOffSeconds(durationSeconds, plannedStartMs, nowMs) {
  const d = Number(durationSeconds);
  const lateS = Math.max(0, (nowMs - plannedStartMs) / 1000);
  return Math.min(d, Math.max(MIN_AUTO_OFF_S, d - lateS));
}

/**
 * The stale auto-off guard (2026-10-07 zone-4 pump-off): the newer bounded ON
 * that now owns the channel, or null. `ownerGen` = the ON that armed this
 * auto-off; see supersedingCommand for the rule.
 */
function staleAutoOffOwner(equipmentId, channel, ownerGen) {
  return supersedingCommand(equipmentId, channel, false, ownerGen, { staleOff: true });
}

/**
 * A suppressed stale auto-off is logged through RelayEventLogger (via
 * applyRelayCache) with source 'automation_auto_off_superseded' and state = 1:
 * the channel stays ON under the newer command. Logging it as OFF would end the
 * newer ON's max-on clock in the safety watchdog and its pump window in the
 * dose controller / run builder. readback/confirmed are the coil's actual value.
 */
function logSupersededAutoOff(equipment, channel, automationId, owner, readbackValue, stage) {
  console.warn(`[Automation] Stale auto-off SUPPRESSED (${stage}) for ${equipment.name} ch ${channel} (automation ${automationId}): newer ON gen ${owner.gen} from ${owner.source || '?'}${owner.automationId != null ? ` (automation ${owner.automationId})` : ''} owns the channel and has its own auto-off`);
  const rbv = typeof readbackValue === 'boolean' ? readbackValue : null;
  try {
    applyRelayCache(equipment, [{ channel, requested: true, readback: rbv, confirmed: rbv === null ? null : rbv === true }], {
      source: 'automation_auto_off_superseded', automationId
    });
  } catch (err) {
    console.error('[Automation] failed to log a suppressed auto-off:', err.message);
  }
}

/**
 * The auto-off of a timed control ON. `ownerGen` is the generation of the ON
 * that armed it. Skipped (and logged) when a newer bounded ON owns the channel,
 * before the write or on its read-back verify; otherwise OFF write -> FC01
 * read-back -> one re-write on disagreement -> alert if still ON.
 */
async function runControlAutoOff(targetEquipment, target, address, automationId, ownerGen) {
  try {
    const owner = staleAutoOffOwner(targetEquipment.id, address, ownerGen);
    if (owner) {
      let rbv = null;
      if (!targetEquipment.write_only) {
        const vals = await readback.readBackCoils(modbusTcpClient, target, address, 1);
        rbv = vals ? vals[0] === true : null;
      }
      logSupersededAutoOff(targetEquipment, address, automationId, owner, rbv, 'before_write');
      return;
    }

    const offRb = await writeCoilConfirmed(targetEquipment, target, address, false, {
      source: 'automation_auto_off', automationId, staleOff: true
    });
    if (offRb.superseded) {
      // The OFF's read-back saw the newer ON — expected, not a failed OFF: no re-write.
      logSupersededAutoOff(targetEquipment, address, automationId, offRb.superseded, offRb.readback, 'verify');
      return;
    }
    if (offRb.retried) {
      try {
        db.prepare(`
          INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
          VALUES (?, ?, ?, 0, 1, ?, ?, datetime('now'))
        `).run(targetEquipment.id, targetEquipment.name, address,
          offRb.confirmed ? 'auto_off_verify_failed' : 'auto_off_retry_failed',
          JSON.stringify({ automation_id: automationId, retry: true, stuck: !offRb.confirmed }));
      } catch (e) {}
      if (!offRb.confirmed) {
        console.error(`[Automation] Auto-off RETRY FAILED for equipment ${targetEquipment.id} ch ${address} — STILL STUCK ON`);
      }
    }

    // Cache the READ-BACK value, log with confirmed/readback_state, broadcast
    applyRelayCache(targetEquipment, [{ channel: address, requested: false, readback: offRb.readback, confirmed: offRb.confirmed }], {
      source: 'automation_auto_off',
      automationId
    });

    console.log(`[Automation] Auto-off completed for equipment ${targetEquipment.id} channel ${address} (confirmed=${offRb.confirmed})`);
  } catch (err) {
    console.error(`[Automation] Auto-off failed for equipment ${targetEquipment.id} channel ${address}:`, err.message);
  }
}

/**
 * Execute a single control action (relay / equipment control).
 *
 * @param {object} action
 * @param {object} automation - owning automation ({ id: null } for non-automation callers)
 * @param {object} [options]
 * @param {string} [options.eventSource] - relay_events / broadcast source label
 *        for the immediate write (defaults to 'automation')
 */
async function executeControlAction(action, automation, options = {}) {
  const eventSource = options.eventSource || 'automation';
  const targetEquipment = action.equipment_id
    ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(action.equipment_id)
    : null;

  if (targetEquipment && action.channel != null) {
    const hostPort = parseHostPort(targetEquipment.address);
    if (!hostPort) {
      return { type: 'control', status: 'error', action: action.action, error: 'Invalid equipment address format' };
    }

    const { host, port } = hostPort;
    const unitId = targetEquipment.slave_id || 1;
    const address = parseInt(action.channel, 10);
    const value = action.action === 'on' ? true : action.action === 'off' ? false : true;

    // When this action is MEANT to switch: scheduling time + its delay. The
    // auto-off is timed from this planned schedule, not from the (possibly
    // late) actual ON — a late pump ON on a busy bus must not push its OFF into
    // the next zone's pump window (2026-10-07 zone-4 pump-off).
    const plannedStartMs = Date.now() + (action.delay_seconds > 0 ? action.delay_seconds * 1000 : 0);

    // Helper: execute the relay write + cache update + broadcast + auto-off scheduling
    const executeRelayAction = async () => {
      // Hard interlock: an ON write must first drive the partner channel OFF
      // and confirm it by read-back. Throws InterlockViolation (logged +
      // critical alert) and never falls through to the energising write.
      const cacheStates = [];
      if (value === true) {
        const guard = await interlock.guardEnergise(targetEquipment, address, modbusTcpClient, {
          source: eventSource, automationId: automation.id
        });
        // The interlock already drove the partner OFF and read it back.
        if (guard.partner !== null) cacheStates.push({ channel: guard.partner, requested: false, readback: false, confirmed: true });
      }

      // This command's generation on the channel, recorded before anything is written.
      const gen = commandLedger.record(targetEquipment.id, address, value, { source: eventSource, automationId: automation.id });

      // Auto-off for a timed ON, armed BEFORE the ON write: the channel always has
      // its OFF owner (also when the write times out but the board took it), and
      // arming replaces — cancels — any older pending auto-off on this channel.
      // checkEnabled is deliberately NOT set: auto-off only ever de-energises,
      // so disabling the automation must never cancel it and strand a relay ON.
      if (action.duration_seconds && action.duration_seconds > 0 && value === true) {
        const offSeconds = autoOffSeconds(action.duration_seconds, plannedStartMs, Date.now());
        relayTimerService.scheduleOff(targetEquipment.id, address, offSeconds,
          () => runControlAutoOff(targetEquipment, { host, port, unitId }, address, automation.id, gen),
          { automationId: automation.id });
      }

      // write -> read back -> (retry once on disagreement) -> alert on disagreement
      const rb = await writeCoilConfirmed(targetEquipment, { host, port, unitId }, address, value, {
        source: eventSource, automationId: automation.id, gen
      });
      cacheStates.unshift({ channel: address, requested: value, readback: rb.readback, confirmed: rb.confirmed });

      // Update cached relay state (READ-BACK value), log relay event, broadcast relay_state_changed
      applyRelayCache(targetEquipment, cacheStates, {
        source: eventSource,
        automationId: automation.id,
        userEmail: options.userEmail || null
      });

      console.log(`[Automation] Relay control executed: equipment ${targetEquipment.id} ch ${address} -> ${value}`);
    };

    try {
      if (action.delay_seconds && action.delay_seconds > 0) {
        // Gate the callback on the automation still being enabled only when this
        // delayed action would turn the coil ON; a delayed OFF must always run.
        relayTimerService.scheduleDelayedStart(targetEquipment.id, address, action.delay_seconds, executeRelayAction, {
          automationId: automation.id,
          checkEnabled: value === true,
          // per action: one automation may hold several delayed windows on a channel
          actionKey: automation.id != null && Number.isInteger(options.actionIdx) ? `a${automation.id}:${options.actionIdx}` : null
        });
        return {
          type: 'control', status: 'scheduled', action: action.action,
          equipment: targetEquipment.name, channel: address,
          channel_name: action.channel_name || `Coil ${address}`,
          delay_seconds: action.delay_seconds,
          duration_seconds: action.duration_seconds || null
        };
      } else {
        await executeRelayAction();
        return {
          type: 'control', status: 'executed', action: action.action,
          equipment: targetEquipment.name, channel: address,
          channel_name: action.channel_name || `Coil ${address}`,
          delay_seconds: null,
          duration_seconds: action.duration_seconds || null
        };
      }
    } catch (err) {
      console.error(`[Automation] Relay control failed for ${targetEquipment.name} ch ${address}:`, err.message);
      return { type: 'control', status: 'error', action: action.action, error: err.message };
    }
  } else if (targetEquipment && action.channel == null) {
    // "All channels" mode — find all coil mappings and control each one
    let mappings = [];
    try {
      mappings = typeof targetEquipment.register_mappings === 'string'
        ? JSON.parse(targetEquipment.register_mappings)
        : (targetEquipment.register_mappings || []);
    } catch (e) {}

    const coils = mappings.filter(m => m.type === 'coil' && m.access === 'readwrite');
    if (coils.length === 0) {
      return { type: 'control', status: 'executed', action: action.action, note: 'No coil mappings found on equipment' };
    }

    // "All channels ON" would energise both members of an interlock pair — refuse outright.
    if (action.action !== 'off' && interlock.hasInterlockPairs(targetEquipment)) {
      const [a, b] = interlock.getInterlockPairs(targetEquipment)[0];
      const err = new interlock.InterlockViolation(
        `Interlock: "All channels ON" refused on ${targetEquipment.name} — ch ${a} and ch ${b} can never be ON at the same time`,
        { equipment_id: targetEquipment.id, channels: [a, b] }
      );
      interlock.reportViolation(targetEquipment, a, err, { source: eventSource, automationId: automation.id });
      return { type: 'control', status: 'error', action: action.action, equipment: targetEquipment.name, all_channels: true, error: err.message };
    }

    // Execute each coil as a separate per-channel action with optional stagger
    const staggerMs = (action.stagger_delay_seconds && action.stagger_delay_seconds > 0)
      ? action.stagger_delay_seconds * 1000
      : 0;
    const results = [];
    for (let i = 0; i < coils.length; i++) {
      if (staggerMs > 0 && i > 0) {
        console.log(`[Automation] Stagger delay: waiting ${action.stagger_delay_seconds}s before channel ${coils[i].register ?? coils[i].address}`);
        await sleep(staggerMs);
      }
      const channelAction = {
        ...action,
        channel: parseInt(coils[i].register ?? coils[i].address, 10),
        channel_name: coils[i].label || coils[i].name || `Coil ${coils[i].register ?? coils[i].address}`,
        stagger_delay_seconds: null,  // prevent sub-action from re-processing
        delay_seconds: i === 0 ? action.delay_seconds : null  // only first channel gets the initial delay
      };
      const result = await executeControlAction(channelAction, automation, options);
      results.push(result);
    }
    return { type: 'control', status: 'executed', action: action.action, equipment: targetEquipment.name, all_channels: true, stagger_delay_seconds: action.stagger_delay_seconds || null, channels: results };
  } else {
    return { type: 'control', status: 'executed', action: action.action, note: 'Equipment not found' };
  }
}

/**
 * Execute an atomic transition action — flips multiple coils on the same
 * equipment in a single Modbus FC15 (Write Multiple Coils) frame so the
 * relay board updates them with no possible drift between channels.
 *
 * Action shape:
 *   {
 *     type: 'transition',
 *     equipment_id: 1,
 *     delay_seconds: 180,                // optional initial delay
 *     duration_seconds: 180,             // optional auto-revert delay
 *     transitions: [
 *       { channel: 3, state: false, name: 'Zone 1' },
 *       { channel: 4, state: true,  name: 'Zone 2' }
 *     ]
 *   }
 *
 * If transitions cover non-contiguous coil addresses, the executor splits
 * them into multiple FC15 calls (one per contiguous group), issued back-to-back.
 */
async function executeTransitionAction(action, automation, actionIdx = 0) {
  const targetEquipment = action.equipment_id
    ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(action.equipment_id)
    : null;

  if (!targetEquipment) {
    return { type: 'transition', status: 'error', error: 'Equipment not found' };
  }
  if (!Array.isArray(action.transitions) || action.transitions.length === 0) {
    return { type: 'transition', status: 'error', error: 'No transitions specified' };
  }

  const hostPort = parseHostPort(targetEquipment.address);
  if (!hostPort) {
    return { type: 'transition', status: 'error', error: 'Invalid equipment address' };
  }
  const { host, port } = hostPort;
  const unitId = targetEquipment.slave_id || 1;

  // Helper that actually issues the FC15 writes
  const executeTransitions = async () => {
    // Cancel any pending auto-reverts from previous transitions on the SAME equipment.
    // This prevents an old transition's auto-revert from wiping out the new state we're about to set.
    const cancelled = relayTimerService.cancelTimersByPrefix(`transition_off:${targetEquipment.id}:`);
    if (cancelled > 0) {
      console.log(`[Automation] Cancelled ${cancelled} stale auto-revert(s) before new transition on equipment ${targetEquipment.id}`);
    }

    // Hard interlock: the frame must not energise both members of a pair, and
    // every partner of a channel being energised is driven OFF + read back
    // BEFORE the frame goes out. Throws InterlockViolation (logged + alert).
    const partnersOff = await interlock.guardWriteSet(targetEquipment, action.transitions, modbusTcpClient, {
      source: 'automation_transition', automationId: automation.id
    });

    // Sort transitions by channel address and group into contiguous FC15 runs
    const groups = buildCoilRuns(action.transitions);
    const sorted = groups.sorted;

    // Execute each group via FC15, then read the run back (FC01). A disagreeing
    // read-back re-sends that run once before the result is decided.
    const frameStates = [];
    for (const g of groups) {
      let rb;
      try {
        rb = await writeCoilsConfirmed(targetEquipment, { host, port, unitId }, g.start, g.values, {
          source: 'automation_transition', automationId: automation.id
        });
        console.log(`[Automation] Transition FC15 sent: equipment ${targetEquipment.id} addr=${g.start} qty=${g.values.length} (${g.items.map(i => `ch${i.channel}=${i.state?'ON':'OFF'}`).join(', ')}) confirmed=${rb.confirmed}${rb.retried ? ' (after retry)' : ''}`);
      } catch (err) {
        console.error(`[Automation] Transition FC15 failed for equipment ${targetEquipment.id}:`, err.message);
        throw err;
      }
      if (rb.retried) {
        const mismatches = rb.items.filter(i => !i.confirmed).map(i => ({ channel: i.channel, expected: i.requested, actual: i.readback }));
        try {
          db.prepare(`
            INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
            VALUES (?, ?, ?, ?, ?, 'transition_verify_failed', ?, datetime('now'))
          `).run(targetEquipment.id, targetEquipment.name, g.start, g.values[0] ? 1 : 0, rb.readback && rb.readback[0] ? 1 : 0,
            JSON.stringify({ automation_id: automation.id, retried: true, stillMismatched: mismatches }));
        } catch (e) {}
      }
      for (const it of rb.items) {
        frameStates.push({ channel: it.channel, requested: it.requested, readback: it.readback, confirmed: it.confirmed });
      }
    }

    // Interlock partners switched OFF ahead of the frame (already read back by the interlock)
    const partnerStates = partnersOff
      .filter(p => !sorted.some(t => t.channel === p))
      .map(p => ({ channel: p, requested: false, readback: false, confirmed: true }));
    if (partnerStates.length) {
      applyRelayCache(targetEquipment, partnerStates, { source: 'interlock', automationId: automation.id });
    }

    // Cache the READ-BACK values, log each channel with confirmed/readback_state, broadcast
    applyRelayCache(targetEquipment, frameStates, { source: 'automation', automationId: automation.id });

    // Schedule auto-revert if duration_seconds is set: flip all transitioned coils to OFF
    if (action.duration_seconds && action.duration_seconds > 0) {
      // Unique key per action to avoid collisions when multiple transitions on the same equipment
      const revertKey = `transition_off:${targetEquipment.id}:${automation.id}:${actionIdx}`;
      relayTimerService.scheduleDelayedRaw(revertKey, action.duration_seconds, async () => {
        try {
          // Build OFF transitions for the same group; write -> read back -> cache/log with confirmed
          const offGroups = groups.map(g => ({ start: g.start, values: g.values.map(() => false) }));
          const offStates = [];
          for (const g of offGroups) {
            const rb = await writeCoilsConfirmed(targetEquipment, { host, port, unitId }, g.start, g.values, {
              source: 'automation_auto_off', automationId: automation.id
            });
            for (const it of rb.items) {
              offStates.push({ channel: it.channel, requested: false, readback: it.readback, confirmed: it.confirmed });
            }
          }
          applyRelayCache(targetEquipment, offStates, { source: 'automation_auto_off', automationId: automation.id });
          console.log(`[Automation] Transition auto-off completed for equipment ${targetEquipment.id} (${sorted.length} channels, confirmed=${offStates.every(s => s.confirmed)})`);
        } catch (err) {
          console.error('[Automation] Transition auto-off failed:', err.message);
        }
      }, { automationId: automation.id });
    }
  };

  // Apply optional delay
  try {
    if (action.delay_seconds && action.delay_seconds > 0) {
      // Unique key per action to avoid timer collisions when multiple transitions
      // on the same equipment share channels
      const delayKey = `transition_delay:${targetEquipment.id}:${automation.id}:${actionIdx}`;
      // Gate on the automation still being enabled only when this transition
      // would energise at least one coil; an all-OFF transition must always run.
      relayTimerService.scheduleDelayedRaw(delayKey, action.delay_seconds, executeTransitions, {
        automationId: automation.id,
        checkEnabled: action.transitions.some(t => !!t.state)
      });
      return {
        type: 'transition', status: 'scheduled', equipment: targetEquipment.name,
        delay_seconds: action.delay_seconds, transitions: action.transitions.length
      };
    } else {
      await executeTransitions();
      return {
        type: 'transition', status: 'executed', equipment: targetEquipment.name,
        transitions: action.transitions.length, delay_seconds: null,
        duration_seconds: action.duration_seconds || null
      };
    }
  } catch (err) {
    return { type: 'transition', status: 'error', error: err.message };
  }
}

/**
 * Emergency stop — the operator's "stop everything".
 *
 * Order matters:
 *   1. Cancel EVERY pending relay timer first, so nothing can re-energise a
 *      coil in the seconds after we push it off.
 *   2. Abort any running fertigation dose cycle (it owns its own timers).
 *   3. Drive every writable coil of every Modbus relay equipment OFF.
 *
 * Coils are grouped per board (host:port:unitId) into contiguous runs and
 * written with FC15 (Write Multiple Coils) — one frame per run instead of one
 * FC05 per channel — using a short per-call timeout (2 s, 1 attempt) so a dead
 * board costs seconds, not the default 5 s × 3 retries. Boards run under
 * Promise.allSettled; boards sharing a gateway still serialise on the pooled
 * host:port request queue, which is what the RS485 bus needs.
 *
 * Rows that are not Modbus or have no parseable host:port address are listed
 * under `skipped` rather than counted as failures.
 *
 * NOT filtered by equipment.enabled: an emergency stop must reach a relay that
 * is disabled in SenseHub but still physically energised.
 *
 * @param {object} [options]
 * @param {object} [options.progress] - if supplied, this object is mutated live
 *        with the running summary so a caller that gives up waiting (HTTP
 *        deadline) can report what has happened so far.
 * @returns {Promise<StopAllSummary>}
 *
 * StopAllSummary = {
 *   ok: boolean,                 // every attempted channel confirmed written
 *   partial: boolean,            // some channel failed (or sweep still running)
 *   attempted: number,           // channels we tried to write
 *   succeeded: number,           // channels written OK (== channelsTurnedOff)
 *   failed: [{ equipment_id, name, channels: number[], error }],
 *   skipped: [{ equipment_id, name, reason }],
 *   boardsTotal, boardsDone,
 *   timersCancelled, doseCycleAborted,
 *   channelsTurnedOff, failures  // legacy per-channel view for older clients
 * }
 */
const STOP_ALL_WRITE_OPTIONS = { timeout: 2000, retries: 1 };

function isConnectionLevelError(err) {
  const m = String(err && err.message || '');
  return /ECONN|EHOSTUNREACH|ENETUNREACH|timed out|Timed Out|Port Not Open|Connection not found|Max reconnect/i.test(m);
}

/**
 * Build the per-board work list for stopAllRelays from equipment rows.
 * Pure (no I/O) so it can be unit-tested against real rows.
 *
 * @returns {{ boards: Array<{key, equipment, host, port, unitId, coils, runs}>, skipped: Array }}
 */
function planStopAll(equipmentList) {
  const boards = new Map();
  const skipped = [];

  for (const eq of equipmentList) {
    // Relay equipment = anything exposing writable coils. Same definition the
    // executor uses for an "all channels" control action.
    let mappings = [];
    try {
      mappings = typeof eq.register_mappings === 'string'
        ? JSON.parse(eq.register_mappings)
        : (eq.register_mappings || []);
    } catch (e) {}

    const coilMappings = Array.isArray(mappings)
      ? mappings.filter(m => m && m.type === 'coil' && m.access === 'readwrite')
      : [];
    if (coilMappings.length === 0) continue;

    if (String(eq.protocol || '').toLowerCase() !== 'modbus') {
      skipped.push({ equipment_id: eq.id, name: eq.name, reason: `protocol '${eq.protocol || 'unknown'}' is not modbus` });
      continue;
    }
    const hostPort = parseHostPort(eq.address);
    if (!hostPort) {
      skipped.push({ equipment_id: eq.id, name: eq.name, reason: `unparseable address '${eq.address || ''}'` });
      continue;
    }

    const coils = [];
    const badCoils = [];
    for (const coil of coilMappings) {
      const channel = parseInt(coil.register ?? coil.address, 10);
      if (!Number.isFinite(channel)) {
        badCoils.push(coil.register ?? coil.address ?? null);
        continue;
      }
      coils.push({ channel, state: false, name: coil.label || coil.name || `Coil ${channel}` });
    }
    if (badCoils.length > 0) {
      skipped.push({ equipment_id: eq.id, name: eq.name, reason: `invalid coil address(es) in register_mappings: ${badCoils.join(', ')}` });
    }
    if (coils.length === 0) continue;

    const unitId = eq.slave_id || 1;
    const key = `${hostPort.host}:${hostPort.port}:${unitId}`;
    let board = boards.get(key);
    if (!board) {
      board = { key, equipment: eq, host: hostPort.host, port: hostPort.port, unitId, coils: [] };
      boards.set(key, board);
    } else if (board.equipment.id !== eq.id) {
      // Two equipment rows claim the same physical board — write both sets of
      // coils but bookkeep under the first row's id, and note the overlap.
      skipped.push({ equipment_id: eq.id, name: eq.name, reason: `shares board ${key} with equipment #${board.equipment.id}; coils written under that row` });
    }
    // Dedupe channels within a board
    for (const c of coils) {
      if (!board.coils.some(x => x.channel === c.channel)) board.coils.push(c);
    }
  }

  const list = [...boards.values()];
  for (const b of list) b.runs = buildCoilRuns(b.coils);
  return { boards: list, skipped };
}

async function stopAllRelays(options = {}) {
  const summary = options.progress && typeof options.progress === 'object' ? options.progress : {};
  Object.assign(summary, {
    ok: false,
    partial: true,
    inProgress: true,
    attempted: 0,
    succeeded: 0,
    failed: [],
    skipped: [],
    boardsTotal: 0,
    boardsDone: 0,
    timersCancelled: 0,
    doseCycleAborted: false,
    channelsTurnedOff: 0,
    failures: [],
    startedAt: new Date().toISOString(),
  });

  // A flow-watch cold-restart retry waiting out its pause is not a RelayTimer:
  // drop it first so nothing re-energises the irrigation pumps after the stop.
  try {
    const fw = require('./IrrigationFlowWatchService').peekFlowWatchService();
    if (fw && fw.cancelPendingRetry('Stop All')) console.log('[Automation] Stop-all: cancelled a pending flow-watch cold restart');
  } catch (err) {
    console.error('[Automation] Stop-all: flow-watch retry cancel failed:', err.message);
  }

  summary.timersCancelled = relayTimerService.cancelAllTimers();
  console.log(`[Automation] Stop-all: cancelled ${summary.timersCancelled} pending relay timer(s)`);

  // A running fertigation dose cycle keeps its OWN setTimeout timers, which are
  // not in the RelayTimerService map and would keep cycling injector valves.
  try {
    if (fertigationDoseScheduler.isRunning()) {
      summary.doseCycleAborted = await fertigationDoseScheduler.abortCycle('stop-all requested');
      console.log('[Automation] Stop-all: aborted the running fertigation dose cycle');
    }
  } catch (err) {
    console.error('[Automation] Stop-all: failed to abort dose cycle:', err.message);
  }

  const equipmentList = db.prepare(
    'SELECT id, name, protocol, address, slave_id, write_only, register_mappings, last_reading FROM equipment'
  ).all();
  const { boards, skipped } = planStopAll(equipmentList);
  summary.skipped = skipped;
  summary.boardsTotal = boards.length;
  for (const s of skipped) {
    console.warn(`[Automation] Stop-all: skipping ${s.name} (#${s.equipment_id}): ${s.reason}`);
  }

  const recordFailure = (board, channels, error) => {
    summary.failed.push({ equipment_id: board.equipment.id, name: board.equipment.name, channels, error });
    for (const ch of channels) {
      summary.failures.push({ equipment_id: board.equipment.id, equipment: board.equipment.name, channel: ch, error });
    }
    console.error(`[Automation] Stop-all: failed to turn off ${board.equipment.name} ch ${channels.join(',')}: ${error}`);
  };

  const stopBoard = async (board) => {
    const { equipment, host, port, unitId, runs } = board;
    const okChannels = [];
    let abortError = null;

    for (const run of runs) {
      const channels = run.items.map(i => i.channel);
      summary.attempted += channels.length;
      if (abortError) {
        // A connection-level failure on this board — don't burn another
        // timeout per run on a board that isn't answering.
        recordFailure(board, channels, abortError);
        continue;
      }
      try {
        // newest command on these channels: an in-flight ON's read-back retry must not re-energise them
        commandLedger.recordMany(equipment.id, channels, false, { source: 'stop_all' });
        if (equipment.write_only) {
          await modbusTcpClient.writeMultipleCoilsFireAndForget(host, port, unitId, run.start, run.values);
        } else {
          await modbusTcpClient.writeMultipleCoils(host, port, unitId, run.start, run.values, STOP_ALL_WRITE_OPTIONS);
        }
        okChannels.push(...channels);
        summary.succeeded += channels.length;
        summary.channelsTurnedOff = summary.succeeded;
        console.log(`[Automation] Stop-all FC15 sent: ${equipment.name} (#${equipment.id}) addr=${run.start} qty=${run.values.length} -> OFF`);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        recordFailure(board, channels, msg);
        if (isConnectionLevelError(err)) abortError = msg;
      }
    }

    if (okChannels.length > 0) {
      try {
        applyRelayCache(equipment, okChannels.map(channel => ({ channel, state: false })), {
          source: 'stop_all',
          automationId: null
        });
      } catch (err) {
        console.error(`[Automation] Stop-all: cache/broadcast update failed for ${equipment.name}:`, err.message);
      }
    }
  };

  const results = await Promise.allSettled(boards.map(async (board) => {
    try {
      await stopBoard(board);
    } finally {
      summary.boardsDone++;
    }
  }));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      // stopBoard catches per-run errors; anything reaching here is unexpected.
      const board = boards[i];
      const msg = results[i].reason && results[i].reason.message ? results[i].reason.message : String(results[i].reason);
      recordFailure(board, board.coils.map(c => c.channel), `unexpected: ${msg}`);
    }
  }

  summary.inProgress = false;
  summary.ok = summary.failed.length === 0;
  summary.partial = !summary.ok;
  summary.finishedAt = new Date().toISOString();

  console.log(`[Automation] Stop-all complete: ${summary.succeeded}/${summary.attempted} channel(s) off across ${summary.boardsTotal} board(s), ${summary.failed.length} failure(s), ${summary.skipped.length} skipped`);

  return summary;
}

module.exports = {
  executeAutomation, evaluateDependencies, executeTransitionAction, stopAllRelays,
  // exported for tests / reuse (flow-watch run shutdown + cold-restart retry)
  planStopAll, buildCoilRuns, parseHostPort, applyRelayCache,
  writeCoilConfirmed, writeCoilsConfirmed, doseCycleSeconds,
  executeControlAction, autoOffSeconds, supersedingCommand,
};
