const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../utils/database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 8 * 60 * 60 * 1000; // 8 hours

// GET /api/auth/setup-status - Check if setup is needed (no users exist)
router.get('/setup-status', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const needsSetup = userCount.count === 0;

  res.json({
    needsSetup,
    userCount: userCount.count
  });
});

// GET /api/auth/setup/network - Get current network configuration
router.get('/setup/network', (req, res) => {
  // Return current network settings or defaults
  const networkSetting = db.prepare(
    "SELECT value FROM system_settings WHERE key = 'network'"
  ).get();

  if (networkSetting) {
    try {
      const network = JSON.parse(networkSetting.value);
      return res.json(network);
    } catch {
      // Fall through to defaults
    }
  }

  // Return defaults
  res.json({
    ipAddress: '',
    gateway: '',
    dns: '',
    dhcp: true
  });
});

// POST /api/auth/setup/network - Save network configuration during setup
router.post('/setup/network', (req, res) => {
  const { ipAddress, gateway, dns, dhcp } = req.body;

  // Validate IP address format if provided (and not using DHCP)
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  if (!dhcp) {
    if (ipAddress && !ipRegex.test(ipAddress)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid IP address format' });
    }
    if (gateway && !ipRegex.test(gateway)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid gateway format' });
    }
    if (dns && !ipRegex.test(dns)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid DNS format' });
    }
  }

  const networkConfig = {
    ipAddress: ipAddress || '',
    gateway: gateway || '',
    dns: dns || '',
    dhcp: dhcp !== false
  };

  try {
    db.prepare(
      'INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now"))'
    ).run('network', JSON.stringify(networkConfig));

    res.json({
      message: 'Network configuration saved',
      network: networkConfig
    });
  } catch (error) {
    console.error('Network config error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to save network configuration' });
  }
});

// POST /api/auth/setup - Initial admin account setup
router.post('/setup', (req, res) => {
  const { email, password, name } = req.body;

  // Check if setup is already complete
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count > 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Setup already completed. Users already exist.' });
  }

  // Validate input
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email, password, and name are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid email format' });
  }

  // Create admin user
  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
    ).run(email, passwordHash, name, 'admin');

    const userId = result.lastInsertRowid;

    // Create session for immediate login
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '8h' });
    const expiresAt = new Date(Date.now() + SESSION_TIMEOUT).toISOString();

    db.prepare(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(userId, token, expiresAt);

    // Mark initial setup as complete in system settings
    db.prepare(
      'INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime("now"))'
    ).run('setup_completed', JSON.stringify(true));

    res.status(201).json({
      message: 'Setup completed successfully',
      token,
      user: {
        id: userId,
        email,
        name,
        role: 'admin'
      },
      expiresAt
    });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bad Request', message: 'Email already exists' });
    }
    console.error('Setup error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create admin account' });
  }
});

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
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

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
      "SELECT s.*, u.id as user_id, u.email, u.name, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
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
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newHash, session.user_id);

  res.json({ message: 'Password changed successfully' });
});

module.exports = router;
