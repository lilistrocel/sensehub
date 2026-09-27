const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { SUPPORTED_LANGS, normalizeLang } = require('../i18n');

/** Validate a `language` body field: undefined → undefined (not sent), else 'en'|'tr'|'ar' or an error. */
function parseLanguage(value) {
  if (value === undefined) return { value: undefined };
  const lang = typeof value === 'string' && SUPPORTED_LANGS.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
  if (!lang) return { error: `language must be one of: ${SUPPORTED_LANGS.join(', ')}` };
  return { value: lang };
}

/** Set a user's language (creating the preferences row when missing). */
function setUserLanguage(userId, lang) {
  const info = db.prepare("UPDATE user_preferences SET language = ?, updated_at = datetime('now') WHERE user_id = ?").run(lang, userId);
  if (info.changes === 0) {
    db.prepare('INSERT INTO user_preferences (user_id, sound_alerts_enabled, sound_volume, language) VALUES (?, 0, 0.5, ?)').run(userId, lang);
  }
}

function formatPreferences(prefs) {
  return {
    sound_alerts_enabled: prefs.sound_alerts_enabled === 1,
    sound_volume: prefs.sound_volume,
    alert_sound_critical: prefs.alert_sound_critical,
    alert_sound_warning: prefs.alert_sound_warning,
    alert_sound_info: prefs.alert_sound_info,
    language: normalizeLang(prefs.language) || 'en'
  };
}

const router = express.Router();

// GET /api/users - List all users (admin only)
router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.is_cloud_synced, u.last_login, u.created_at, COALESCE(p.language, 'en') AS language
     FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id ORDER BY u.created_at DESC`
  ).all();

  res.json(users);
});

// POST /api/users - Create user (admin only)
router.post('/', requireRole('admin'), (req, res) => {
  const { email, password, name, role } = req.body;
  const language = parseLanguage(req.body.language);
  if (language.error) {
    return res.status(400).json({ error: 'Bad Request', message: language.error });
  }

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email, password, and name are required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid email format' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters' });
  }

  const validRoles = ['admin', 'operator', 'viewer'];
  const userRole = validRoles.includes(role) ? role : 'viewer';

  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
    ).run(email, passwordHash, name, userRole);
    const lang = language.value || 'en';
    setUserLanguage(Number(result.lastInsertRowid), lang);

    res.status(201).json({
      id: result.lastInsertRowid,
      email,
      name,
      role: userRole,
      language: lang,
      message: 'User created successfully'
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Conflict', message: 'Email already exists' });
    }
    throw error;
  }
});

// GET /api/users/:id - Get user details (admin only)
router.get('/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.is_cloud_synced, u.last_login, u.created_at, u.updated_at, COALESCE(p.language, 'en') AS language
     FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ?`
  ).get(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'Not Found', message: 'User not found' });
  }

  res.json(user);
});

// PUT /api/users/:id - Update user (admin only)
router.put('/:id', requireRole('admin'), (req, res) => {
  const { email, name, role, password } = req.body;
  const userId = req.params.id;
  const language = parseLanguage(req.body.language);
  if (language.error) {
    return res.status(400).json({ error: 'Bad Request', message: language.error });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (!user) {
    return res.status(404).json({ error: 'Not Found', message: 'User not found' });
  }

  const updates = [];
  const params = [];

  if (email) {
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid email format' });
    }
    updates.push('email = ?');
    params.push(email);
  }

  if (name) {
    updates.push('name = ?');
    params.push(name);
  }

  if (role && ['admin', 'operator', 'viewer'].includes(role)) {
    updates.push('role = ?');
    params.push(role);
  }

  if (password) {
    if (password.length < 8) {
      return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters' });
    }
    updates.push('password_hash = ?');
    params.push(bcrypt.hashSync(password, 10));
  }

  if (updates.length === 0 && language.value === undefined) {
    return res.status(400).json({ error: 'Bad Request', message: 'No valid fields to update' });
  }

  try {
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(userId);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    if (language.value !== undefined) setUserLanguage(Number(userId), language.value);
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Conflict', message: 'Email already exists' });
    }
    throw error;
  }
});

// DELETE /api/users/:id - Delete user (admin only, requires password confirmation)
router.delete('/:id', requireRole('admin'), (req, res) => {
  const userId = req.params.id;
  const { password } = req.body;

  // Prevent self-deletion
  if (parseInt(userId) === req.user.id) {
    return res.status(400).json({ error: 'Bad Request', message: 'Cannot delete your own account' });
  }

  // Require password confirmation
  if (!password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password required' });
  }

  // Verify the requesting admin's password
  const admin = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
  }

  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'User not found' });
  }

  res.json({ message: 'User deleted successfully' });
});

// GET /api/users/preferences - Get current user's preferences
router.get('/me/preferences', (req, res) => {
  const userId = req.user.id;

  let prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);

  // If no preferences exist, create default ones
  if (!prefs) {
    db.prepare(`
      INSERT INTO user_preferences (user_id, sound_alerts_enabled, sound_volume)
      VALUES (?, 0, 0.5)
    `).run(userId);

    prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);
  }

  res.json(formatPreferences(prefs));
});

// PUT /api/users/preferences - Update current user's preferences
router.put('/me/preferences', (req, res) => {
  const userId = req.user.id;
  const { sound_alerts_enabled, sound_volume, alert_sound_critical, alert_sound_warning, alert_sound_info } = req.body;
  const language = parseLanguage(req.body.language);
  if (language.error) {
    return res.status(400).json({ error: 'Bad Request', message: language.error });
  }

  // Check if preferences exist
  const existing = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);

  if (!existing) {
    // Create new preferences
    db.prepare(`
      INSERT INTO user_preferences (user_id, sound_alerts_enabled, sound_volume, alert_sound_critical, alert_sound_warning, alert_sound_info, language)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      sound_alerts_enabled ? 1 : 0,
      sound_volume !== undefined ? sound_volume : 0.5,
      alert_sound_critical || 'alarm',
      alert_sound_warning || 'beep',
      alert_sound_info || 'chime',
      language.value || 'en'
    );
  } else {
    // Update existing preferences
    const updates = [];
    const params = [];

    if (sound_alerts_enabled !== undefined) {
      updates.push('sound_alerts_enabled = ?');
      params.push(sound_alerts_enabled ? 1 : 0);
    }

    if (sound_volume !== undefined) {
      updates.push('sound_volume = ?');
      params.push(Math.max(0, Math.min(1, sound_volume)));
    }

    if (alert_sound_critical !== undefined) {
      updates.push('alert_sound_critical = ?');
      params.push(alert_sound_critical);
    }

    if (alert_sound_warning !== undefined) {
      updates.push('alert_sound_warning = ?');
      params.push(alert_sound_warning);
    }

    if (alert_sound_info !== undefined) {
      updates.push('alert_sound_info = ?');
      params.push(alert_sound_info);
    }

    if (language.value !== undefined) {
      updates.push('language = ?');
      params.push(language.value);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(userId);
      db.prepare(`UPDATE user_preferences SET ${updates.join(', ')} WHERE user_id = ?`).run(...params);
    }
  }

  // Fetch and return updated preferences
  const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId);

  res.json({
    message: 'Preferences updated successfully',
    preferences: formatPreferences(prefs)
  });
});

module.exports = router;
module.exports.parseLanguage = parseLanguage;
