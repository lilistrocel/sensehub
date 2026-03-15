const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// System templates seeded on first run
const SYSTEM_TEMPLATES = [
  {
    name: 'Temperature Alert',
    description: 'Send alert when temperature exceeds a threshold value',
    category: 'Monitoring',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'warning', message: 'High temperature detected - exceeds threshold' }]
  },
  {
    name: 'Humidity Alert',
    description: 'Send alert when humidity goes outside normal range',
    category: 'Monitoring',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'warning', message: 'High humidity detected - check ventilation' }]
  },
  {
    name: 'Equipment On',
    description: 'Turn equipment on (assign a trigger to control when)',
    category: 'Control',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'control', action: 'on' }]
  },
  {
    name: 'Equipment Off',
    description: 'Turn equipment off (assign a trigger to control when)',
    category: 'Control',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'control', action: 'off' }]
  },
  {
    name: 'Maintenance Reminder',
    description: 'Send a maintenance check reminder',
    category: 'Maintenance',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'info', message: 'Weekly maintenance check reminder' }]
  },
  {
    name: 'Low Temperature Alert',
    description: 'Send critical alert when temperature drops below threshold',
    category: 'Monitoring',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'critical', message: 'Critical: Low temperature detected - risk of freezing' }]
  },
  {
    name: 'Pressure Alert',
    description: 'Alert when pressure exceeds safe operating limit',
    category: 'Safety',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'critical', message: 'Critical: High pressure detected - check equipment immediately' }]
  },
  {
    name: 'Manual Inspection',
    description: 'Inspection workflow with logging',
    category: 'Manual',
    conditions: [],
    condition_logic: 'AND',
    actions: [
      { type: 'log', message: 'Manual inspection initiated' },
      { type: 'alert', severity: 'info', message: 'Manual inspection in progress' }
    ]
  },
  {
    name: 'Power Consumption Alert',
    description: 'Alert when power consumption exceeds limit',
    category: 'Monitoring',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'alert', severity: 'warning', message: 'High power consumption detected' }]
  },
  {
    name: 'Hourly Status Log',
    description: 'Log system status periodically',
    category: 'Logging',
    conditions: [],
    condition_logic: 'AND',
    actions: [{ type: 'log', message: 'Hourly status check completed' }]
  }
];

// Seed system templates if not already present
const seedAutomationTemplates = () => {
  if (!db) return;
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM automation_templates WHERE is_system = 1').get();
    if (count.count === 0) {
      const stmt = db.prepare(
        'INSERT INTO automation_templates (name, description, category, conditions, condition_logic, actions, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)'
      );
      const insertAll = db.transaction((templates) => {
        for (const t of templates) {
          stmt.run(t.name, t.description, t.category, JSON.stringify(t.conditions), t.condition_logic, JSON.stringify(t.actions));
        }
      });
      insertAll(SYSTEM_TEMPLATES);
      console.log(`Seeded ${SYSTEM_TEMPLATES.length} system automation templates`);
    }
  } catch (err) {
    console.error('Error seeding automation templates:', err);
  }
};

seedAutomationTemplates();

// GET /api/automation-templates - List all automation templates
router.get('/', (req, res) => {
  try {
    const { category } = req.query;
    let query = 'SELECT * FROM automation_templates WHERE 1=1';
    const params = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    query += ' ORDER BY is_system DESC, category, name';
    const templates = db.prepare(query).all(...params);

    // Parse JSON fields
    const parsed = templates.map(t => ({
      ...t,
      conditions: JSON.parse(t.conditions || '[]'),
      actions: JSON.parse(t.actions || '[]')
    }));

    res.json(parsed);
  } catch (err) {
    console.error('Error fetching automation templates:', err);
    res.status(500).json({ error: 'Failed to fetch automation templates' });
  }
});

// GET /api/automation-templates/:id - Get a single template
router.get('/:id', (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Include count of linked automations
    const linked = db.prepare('SELECT COUNT(*) as count FROM automations WHERE template_id = ?').get(req.params.id);

    res.json({
      ...template,
      conditions: JSON.parse(template.conditions || '[]'),
      actions: JSON.parse(template.actions || '[]'),
      linked_automations_count: linked.count
    });
  } catch (err) {
    console.error('Error fetching automation template:', err);
    res.status(500).json({ error: 'Failed to fetch automation template' });
  }
});

// POST /api/automation-templates - Create a custom template
router.post('/', requireRole('admin', 'operator'), (req, res) => {
  try {
    const { name, description, category, conditions, condition_logic, actions } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'At least one action is required' });
    }

    const result = db.prepare(
      'INSERT INTO automation_templates (name, description, category, conditions, condition_logic, actions, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      name,
      description || null,
      category || 'General',
      JSON.stringify(conditions || []),
      condition_logic || 'AND',
      JSON.stringify(actions)
    );

    const newTemplate = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({
      ...newTemplate,
      conditions: JSON.parse(newTemplate.conditions || '[]'),
      actions: JSON.parse(newTemplate.actions || '[]')
    });
  } catch (err) {
    console.error('Error creating automation template:', err);
    res.status(500).json({ error: 'Failed to create automation template' });
  }
});

// PUT /api/automation-templates/:id - Update a template and propagate to linked automations
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { name, description, category, conditions, condition_logic, actions } = req.body;

    // Update the template
    db.prepare(
      "UPDATE automation_templates SET name = ?, description = ?, category = ?, conditions = ?, condition_logic = ?, actions = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(
      name ?? template.name,
      description !== undefined ? description : template.description,
      category ?? template.category,
      conditions ? JSON.stringify(conditions) : template.conditions,
      condition_logic ?? template.condition_logic,
      actions ? JSON.stringify(actions) : template.actions,
      req.params.id
    );

    // Propagate changes to all linked automations
    const newConditions = conditions ? JSON.stringify(conditions) : template.conditions;
    const newConditionLogic = condition_logic ?? template.condition_logic;
    const newActions = actions ? JSON.stringify(actions) : template.actions;

    const propagated = db.prepare(
      "UPDATE automations SET conditions = ?, condition_logic = ?, actions = ?, updated_at = datetime('now') WHERE template_id = ?"
    ).run(newConditions, newConditionLogic, newActions, req.params.id);

    const updated = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(req.params.id);

    // Broadcast update to connected clients
    if (global.broadcast) {
      global.broadcast('automation_template_updated', {
        templateId: parseInt(req.params.id),
        propagatedCount: propagated.changes,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      ...updated,
      conditions: JSON.parse(updated.conditions || '[]'),
      actions: JSON.parse(updated.actions || '[]'),
      propagated_to: propagated.changes
    });
  } catch (err) {
    console.error('Error updating automation template:', err);
    res.status(500).json({ error: 'Failed to update automation template' });
  }
});

// DELETE /api/automation-templates/:id - Delete a template (unlinks automations)
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (template.is_system) {
      return res.status(403).json({ error: 'System templates cannot be deleted' });
    }

    // Unlink automations (they keep their current actions but lose template_id)
    const unlinked = db.prepare(
      "UPDATE automations SET template_id = NULL, updated_at = datetime('now') WHERE template_id = ?"
    ).run(req.params.id);

    db.prepare('DELETE FROM automation_templates WHERE id = ?').run(req.params.id);

    res.json({
      success: true,
      message: 'Template deleted',
      unlinked_automations: unlinked.changes
    });
  } catch (err) {
    console.error('Error deleting automation template:', err);
    res.status(500).json({ error: 'Failed to delete automation template' });
  }
});

// GET /api/automation-templates/:id/automations - List automations linked to this template
router.get('/:id/automations', (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const automations = db.prepare('SELECT * FROM automations WHERE template_id = ? ORDER BY name').all(req.params.id);
    res.json(automations);
  } catch (err) {
    console.error('Error fetching linked automations:', err);
    res.status(500).json({ error: 'Failed to fetch linked automations' });
  }
});

module.exports = router;
