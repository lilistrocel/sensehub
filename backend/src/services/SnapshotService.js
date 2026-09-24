const fs = require('fs');
const path = require('path');
const { db } = require('../utils/database');
const { cameraStreamService } = require('./CameraStreamService');

const { DailyLocalTrigger } = require('./DailyLocalTrigger');
const { getSystemTimezone } = require('../utils/systemTimezone');

const SNAPSHOT_DIR = path.join(__dirname, '../../data/snapshots');
const CAPTURE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SNAPSHOTS_PER_CAMERA = 42; // ~7 days at 4h intervals
const NOON_TICK_MS = 60 * 1000;
const NOON_HOUR = 12;
const NOON_MINUTE = 0;
const NOON_GRACE_MINUTES = 60; // a restart at 12:20 still captures; 13:00+ waits for tomorrow

class SnapshotService {
  constructor() {
    this.intervalId = null;
    this.noonIntervalId = null;
    this.noonTrigger = null;
  }

  start() {
    if (this.intervalId) return;

    // Ensure snapshot directory exists
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }

    console.log(`[Snapshot] Service started (capturing every 4 hours)`);

    // Capture immediately on start, then every 4 hours
    setTimeout(() => this._captureAll(), 60000); // wait 1 min for cameras to init
    this.intervalId = setInterval(() => this._captureAll(), CAPTURE_INTERVAL_MS);

    this._startNoonCapture();
  }

  /**
   * Fixed daily canopy capture at 12:00 in the system timezone (system_settings.timezone,
   * falling back to TZ env). Independent of the 4-hourly cycle; the agronomist's daily
   * report attaches this photo.
   */
  _startNoonCapture() {
    const tz = () => getSystemTimezone(db);
    this.noonTrigger = new DailyLocalTrigger({
      hour: NOON_HOUR, minute: NOON_MINUTE, tz, graceMinutes: NOON_GRACE_MINUTES,
      onFire: ({ dateStr, tz: zone }) => this._runNoonCapture(dateStr, zone),
    });
    // If today's capture already exists (restart after noon), don't take it again.
    try {
      const { localDateStr } = require('../utils/systemTimezone');
      const today = localDateStr(new Date(), tz());
      const row = db.prepare("SELECT id FROM agronomist_captures WHERE capture_date = ? AND source = 'noon' LIMIT 1").get(today);
      if (row) this.noonTrigger.markFired(today);
    } catch {}
    console.log(`[Snapshot] Noon canopy capture registered: daily ${String(NOON_HOUR).padStart(2, '0')}:${String(NOON_MINUTE).padStart(2, '0')} ${tz()} (grace ${NOON_GRACE_MINUTES} min)`);
    this.noonIntervalId = setInterval(() => { try { this.noonTrigger.tick(); } catch (err) { console.error('[Snapshot] Noon tick error:', err.message); } }, NOON_TICK_MS);
  }

  async _runNoonCapture(dateStr, zone) {
    const { agronomistCaptureService } = require('./AgronomistCaptureService');
    let cfg = {};
    try { cfg = require('./AgronomistService').agronomistService.getConfig(); } catch {}
    if (cfg.capture_enabled === false) {
      console.log(`[Snapshot] Noon capture for ${dateStr} skipped (capture_enabled=false)`);
      return;
    }
    if (!cameraStreamService.ready) {
      console.warn(`[Snapshot] Noon capture for ${dateStr} skipped: go2rtc not ready`);
      return;
    }
    const frames = cfg.capture_frames || 3;
    console.log(`[Snapshot] Firing noon canopy session for ${dateStr} (${zone}): ${frames} frame(s), ${cfg.capture_spacing_seconds ?? 30} s apart`);
    try {
      const row = await agronomistCaptureService.captureForDate(dateStr, {
        cameraId: cfg.capture_camera_id || null,
        presetId: cfg.capture_preset_id || null,
        source: 'noon',
        frames,
        spacingMs: (cfg.capture_spacing_seconds ?? 30) * 1000,
      });
      const summary = (row.frames || []).map(f => `#${f.sequence} sharp=${f.sharpness == null ? 'n/a' : Math.round(f.sharpness)}`).join(', ');
      console.log(`[Snapshot] Noon session stored: ${row.frames?.length || 1} frame(s) [${summary}]; best ${row.path} (${row.width}x${row.height}, ${(row.bytes / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`[Snapshot] Noon capture for ${dateStr} failed:`, err.message);
    }
  }

  stop() {
    if (this.noonIntervalId) {
      clearInterval(this.noonIntervalId);
      this.noonIntervalId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Snapshot] Service stopped');
    }
  }

  async _captureAll() {
    const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();

    for (const camera of cameras) {
      try {
        await this._captureOne(camera);
      } catch (err) {
        console.error(`[Snapshot] Failed to capture ${camera.name}:`, err.message);
      }
    }

    // Cleanup old snapshots
    this._cleanup();
  }

  async _captureOne(camera, { force = false } = {}) {
    if (!cameraStreamService.ready) {
      console.warn('[Snapshot] go2rtc not ready, skipping capture');
      return;
    }

    const { buffer } = await cameraStreamService.getSnapshot(camera.go2rtc_name, { force });
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty snapshot');
    }

    const timestamp = new Date();
    const filename = `cam_${camera.id}_${timestamp.toISOString().replace(/[:.]/g, '-')}.jpg`;
    const filepath = path.join(SNAPSHOT_DIR, filename);

    fs.writeFileSync(filepath, buffer);

    db.prepare(
      'INSERT INTO camera_snapshots (camera_id, filename, file_size, captured_at) VALUES (?, ?, ?, ?)'
    ).run(camera.id, filename, buffer.length, timestamp.toISOString());

    console.log(`[Snapshot] Captured ${camera.name}: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }

  _cleanup() {
    try {
      const cameras = db.prepare('SELECT id FROM cameras').all();
      for (const cam of cameras) {
        const excess = db.prepare(
          'SELECT id, filename FROM camera_snapshots WHERE camera_id = ? ORDER BY captured_at DESC LIMIT -1 OFFSET ?'
        ).all(cam.id, MAX_SNAPSHOTS_PER_CAMERA);

        for (const snap of excess) {
          const filepath = path.join(SNAPSHOT_DIR, snap.filename);
          try { fs.unlinkSync(filepath); } catch {}
          db.prepare('DELETE FROM camera_snapshots WHERE id = ?').run(snap.id);
        }

        if (excess.length > 0) {
          console.log(`[Snapshot] Cleaned up ${excess.length} old snapshots for camera ${cam.id}`);
        }
      }
    } catch (err) {
      console.error('[Snapshot] Cleanup error:', err.message);
    }
  }

  /** Get snapshots for a camera */
  getSnapshots(cameraId, limit = 42) {
    return db.prepare(
      'SELECT * FROM camera_snapshots WHERE camera_id = ? ORDER BY captured_at DESC LIMIT ?'
    ).all(cameraId, limit);
  }

  /** Get latest snapshot for each camera */
  getLatestAll() {
    return db.prepare(`
      SELECT cs.* FROM camera_snapshots cs
      INNER JOIN (
        SELECT camera_id, MAX(captured_at) as max_time
        FROM camera_snapshots GROUP BY camera_id
      ) latest ON cs.camera_id = latest.camera_id AND cs.captured_at = latest.max_time
    `).all();
  }

  /** Force capture now */
  async captureNow(cameraId) {
    const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
    if (!camera) throw new Error('Camera not found');
    await this._captureOne(camera, { force: true });
  }
}

const snapshotService = new SnapshotService();

module.exports = { snapshotService, SNAPSHOT_DIR };
