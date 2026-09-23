const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { cameraStreamService } = require('../services/CameraStreamService');
const { ptzService, PtzError } = require('../services/PtzService');
const { cameraCredentials } = require('../services/CameraCredentials');

const router = express.Router();

// Helper: generate a unique go2rtc stream name from camera name
const toGo2rtcName = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
};

// GET /api/cameras - List all cameras
router.get('/', (req, res) => {
  const { status, search } = req.query;

  let query = 'SELECT * FROM cameras';
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (search) {
    conditions.push('(name LIKE ? OR description LIKE ? OR ip_address LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY name ASC';

  const cameras = db.prepare(query).all(...params);

  // Add stream URLs and strip passwords from response
  cameras.forEach(cam => {
    cam.streams = cameraStreamService.getStreamUrls(cam.go2rtc_name);
    cam.has_password = !!cam.password;
    delete cam.password;
  });

  res.json(cameras);
});

// GET /api/cameras/snapshots/latest - Get latest snapshot for each camera
// NOTE: Must be before /:id to avoid being caught by the wildcard
router.get('/snapshots/latest', (req, res) => {
  const { snapshotService } = require('../services/SnapshotService');
  res.json(snapshotService.getLatestAll());
});

// GET /api/cameras/snapshots/file/:filename - Serve a stored snapshot image
router.get('/snapshots/file/:filename', (req, res) => {
  const { SNAPSHOT_DIR } = require('../services/SnapshotService');
  const filepath = path.join(SNAPSHOT_DIR, req.params.filename);
  if (!filepath.startsWith(SNAPSHOT_DIR)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(filepath);
});

// GET /api/cameras/:id - Get camera detail + stream URLs
router.get('/:id', (req, res) => {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }

  // Get zones for this camera
  const zones = db.prepare(
    'SELECT z.* FROM zones z JOIN camera_zones cz ON z.id = cz.zone_id WHERE cz.camera_id = ?'
  ).all(req.params.id);

  camera.streams = cameraStreamService.getStreamUrls(camera.go2rtc_name);
  camera.has_password = !!camera.password;
  delete camera.password;

  res.json({ ...camera, zones });
});

// POST /api/cameras - Add a new camera
router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const {
    name, description, stream_url, snapshot_url,
    username, password, manufacturer, model,
    ip_address, rtsp_port, http_port, enabled
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }
  if (!stream_url && !ip_address) {
    return res.status(400).json({ error: 'Bad Request', message: 'Either stream_url or ip_address is required' });
  }

  // Generate unique go2rtc name
  let go2rtcName = toGo2rtcName(name);
  const existing = db.prepare('SELECT id FROM cameras WHERE go2rtc_name = ?').get(go2rtcName);
  if (existing) {
    go2rtcName = `${go2rtcName}_${Date.now()}`;
  }

  // Default stream URL for Hikvision if only IP provided
  const effectiveStreamUrl = stream_url || `/Streaming/Channels/101`;

  try {
    const result = db.prepare(`
      INSERT INTO cameras (name, description, stream_url, snapshot_url, username, password,
        manufacturer, model, ip_address, rtsp_port, http_port, go2rtc_name, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      description || null,
      effectiveStreamUrl,
      snapshot_url || null,
      username || null,
      password || null,
      manufacturer || null,
      model || null,
      ip_address || null,
      rtsp_port || 554,
      http_port || 80,
      go2rtcName,
      enabled !== undefined ? (enabled ? 1 : 0) : 1
    );

    const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(result.lastInsertRowid);

    // Register stream with go2rtc
    if (camera.enabled && cameraStreamService.ready) {
      try {
        await cameraStreamService.addStream(camera);
      } catch (err) {
        console.error(`[Cameras] Failed to register stream with go2rtc:`, err.message);
        db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
          .run(err.message, camera.id);
      }
    }

    const created = db.prepare('SELECT * FROM cameras WHERE id = ?').get(camera.id);
    created.streams = cameraStreamService.getStreamUrls(created.go2rtc_name);
    delete created.password;

    global.broadcast('camera_created', created);
    res.status(201).json(created);
  } catch (err) {
    console.error('[Cameras] Create error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

// PUT /api/cameras/:id - Update camera
router.put('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const {
    name, description, stream_url, snapshot_url,
    username, password, manufacturer, model,
    ip_address, rtsp_port, http_port, enabled
  } = req.body;

  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }

  db.prepare(`
    UPDATE cameras SET
      name = ?, description = ?, stream_url = ?, snapshot_url = ?,
      username = ?, password = ?, manufacturer = ?, model = ?,
      ip_address = ?, rtsp_port = ?, http_port = ?, enabled = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? camera.name,
    description ?? camera.description,
    stream_url ?? camera.stream_url,
    snapshot_url ?? camera.snapshot_url,
    username ?? camera.username,
    // Write-only field: blank/undefined means "keep the stored password"
    (typeof password === 'string' && password.length > 0) ? password : camera.password,
    manufacturer ?? camera.manufacturer,
    model ?? camera.model,
    ip_address ?? camera.ip_address,
    rtsp_port ?? camera.rtsp_port,
    http_port ?? camera.http_port,
    enabled !== undefined ? (enabled ? 1 : 0) : camera.enabled,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  cameraCredentials.invalidate(updated.id);
  ptzService.clearAuthState(updated.id);

  // Re-sync with go2rtc if stream config changed
  if (cameraStreamService.ready) {
    try {
      if (updated.enabled) {
        await cameraStreamService.addStream(updated);
        await cameraStreamService.probeCamera(updated);
      } else {
        await cameraStreamService.removeStream(updated.go2rtc_name);
        db.prepare("UPDATE cameras SET status = 'offline', updated_at = datetime('now') WHERE id = ?")
          .run(updated.id);
      }
    } catch (err) {
      console.error(`[Cameras] Failed to re-sync stream:`, err.message);
    }
  }

  const result = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  result.streams = cameraStreamService.getStreamUrls(result.go2rtc_name);
  result.has_password = !!result.password;
  delete result.password;

  global.broadcast('camera_updated', result);
  res.json(result);
});

// DELETE /api/cameras/:id - Remove camera
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }

  // Remove stream from go2rtc
  if (cameraStreamService.ready) {
    try {
      await cameraStreamService.removeStream(camera.go2rtc_name);
    } catch (err) {
      console.error(`[Cameras] Failed to remove stream from go2rtc:`, err.message);
    }
  }

  db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);

  global.broadcast('camera_deleted', { id: parseInt(req.params.id) });
  res.json({ message: 'Camera deleted successfully' });
});

// POST /api/cameras/:id/test - Test camera connection via go2rtc snapshot
router.post('/:id/test', requireRole('admin', 'operator'), async (req, res) => {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }

  if (!cameraStreamService.ready) {
    return res.status(503).json({ error: 'Service Unavailable', message: 'go2rtc is not reachable' });
  }

  try {
    // Ensure stream is registered
    await cameraStreamService.addStream(camera);

    // Try to grab a snapshot — proves the RTSP source is reachable
    const { buffer } = await cameraStreamService.getSnapshot(camera.go2rtc_name, { force: true });

    db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(camera.id);

    const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(camera.id);
    global.broadcast('camera_updated', { ...updated, password: undefined });

    res.json({ success: true, message: `Camera "${camera.name}" is reachable`, snapshotSize: buffer.length });
  } catch (err) {
    db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
      .run(err.message, camera.id);

    res.json({ success: false, message: err.message });
  }
});

// GET /api/cameras/:id/snapshot - Proxy JPEG snapshot from go2rtc
router.get('/:id/snapshot', async (req, res) => {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }

  if (!cameraStreamService.ready) {
    return res.status(503).json({ error: 'Service Unavailable', message: 'go2rtc is not reachable' });
  }

  try {
    const { buffer, contentType } = await cameraStreamService.getSnapshot(camera.go2rtc_name);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache, no-store');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Bad Gateway', message: `Snapshot failed: ${err.message}` });
  }
});

// GET /api/cameras/:id/snapshots - Get stored snapshot history for a camera
router.get('/:id/snapshots', (req, res) => {
  const { limit = 42 } = req.query;
  const { snapshotService } = require('../services/SnapshotService');
  const snapshots = snapshotService.getSnapshots(parseInt(req.params.id), parseInt(limit));
  res.json(snapshots);
});

// POST /api/cameras/:id/capture - Force capture a snapshot now
router.post('/:id/capture', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const { snapshotService } = require('../services/SnapshotService');
    await snapshotService.captureNow(parseInt(req.params.id));
    res.json({ success: true, message: 'Snapshot captured' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PTZ (Hikvision ISAPI) — viewers may read status/presets; admin+operator may move
// ---------------------------------------------------------------------------

const loadCamera = (req, res, next) => {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!camera) {
    return res.status(404).json({ error: 'Not Found', message: 'Camera not found' });
  }
  req.camera = camera;
  next();
};

const ptzErrorStatus = (err) => {
  if (!(err instanceof PtzError)) return 500;
  if (err.status === 'unreachable') return 503;
  if (err.status === 'rate_limited') return 429;
  if (err.httpStatus === 400) return 400;
  return 502; // auth / camera-side error
};

const sendPtzError = (res, err, cameraName) => {
  if (!(err instanceof PtzError)) {
    console.error(`[PTZ] ${cameraName}:`, err);
    return res.status(500).json({ status: 'error', message: err.message || 'PTZ request failed' });
  }
  if (err.status !== 'rate_limited') console.warn(`[PTZ] ${cameraName}: ${err.status} — ${err.message}`);
  res.status(ptzErrorStatus(err)).json(err.toJSON());
};

// GET /api/cameras/:id/ptz/status - reachability probe (2 s) + capabilities
router.get('/:id/ptz/status', loadCamera, async (req, res) => {
  try {
    const info = await ptzService.getStatus(req.camera);
    res.json(info);
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// GET /api/cameras/:id/ptz/presets
router.get('/:id/ptz/presets', loadCamera, async (req, res) => {
  try {
    res.json(await ptzService.getPresets(req.camera));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// POST /api/cameras/:id/ptz/move {pan,tilt,zoom} (-100..100, 0 = stop)
router.post('/:id/ptz/move', requireRole('admin', 'operator'), loadCamera, async (req, res) => {
  const { pan, tilt, zoom } = req.body || {};
  for (const [k, v] of Object.entries({ pan, tilt, zoom })) {
    if (v !== undefined && v !== null && !Number.isFinite(Number(v))) {
      return res.status(400).json({ status: 'error', message: `${k} must be a number between -100 and 100` });
    }
  }
  try {
    res.json(await ptzService.move(req.camera, { pan, tilt, zoom }));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// POST /api/cameras/:id/ptz/stop
router.post('/:id/ptz/stop', requireRole('admin', 'operator'), loadCamera, async (req, res) => {
  try {
    res.json(await ptzService.stop(req.camera));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// POST /api/cameras/:id/ptz/presets/:pid/goto
router.post('/:id/ptz/presets/:pid/goto', requireRole('admin', 'operator'), loadCamera, async (req, res) => {
  try {
    res.json(await ptzService.gotoPreset(req.camera, req.params.pid));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// PUT /api/cameras/:id/ptz/presets/:pid {name} - save current position as preset
router.put('/:id/ptz/presets/:pid', requireRole('admin', 'operator'), loadCamera, async (req, res) => {
  try {
    const name = req.body && req.body.name;
    if (name !== undefined && typeof name !== 'string') {
      return res.status(400).json({ status: 'error', message: 'name must be a string' });
    }
    res.json(await ptzService.savePreset(req.camera, req.params.pid, name));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

// DELETE /api/cameras/:id/ptz/presets/:pid
router.delete('/:id/ptz/presets/:pid', requireRole('admin', 'operator'), loadCamera, async (req, res) => {
  try {
    res.json(await ptzService.deletePreset(req.camera, req.params.pid));
  } catch (err) {
    sendPtzError(res, err, req.camera.name);
  }
});

module.exports = router;
