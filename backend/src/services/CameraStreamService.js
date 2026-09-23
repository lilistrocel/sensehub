const net = require('net');
const { db } = require('../utils/database');
const { createAlert } = require('../utils/alertBroadcast');
const { cameraCredentials } = require('./CameraCredentials');

const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
const HEALTH_CHECK_INTERVAL = 60000; // 60s
const PROBE_TIMEOUT_MS = 2000;
// After a failed snapshot (camera down or, worse, wrong RTSP password) don't ask
// go2rtc again for a while: every attempt is an RTSP login on the camera, and
// Hikvision locks the client IP after 7 failures. The Cameras page refreshes
// thumbnails every 30 s, so without this an open tab re-locks the camera.
const SNAPSHOT_FAIL_BACKOFF_MS = 2 * 60 * 1000;

/** TCP connect probe — resolves true if host:port accepts a connection within the timeout. */
function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(Number(port) || 554, host);
  });
}

class CameraStreamService {
  constructor() {
    this.healthInterval = null;
    this.ready = false;
    this.unreachableSince = new Map(); // camera.id -> ISO timestamp of first failed probe
    this.snapshotFailUntil = new Map(); // go2rtc_name -> ms timestamp
  }

  async start() {
    // Wait for go2rtc to be reachable
    let attempts = 0;
    while (attempts < 30) {
      try {
        const res = await fetch(`${GO2RTC_URL}/api`);
        if (res.ok) {
          this.ready = true;
          console.log('[CameraStream] go2rtc is reachable');
          break;
        }
      } catch (e) {
        // not ready yet
      }
      attempts++;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!this.ready) {
      console.warn('[CameraStream] go2rtc not reachable after 60s, starting without it');
      return;
    }

    // Sync all enabled cameras to go2rtc
    await this.syncAllCameras();
    await this.probeAllCameras();

    // Start periodic health check
    this.healthInterval = setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL);
    console.log('[CameraStream] Service started');
  }

  stop() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    console.log('[CameraStream] Service stopped');
  }

  async syncAllCameras() {
    const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();
    for (const camera of cameras) {
      try {
        await this.addStream(camera);
      } catch (err) {
        console.error(`[CameraStream] Failed to sync camera ${camera.name}:`, err.message);
        db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
          .run(err.message, camera.id);
      }
    }
  }

  async addStream(camera) {
    // go2rtc's REST API takes name/src as QUERY parameters (a JSON body is ignored),
    // and persists the result into go2rtc.yaml itself — the DB is the source of truth.
    const src = await this._buildStreamUrl(camera);
    const qs = `name=${encodeURIComponent(camera.go2rtc_name)}&src=${encodeURIComponent(src)}`;
    const res = await fetch(`${GO2RTC_URL}/api/streams?${qs}`, { method: 'PUT' });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`go2rtc PUT /api/streams failed (${res.status}): ${text}`);
    }

    db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(camera.id);
  }

  async removeStream(name) {
    const res = await fetch(`${GO2RTC_URL}/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`go2rtc remove stream failed (${res.status}): ${text}`);
    }
  }

  getStreamUrls(go2rtcName) {
    return {
      mse: `/camera-stream/api/ws?src=${encodeURIComponent(go2rtcName)}`,
      webrtc: `/camera-stream/api/webrtc?src=${encodeURIComponent(go2rtcName)}`,
      mjpeg: `/camera-stream/api/frame.mp4?src=${encodeURIComponent(go2rtcName)}`,
      snapshot: `/api/cameras/by-name/${encodeURIComponent(go2rtcName)}/snapshot`
    };
  }

  async getSnapshot(go2rtcName, { force = false } = {}) {
    const until = this.snapshotFailUntil.get(go2rtcName) || 0;
    if (!force && Date.now() < until) {
      throw new Error(`Snapshot skipped: last attempt failed, retrying in ${Math.ceil((until - Date.now()) / 1000)} s`);
    }
    const url = `${GO2RTC_URL}/api/frame.jpeg?src=${encodeURIComponent(go2rtcName)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      this.snapshotFailUntil.set(go2rtcName, Date.now() + SNAPSHOT_FAIL_BACKOFF_MS);
      throw err;
    }
    const buffer = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    if (!res.ok || !buffer || buffer.length === 0) {
      // go2rtc answers 200 with an empty body when the source is down or rejects the credentials
      this.snapshotFailUntil.set(go2rtcName, Date.now() + SNAPSHOT_FAIL_BACKOFF_MS);
      throw new Error(res.ok ? 'Snapshot failed: no frame from camera (offline or wrong RTSP password)' : `Snapshot failed (${res.status})`);
    }
    this.snapshotFailUntil.delete(go2rtcName);
    return {
      buffer,
      contentType: res.headers.get('content-type') || 'image/jpeg'
    };
  }

  async healthCheck() {
    try {
      const res = await fetch(`${GO2RTC_URL}/api`);
      if (!res.ok) {
        this.ready = false;
        console.warn('[CameraStream] go2rtc health check failed');
        this._markAllCameras('error', 'go2rtc unreachable');
        return;
      }

      this.ready = true;

      // Check individual stream statuses
      const streamsRes = await fetch(`${GO2RTC_URL}/api/streams`);
      if (!streamsRes.ok) return;

      const streams = await streamsRes.json();
      const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();

      for (const camera of cameras) {
        if (!streams[camera.go2rtc_name]) {
          // Stream not registered — re-register it
          try {
            await this.addStream(camera);
          } catch (err) {
            db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
              .run(err.message, camera.id);
            continue;
          }
        }
        await this.probeCamera(camera);
      }
    } catch (err) {
      console.warn('[CameraStream] Health check error:', err.message);
      this.ready = false;
    }
  }

  async probeAllCameras() {
    const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();
    for (const camera of cameras) {
      try { await this.probeCamera(camera); } catch (err) {
        console.warn(`[CameraStream] Probe failed for ${camera.name}: ${err.message}`);
      }
    }
  }

  /**
   * Probe the camera itself (TCP connect to its RTSP port, 2 s). Drives cameras.status:
   * unreachable -> 'error' with "Camera unreachable since <time>" and a fingerprinted
   * warning alert; reachable again -> 'online', alert cleared with an info alert.
   * A DHCP move once caused a months-long silent outage — this makes it loud.
   */
  async probeCamera(camera) {
    if (!camera.ip_address) return true;
    const reachable = await tcpProbe(camera.ip_address, camera.rtsp_port || 554);
    const wasUnreachable = this.unreachableSince.has(camera.id);

    if (reachable) {
      if (wasUnreachable) {
        const since = this.unreachableSince.get(camera.id);
        this.unreachableSince.delete(camera.id);
        console.log(`[CameraStream] Camera "${camera.name}" (${camera.ip_address}) reachable again (was unreachable since ${since})`);
        createAlert({
          severity: 'info', source: 'camera', fingerprint: `camera_recovered:${camera.id}`,
          message: `Camera "${camera.name}" (${camera.ip_address}) is reachable again (unreachable since ${since})`,
        });
      }
      if (camera.status !== 'online' || camera.error_message) {
        db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(camera.id);
        this._broadcastCamera(camera.id);
      }
      return true;
    }

    // Unreachable. Keep the first-failure time (recover it from error_message after a restart).
    let since = this.unreachableSince.get(camera.id);
    if (!since) {
      const m = /unreachable since (\S+)/.exec(camera.error_message || '');
      since = (m && !Number.isNaN(Date.parse(m[1]))) ? m[1] : new Date().toISOString();
      this.unreachableSince.set(camera.id, since);
      console.warn(`[CameraStream] Camera "${camera.name}" at ${camera.ip_address}:${camera.rtsp_port || 554} is not answering (unreachable since ${since}). ` +
        'If the camera uses DHCP its address may have changed — give it a DHCP reservation or static IP.');
    }
    const message = `Camera unreachable since ${since}`;
    if (camera.status !== 'error' || camera.error_message !== message) {
      db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
        .run(message, camera.id);
      this._broadcastCamera(camera.id);
    }
    createAlert({
      severity: 'warning', source: 'camera', fingerprint: `camera_unreachable:${camera.id}`,
      message: `Camera "${camera.name}" (${camera.ip_address}) unreachable since ${since} — check power/network; if it uses DHCP its IP may have changed (set a DHCP reservation)`,
    });
    return false;
  }

  _broadcastCamera(id) {
    try {
      const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
      if (row && global.broadcast) {
        row.has_password = !!row.password;
        delete row.password;
        row.streams = this.getStreamUrls(row.go2rtc_name);
        global.broadcast('camera_updated', row);
      }
    } catch { /* best effort */ }
  }

  async _buildStreamUrl(camera) {
    // If stream_url is already a full RTSP URL, use it as-is
    if (camera.stream_url.startsWith('rtsp://')) {
      return camera.stream_url;
    }
    // Build RTSP URL from components. The password comes from the DB, or (when the
    // DB column is empty) from the existing go2rtc source — see CameraCredentials.
    let userPass = '';
    if (camera.username) {
      const { password } = await cameraCredentials.resolve(camera);
      userPass = `${encodeURIComponent(camera.username)}:${encodeURIComponent(password || '')}@`;
    }
    const port = camera.rtsp_port || 554;
    const path = camera.stream_url.startsWith('/') ? camera.stream_url : `/${camera.stream_url}`;
    return `rtsp://${userPass}${camera.ip_address}:${port}${path}`;
  }

  _markAllCameras(status, message) {
    db.prepare("UPDATE cameras SET status = ?, error_message = ?, updated_at = datetime('now') WHERE enabled = 1")
      .run(status, message);
  }
}

const cameraStreamService = new CameraStreamService();

module.exports = { cameraStreamService };
