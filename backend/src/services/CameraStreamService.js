const { db } = require('../utils/database');

const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
const HEALTH_CHECK_INTERVAL = 60000; // 60s

class CameraStreamService {
  constructor() {
    this.healthInterval = null;
    this.ready = false;
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
    const src = this._buildStreamUrl(camera);
    const res = await fetch(`${GO2RTC_URL}/api/streams`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: camera.go2rtc_name, src })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`go2rtc PUT /api/streams failed (${res.status}): ${text}`);
    }

    db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(camera.id);
  }

  async removeStream(name) {
    // Setting empty src removes the stream
    const res = await fetch(`${GO2RTC_URL}/api/streams`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, src: '' })
    });

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

  async getSnapshot(go2rtcName) {
    const url = `${GO2RTC_URL}/api/frame.jpeg?src=${encodeURIComponent(go2rtcName)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Snapshot failed (${res.status})`);
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
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
        const streamInfo = streams[camera.go2rtc_name];
        if (streamInfo) {
          // Stream exists in go2rtc - check if producers are connected
          const hasProducers = streamInfo.producers && streamInfo.producers.length > 0;
          if (hasProducers) {
            db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
              .run(camera.id);
          } else if (camera.status !== 'error') {
            // No producers but stream is registered — it will connect on demand, mark online
            db.prepare("UPDATE cameras SET status = 'online', error_message = NULL, updated_at = datetime('now') WHERE id = ?")
              .run(camera.id);
          }
        } else {
          // Stream not registered — re-register it
          try {
            await this.addStream(camera);
          } catch (err) {
            db.prepare("UPDATE cameras SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?")
              .run(err.message, camera.id);
          }
        }
      }
    } catch (err) {
      console.warn('[CameraStream] Health check error:', err.message);
      this.ready = false;
    }
  }

  _buildStreamUrl(camera) {
    // If stream_url is already a full RTSP URL, use it as-is
    if (camera.stream_url.startsWith('rtsp://')) {
      return camera.stream_url;
    }
    // Build RTSP URL from components
    const userPass = camera.username ? `${camera.username}:${camera.password || ''}@` : '';
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
