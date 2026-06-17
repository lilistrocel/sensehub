/**
 * AutomationExecutor - Shared action execution logic for automations.
 *
 * Used by both the REST trigger endpoint and the background scheduler.
 */

const { db } = require('../utils/database');
const { broadcastNewAlert } = require('../utils/alertBroadcast');
const { modbusTcpClient } = require('./ModbusTcpClient');
const { relayTimerService } = require('./RelayTimerService');
const { logRelayEvent } = require('./RelayEventLogger');
const { fertigationDoseScheduler } = require('./FertigationDoseScheduler');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
      broadcastNewAlert(db.prepare(
        "INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))"
      ).run(action.severity || 'info', action.message || 'Automation triggered'));
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
 */
async function executeControlAction(action, automation) {
  const targetEquipment = action.equipment_id
    ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(action.equipment_id)
    : null;

  if (targetEquipment && action.channel != null) {
    const addrParts = (targetEquipment.address || '').split(':');
    if (addrParts.length !== 2) {
      return { type: 'control', status: 'error', action: action.action, error: 'Invalid equipment address format' };
    }

    const host = addrParts[0];
    const port = parseInt(addrParts[1], 10);
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

      // Update cached relay state
      let lastReading = {};
      try { if (targetEquipment.last_reading) lastReading = JSON.parse(targetEquipment.last_reading); } catch (e) {}
      if (!lastReading.relayStates) lastReading.relayStates = {};
      lastReading.relayStates[address] = value;

      db.prepare(
        "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(lastReading), targetEquipment.id);

      global.broadcast('relay_state_changed', {
        equipmentId: targetEquipment.id,
        channel: address,
        state: value,
        source: 'automation',
        automationId: automation.id
      });

      // Log relay event for fertigation tracking
      logRelayEvent(targetEquipment.id, address, value, 'automation', automation.id);

      // Schedule auto-off if duration_seconds is set and action is "on"
      if (action.duration_seconds && action.duration_seconds > 0 && value === true) {
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
        });
      }

      console.log(`[Automation] Relay control executed: equipment ${targetEquipment.id} ch ${address} -> ${value}`);
    };

    try {
      if (action.delay_seconds && action.delay_seconds > 0) {
        relayTimerService.scheduleDelayedStart(targetEquipment.id, address, action.delay_seconds, executeRelayAction);
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
      const result = await executeControlAction(channelAction, automation);
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

  const addrParts = (targetEquipment.address || '').split(':');
  if (addrParts.length !== 2) {
    return { type: 'transition', status: 'error', error: 'Invalid equipment address' };
  }
  const host = addrParts[0];
  const port = parseInt(addrParts[1], 10);
  const unitId = targetEquipment.slave_id || 1;

  // Helper that actually issues the FC15 writes
  const executeTransitions = async () => {
    // Cancel any pending auto-reverts from previous transitions on the SAME equipment.
    // This prevents an old transition's auto-revert from wiping out the new state we're about to set.
    const cancelled = relayTimerService.cancelTimersByPrefix(`transition_off:${targetEquipment.id}:`);
    if (cancelled > 0) {
      console.log(`[Automation] Cancelled ${cancelled} stale auto-revert(s) before new transition on equipment ${targetEquipment.id}`);
    }

    // Sort transitions by channel address
    const sorted = [...action.transitions]
      .map(t => ({ channel: parseInt(t.channel, 10), state: !!t.state, name: t.name || `Coil ${t.channel}` }))
      .sort((a, b) => a.channel - b.channel);

    // Group into contiguous ranges
    const groups = [];
    let current = null;
    for (const t of sorted) {
      if (current && t.channel === current.start + current.values.length) {
        current.values.push(t.state);
        current.items.push(t);
      } else {
        if (current) groups.push(current);
        current = { start: t.channel, values: [t.state], items: [t] };
      }
    }
    if (current) groups.push(current);

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
      });
    }
  };

  // Apply optional delay
  try {
    if (action.delay_seconds && action.delay_seconds > 0) {
      // Unique key per action to avoid timer collisions when multiple transitions
      // on the same equipment share channels
      const delayKey = `transition_delay:${targetEquipment.id}:${automation.id}:${actionIdx}`;
      relayTimerService.scheduleDelayedRaw(delayKey, action.delay_seconds, executeTransitions);
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

module.exports = { executeAutomation, evaluateDependencies, executeTransitionAction };
