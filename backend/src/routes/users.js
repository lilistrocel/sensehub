const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users - List all users (admin only)
router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare(
    'SELECT id, email, name, role, is_cloud_synced, last_login, created_at FROM users ORDER BY created_at DESC'
  ).all();

  res.json(users);
});

// POST /api/users - Create user (admin only)
router.post('/', requireRole('admin'), (req, res) => {
  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email, password, and name are required' });
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

    res.status(201).json({
      id: result.lastInsertRowid,
      email,
      name,
      role: userRole,
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
    'SELECT id, email, name, role, is_cloud_synced, last_login, created_at, updated_at FROM users WHERE id = ?'
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

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (!user) {
    return res.status(404).json({ error: 'Not Found', message: 'User not found' });
  }

  const updates = [];
  const params = [];

  if (email) {
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

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'No valid fields to update' });
  }

  updates.push("updated_at = datetime('now')");
  params.push(userId);

  try {
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Conflict', message: 'Email already exists' });
    }
    throw error;
  }
});

// DELETE /api/users/:id - Delete user (admin only)
router.delete('/:id', requireRole('admin'), (req, res) => {
  const userId = req.params.id;

  // Prevent self-deletion
  if (parseInt(userId) === req.user.id) {
    return res.status(400).json({ error: 'Bad Request', message: 'Cannot delete your own account' });
  }

  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'User not found' });
  }

  res.json({ message: 'User deleted successfully' });
});

module.exports = router;
