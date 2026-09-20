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

/**
 * Per-channel bookkeeping after a successful coil write: update the cached
 * relayStates in equipment.last_reading, mark the equipment online, log a
 * relay_events row and broadcast `relay_state_changed` for each channel.
 *
 * The broadcast payload shape ({equipmentId, channel, state, source,
 * automationId}) is relied on by the frontend — keep it stable.
 *
 * @param {object} equipment - equipment row (id, last_reading)
 * @param {Array<{channel:number, state:boolean}>} channelStates
 * @param {object} opts
 * @param {string} opts.source - relay_events / broadcast source label
 * @param {number|null} opts.automationId
 */
function applyRelayCache(equipment, channelStates, { source, automationId = null }) {
  // Re-read last_reading so we merge onto the freshest polled snapshot rather
  // than a row that may have been fetched seconds (or a delay timer) ago.
  let lastReading = {};
  try {
    const fresh = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(equipment.id);
    const raw = fresh ? fresh.last_reading : equipment.last_reading;
    if (raw) lastReading = JSON.parse(raw);
  } catch (e) {
    try { if (equipment.last_reading) lastReading = JSON.parse(equipment.last_reading); } catch (e2) {}
  }
  if (!lastReading || typeof lastReading !== 'object') lastReading = {};
  if (!lastReading.relayStates) lastReading.relayStates = {};
  for (const { channel, state } of channelStates) {
    lastReading.relayStates[channel] = state;
  }

  db.prepare(
    "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(lastReading), equipment.id);

  for (const { channel, state } of channelStates) {
    global.broadcast('relay_state_changed', {
      equipmentId: equipment.id,
      channel,
      state,
      source,
      automationId
    });
    // Log relay event for fertigation tracking
    logRelayEvent(equipment.id, channel, state, source, automationId);
  }
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
        message: action.message || 'Automation triggered',
      });
      executedActions.push({ type: 'alert', status: 'executed', message: action.message });

    } else if (action.type === 'log') {
      executedActions.push({ type: 'log', status: 'executed', message: action.message || 'Event logged' });

    } else if (action.type === 'control') {
      const result = await executeControlAction(action, automation);
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
      const durations = executedActions
        .filter(a => a.type === 'control' && a.status !== 'error' && a.status !== 'skipped_dependency')
        .map(a => parseFloat(a.duration_seconds) || 0);
      const ranControl = durations.some(d => d > 0);
      const cycleSeconds = Math.max(0, ...durations);
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

    // Helper: execute the relay write + cache update + broadcast + auto-off scheduling
    const executeRelayAction = async () => {
      if (targetEquipment.write_only) {
        await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, address, value);
      } else {
        await modbusTcpClient.writeSingleCoil(host, port, unitId, address, value);
      }

      // Update cached relay state, log relay event, broadcast relay_state_changed
      applyRelayCache(targetEquipment, [{ channel: address, state: value }], {
        source: eventSource,
        automationId: automation.id
      });

      // Schedule auto-off if duration_seconds is set and action is "on"
      if (action.duration_seconds && action.duration_seconds > 0 && value === true) {
        // checkEnabled is deliberately NOT set: auto-off only ever de-energises,
        // so disabling the automation must never cancel it and strand a relay ON.
        relayTimerService.scheduleOff(targetEquipment.id, address, action.duration_seconds, async () => {
          try {
            // Send OFF command with retry+verify for reliability
            const sendOff = async () => {
              if (targetEquipment.write_only) {
                await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, address, false);
              } else {
                await modbusTcpClient.writeSingleCoil(host, port, unitId, address, false);
              }
            };

            await sendOff();

            // Verify the coil actually turned off (non-write-only devices)
            if (!targetEquipment.write_only) {
              await new Promise(r => setTimeout(r, 500)); // let the bus settle
              try {
                const coils = await modbusTcpClient.readCoils(host, port, unitId, address, 1, { timeout: 3000, retries: 1 });
                if (coils && coils[0] === true) {
                  console.warn(`[Automation] Auto-off verify FAILED for equipment ${targetEquipment.id} ch ${address} — still ON, retrying`);
                  try {
                    db.prepare(`
                      INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
                      VALUES (?, ?, ?, 0, 1, 'auto_off_verify_failed', ?, datetime('now'))
                    `).run(targetEquipment.id, targetEquipment.name, address, JSON.stringify({ automation_id: automation.id, retry: true }));
                  } catch (e) {}
                  await new Promise(r => setTimeout(r, 300));
                  await sendOff();

                  // Verify again after retry
                  await new Promise(r => setTimeout(r, 500));
                  try {
                    const retryCoils = await modbusTcpClient.readCoils(host, port, unitId, address, 1, { timeout: 3000, retries: 1 });
                    if (retryCoils && retryCoils[0] === true) {
                      console.error(`[Automation] Auto-off RETRY FAILED for equipment ${targetEquipment.id} ch ${address} — STILL STUCK ON`);
                      db.prepare(`
                        INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
                        VALUES (?, ?, ?, 0, 1, 'auto_off_retry_failed', ?, datetime('now'))
                      `).run(targetEquipment.id, targetEquipment.name, address, JSON.stringify({ automation_id: automation.id, stuck: true }));
                    }
                  } catch (e) {}
                }
              } catch (verifyErr) {
                // Verify read failed — the write probably went through, don't block on this
              }
            }

            let reading = {};
            try {
              const freshEq = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(targetEquipment.id);
              if (freshEq?.last_reading) reading = JSON.parse(freshEq.last_reading);
            } catch (e) {}
            if (!reading.relayStates) reading.relayStates = {};
            reading.relayStates[address] = false;

            db.prepare(
              "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), updated_at = datetime('now') WHERE id = ?"
            ).run(JSON.stringify(reading), targetEquipment.id);

            global.broadcast('relay_state_changed', {
              equipmentId: targetEquipment.id,
              channel: address,
              state: false,
              source: 'automation_auto_off',
              automationId: automation.id
            });

            // Log relay event for fertigation tracking
            logRelayEvent(targetEquipment.id, address, false, 'automation_auto_off', automation.id);

            console.log(`[Automation] Auto-off completed for equipment ${targetEquipment.id} channel ${address}`);
          } catch (err) {
            console.error(`[Automation] Auto-off failed for equipment ${targetEquipment.id} channel ${address}:`, err.message);
          }
        }, { automationId: automation.id });
      }

      console.log(`[Automation] Relay control executed: equipment ${targetEquipment.id} ch ${address} -> ${value}`);
    };

    try {
      if (action.delay_seconds && action.delay_seconds > 0) {
        // Gate the callback on the automation still being enabled only when this
        // delayed action would turn the coil ON; a delayed OFF must always run.
        relayTimerService.scheduleDelayedStart(targetEquipment.id, address, action.delay_seconds, executeRelayAction, {
          automationId: automation.id,
          checkEnabled: value === true
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

    // Sort transitions by channel address and group into contiguous FC15 runs
    const groups = buildCoilRuns(action.transitions);
    const sorted = groups.sorted;

    // Execute each group via FC15
    for (const g of groups) {
      try {
        if (targetEquipment.write_only) {
          await modbusTcpClient.writeMultipleCoilsFireAndForget(host, port, unitId, g.start, g.values);
        } else {
          await modbusTcpClient.writeMultipleCoils(host, port, unitId, g.start, g.values);
        }
        console.log(`[Automation] Transition FC15 sent: equipment ${targetEquipment.id} addr=${g.start} qty=${g.values.length} (${g.items.map(i => `ch${i.channel}=${i.state?'ON':'OFF'}`).join(', ')})`);
      } catch (err) {
        console.error(`[Automation] Transition FC15 failed for equipment ${targetEquipment.id}:`, err.message);
        throw err;
      }
    }

    // Update cached relay state
    let lastReading = {};
    try { if (targetEquipment.last_reading) lastReading = JSON.parse(targetEquipment.last_reading); } catch (e) {}
    if (!lastReading.relayStates) lastReading.relayStates = {};
    for (const t of sorted) {
      lastReading.relayStates[t.channel] = t.state;
    }
    db.prepare(
      "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(lastReading), targetEquipment.id);

    // Log each individual relay event and broadcast
    for (const t of sorted) {
      logRelayEvent(targetEquipment.id, t.channel, t.state, 'automation', automation.id);
      global.broadcast('relay_state_changed', {
        equipmentId: targetEquipment.id,
        channel: t.channel,
        state: t.state,
        source: 'automation_transition',
        automationId: automation.id
      });
    }

    // Verify-and-retry: read coils back and detect mismatches (only for non-write-only devices)
    if (!targetEquipment.write_only) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const minCh = sorted[0].channel;
        const maxCh = sorted[sorted.length - 1].channel;
        const span = maxCh - minCh + 1;
        const coils = await modbusTcpClient.readCoils(host, port, unitId, minCh, span, { timeout: 3000, retries: 1 });
        const mismatches = [];
        for (const t of sorted) {
          const idx = t.channel - minCh;
          if (coils[idx] !== t.state) {
            mismatches.push({ channel: t.channel, expected: t.state, actual: coils[idx] });
          }
        }
        if (mismatches.length > 0) {
          console.warn(`[Automation] Transition verify FAILED for equipment ${targetEquipment.id}: ${mismatches.length} mismatches, retrying`);
          try {
            db.prepare(`
              INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, detail, created_at)
              VALUES (?, ?, ?, ?, ?, 'transition_verify_failed', ?, datetime('now'))
            `).run(targetEquipment.id, targetEquipment.name, mismatches[0].channel, mismatches[0].expected ? 1 : 0, mismatches[0].actual ? 1 : 0, JSON.stringify({ automation_id: automation.id, mismatches }));
          } catch (e) {}
          // Retry the entire transition
          await new Promise(r => setTimeout(r, 300));
          for (const g of groups) {
            try {
              await modbusTcpClient.writeMultipleCoils(host, port, unitId, g.start, g.values);
            } catch (e) {
              console.error('[Automation] Transition retry write failed:', e.message);
            }
          }
        }
      } catch (verifyErr) {
        // Verify read failed (bus busy) — don't block, the polling drift detector will catch any issue
      }
    }

    // Schedule auto-revert if duration_seconds is set: flip all transitioned coils to OFF
    if (action.duration_seconds && action.duration_seconds > 0) {
      // Unique key per action to avoid collisions when multiple transitions on the same equipment
      const revertKey = `transition_off:${targetEquipment.id}:${automation.id}:${actionIdx}`;
      relayTimerService.scheduleDelayedRaw(revertKey, action.duration_seconds, async () => {
        try {
          // Build OFF transitions for the same group
          const offGroups = groups.map(g => ({ start: g.start, values: g.values.map(() => false) }));
          for (const g of offGroups) {
            if (targetEquipment.write_only) {
              await modbusTcpClient.writeMultipleCoilsFireAndForget(host, port, unitId, g.start, g.values);
            } else {
              await modbusTcpClient.writeMultipleCoils(host, port, unitId, g.start, g.values);
            }
          }
          // Update cache and log
          let r = {};
          try {
            const fresh = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(targetEquipment.id);
            if (fresh?.last_reading) r = JSON.parse(fresh.last_reading);
          } catch {}
          if (!r.relayStates) r.relayStates = {};
          for (const t of sorted) {
            r.relayStates[t.channel] = false;
            logRelayEvent(targetEquipment.id, t.channel, false, 'automation_auto_off', automation.id);
            global.broadcast('relay_state_changed', { equipmentId: targetEquipment.id, channel: t.channel, state: false, source: 'automation_auto_off', automationId: automation.id });
          }
          db.prepare("UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(r), targetEquipment.id);
          console.log(`[Automation] Transition auto-off completed for equipment ${targetEquipment.id} (${sorted.length} channels)`);
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
  // exported for tests / reuse
  planStopAll, buildCoilRuns, parseHostPort, applyRelayCache
};
