const jwt = require('jsonwebtoken');
const { db } = require('../utils/database');

const JWT_SECRET = process.env.JWT_SECRET || 'sensehub-dev-secret-change-in-production';

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if session exists and is not expired
    const session = db.prepare(
      'SELECT s.*, u.id as user_id, u.email, u.name, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime("now")'
    ).get(token);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Session expired or invalid' });
    }

    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Not authenticated' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    next();
  };
};

module.exports = { authMiddleware, requireRole, JWT_SECRET };
