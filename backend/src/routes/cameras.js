const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { cameraStreamService } = require('../services/CameraStreamService');

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
    delete cam.password;
  });

  res.json(cameras);
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
    password ?? camera.password,
    manufacturer ?? camera.manufacturer,
    model ?? camera.model,
    ip_address ?? camera.ip_address,
    rtsp_port ?? camera.rtsp_port,
    http_port ?? camera.http_port,
    enabled !== undefined ? (enabled ? 1 : 0) : camera.enabled,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);

  // Re-sync with go2rtc if stream config changed
  if (cameraStreamService.ready) {
    try {
      if (updated.enabled) {
        await cameraStreamService.addStream(updated);
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
    const { buffer } = await cameraStreamService.getSnapshot(camera.go2rtc_name);

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

module.exports = router;
