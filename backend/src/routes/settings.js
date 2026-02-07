const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings - Get system settings
router.get('/', requireRole('admin'), (req, res) => {
  const settings = db.prepare('SELECT * FROM system_settings').all();

  const settingsObj = {};
  settings.forEach(s => {
    try {
      settingsObj[s.key] = JSON.parse(s.value);
    } catch {
      settingsObj[s.key] = s.value;
    }
  });

  res.json(settingsObj);
});

// PUT /api/settings - Update system settings
router.put('/', requireRole('admin'), (req, res) => {
  const updates = req.body;

  const stmt = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, datetime("now"))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime("now")
  `);

  for (const [key, value] of Object.entries(updates)) {
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    stmt.run(key, valueStr, valueStr);
  }

  res.json({ message: 'Settings updated' });
});

// POST /api/settings/backup - Create backup
router.post('/backup', requireRole('admin'), (req, res) => {
  // In production, this would create an actual backup
  const backup = {
    id: Date.now(),
    created_at: new Date().toISOString(),
    size: '2.5 MB',
    status: 'completed'
  };

  res.json(backup);
});

// POST /api/settings/restore - Restore from backup
router.post('/restore', requireRole('admin'), (req, res) => {
  const { backup_id, confirm } = req.body;

  if (!confirm) {
    return res.status(400).json({ error: 'Bad Request', message: 'Confirmation required' });
  }

  // In production, this would restore from backup
  res.json({ message: 'Restore initiated', backup_id });
});

// POST /api/settings/factory-reset - Factory reset
router.post('/factory-reset', requireRole('admin'), (req, res) => {
  const { password, confirm } = req.body;

  if (!confirm || confirm !== 'FACTORY_RESET') {
    return res.status(400).json({ error: 'Bad Request', message: 'Must confirm with "FACTORY_RESET"' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password required' });
  }

  // Verify admin password
  const session = db.prepare(`
    SELECT u.password_hash FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(req.headers.authorization?.substring(7));

  if (!session || !bcrypt.compareSync(password, session.password_hash)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
  }

  // In production, this would perform factory reset
  res.json({ message: 'Factory reset initiated - system will restart' });
});

module.exports = router;
