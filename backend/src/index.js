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
const templateRoutes = require('./routes/templates');
const automationTemplateRoutes = require('./routes/automationTemplates');
const notificationRoutes = require('./routes/notifications');
const cameraRoutes = require('./routes/cameras');
const labReadingRoutes = require('./routes/labReadings');
const fertigationRoutes = require('./routes/fertigation');
const calibrationRoutes = require('./routes/calibration');
const reportRoutes = require('./routes/reports');
const analyticsRoutes = require('./routes/analytics');
const retentionRoutes = require('./routes/retention');
const cropRoutes = require('./routes/crops');
const amicRoutes = require('./routes/amic');
const agronomistRoutes = require('./routes/agronomist');
const plannerRoutes = require('./routes/planner');
const operatorTasksRoutes = require('./routes/operatorTasks');
const baselineRoutes = require('./routes/baselines');

// Import middleware
const { authMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

// Import services
const { modbusPollingService } = require('./services/ModbusPollingService');
const { relayTimerService } = require('./services/RelayTimerService');
const { automationSchedulerService } = require('./services/AutomationSchedulerService');
const { cameraStreamService } = require('./services/CameraStreamService');
const { watchdogService } = require('./services/WatchdogService');
const { networkUsageService } = require('./services/NetworkUsageService');
const { snapshotService } = require('./services/SnapshotService');
const { agronomistSchedulerService } = require('./services/AgronomistSchedulerService');
const { fertilizerAdvisorSchedulerService } = require('./services/FertilizerAdvisorSchedulerService');
const { relaySafetyWatchdogService } = require('./services/RelaySafetyWatchdogService');
const { amicSchedulerService } = require('./services/AmicSchedulerService');
const { operationalPlannerSchedulerService } = require('./services/OperationalPlannerSchedulerService');
const { dataRetentionService } = require('./services/DataRetentionService');
const { getMqttIngestService } = require('./services/MqttIngestService');
const { getFlowWatchService } = require('./services/IrrigationFlowWatchService');
const { getDoseController } = require('./services/DoseController');
const { getIrrigationRunsService } = require('./services/IrrigationRunsService');

const app = express();
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
// CORS: allow only a configurable origin list. CORS_ORIGINS is comma-separated
// (e.g. "http://localhost:5173,https://hub.example.com"); "*" allows any origin.
// Requests without an Origin header (curl, server-to-server, same-origin via
// the nginx proxy) are not cross-origin and always pass through.
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://localhost:3002'];
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_CORS_ORIGINS;
const allowAnyOrigin = allowedOrigins.includes('*');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowAnyOrigin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Not allowed: respond without CORS headers so the browser blocks it.
    return callback(null, false);
  },
  credentials: true,
}));
console.log(`CORS origins: ${allowAnyOrigin ? '* (any)' : allowedOrigins.join(', ')}`);
app.use(express.json());
// Request language (en/tr/ar) → req.lang; authMiddleware refines it with the user's saved language.
app.use('/api', require('./middleware/language').languageMiddleware);

// Request logging middleware - logs to database for network analysis
const requestLogDb = require('./utils/database').db;
(() => {
  try {
    requestLogDb.exec(`
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER,
        response_bytes INTEGER,
        duration_ms INTEGER,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path, created_at);
    `);
  } catch (e) { /* table already exists */ }
})();

const insertRequestLog = requestLogDb.prepare(
  'INSERT INTO request_log (method, path, status, response_bytes, duration_ms, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

app.use((req, res, next) => {
  // Skip health checks and static assets
  if (req.path === '/api/health') return next();

  const start = Date.now();
  const originalEnd = res.end;
  let responseSize = 0;

  // Intercept write to measure response size
  const originalWrite = res.write;
  res.write = function(chunk, ...args) {
    if (chunk) responseSize += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return originalWrite.apply(this, [chunk, ...args]);
  };

  res.end = function(chunk, ...args) {
    if (chunk) responseSize += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    const duration = Date.now() - start;

    try {
      insertRequestLog.run(
        req.method,
        req.path,
        res.statusCode,
        responseSize,
        duration,
        req.ip || req.connection?.remoteAddress || '',
        (req.headers['user-agent'] || '').substring(0, 200),
        new Date().toISOString()
      );
    } catch (e) { /* don't break requests on log failure */ }

    return originalEnd.apply(this, [chunk, ...args]);
  };

  next();
});

// Action audit trail: records every non-GET /api request (user, role, IP,
// device, target, before/after diff) after the response finishes. Mounted
// before the routers so new routes are covered automatically; never blocks.
app.use(require('./middleware/auditLog').auditMiddleware);

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

// Public routes (no auth required)
// Agronomist canopy capture JPEG — same treatment as camera snapshot files so an <img>
// tag (no Authorization header) can display it.
app.get('/api/agronomist/captures/:id/image', (req, res) => {
  const fs = require('fs');
  const { agronomistCaptureService } = require('./services/AgronomistCaptureService');
  const id = parseInt(req.params.id, 10);
  const row = id ? agronomistCaptureService.getById(id) : null;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const abs = agronomistCaptureService.absolutePath(row.path);
  if (!abs.startsWith(agronomistCaptureService.rootDir) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(abs);
});
app.get('/api/cameras/snapshots/file/:filename', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const { SNAPSHOT_DIR } = require('./services/SnapshotService');
  const filepath = path.join(SNAPSHOT_DIR, req.params.filename);
  if (!filepath.startsWith(SNAPSHOT_DIR) || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(filepath);
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
app.use('/api/templates', authMiddleware, templateRoutes);
app.use('/api/automation-templates', authMiddleware, automationTemplateRoutes);
app.use('/api/notifications', authMiddleware, notificationRoutes);
app.use('/api/cameras', authMiddleware, cameraRoutes);
app.use('/api/lab-readings', authMiddleware, labReadingRoutes);
app.use('/api/fertigation', authMiddleware, fertigationRoutes);
app.use('/api/calibration', authMiddleware, calibrationRoutes);
app.use('/api/reports', authMiddleware, reportRoutes);
app.use('/api/analytics', authMiddleware, analyticsRoutes);
app.use('/api/retention', authMiddleware, retentionRoutes);
app.use('/api/crops', authMiddleware, cropRoutes);
app.use('/api/amic', authMiddleware, amicRoutes);
app.use('/api/agronomist', authMiddleware, agronomistRoutes);
app.use('/api/nutrition', authMiddleware, require('./routes/nutrition')); // crop profile + feed calculator + fertilizer advisor (advisory only)
app.use('/api/planner', authMiddleware, plannerRoutes);
app.use('/api/ai/data-sources', authMiddleware, require('./routes/aiDataSources'));
app.use('/api/operator-tasks', authMiddleware, operatorTasksRoutes);
app.use('/api/baselines', authMiddleware, baselineRoutes);
app.use('/api/relay-events', authMiddleware, require('./routes/relayEvents'));
app.use('/api/mqtt', authMiddleware, require('./routes/mqtt'));
app.use('/api/flow-watch', authMiddleware, require('./routes/flowWatch'));
app.use('/api/dose-controller', authMiddleware, require('./routes/doseController'));
app.use('/api/irrigation', authMiddleware, require('./routes/irrigationRuns'));
app.use('/api/irrigation', authMiddleware, require('./routes/irrigationStop')); // POST /stop (admin + operator)
app.use('/api/logs', authMiddleware, require('./routes/logs')); // unified activity log (admin + operator, read-only)

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
server.listen(PORT, async () => {
  console.log(`SenseHub backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`Database: ${db.isConnected() ? 'Connected' : 'Not connected'}`);

  // Start Modbus polling service
  try {
    await modbusPollingService.start();
    console.log('Modbus polling service: Started');
  } catch (error) {
    console.error('Modbus polling service: Failed to start -', error.message);
  }

  // Start automation scheduler
  try {
    automationSchedulerService.start();
    console.log('Automation scheduler: Started');
  } catch (error) {
    console.error('Automation scheduler: Failed to start -', error.message);
  }

  // Start camera stream service (connects to go2rtc)
  try {
    await cameraStreamService.start();
    console.log('Camera stream service: Started');
  } catch (error) {
    console.error('Camera stream service: Failed to start -', error.message);
  }

  // Start watchdog service (monitors automations & equipment health)
  try {
    watchdogService.start();
    console.log('Watchdog service: Started');
  } catch (error) {
    console.error('Watchdog service: Failed to start -', error.message);
  }

  // Start relay safety watchdog (force-OFFs any channel stuck ON beyond its max duration)
  try {
    relaySafetyWatchdogService.start();
    console.log('Relay safety watchdog: Started');
  } catch (error) {
    console.error('Relay safety watchdog: Failed to start -', error.message);
  }

  // Start network usage tracking
  try {
    networkUsageService.start();
    console.log('Network usage service: Started');
  } catch (error) {
    console.error('Network usage service: Failed to start -', error.message);
  }

  // Start snapshot capture service (every 4 hours)
  try {
    snapshotService.start();
    console.log('Snapshot service: Started');
  } catch (error) {
    console.error('Snapshot service: Failed to start -', error.message);
  }

  // Start AMIC calibration scheduler (fires Calibrate at configured times of day)
  try {
    amicSchedulerService.start();
    console.log('AMIC calibration scheduler: Started');
  } catch (error) {
    console.error('AMIC calibration scheduler: Failed to start -', error.message);
  }

  // Start agronomist daily report scheduler
  try {
    agronomistSchedulerService.start();
    console.log('Agronomist scheduler: Started');
  } catch (error) {
    console.error('Agronomist scheduler: Failed to start -', error.message);
  }

  // Crop profile stage sync + fertilizer advisor (weekly / debounced automatic runs).
  // Advisory only: never changes recipes, dose programs, ratios, tanks or automations.
  try {
    fertilizerAdvisorSchedulerService.start();
    console.log('Fertilizer advisor scheduler: Started');
  } catch (error) {
    console.error('Fertilizer advisor scheduler: Failed to start -', error.message);
  }

  // Start operational planner scheduler (fires daily at configured time, default 18:00)
  try {
    operationalPlannerSchedulerService.start();
    console.log('Operational planner scheduler: Started');
  } catch (error) {
    console.error('Operational planner scheduler: Failed to start -', error.message);
  }

  // Start data retention scheduler (fires nightly at configured time, default 03:30)
  try {
    dataRetentionService.start();
    console.log('Data retention scheduler: Started');
  } catch (error) {
    console.error('Data retention scheduler: Failed to start -', error.message);
  }

  // MQTT ingest (irrigation monitors on the local Mosquitto). Read-only telemetry;
  // a missing/down broker only logs — mqtt.js keeps reconnecting with backoff.
  try {
    getMqttIngestService().start();
    console.log('MQTT ingest service: Started');
  } catch (error) {
    console.error('MQTT ingest service: Failed to start -', error.message);
  }

  // Irrigation flow watch: live flow vs relay state (no-flow / low-flow / dosing
  // without water ...). Its only actuation is aborting a running dose cycle
  // through FertigationDoseScheduler.abortCycle (abort_dosing_on_no_water).
  try {
    getFlowWatchService().start();
    console.log('Irrigation flow watch: Started');
  } catch (error) {
    console.error('Irrigation flow watch: Failed to start -', error.message);
  }

  // Closed-loop dose controller: subscribes to the live monitor stream; it only
  // drives valves inside a dose cycle of a control_mode='closed_loop' program.
  // A run left open by a restart gets its dosing valves written OFF here.
  try {
    getDoseController().start();
    console.log('Dose controller: Started');
  } catch (error) {
    console.error('Dose controller: Failed to start -', error.message);
  }

  // Irrigation runs: groups monitor cycles + relay events into automated / manual
  // runs (irrigation_runs, derived data). Read-only for the plant: no relay writes.
  try {
    getIrrigationRunsService().start();
    console.log('Irrigation runs: Started');
  } catch (error) {
    console.error('Irrigation runs: Failed to start -', error.message);
  }
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('\\nGraceful shutdown initiated...');
  agronomistSchedulerService.stop();
  fertilizerAdvisorSchedulerService.stop();
  snapshotService.stop();
  networkUsageService.stop();
  watchdogService.stop();
  cameraStreamService.stop();
  automationSchedulerService.stop();
  relayTimerService.shutdown();
  try { getMqttIngestService().stop(); } catch (_) {}
  try { getFlowWatchService().stop(); } catch (_) {}
  try { getDoseController().stop(); } catch (_) {}
  try { getIrrigationRunsService().stop(); } catch (_) {}
  await modbusPollingService.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\nGraceful shutdown initiated...');
  agronomistSchedulerService.stop();
  fertilizerAdvisorSchedulerService.stop();
  snapshotService.stop();
  networkUsageService.stop();
  watchdogService.stop();
  cameraStreamService.stop();
  automationSchedulerService.stop();
  relayTimerService.shutdown();
  try { getMqttIngestService().stop(); } catch (_) {}
  try { getFlowWatchService().stop(); } catch (_) {}
  try { getDoseController().stop(); } catch (_) {}
  try { getIrrigationRunsService().stop(); } catch (_) {}
  await modbusPollingService.stop();
  process.exit(0);
});
