const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// Initialize database
const db = require('./utils/database');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const equipmentRoutes = require('./routes/equipment');
const zoneRoutes = require('./routes/zones');
const automationRoutes = require('./routes/automations');
const alertRoutes = require('./routes/alerts');
const dashboardRoutes = require('./routes/dashboard');
const cloudRoutes = require('./routes/cloud');
const settingsRoutes = require('./routes/settings');
const systemRoutes = require('./routes/system');
const modbusRoutes = require('./routes/modbus');

// Import middleware
const { authMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint (no auth required)
app.get('/api/health', (req, res) => {
  const dbStatus = db.isConnected() ? 'connected' : 'disconnected';
  res.json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/equipment', authMiddleware, equipmentRoutes);
app.use('/api/zones', authMiddleware, zoneRoutes);
app.use('/api/automations', authMiddleware, automationRoutes);
app.use('/api/alerts', authMiddleware, alertRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/cloud', authMiddleware, cloudRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/system', authMiddleware, systemRoutes);
app.use('/api/modbus', authMiddleware, modbusRoutes);

// Error handling middleware
app.use(errorHandler);

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Handle ping/pong for connection keepalive
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }

      console.log('Received:', data);
    } catch (error) {
      console.log('Received non-JSON message:', message.toString());
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection confirmation
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

// Broadcast function for real-time updates
global.broadcast = (type, data) => {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(JSON.stringify({ type, data, timestamp: new Date().toISOString() }));
    }
  });
};

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SenseHub backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`Database: ${db.isConnected() ? 'Connected' : 'Not connected'}`);
});
// trigger reload Sat Feb  7 08:13:02 PM UTC 2026
