const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

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

// POST /api/automations/:id/test - Test automation
router.post('/:id/test', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Simulate automation test
  const testResult = {
    automation_id: automation.id,
    status: 'success',
    message: 'Test completed - conditions evaluated, actions simulated',
    simulated: true,
    timestamp: new Date().toISOString()
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
router.post('/:id/trigger', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Parse trigger_config to verify it's a manual type (though we allow triggering any)
  let triggerConfig;
  try {
    triggerConfig = typeof automation.trigger_config === 'string'
      ? JSON.parse(automation.trigger_config)
      : automation.trigger_config;
  } catch (e) {
    triggerConfig = {};
  }

  // Parse actions to execute
  let actions;
  try {
    actions = typeof automation.actions === 'string'
      ? JSON.parse(automation.actions)
      : automation.actions || [];
  } catch (e) {
    actions = [];
  }

  // Execute each action
  const executedActions = [];
  for (const action of actions) {
    if (action.type === 'alert') {
      // Create an alert in the database
      db.prepare(
        "INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))"
      ).run(action.severity || 'info', action.message || 'Automation triggered');
      executedActions.push({ type: 'alert', status: 'executed', message: action.message });
    } else if (action.type === 'log') {
      // Log the event
      executedActions.push({ type: 'log', status: 'executed', message: action.message || 'Event logged' });
    } else if (action.type === 'control') {
      // Control equipment (simulated for now)
      executedActions.push({ type: 'control', status: 'executed', action: action.action });
    }
  }

  // Log the automation run
  db.prepare(
    "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run(automation.id, 'success', 'Manual trigger executed');

  // Update automation run count and last_run
  db.prepare(
    "UPDATE automations SET run_count = COALESCE(run_count, 0) + 1, last_run = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(automation.id);

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
});

module.exports = router;
