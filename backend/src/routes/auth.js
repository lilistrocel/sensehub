const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../utils/database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 8 * 60 * 60 * 1000; // 8 hours

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash);

  if (!validPassword) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
  }

  // Create session
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
  const expiresAt = new Date(Date.now() + SESSION_TIMEOUT).toISOString();

  db.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(user.id, token, expiresAt);

  // Update last login
  db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    },
    expiresAt
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/session
router.get('/session', (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
  }

  const token = authHeader.substring(7);

  try {
    jwt.verify(token, JWT_SECRET);

    const session = db.prepare(
      'SELECT s.*, u.id as user_id, u.email, u.name, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime("now")'
    ).get(token);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Session expired' });
    }

    res.json({
      user: {
        id: session.user_id,
        email: session.email,
        name: session.name,
        role: session.role
      },
      expiresAt: session.expires_at
    });
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', (req, res) => {
  const authHeader = req.headers.authorization;
  const { currentPassword, newPassword } = req.body;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Bad Request', message: 'Current and new password required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters' });
  }

  const token = authHeader.substring(7);
  const session = db.prepare(
    'SELECT s.*, u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?'
  ).get(token);

  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const validPassword = bcrypt.compareSync(currentPassword, session.password_hash);

  if (!validPassword) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Current password is incorrect' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?')
    .run(newHash, session.user_id);

  res.json({ message: 'Password changed successfully' });
});

module.exports = router;
