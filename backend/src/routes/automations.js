const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { executeAutomation } = require('../services/AutomationExecutor');

const router = express.Router();

// GET /api/automations - List all automations
router.get('/', (req, res) => {
  const automations = db.prepare('SELECT * FROM automations ORDER BY priority ASC, name ASC').all();
  res.json(automations);
});

// POST /api/automations - Create automation
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, trigger_config, conditions, condition_logic, actions, priority } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  const result = db.prepare(
    'INSERT INTO automations (name, description, trigger_config, conditions, condition_logic, actions, priority) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    name,
    description,
    JSON.stringify(trigger_config || {}),
    JSON.stringify(conditions || []),
    condition_logic || 'AND',
    JSON.stringify(actions || []),
    priority || 0
  );

  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(automation);
});

// GET /api/automations/templates - Get automation templates
router.get('/templates', (req, res) => {
  const templates = [
    {
      id: 'temperature_alert',
      name: 'Temperature Alert',
      description: 'Send alert when temperature exceeds a threshold value',
      category: 'Monitoring',
      trigger_config: {
        type: 'threshold',
        sensor_type: 'temperature',
        operator: 'gt',
        threshold_value: 30,
        unit: '°C'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'warning', message: 'High temperature detected - exceeds threshold' }]
    },
    {
      id: 'humidity_alert',
      name: 'Humidity Alert',
      description: 'Send alert when humidity goes outside normal range',
      category: 'Monitoring',
      trigger_config: {
        type: 'threshold',
        sensor_type: 'humidity',
        operator: 'gt',
        threshold_value: 80,
        unit: '%'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'warning', message: 'High humidity detected - check ventilation' }]
    },
    {
      id: 'scheduled_on',
      name: 'Daily Equipment Start',
      description: 'Turn equipment on at a scheduled time each day',
      category: 'Scheduling',
      trigger_config: {
        type: 'schedule',
        schedule_type: 'daily',
        time: '08:00'
      },
      conditions: [],
      actions: [{ type: 'control', action: 'on' }]
    },
    {
      id: 'scheduled_off',
      name: 'Daily Equipment Shutdown',
      description: 'Turn equipment off at a scheduled time each day',
      category: 'Scheduling',
      trigger_config: {
        type: 'schedule',
        schedule_type: 'daily',
        time: '18:00'
      },
      conditions: [],
      actions: [{ type: 'control', action: 'off' }]
    },
    {
      id: 'weekly_maintenance',
      name: 'Weekly Maintenance Alert',
      description: 'Send maintenance reminder every week',
      category: 'Maintenance',
      trigger_config: {
        type: 'schedule',
        schedule_type: 'weekly',
        day_of_week: '1',
        time: '09:00'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'info', message: 'Weekly maintenance check reminder' }]
    },
    {
      id: 'low_temperature_alert',
      name: 'Low Temperature Alert',
      description: 'Send critical alert when temperature drops below threshold',
      category: 'Monitoring',
      trigger_config: {
        type: 'threshold',
        sensor_type: 'temperature',
        operator: 'lt',
        threshold_value: 5,
        unit: '°C'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'critical', message: 'Critical: Low temperature detected - risk of freezing' }]
    },
    {
      id: 'pressure_alert',
      name: 'Pressure Alert',
      description: 'Alert when pressure exceeds safe operating limit',
      category: 'Safety',
      trigger_config: {
        type: 'threshold',
        sensor_type: 'pressure',
        operator: 'gt',
        threshold_value: 100,
        unit: 'PSI'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'critical', message: 'Critical: High pressure detected - check equipment immediately' }]
    },
    {
      id: 'manual_inspection',
      name: 'Manual Inspection Trigger',
      description: 'Manually triggered inspection with logging',
      category: 'Manual',
      trigger_config: {
        type: 'manual'
      },
      conditions: [],
      actions: [
        { type: 'log', message: 'Manual inspection initiated' },
        { type: 'alert', severity: 'info', message: 'Manual inspection in progress' }
      ]
    },
    {
      id: 'power_monitor',
      name: 'Power Consumption Alert',
      description: 'Alert when power consumption exceeds limit',
      category: 'Monitoring',
      trigger_config: {
        type: 'threshold',
        sensor_type: 'power',
        operator: 'gt',
        threshold_value: 5000,
        unit: 'W'
      },
      conditions: [],
      actions: [{ type: 'alert', severity: 'warning', message: 'High power consumption detected' }]
    },
    {
      id: 'hourly_log',
      name: 'Hourly Status Log',
      description: 'Log system status every hour',
      category: 'Logging',
      trigger_config: {
        type: 'schedule',
        schedule_type: 'hourly',
        minute: '0'
      },
      conditions: [],
      actions: [{ type: 'log', message: 'Hourly status check completed' }]
    }
  ];

  res.json(templates);
});

// GET /api/automations/:id - Get automation details
router.get('/:id', (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Get run history
  const logs = db.prepare(
    'SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY triggered_at DESC LIMIT 50'
  ).all(req.params.id);

  res.json({ ...automation, logs });
});

// PUT /api/automations/:id - Update automation
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, trigger_config, conditions, condition_logic, actions, priority, enabled } = req.body;
  const automationId = req.params.id;

  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  db.prepare(
    "UPDATE automations SET name = ?, description = ?, trigger_config = ?, conditions = ?, condition_logic = ?, actions = ?, priority = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    name ?? automation.name,
    description ?? automation.description,
    trigger_config ? JSON.stringify(trigger_config) : automation.trigger_config,
    conditions ? JSON.stringify(conditions) : automation.conditions,
    condition_logic ?? automation.condition_logic ?? 'AND',
    actions ? JSON.stringify(actions) : automation.actions,
    priority ?? automation.priority,
    enabled !== undefined ? (enabled ? 1 : 0) : automation.enabled,
    automationId
  );

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);
  res.json(updated);
});

// DELETE /api/automations/:id - Delete automation
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  res.json({ message: 'Automation deleted successfully' });
});

// POST /api/automations/:id/test - Test automation in simulation mode
router.post('/:id/test', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Parse automation configuration
  let triggerConfig, conditions, actions;
  try {
    triggerConfig = typeof automation.trigger_config === 'string'
      ? JSON.parse(automation.trigger_config)
      : automation.trigger_config || {};
    conditions = typeof automation.conditions === 'string'
      ? JSON.parse(automation.conditions)
      : automation.conditions || [];
    actions = typeof automation.actions === 'string'
      ? JSON.parse(automation.actions)
      : automation.actions || [];
  } catch (e) {
    triggerConfig = {};
    conditions = [];
    actions = [];
  }

  // Build trigger evaluation result
  const triggerEvaluation = {
    type: triggerConfig.type || 'manual',
    would_fire: true,
    details: {}
  };

  if (triggerConfig.type === 'schedule') {
    triggerEvaluation.details = {
      schedule_type: triggerConfig.schedule_type || 'daily',
      time: triggerConfig.time || '08:00',
      next_run: 'Next scheduled run calculated based on configuration'
    };
  } else if (triggerConfig.type === 'threshold') {
    const equipment = triggerConfig.equipment_id
      ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(triggerConfig.equipment_id)
      : null;
    triggerEvaluation.details = {
      equipment: equipment?.name || 'Any equipment',
      sensor_type: triggerConfig.sensor_type || 'temperature',
      condition: `${triggerConfig.operator || 'gt'} ${triggerConfig.threshold_value || 0}${triggerConfig.unit || ''}`,
      current_value: 'N/A (simulated)',
      would_trigger: 'Yes (simulated threshold met)'
    };
  } else if (triggerConfig.type === 'manual') {
    triggerEvaluation.details = {
      message: 'Manual trigger - fires when user clicks Run button'
    };
  }

  // Evaluate conditions (simulated)
  const conditionResults = conditions.map((cond, idx) => ({
    index: idx + 1,
    field: cond.field,
    operator: cond.operator,
    expected_value: cond.value,
    test_result: 'PASS (simulated)',
    would_pass: true
  }));

  const conditionLogic = automation.condition_logic || 'AND';
  const allConditionsMet = conditionResults.length === 0 ||
    (conditionLogic === 'AND' ? conditionResults.every(c => c.would_pass) : conditionResults.some(c => c.would_pass));

  // Simulate actions (no real execution)
  const actionResults = actions.map((action, idx) => {
    const result = {
      index: idx + 1,
      type: action.type,
      simulated: true,
      would_execute: allConditionsMet
    };

    if (action.type === 'alert') {
      result.details = {
        severity: action.severity || 'info',
        message: action.message,
        simulation_note: 'Would create alert in alerts table (NOT CREATED during test)'
      };
    } else if (action.type === 'control') {
      const equipment = action.equipment_id
        ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(action.equipment_id)
        : null;
      result.details = {
        action: action.action,
        equipment: equipment?.name || action.equipment_name || 'Unknown',
        equipment_id: action.equipment_id,
        channel: action.channel != null ? action.channel : 'all',
        channel_name: action.channel_name || null,
        delay_seconds: action.delay_seconds || null,
        duration_seconds: action.duration_seconds || null,
        value: action.value,
        simulation_note: action.channel != null
          ? `Would${action.delay_seconds ? ` wait ${action.delay_seconds}s then` : ''} send FC05 to coil ${action.channel}${action.duration_seconds ? ` with ${action.duration_seconds}s auto-off` : ''} (NOT SENT during test)`
          : 'Would send control command to equipment (NOT SENT during test)'
      };
    } else if (action.type === 'log') {
      result.details = {
        message: action.message,
        simulation_note: 'Would log event (NOT LOGGED during test)'
      };
    }

    return result;
  });

  // Build comprehensive test result
  const testResult = {
    automation_id: automation.id,
    automation_name: automation.name,
    status: allConditionsMet ? 'success' : 'conditions_not_met',
    simulated: true,
    mode: 'TEST MODE - No actual actions executed',
    timestamp: new Date().toISOString(),
    summary: {
      trigger_would_fire: triggerEvaluation.would_fire,
      conditions_evaluated: conditionResults.length,
      conditions_logic: conditionLogic,
      all_conditions_met: allConditionsMet,
      actions_to_execute: actionResults.filter(a => a.would_execute).length,
      total_actions: actions.length
    },
    trigger: triggerEvaluation,
    conditions: conditionResults,
    actions: actionResults,
    message: allConditionsMet
      ? `Test completed successfully. ${actionResults.length} action(s) would be executed.`
      : `Test completed. Conditions not met - ${actionResults.length} action(s) would NOT execute.`
  };

  res.json(testResult);
});

// POST /api/automations/:id/toggle - Toggle automation enabled state
router.post('/:id/toggle', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  const newState = automation.enabled ? 0 : 1;
  db.prepare("UPDATE automations SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newState, req.params.id);

  res.json({ enabled: newState === 1 });
});

// POST /api/automations/:id/duplicate - Duplicate an automation
router.post('/:id/duplicate', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Create a new name with "Copy" suffix
  let newName = `${automation.name} (Copy)`;

  // Check if this name already exists, and increment the copy number if needed
  let copyNumber = 1;
  while (db.prepare('SELECT id FROM automations WHERE name = ?').get(newName)) {
    copyNumber++;
    newName = `${automation.name} (Copy ${copyNumber})`;
  }

  // Insert the duplicated automation
  const result = db.prepare(
    'INSERT INTO automations (name, description, trigger_config, conditions, condition_logic, actions, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newName,
    automation.description,
    automation.trigger_config,
    automation.conditions,
    automation.condition_logic || 'AND',
    automation.actions,
    automation.priority || 0,
    0  // Start disabled for safety
  );

  const duplicated = db.prepare('SELECT * FROM automations WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    success: true,
    message: `Automation duplicated as "${newName}"`,
    automation: duplicated
  });
});

// POST /api/automations/:id/trigger - Manually trigger an automation
router.post('/:id/trigger', requireRole('admin', 'operator'), async (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  let triggerConfig;
  try {
    triggerConfig = typeof automation.trigger_config === 'string'
      ? JSON.parse(automation.trigger_config)
      : automation.trigger_config;
  } catch (e) {
    triggerConfig = {};
  }

  try {
    const { executedActions } = await executeAutomation(automation, 'manual');
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(automation.id);

    res.json({
      success: true,
      automation_id: automation.id,
      automation_name: automation.name,
      trigger_type: triggerConfig?.type || 'manual',
      executed_actions: executedActions,
      run_count: updated.run_count,
      last_run: updated.last_run,
      message: `Automation "${automation.name}" triggered successfully`
    });
  } catch (err) {
    console.error(`[Automation] Manual trigger failed for "${automation.name}":`, err.message);
    res.status(500).json({ error: 'Execution failed', message: err.message });
  }
});

module.exports = router;
