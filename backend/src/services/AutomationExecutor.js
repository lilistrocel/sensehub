/**
 * AutomationExecutor - Shared action execution logic for automations.
 *
 * Used by both the REST trigger endpoint and the background scheduler.
 */

const { db } = require('../utils/database');
const { modbusTcpClient } = require('./ModbusTcpClient');
const { relayTimerService } = require('./RelayTimerService');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

  for (const action of actions) {
    if (action.type === 'alert') {
      db.prepare(
        "INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))"
      ).run(action.severity || 'info', action.message || 'Automation triggered');
      executedActions.push({ type: 'alert', status: 'executed', message: action.message });

    } else if (action.type === 'log') {
      executedActions.push({ type: 'log', status: 'executed', message: action.message || 'Event logged' });

    } else if (action.type === 'control') {
      const result = await executeControlAction(action, automation);
      executedActions.push(result);
    }
  }

  // Log the automation run
  db.prepare(
    "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run(automation.id, 'success', `${source} trigger executed`);

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

      // Schedule auto-off if duration_seconds is set and action is "on"
      if (action.duration_seconds && action.duration_seconds > 0 && value === true) {
        relayTimerService.scheduleOff(targetEquipment.id, address, action.duration_seconds, async () => {
          try {
            if (targetEquipment.write_only) {
              await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, address, false);
            } else {
              await modbusTcpClient.writeSingleCoil(host, port, unitId, address, false);
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

module.exports = { executeAutomation };
