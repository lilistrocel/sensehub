/**
 * AgronomistCaptureService — the canopy frames the agronomist looks at, plus
 * everything around them:
 *
 *   captureForDate(date, opts)   a SESSION of N frames (default 3, ~30 s apart) from the
 *                                camera (optionally after a PTZ preset move), each
 *                                downscaled to <= 1568 px on the long edge (go2rtc scales
 *                                server-side — no image libs in this image), scored for
 *                                sharpness (variance of the Laplacian, pure JS) and stored
 *                                at data/snapshots/agronomist/<camera_id>/<date>-<n>.jpg
 *                                with one agronomist_captures row per frame
 *   getCapturesForReport(date)   what to attach to the daily report (up to 3 frames):
 *                                  a) today's noon session, sharpest first
 *                                  b) no noon session: today's manual session taken in daylight
 *                                  c) else the routine 4-hourly camera_snapshots taken today
 *                                     10:00-14:00 local, registered as source='fallback_4h'
 *                                  d) else the latest daytime (06-18 local) frame within 36 h
 *                                  e) else today's manual session taken after dark
 *                                Every item carries captured_at, source, sharpness, sequence.
 *   describeSelection(sel)       the exact photo line for the prompt ("3 canopy frames from
 *                                today's 12:00 session (sharpest first: ...)", "No noon
 *                                session today; 2 frames from the 4-hourly snapshots at ...")
 *   listCaptures / listCapturesGrouped   for GET /api/agronomist/captures
 *   prune(days)                  retention: delete files + rows older than N days (all frames)
 *   buildImageBlock(buf)         Anthropic image content block (base64 JPEG)
 *
 * All external deps (db, frame fetcher, ptz, clock, sleep, tz) are injectable so the
 * unit tests run without go2rtc, a camera or the production DB.
 */

const fs = require('fs');
const path = require('path');

const MAX_EDGE_PX = 1568;
const REPORT_MAX_AGE_HOURS = 36;
const PRESET_SETTLE_MS = 5000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_FRAMES = 3;
const MAX_FRAMES = 5;
const DEFAULT_SPACING_MS = 30_000;
const MAX_IMAGES_PER_REPORT = 3;      // hard cost guard: never send more than this
const NOON_WINDOW = [10, 14];         // local hours for the 4-hourly fallback
const DAYTIME_WINDOW = [6, 18];       // local hours that count as "daytime"
const RELATIVE_DIR = path.join('snapshots', 'agronomist');
const SNAPSHOT_DIR_REL = 'snapshots';  // the 4-hourly cycle's files (SnapshotService)

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

// ---- local-time helpers (all times in the DB are ISO UTC) -------------------------

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get('hour'), 10) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour, minute: parseInt(get('minute'), 10), second: parseInt(get('second'), 10),
    hm: `${String(hour).padStart(2, '0')}:${get('minute')}`,
    hms: `${String(hour).padStart(2, '0')}:${get('minute')}:${get('second')}`,
  };
}

function parseIso(s) {
  const t = s ? new Date(s) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

function inWindow(hour, [from, to]) { return hour >= from && hour < to; }

function bySharpest(a, b) {
  const sa = a.sharpness ?? -1, sb = b.sharpness ?? -1;
  if (sb !== sa) return sb - sa;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

function fmtSharp(v) { return v == null ? 'n/a' : Math.round(v).toString(); }

function joinTimes(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/**
 * The photo line: what exactly is attached, in local time. `sel` is the result of
 * getCapturesForReport (mode + items). Never calls a fallback "the noon capture".
 */
function describeSelection(sel, { date, tz } = {}) {
  if (!sel || !sel.items?.length) return null;
  const zone = tz || sel.tz || 'UTC';
  const day = date || sel.date;
  const items = sel.items;
  const n = items.length;
  const frameWord = n === 1 ? 'frame' : 'frames';
  const times = items.map(it => localParts(parseIso(it.capture.captured_at) || new Date(0), zone));
  switch (sel.mode) {
    case 'noon': {
      const earliest = [...times].sort((a, b) => a.hms.localeCompare(b.hms))[0];
      return `${n} canopy ${frameWord} from today's ${earliest.hm} session (sharpest first: ${times.map(t => t.hms).join(', ')})`;
    }
    case 'manual': {
      const earliest = [...times].sort((a, b) => a.hms.localeCompare(b.hms))[0];
      return `No noon session today; ${n} canopy ${frameWord} from today's ${earliest.hm} manual capture (sharpest first: ${times.map(t => t.hms).join(', ')})`;
    }
    case 'fallback_4h':
      return `No noon session today; ${n} ${frameWord} from the 4-hourly snapshots at ${joinTimes(times.map(t => t.hm))}`;
    case 'latest': {
      const t = times[0];
      const age = Math.round(items[0].ageHours);
      let when;
      if (t.date === day) when = 'today';
      else {
        const prev = new Date(Date.parse(`${day}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
        when = t.date === prev ? 'yesterday' : `on ${t.date}`;
      }
      return `No daytime capture today; latest frame is from ${t.hm} ${when} (${age} h old)`;
    }
    case 'manual_night': {
      const earliest = [...times].sort((a, b) => a.hms.localeCompare(b.hms))[0];
      return `No daytime capture within ${REPORT_MAX_AGE_HOURS} h; ${n} ${frameWord} from today's ${earliest.hm} manual capture taken outside daylight hours (sharpest first: ${times.map(t => t.hms).join(', ')})`;
    }
    default:
      return `${n} canopy ${frameWord} attached (${times.map(t => t.hms).join(', ')})`;
  }
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
    this._tz = deps.tz || null;                 // string or () => string
    this._sharpness = deps.sharpness || null;   // (buffer) => number | null (test hook)
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

  tz() {
    if (typeof this._tz === 'function') return this._tz();
    if (this._tz) return this._tz;
    try { return require('../utils/systemTimezone').getSystemTimezone(this.db); } catch { return process.env.TZ || 'UTC'; }
  }

  /** Path of a capture file relative to rootDir (this is what the DB stores). */
  relativePath(cameraId, fileBase) {
    return path.join(RELATIVE_DIR, String(cameraId), `${fileBase}.jpg`);
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

  /** Blur metric for a JPEG buffer; null when it cannot be decoded (never throws). */
  scoreSharpness(buffer) {
    try {
      if (this._sharpness) return this._sharpness(buffer);
      return require('./ImageSharpness').sharpnessScore(buffer).sharpness;
    } catch (err) {
      this.log.warn(`[AgronomistCapture] sharpness scoring failed: ${err.message}`);
      return null;
    }
  }

  /** 1) native frame, 2) if the long edge exceeds the limit ask go2rtc for a scaled one. */
  async _grabFrame(camera) {
    let buffer = await this.fetchFrame(camera.go2rtc_name, {});
    let dims = jpegDimensions(buffer);
    let scaled = false;
    let note = null;
    if (dims && Math.max(dims.width, dims.height) > this.maxEdgePx) {
      const landscape = dims.width >= dims.height;
      try {
        const small = await this.fetchFrame(camera.go2rtc_name, landscape ? { width: this.maxEdgePx } : { height: this.maxEdgePx });
        const sd = jpegDimensions(small);
        if (small?.length && sd && Math.max(sd.width, sd.height) <= this.maxEdgePx) {
          buffer = small; dims = sd; scaled = true;
        } else {
          note = 'scaled fetch returned unexpected size, using original';
        }
      } catch (err) {
        note = `scaled fetch failed (${err.message}), using original`;
      }
    }
    return { buffer, dims, scaled, note };
  }

  _insertRow({ camera, dateStr, relPath, dims, bytes, presetId, sequence, sharpness, source, capturedAt }) {
    const createdAt = this.now().toISOString();
    const r = this.db.prepare(`
      INSERT INTO agronomist_captures
        (camera_id, capture_date, path, width, height, bytes, preset_id, created_at, sequence, sharpness, source, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(camera.id, dateStr, relPath, dims?.width ?? null, dims?.height ?? null, bytes, presetId, createdAt, sequence, sharpness, source, capturedAt);
    return this.getById(r.lastInsertRowid);
  }

  /**
   * Capture a SESSION of frames for `dateStr` (YYYY-MM-DD, local).
   * @param opts.cameraId   null = first enabled camera
   * @param opts.presetId   null = do not move the PTZ
   * @param opts.frames     frames per session (1..5, default 3)
   * @param opts.spacingMs  gap between frames (default 30 s)
   * @param opts.source     'noon' | 'manual' (default 'manual')
   * @returns the best (sharpest) row spread at top level (+ `scaled`, `note`, `camera_name`)
   *          plus `frames` (all rows, sequence order) and `session` { date, source, frames }
   */
  async captureForDate(dateStr, opts = {}) {
    const camera = this._pickCamera(opts.cameraId || null);
    const presetId = opts.presetId || null;
    const source = opts.source === 'noon' ? 'noon' : 'manual';
    const frames = Math.min(MAX_FRAMES, Math.max(1, parseInt(opts.frames, 10) || DEFAULT_FRAMES));
    const spacingMs = Math.min(120_000, Math.max(0, Number.isFinite(+opts.spacingMs) ? +opts.spacingMs : DEFAULT_SPACING_MS));
    const notes = [];

    if (presetId && this.ptz) {
      try {
        await this.ptz.gotoPreset(camera, presetId);
        await this.sleep(opts.settleMs ?? PRESET_SETTLE_MS);
      } catch (err) {
        notes.push(`preset ${presetId} move failed: ${err.message}`);
        this.log.warn(`[AgronomistCapture] ${notes[notes.length - 1]}`);
      }
    }

    // File base: the noon session owns <date>-<n>.jpg; manual sessions get a time tag so
    // a second capture-now the same day does not clobber the frames of the first.
    const sessionStart = this.now();
    const tag = source === 'noon' ? dateStr : `${dateStr}-manual-${localParts(sessionStart, this.tz()).hms.replace(/:/g, '')}`;
    if (source === 'noon') {
      // One noon session per day: a re-run replaces the earlier frames.
      const old = this.db.prepare("SELECT id, path FROM agronomist_captures WHERE camera_id = ? AND capture_date = ? AND source = 'noon'").all(camera.id, dateStr);
      for (const r of old) {
        try { fs.unlinkSync(this.absolutePath(r.path)); } catch {}
        this.db.prepare('DELETE FROM agronomist_captures WHERE id = ?').run(r.id);
      }
    }

    const rows = [];
    let anyScaled = false;
    let lastErr = null;
    for (let n = 1; n <= frames; n++) {
      if (n > 1 && spacingMs > 0) await this.sleep(spacingMs);
      let grab;
      try {
        grab = await this._grabFrame(camera);
      } catch (err) {
        lastErr = err;
        notes.push(`frame ${n} failed: ${err.message}`);
        this.log.warn(`[AgronomistCapture] frame ${n}/${frames} failed: ${err.message}`);
        continue;
      }
      if (grab.note) notes.push(`frame ${n}: ${grab.note}`);
      anyScaled = anyScaled || grab.scaled;
      const capturedAt = this.now().toISOString();
      const sharpness = this.scoreSharpness(grab.buffer);
      const relPath = this.relativePath(camera.id, `${tag}-${n}`);
      const absPath = this.absolutePath(relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, grab.buffer);
      const row = this._insertRow({ camera, dateStr, relPath, dims: grab.dims, bytes: grab.buffer.length, presetId, sequence: n, sharpness, source, capturedAt });
      rows.push(row);
      this.log.log(`[AgronomistCapture] ${camera.name} ${dateStr} ${source} #${n}/${frames}: ${grab.dims ? `${grab.dims.width}x${grab.dims.height}` : '?x?'} ${(grab.buffer.length / 1024).toFixed(0)} KB sharpness=${fmtSharp(sharpness)}${grab.scaled ? ' (scaled)' : ''}`);
    }
    if (!rows.length) throw new Error(`no frame captured (${lastErr?.message || 'unknown error'})`);

    const best = [...rows].sort(bySharpest)[0];
    const note = notes.length ? notes.join('; ') : null;
    if (note) this.log.warn(`[AgronomistCapture] ${camera.name} ${dateStr}: ${note}`);
    return {
      ...best, camera_name: camera.name, scaled: anyScaled, note,
      frames: rows,
      session: { date: dateStr, source, frames: rows.length, requested: frames, spacing_ms: spacingMs, best_id: best.id },
    };
  }

  _rowsQuery(where, params) {
    return this.db.prepare(`
      SELECT c.*, cam.name AS camera_name FROM agronomist_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id
      WHERE ${where}
      ORDER BY c.captured_at DESC, c.sequence
    `).all(...params);
  }

  _withLocal(rows, tz) {
    return rows.map(r => {
      const t = parseIso(r.captured_at) || parseIso(r.created_at);
      return { row: r, at: t, local: t ? localParts(t, tz) : null };
    });
  }

  /**
   * Register the routine 4-hourly camera_snapshots taken on `dateStr` within the local
   * noon window as source='fallback_4h' rows (downscaled copy + sharpness). Idempotent:
   * a snapshot already registered (same path) is reused. Newest first, up to `limit`.
   */
  _registerFallbackSnapshots(dateStr, { tz, cameraId = null, limit = MAX_IMAGES_PER_REPORT, now = this.now() } = {}) {
    let snaps;
    try {
      const lo = new Date(Date.parse(`${dateStr}T00:00:00Z`) - 86400_000).toISOString();
      const hi = new Date(Date.parse(`${dateStr}T00:00:00Z`) + 2 * 86400_000).toISOString();
      snaps = this.db.prepare(`
        SELECT s.*, cam.name AS camera_name, cam.enabled FROM camera_snapshots s
        LEFT JOIN cameras cam ON cam.id = s.camera_id
        WHERE s.captured_at >= ? AND s.captured_at < ? ${cameraId ? 'AND s.camera_id = ?' : ''}
        ORDER BY s.captured_at DESC
      `).all(...(cameraId ? [lo, hi, cameraId] : [lo, hi]));
    } catch (err) {
      this.log.warn(`[AgronomistCapture] camera_snapshots lookup failed: ${err.message}`);
      return [];
    }
    const candidates = snaps.filter(s => {
      const t = parseIso(s.captured_at);
      if (!t) return false;
      const l = localParts(t, tz);
      return l.date === dateStr && inWindow(l.hour, NOON_WINDOW);
    });
    if (cameraId == null && candidates.length) {
      // keep a single camera per report (the one with the newest frame)
      const cam = candidates[0].camera_id;
      for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].camera_id !== cam) candidates.splice(i, 1);
    }
    const out = [];
    let seq = 0;
    for (const s of candidates) {
      if (out.length >= limit) break;
      const relPath = this.relativePath(s.camera_id, `${dateStr}-f${s.id}`);
      const existing = this.db.prepare('SELECT id FROM agronomist_captures WHERE path = ?').get(relPath);
      if (existing) { const r = this.getById(existing.id); if (r && fs.existsSync(this.absolutePath(r.path))) { out.push(r); seq++; continue; } }
      const srcAbs = path.join(this.rootDir, SNAPSHOT_DIR_REL, s.filename);
      let buffer;
      try { buffer = fs.readFileSync(srcAbs); } catch { this.log.warn(`[AgronomistCapture] fallback snapshot missing: ${s.filename}`); continue; }
      let dims = jpegDimensions(buffer);
      try {
        if (dims && Math.max(dims.width, dims.height) > this.maxEdgePx) {
          const d = require('./ImageSharpness').downscaleJpeg(buffer, this.maxEdgePx);
          buffer = d.buffer; dims = { width: d.width, height: d.height };
        }
      } catch (err) {
        this.log.warn(`[AgronomistCapture] fallback downscale failed (${err.message}), using original`);
      }
      const sharpness = this.scoreSharpness(buffer);
      const absPath = this.absolutePath(relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buffer);
      const camera = { id: s.camera_id, name: s.camera_name };
      const row = this._insertRow({ camera, dateStr, relPath, dims, bytes: buffer.length, presetId: null, sequence: ++seq, sharpness, source: 'fallback_4h', capturedAt: s.captured_at });
      this.log.log(`[AgronomistCapture] registered 4-hourly snapshot #${s.id} (${localParts(parseIso(s.captured_at), tz).hm} local) as fallback frame for ${dateStr}, sharpness=${fmtSharp(sharpness)}`);
      out.push(row);
      void now;
    }
    return out;
  }

  /**
   * Frames to attach to the report for `dateStr`. See the header for the cascade.
   * @param opts.limit          max frames (1..3, default 3 — the hard cost guard)
   * @param opts.ignoreSession  skip today's noon/manual sessions (dry-run of the fallback path)
   * @returns { mode, date, tz, items: [{ capture, buffer, ageHours }], total_bytes } | null
   */
  getCapturesForReport(dateStr, { now = this.now(), maxAgeHours = REPORT_MAX_AGE_HOURS, cameraId = null, limit = MAX_IMAGES_PER_REPORT, ignoreSession = false, tz = this.tz() } = {}) {
    const cap = Math.min(MAX_IMAGES_PER_REPORT, Math.max(1, parseInt(limit, 10) || MAX_IMAGES_PER_REPORT));
    const camWhere = cameraId ? ' AND c.camera_id = ?' : '';
    const camParams = cameraId ? [cameraId] : [];
    let mode = null;
    let rows = [];

    if (!ignoreSession) {
      // a) today's noon session
      rows = this._rowsQuery(`c.capture_date = ? AND c.source = 'noon'${camWhere}`, [dateStr, ...camParams]);
      if (rows.length) mode = 'noon';
      // b) today's manual session in daylight (latest session = frames sharing the same file tag)
      if (!rows.length) {
        const manual = this._withLocal(this._rowsQuery(`c.capture_date = ? AND c.source = 'manual'${camWhere}`, [dateStr, ...camParams]), tz)
          .filter(x => x.local && inWindow(x.local.hour, DAYTIME_WINDOW));
        if (manual.length) {
          const tag = manual[0].row.path.replace(/-\d+\.jpg$/, '');
          rows = manual.filter(x => x.row.path.startsWith(tag)).map(x => x.row);
          mode = 'manual';
        }
      }
    }
    // c) routine 4-hourly snapshots taken today 10:00-14:00 local
    if (!rows.length) {
      rows = this._registerFallbackSnapshots(dateStr, { tz, cameraId, limit: cap, now });
      if (rows.length) mode = 'fallback_4h';
    }
    // d) latest daytime frame within maxAgeHours (any source)
    if (!rows.length) {
      const cutoff = new Date(now.getTime() - maxAgeHours * 3600_000).toISOString();
      const recent = this._withLocal(this._rowsQuery(`c.captured_at >= ? AND c.captured_at <= ?${camWhere}`, [cutoff, now.toISOString(), ...camParams]), tz)
        .filter(x => x.local && inWindow(x.local.hour, DAYTIME_WINDOW));
      if (recent.length) { rows = [recent[0].row]; mode = 'latest'; }
    }
    // e) today's manual session taken after dark — the operator asked for it explicitly
    if (!rows.length && !ignoreSession) {
      const manual = this._rowsQuery(`c.capture_date = ? AND c.source = 'manual'${camWhere}`, [dateStr, ...camParams]);
      if (manual.length) {
        const tag = manual[0].path.replace(/-\d+\.jpg$/, '');
        rows = manual.filter(r => r.path.startsWith(tag));
        mode = 'manual_night';
      }
    }
    if (!rows.length) return null;

    // Ordering: sessions sharpest-first; fallback snapshots newest-first (already); cap.
    if (mode === 'noon' || mode === 'manual' || mode === 'manual_night') rows = [...rows].sort(bySharpest);
    rows = rows.slice(0, cap);

    const items = [];
    for (const row of rows) {
      let buffer;
      try { buffer = fs.readFileSync(this.absolutePath(row.path)); } catch { continue; }
      const at = parseIso(row.captured_at) || parseIso(row.created_at) || now;
      const ageHours = Math.max(0, (now.getTime() - at.getTime()) / 3600_000);
      items.push({ capture: row, ageHours: Math.round(ageHours * 10) / 10, buffer });
    }
    if (!items.length) return null;
    return { mode, date: dateStr, tz, items, total_bytes: items.reduce((a, it) => a + it.buffer.length, 0) };
  }

  /** Back-compat single-image view of getCapturesForReport: { capture, ageHours, buffer } | null. */
  getCaptureForReport(dateStr, opts = {}) {
    const sel = this.getCapturesForReport(dateStr, opts);
    return sel ? { ...sel.items[0], mode: sel.mode } : null;
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
      ORDER BY c.capture_date DESC, c.camera_id, c.captured_at, c.sequence
    `).all(...(cameraId ? [cutoff, cameraId] : [cutoff]));
  }

  /** Captures grouped by day (newest day first), frames in capture order. */
  listCapturesGrouped(opts = {}) {
    const rows = this.listCaptures(opts);
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.capture_date}|${r.camera_id}`;
      if (!groups.has(key)) groups.set(key, { date: r.capture_date, camera_id: r.camera_id, camera_name: r.camera_name, frames: [] });
      groups.get(key).frames.push(r);
    }
    return [...groups.values()].map(g => ({ ...g, best_id: [...g.frames].sort(bySharpest)[0]?.id ?? null }));
  }

  /** Delete captures (files + rows, every frame) whose capture_date is older than retentionDays. */
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
  describeSelection,
  localParts,
  MAX_EDGE_PX,
  REPORT_MAX_AGE_HOURS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_FRAMES,
  MAX_FRAMES,
  DEFAULT_SPACING_MS,
  MAX_IMAGES_PER_REPORT,
};
