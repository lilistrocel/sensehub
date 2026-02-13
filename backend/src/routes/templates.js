const express = require('express');
const router = express.Router();
const { db } = require('../utils/database');

// Helper function to generate relay coil mappings for Waveshare modules
const generateWaveshareRelayMappings = (channelCount) => {
  const mappings = [];
  for (let i = 0; i < channelCount; i++) {
    mappings.push({
      name: `Relay ${i + 1}`,
      register: String(i),
      type: 'coil',
      dataType: 'bool',
      access: 'readwrite'
    });
  }
  // Waveshare configuration registers
  mappings.push({
    name: 'Baud Rate Config',
    register: '8192', // 0x2000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  mappings.push({
    name: 'Device Address Config',
    register: '16384', // 0x4000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  return mappings;
};

// System templates that get seeded on startup
const SYSTEM_TEMPLATES = [
  {
    name: 'Waveshare 4-Channel Relay',
    category: 'relay',
    manufacturer: 'Waveshare',
    model: '4CH-RTU',
    description: 'Waveshare Modbus RTU 4-channel relay module with baud rate and address configuration registers',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: generateWaveshareRelayMappings(4),
    is_system: 1
  },
  {
    name: 'Waveshare 6-Channel Relay',
    category: 'relay',
    manufacturer: 'Waveshare',
    model: '6CH-RTU',
    description: 'Waveshare Modbus RTU 6-channel relay module with baud rate and address configuration registers',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: generateWaveshareRelayMappings(6),
    is_system: 1
  },
  {
    name: 'Waveshare 8-Channel Relay',
    category: 'relay',
    manufacturer: 'Waveshare',
    model: '8CH-RTU',
    description: 'Waveshare Modbus RTU 8-channel relay module with baud rate and address configuration registers',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: generateWaveshareRelayMappings(8),
    is_system: 1
  },
  {
    name: 'Waveshare 16-Channel Relay',
    category: 'relay',
    manufacturer: 'Waveshare',
    model: '16CH-RTU',
    description: 'Waveshare Modbus RTU 16-channel relay module with baud rate and address configuration registers',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: generateWaveshareRelayMappings(16),
    is_system: 1
  },
  {
    name: 'Waveshare 32-Channel Relay',
    category: 'relay',
    manufacturer: 'Waveshare',
    model: '32CH-RTU',
    description: 'Waveshare Modbus RTU 32-channel relay module with baud rate and address configuration registers',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: generateWaveshareRelayMappings(32),
    is_system: 1
  },
  {
    name: 'Generic Temperature/Humidity Sensor',
    category: 'sensor',
    manufacturer: 'Generic',
    model: 'TH-SENSOR',
    description: 'Generic Modbus temperature and humidity sensor',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 5000,
    register_mappings: [
      { name: 'Temperature', register: '0', type: 'input', dataType: 'int16', access: 'read' },
      { name: 'Humidity', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
    ],
    is_system: 1
  },
  {
    name: 'Generic Power Meter',
    category: 'meter',
    manufacturer: 'Generic',
    model: 'PWR-METER',
    description: 'Generic Modbus power meter with voltage, current, power and energy readings',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 1000,
    register_mappings: [
      { name: 'Voltage', register: '0', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Current', register: '2', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Power', register: '4', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Energy', register: '6', type: 'input', dataType: 'float32', access: 'read' },
    ],
    is_system: 1
  },
  {
    name: 'Generic VFD Controller',
    category: 'controller',
    manufacturer: 'Generic',
    model: 'VFD-CTRL',
    description: 'Generic Variable Frequency Drive with frequency control and monitoring',
    protocol: 'modbus',
    default_slave_id: 1,
    default_polling_interval_ms: 500,
    register_mappings: [
      { name: 'Frequency Setpoint', register: '0', type: 'holding', dataType: 'uint16', access: 'readwrite' },
      { name: 'Actual Frequency', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Current', register: '2', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Voltage', register: '3', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Run/Stop Command', register: '0', type: 'coil', dataType: 'bool', access: 'readwrite' },
    ],
    is_system: 1
  }
];

// Seed system templates if not already present
const seedSystemTemplates = () => {
  if (!db) return;

  try {
    const existingCount = db.prepare('SELECT COUNT(*) as count FROM device_templates WHERE is_system = 1').get();
    if (existingCount.count === 0) {
      const insertStmt = db.prepare(`
        INSERT INTO device_templates (name, category, manufacturer, model, description, protocol, default_slave_id, default_polling_interval_ms, register_mappings, is_system)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((templates) => {
        for (const t of templates) {
          insertStmt.run(
            t.name,
            t.category,
            t.manufacturer,
            t.model,
            t.description,
            t.protocol,
            t.default_slave_id,
            t.default_polling_interval_ms,
            JSON.stringify(t.register_mappings),
            t.is_system
          );
        }
      });

      insertMany(SYSTEM_TEMPLATES);
      console.log(`Seeded ${SYSTEM_TEMPLATES.length} system device templates`);
    }
  } catch (err) {
    console.error('Error seeding device templates:', err);
  }
};

// Initialize templates on module load
seedSystemTemplates();

// GET /api/templates - List all device templates
router.get('/', (req, res) => {
  try {
    const { category, manufacturer, protocol } = req.query;

    let query = 'SELECT * FROM device_templates WHERE 1=1';
    const params = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (manufacturer) {
      query += ' AND manufacturer = ?';
      params.push(manufacturer);
    }
    if (protocol) {
      query += ' AND protocol = ?';
      params.push(protocol);
    }

    query += ' ORDER BY is_system DESC, category, name';

    const templates = db.prepare(query).all(...params);

    // Parse JSON register_mappings for each template
    const parsed = templates.map(t => ({
      ...t,
      register_mappings: JSON.parse(t.register_mappings || '[]')
    }));

    res.json(parsed);
  } catch (err) {
    console.error('Error fetching templates:', err);
    res.status(500).json({ error: 'Failed to fetch device templates' });
  }
});

// GET /api/templates/:id - Get a specific template
router.get('/:id', (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM device_templates WHERE id = ?').get(req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({
      ...template,
      register_mappings: JSON.parse(template.register_mappings || '[]')
    });
  } catch (err) {
    console.error('Error fetching template:', err);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// POST /api/templates - Create a custom template
router.post('/', (req, res) => {
  try {
    const { name, category, manufacturer, model, description, protocol, default_slave_id, default_polling_interval_ms, register_mappings } = req.body;

    if (!name || !category || !register_mappings) {
      return res.status(400).json({ error: 'Name, category, and register_mappings are required' });
    }

    const result = db.prepare(`
      INSERT INTO device_templates (name, category, manufacturer, model, description, protocol, default_slave_id, default_polling_interval_ms, register_mappings, is_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      name,
      category,
      manufacturer || null,
      model || null,
      description || null,
      protocol || 'modbus',
      default_slave_id || null,
      default_polling_interval_ms || 1000,
      JSON.stringify(register_mappings)
    );

    const newTemplate = db.prepare('SELECT * FROM device_templates WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      ...newTemplate,
      register_mappings: JSON.parse(newTemplate.register_mappings)
    });
  } catch (err) {
    console.error('Error creating template:', err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// DELETE /api/templates/:id - Delete a custom template (system templates cannot be deleted)
router.delete('/:id', (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM device_templates WHERE id = ?').get(req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (template.is_system) {
      return res.status(403).json({ error: 'System templates cannot be deleted' });
    }

    db.prepare('DELETE FROM device_templates WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    console.error('Error deleting template:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = router;
