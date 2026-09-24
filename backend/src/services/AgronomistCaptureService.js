/**
 * AgronomistCaptureService — the fixed daily (noon, local time) canopy photo
 * the agronomist looks at, plus everything around it:
 *
 *   captureForDate(date)      grab a frame (optionally after a PTZ preset move),
 *                             downscale to <= 1568 px on the long edge (go2rtc does
 *                             the scaling server-side — no image libs in this image),
 *                             store at data/snapshots/agronomist/<camera_id>/<date>.jpg
 *                             and upsert an agronomist_captures row
 *   getCaptureForReport(date) today's capture, else the newest within 36 h (with age)
 *   listCaptures({days})      for GET /api/agronomist/captures
 *   prune(days)               retention: delete files + rows older than N days
 *   buildImageBlock(buf)      Anthropic image content block (base64 JPEG)
 *
 * All external deps (db, frame fetcher, ptz, clock, sleep) are injectable so the
 * unit tests run without go2rtc, a camera or the production DB.
 */

const fs = require('fs');
const path = require('path');

const MAX_EDGE_PX = 1568;
const REPORT_MAX_AGE_HOURS = 36;
const PRESET_SETTLE_MS = 5000;
const DEFAULT_RETENTION_DAYS = 30;
const RELATIVE_DIR = path.join('snapshots', 'agronomist');

/** Width/height from a JPEG buffer (SOFn marker scan). Returns null if not found. */
function jpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xFF) { i++; continue; }
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Anthropic image content block. */
function buildImageBlock(buffer, mediaType = 'image/jpeg') {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: Buffer.from(buffer).toString('base64') },
  };
}

function defaultFetchFrame() {
  const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
  return async (go2rtcName, { width, height } = {}) => {
    const qs = new URLSearchParams({ src: go2rtcName });
    if (width) qs.set('w', String(width));
    if (height) qs.set('h', String(height));
    const res = await fetch(`${GO2RTC_URL}/api/frame.jpeg?${qs.toString()}`);
    if (!res.ok) throw new Error(`go2rtc frame failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('go2rtc returned an empty frame (camera offline or wrong RTSP password)');
    return buf;
  };
}

class AgronomistCaptureService {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.rootDir = deps.rootDir || path.join(__dirname, '../../data');
    this.fetchFrame = deps.fetchFrame || defaultFetchFrame();
    this._ptz = deps.ptz === undefined ? null : deps.ptz;
    this._ptzResolved = deps.ptz !== undefined;
    this.now = deps.now || (() => new Date());
    this.sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.log = deps.log || console;
    this.maxEdgePx = deps.maxEdgePx || MAX_EDGE_PX;
  }

  get db() {
    if (!this._db) this._db = require('../utils/database').db;
    return this._db;
  }

  get ptz() {
    if (!this._ptzResolved) {
      try { this._ptz = require('./PtzService').ptzService; } catch { this._ptz = null; }
      this._ptzResolved = true;
    }
    return this._ptz;
  }

  /** Path of the capture file relative to rootDir (this is what the DB stores). */
  relativePath(cameraId, dateStr) {
    return path.join(RELATIVE_DIR, String(cameraId), `${dateStr}.jpg`);
  }

  absolutePath(relPath) {
    return path.join(this.rootDir, relPath);
  }

  _pickCamera(cameraId) {
    if (cameraId) {
      const cam = this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
      if (!cam) throw new Error(`Camera ${cameraId} not found`);
      return cam;
    }
    const cam = this.db.prepare('SELECT * FROM cameras WHERE enabled = 1 ORDER BY id LIMIT 1').get();
    if (!cam) throw new Error('No enabled camera to capture from');
    return cam;
  }

  /**
   * Capture the canopy photo for `dateStr` (YYYY-MM-DD, local).
   * @param opts.cameraId  null = first enabled camera
   * @param opts.presetId  null = do not move the PTZ
   * @returns the agronomist_captures row (+ `scaled` boolean, `note`)
   */
  async captureForDate(dateStr, opts = {}) {
    const camera = this._pickCamera(opts.cameraId || null);
    const presetId = opts.presetId || null;
    let note = null;

    if (presetId && this.ptz) {
      try {
        await this.ptz.gotoPreset(camera, presetId);
        await this.sleep(opts.settleMs ?? PRESET_SETTLE_MS);
      } catch (err) {
        note = `preset ${presetId} move failed: ${err.message}`;
        this.log.warn(`[AgronomistCapture] ${note}`);
      }
    }

    // 1) native frame, 2) if the long edge exceeds the limit ask go2rtc for a scaled one.
    let buffer = await this.fetchFrame(camera.go2rtc_name, {});
    let dims = jpegDimensions(buffer);
    let scaled = false;
    if (dims && Math.max(dims.width, dims.height) > this.maxEdgePx) {
      const landscape = dims.width >= dims.height;
      try {
        const small = await this.fetchFrame(camera.go2rtc_name, landscape ? { width: this.maxEdgePx } : { height: this.maxEdgePx });
        const sd = jpegDimensions(small);
        if (small?.length && sd && Math.max(sd.width, sd.height) <= this.maxEdgePx) {
          buffer = small; dims = sd; scaled = true;
        } else {
          note = (note ? note + '; ' : '') + 'scaled fetch returned unexpected size, using original';
        }
      } catch (err) {
        note = (note ? note + '; ' : '') + `scaled fetch failed (${err.message}), using original`;
      }
    }

    const relPath = this.relativePath(camera.id, dateStr);
    const absPath = this.absolutePath(relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buffer);

    const createdAt = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO agronomist_captures (camera_id, capture_date, path, width, height, bytes, preset_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(camera_id, capture_date) DO UPDATE SET
        path = excluded.path, width = excluded.width, height = excluded.height,
        bytes = excluded.bytes, preset_id = excluded.preset_id, created_at = excluded.created_at
    `).run(camera.id, dateStr, relPath, dims?.width ?? null, dims?.height ?? null, buffer.length, presetId, createdAt);

    const row = this.db.prepare('SELECT * FROM agronomist_captures WHERE camera_id = ? AND capture_date = ?').get(camera.id, dateStr);
    this.log.log(`[AgronomistCapture] ${camera.name} ${dateStr}: ${dims ? `${dims.width}x${dims.height}` : '?x?'} ${(buffer.length / 1024).toFixed(0)} KB${scaled ? ' (scaled)' : ''}${note ? ` — ${note}` : ''}`);
    return { ...row, camera_name: camera.name, scaled, note };
  }

  /**
   * Capture to feed the report for `dateStr`: the one taken that day, otherwise the
   * newest within `maxAgeHours` of `now`. Returns { capture, ageHours, buffer } or null.
   */
  getCaptureForReport(dateStr, { now = this.now(), maxAgeHours = REPORT_MAX_AGE_HOURS, cameraId = null } = {}) {
    const nowMs = now.getTime();
    let row = this.db.prepare(`
      SELECT c.*, cam.name AS camera_name FROM agronomist_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id
      WHERE c.capture_date = ? ${cameraId ? 'AND c.camera_id = ?' : ''}
      ORDER BY c.created_at DESC LIMIT 1
    `).get(...(cameraId ? [dateStr, cameraId] : [dateStr]));
    if (!row) {
      const cutoff = new Date(nowMs - maxAgeHours * 3600_000).toISOString();
      row = this.db.prepare(`
        SELECT c.*, cam.name AS camera_name FROM agronomist_captures c
        LEFT JOIN cameras cam ON cam.id = c.camera_id
        WHERE c.created_at >= ? ${cameraId ? 'AND c.camera_id = ?' : ''}
        ORDER BY c.created_at DESC LIMIT 1
      `).get(...(cameraId ? [cutoff, cameraId] : [cutoff]));
    }
    if (!row) return null;
    let buffer;
    try { buffer = fs.readFileSync(this.absolutePath(row.path)); } catch { return null; }
    const ageHours = Math.max(0, (nowMs - new Date(row.created_at).getTime()) / 3600_000);
    return { capture: row, ageHours: Math.round(ageHours * 10) / 10, buffer };
  }

  getById(id) {
    return this.db.prepare(`
      SELECT c.*, cam.name AS camera_name FROM agronomist_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id WHERE c.id = ?
    `).get(id) || null;
  }

  listCaptures({ days = 7, cameraId = null } = {}) {
    const cutoff = new Date(this.now().getTime() - days * 86400_000).toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT c.*, cam.name AS camera_name FROM agronomist_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id
      WHERE c.capture_date >= ? ${cameraId ? 'AND c.camera_id = ?' : ''}
      ORDER BY c.capture_date DESC, c.camera_id
    `).all(...(cameraId ? [cutoff, cameraId] : [cutoff]));
  }

  /** Delete captures (files + rows) whose capture_date is older than retentionDays. */
  prune(retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false) {
    const days = Number.isFinite(+retentionDays) && +retentionDays > 0 ? +retentionDays : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(this.now().getTime() - days * 86400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare('SELECT id, path FROM agronomist_captures WHERE capture_date < ?').all(cutoff);
    if (dryRun) return { eligible_rows: rows.length, rows_dropped: 0, files_removed: 0, dry_run: true, cutoff };
    let filesRemoved = 0;
    const del = this.db.prepare('DELETE FROM agronomist_captures WHERE id = ?');
    for (const r of rows) {
      try { fs.unlinkSync(this.absolutePath(r.path)); filesRemoved++; } catch {}
      del.run(r.id);
    }
    return { rows_dropped: rows.length, files_removed: filesRemoved, cutoff };
  }
}

const agronomistCaptureService = new AgronomistCaptureService();

module.exports = {
  AgronomistCaptureService,
  agronomistCaptureService,
  jpegDimensions,
  buildImageBlock,
  MAX_EDGE_PX,
  REPORT_MAX_AGE_HOURS,
  DEFAULT_RETENTION_DAYS,
};
