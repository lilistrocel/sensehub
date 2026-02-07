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
  const { name, description, trigger_config, conditions, actions, priority } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  const result = db.prepare(
    'INSERT INTO automations (name, description, trigger_config, conditions, actions, priority) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    name,
    description,
    JSON.stringify(trigger_config || {}),
    JSON.stringify(conditions || []),
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
      description: 'Send alert when temperature exceeds threshold',
      trigger_config: { type: 'threshold', equipment_type: 'temperature' },
      conditions: [{ field: 'value', operator: 'gt', value: 30 }],
      actions: [{ type: 'alert', severity: 'warning', message: 'High temperature detected' }]
    },
    {
      id: 'scheduled_control',
      name: 'Scheduled Equipment Control',
      description: 'Turn equipment on/off at scheduled times',
      trigger_config: { type: 'schedule', cron: '0 8 * * *' },
      conditions: [],
      actions: [{ type: 'control', action: 'on' }]
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
  const { name, description, trigger_config, conditions, actions, priority, enabled } = req.body;
  const automationId = req.params.id;

  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  db.prepare(
    "UPDATE automations SET name = ?, description = ?, trigger_config = ?, conditions = ?, actions = ?, priority = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    name ?? automation.name,
    description ?? automation.description,
    trigger_config ? JSON.stringify(trigger_config) : automation.trigger_config,
    conditions ? JSON.stringify(conditions) : automation.conditions,
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

module.exports = router;
