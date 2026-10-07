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
 *   captureViews(date, opts)     the PRESET TOUR (operator request 2026-10-07): one view from
 *                                each named camera preset ("Agronomist 1/2/3"). Remembers the
 *                                camera's position, visits each preset (goto -> poll the ISAPI
 *                                PTZ status until the position is stable -> focus/exposure
 *                                settle -> N frames, sharpest kept; a blurry/dark/disturbed
 *                                view is retried once), then puts the camera back. Missing
 *                                presets / failed gotos are recorded per view, never
 *                                substituted; the first 401 stops the tour (lockout guard).
 *                                One agronomist_capture_sessions row per tour.
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
// Preset tour (captureViews). Settle: poll GET /ISAPI/PTZCtrl/channels/1/status every
// SETTLE_POLL_MS; the move is over when SETTLE_STABLE_READS consecutive reads agree
// (>= 1 s without motion) and either the position changed or SETTLE_MIN_MS passed
// (a goto can take a few hundred ms to start; already being at the preset is fine).
// SETTLE_TIMEOUT_MS bounds a camera that never reports stable. Without a usable
// status endpoint we wait SETTLE_FALLBACK_MS: the DS-2DE4425IW's preset moves run at
// up to ~100 deg/s pan and the worst case here (half a turn plus a zoom change) is
// measured in single seconds, so 8 s leaves a wide margin. Autofocus / auto-exposure
// then get FOCUS_SETTLE_MS before the first frame.
const DEFAULT_VIEW_PRESETS = ['Agronomist 1', 'Agronomist 2', 'Agronomist 3'];
const MAX_VIEWS = 3;                  // == MAX_IMAGES_PER_REPORT: one image per view, cost guard
const SETTLE_POLL_MS = 500;
const SETTLE_STABLE_READS = 3;
const SETTLE_MIN_MS = 2500;
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_FALLBACK_MS = 8000;
const FOCUS_SETTLE_MS = 3000;
const DEFAULT_FRAMES_PER_VIEW = 2;
const VIEW_FRAME_SPACING_MS = 3000;
const BLUR_THRESHOLD = 30;            // sharpness below this = blurry (noon frames score ~90-110)
const DARK_THRESHOLD = 40;            // mean luma (0-255) below this = too dark
const MANUAL_QUIET_MS = 30_000;       // a person moved the camera within this window = "in use"
const MANUAL_WAIT_MAX_MS = 60_000;    // wait this long for them to finish, then proceed (logged)
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

/** Rows of the newest session among `rows` (newest first): same session_id, or the legacy file tag. */
function latestSession(rows) {
  if (!rows.length) return [];
  const head = rows[0];
  if (head.session_id != null) return rows.filter(r => r.session_id === head.session_id);
  const tag = head.path.replace(/-v?\d+\.jpg$/, '');
  return rows.filter(r => r.session_id == null && r.path.replace(/-v?\d+\.jpg$/, '') === tag);
}

/** Noon rows: a re-run replaces the day's frames, but if two tours ever coexist keep the newest. */
function sameSession(rows) {
  if (!rows.length || !rows.some(r => r.session_id != null)) return rows;
  const newest = Math.max(...rows.filter(r => r.session_id != null).map(r => r.session_id));
  return rows.filter(r => r.session_id === newest);
}

function bySharpest(a, b) {
  const sa = a.sharpness ?? -1, sb = b.sharpness ?? -1;
  if (sb !== sa) return sb - sa;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

function fmtSharp(v) { return v == null ? 'n/a' : Math.round(v).toString(); }

/** Preset names from config: trimmed, non-empty, unique (case-insensitive), <= MAX_VIEWS. */
function normalisePresetNames(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw ?? '').trim().slice(0, 64);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

/** Look a preset up by name on the camera's list (case/space-insensitive; lowest id wins). */
function findPreset(presets, name) {
  const key = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const hits = (presets || []).filter(p => String(p.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === key)
    .sort((a, b) => a.id - b.id);
  return { preset: hits[0] || null, duplicates: hits.slice(1).map(p => p.id) };
}

const samePos = (a, b) => !!a && !!b && a.elevation === b.elevation && a.azimuth === b.azimuth && a.zoom === b.zoom;
const isAuthError = err => err && (err.status === 'auth' || err.httpStatus === 401);

function viewLabel(v) {
  return `View ${v.index} "${v.name}"${v.preset_id ? ` (preset ${v.preset_id})` : ''}`;
}

/** Plain-English reason for a view that has no image. */
function missingReason(v) {
  switch (v.status) {
    case 'missing': return `preset "${v.name}" not found on the camera`;
    case 'goto_failed': return `the camera did not move to it${v.message ? ` (${v.message})` : ''}`;
    case 'capture_failed': return `no frame could be taken${v.message ? ` (${v.message})` : ''}`;
    case 'auth_stopped': return 'not attempted: the camera rejected the login and the tour stopped (lockout guard)';
    case 'not_attempted': return `not attempted${v.message ? ` (${v.message})` : ''}`;
    default: return v.message || v.status || 'no image';
  }
}

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
  if (sel.layout === 'views' && (sel.mode === 'noon' || sel.mode === 'manual' || sel.mode === 'manual_night')) {
    const all = sel.views?.length ? sel.views : items.map(it => ({ index: it.capture.sequence, name: it.capture.preset_name, preset_id: it.capture.preset_id, status: 'ok', capture_id: it.capture.id }));
    const byId = new Map(items.map((it, i) => [it.capture.id, times[i]]));
    const total = all.length;
    const earliest = [...times].sort((a, b) => a.hms.localeCompare(b.hms))[0];
    const kind = sel.mode === 'noon' ? `today's ${earliest.hm} noon session`
      : sel.mode === 'manual' ? `No noon session today; today's ${earliest.hm} manual capture`
        : `No daytime capture within ${REPORT_MAX_AGE_HOURS} h; today's ${earliest.hm} manual capture taken outside daylight hours`;
    const parts = all.map(v => {
      const t = v.capture_id != null ? byId.get(v.capture_id) : null;
      return t ? `${viewLabel(v)} at ${t.hms}` : `${viewLabel(v)} MISSING: ${missingReason(v)}`;
    });
    return `${n} of ${total} canopy ${total === 1 ? 'view' : 'views'} from ${kind} (${parts.join('; ')})`;
  }
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
    return this.scoreFrame(buffer).sharpness;
  }

  /** { sharpness, brightness } for a JPEG buffer; nulls when it cannot be decoded (never throws). */
  scoreFrame(buffer) {
    try {
      if (this._sharpness) {
        const v = this._sharpness(buffer);
        return v && typeof v === 'object' ? { sharpness: v.sharpness ?? null, brightness: v.brightness ?? null } : { sharpness: v ?? null, brightness: null };
      }
      const r = require('./ImageSharpness').sharpnessScore(buffer);
      return { sharpness: r.sharpness, brightness: r.brightness ?? null };
    } catch (err) {
      this.log.warn(`[AgronomistCapture] sharpness scoring failed: ${err.message}`);
      return { sharpness: null, brightness: null };
    }
  }

  /** 1) native frame, 2) if the long edge exceeds the limit ask go2rtc for a scaled one. */
  async _grabFrame(camera, { scaledHint = null } = {}) {
    // A tour asks for the scaled frame straight away once it knows the camera's native
    // size is above the limit (saves one RTSP round trip per frame).
    if (scaledHint) {
      try {
        const small = await this.fetchFrame(camera.go2rtc_name, scaledHint);
        const sd = jpegDimensions(small);
        if (small?.length && sd && Math.max(sd.width, sd.height) <= this.maxEdgePx) return { buffer: small, dims: sd, scaled: true, note: null, hint: scaledHint };
      } catch { /* fall back to the native-first path */ }
    }
    let buffer = await this.fetchFrame(camera.go2rtc_name, {});
    let dims = jpegDimensions(buffer);
    let hint = null;
    let scaled = false;
    let note = null;
    if (dims && Math.max(dims.width, dims.height) > this.maxEdgePx) {
      const landscape = dims.width >= dims.height;
      try {
        const small = await this.fetchFrame(camera.go2rtc_name, landscape ? { width: this.maxEdgePx } : { height: this.maxEdgePx });
        const sd = jpegDimensions(small);
        if (small?.length && sd && Math.max(sd.width, sd.height) <= this.maxEdgePx) {
          buffer = small; dims = sd; scaled = true;
          hint = landscape ? { width: this.maxEdgePx } : { height: this.maxEdgePx };
        } else {
          note = 'scaled fetch returned unexpected size, using original';
        }
      } catch (err) {
        note = `scaled fetch failed (${err.message}), using original`;
      }
    }
    return { buffer, dims, scaled, note, hint };
  }

  _insertRow({ camera, dateStr, relPath, dims, bytes, presetId, sequence, sharpness, source, capturedAt, presetName = null, sessionId = null }) {
    const createdAt = this.now().toISOString();
    const r = this.db.prepare(`
      INSERT INTO agronomist_captures
        (camera_id, capture_date, path, width, height, bytes, preset_id, created_at, sequence, sharpness, source, captured_at, preset_name, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(camera.id, dateStr, relPath, dims?.width ?? null, dims?.height ?? null, bytes, presetId, createdAt, sequence, sharpness, source, capturedAt, presetName, sessionId);
    return this.getById(r.lastInsertRowid);
  }

  /** Delete today's earlier noon frames + sessions for the camera (one noon session per day). */
  _dropNoon(cameraId, dateStr) {
    const old = this.db.prepare("SELECT id, path FROM agronomist_captures WHERE camera_id = ? AND capture_date = ? AND source = 'noon'").all(cameraId, dateStr);
    for (const r of old) {
      try { fs.unlinkSync(this.absolutePath(r.path)); } catch {}
      this.db.prepare('DELETE FROM agronomist_captures WHERE id = ?').run(r.id);
    }
    try { this.db.prepare("DELETE FROM agronomist_capture_sessions WHERE camera_id = ? AND capture_date = ? AND source = 'noon'").run(cameraId, dateStr); } catch {}
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
    // One noon session per day: a re-run replaces the earlier frames.
    if (source === 'noon') this._dropNoon(camera.id, dateStr);

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

  // ---- preset tour (operator request 2026-10-07) ----------------------------------

  _timing(overrides = {}) {
    return {
      pollMs: SETTLE_POLL_MS, stableReads: SETTLE_STABLE_READS, minMs: SETTLE_MIN_MS,
      timeoutMs: SETTLE_TIMEOUT_MS, fallbackMs: SETTLE_FALLBACK_MS, focusMs: FOCUS_SETTLE_MS,
      frameSpacingMs: VIEW_FRAME_SPACING_MS, manualQuietMs: MANUAL_QUIET_MS, manualWaitMaxMs: MANUAL_WAIT_MAX_MS,
      blurThreshold: BLUR_THRESHOLD, darkThreshold: DARK_THRESHOLD,
      ...overrides,
    };
  }

  _nowMs() { return this.now().getTime(); }

  /** Why a frame is not good enough (null = fine). */
  _poorReason(frame, t) {
    if (!frame) return 'no frame';
    if (frame.brightness != null && frame.brightness < t.darkThreshold) return `too dark (mean luma ${Math.round(frame.brightness)} < ${t.darkThreshold})`;
    if (frame.sharpness != null && frame.sharpness < t.blurThreshold) return `blurry (sharpness ${Math.round(frame.sharpness)} < ${t.blurThreshold})`;
    return null;
  }

  /** Is a person driving the camera from the live view (continuous move or a recent UI action)? */
  _inUse(camera, t) {
    const ptz = this.ptz;
    if (ptz?.isMoving?.(camera.id)) return true;
    const act = ptz?.lastActivity?.(camera.id);
    return !!act && this._nowMs() - act.at < t.manualQuietMs;
  }

  /**
   * Somebody is using the PTZ: wait up to manualWaitMaxMs for them to finish, then
   * proceed anyway. Either way it is logged and recorded on the session.
   */
  async _waitForManualQuiet(camera, t, note) {
    if (!this._inUse(camera, t)) return null;
    const start = this._nowMs();
    note(`someone is using the camera (live-view PTZ); waiting up to ${Math.round(t.manualWaitMaxMs / 1000)} s for them to finish`);
    while (this._inUse(camera, t) && this._nowMs() - start < t.manualWaitMaxMs) await this.sleep(5000);
    const waited = this._nowMs() - start;
    if (this._inUse(camera, t)) note(`camera still in use after ${Math.round(waited / 1000)} s; capture proceeds anyway (the person driving it will see it move)`);
    else note(`camera free after ${Math.round(waited / 1000)} s`);
    return waited;
  }

  /** A continuous UI move holds the stop watchdog; let it lapse instead of racing it (<= 5 s). */
  async _waitWhileMoving(camera) {
    for (let i = 0; this.ptz?.isMoving?.(camera.id) && i < 10; i++) await this.sleep(500);
  }

  /**
   * Wait until the PTZ has stopped after a goto. Polls the ISAPI status; settled =
   * stableReads identical consecutive positions AND (moved away from `from` OR minMs
   * elapsed). No usable status -> fixed fallback delay. Auth errors propagate.
   * @returns { mode: 'polled'|'fixed'|'timeout', ms, reads, moved, position }
   */
  async _waitSettled(camera, t, from = null) {
    const start = this._nowMs();
    let last = null, stable = 0, reads = 0, moved = false, ref = from;
    for (;;) {
      await this.sleep(t.pollMs);
      const elapsed = this._nowMs() - start;
      let pos;
      try { pos = await this.ptz.getPosition(camera); } catch (err) {
        if (isAuthError(err)) throw err;
        pos = undefined;
      }
      if (!pos) {
        if (reads === 0) {
          const rest = Math.max(0, t.fallbackMs - elapsed);
          if (rest) await this.sleep(rest);
          return { mode: 'fixed', ms: this._nowMs() - start, reads: 0, moved: null, position: null };
        }
        stable = 0; last = null;
      } else {
        reads++;
        if (!ref) ref = pos;
        if (!samePos(pos, ref)) moved = true;
        stable = samePos(pos, last) ? stable + 1 : 1;
        last = pos;
        if (stable >= t.stableReads && (moved || elapsed >= t.minMs)) {
          return { mode: 'polled', ms: elapsed, reads, moved, position: pos };
        }
      }
      if (elapsed >= t.timeoutMs) return { mode: 'timeout', ms: elapsed, reads, moved, position: last };
    }
  }

  /** One visit of one preset: goto -> settle -> focus -> N frames. Throws with err.stage. */
  async _visitView(camera, view, { t, framesPerView, from, hintRef, attempt }) {
    const startMs = this._nowMs();
    await this._waitWhileMoving(camera);
    try {
      await this.ptz.gotoPreset(camera, view.preset_id, { source: 'agronomist' });
    } catch (err) { err.stage = 'goto'; throw err; }
    const settle = await this._waitSettled(camera, t, from);
    await this.sleep(t.focusMs);
    const candidates = [];
    let lastErr = null;
    for (let f = 1; f <= framesPerView; f++) {
      if (f > 1) await this.sleep(t.frameSpacingMs);
      let grab;
      try { grab = await this._grabFrame(camera, { scaledHint: hintRef.hint }); } catch (err) { lastErr = err; continue; }
      if (grab.hint) hintRef.hint = grab.hint;
      const score = this.scoreFrame(grab.buffer);
      candidates.push({ ...grab, ...score, attempt, frame: f, capturedAt: this.now().toISOString() });
    }
    if (!candidates.length) {
      const err = new Error(`no frame from go2rtc (${lastErr?.message || 'unknown error'})`);
      err.stage = 'capture';
      throw err;
    }
    const act = this.ptz.lastActivity?.(camera.id);
    const disturbed = !!act && act.at >= startMs;
    return { candidates, settle, disturbed };
  }

  /** Put the camera back: configured home preset, else the position before the tour. */
  async _restoreCamera(camera, { home, homePreset, presets, aborted, moved, startedMs, lastPos }, t, note) {
    if (aborted === 'auth') return { mode: 'skipped', ok: false, reason: 'camera rejected the login; no further requests (lockout guard)' };
    if (!moved) return { mode: 'not_needed', ok: true, reason: 'the camera was not moved' };
    const act = this.ptz.lastActivity?.(camera.id);
    if (act && act.at >= startedMs && this._nowMs() - act.at < t.manualQuietMs) {
      note('someone moved the camera during the capture; left it where they put it instead of restoring');
      return { mode: 'skipped', ok: false, reason: 'someone is using the camera' };
    }
    try {
      if (homePreset) {
        const { preset } = findPreset(presets, homePreset);
        if (preset) {
          await this.ptz.gotoPreset(camera, preset.id, { source: 'agronomist' });
          const s = await this._waitSettled(camera, t, lastPos);
          return { mode: 'preset', ok: true, preset_id: preset.id, preset_name: preset.name, settle_ms: s.ms, final: s.position };
        }
        note(`home preset "${homePreset}" not found on the camera; returning to the starting position instead`);
      }
      if (!home) {
        note('starting position unknown; camera left at the last view');
        return { mode: 'none', ok: false, reason: 'starting position unknown' };
      }
      await this.ptz.gotoAbsolute(camera, home, { source: 'agronomist' });
      const s = await this._waitSettled(camera, t, lastPos);
      const final = s.position;
      const close = final ? Math.abs(final.elevation - home.elevation) <= 2 && Math.abs(final.azimuth - home.azimuth) <= 2 && Math.abs(final.zoom - home.zoom) <= 2 : null;
      if (close === false) note(`camera returned to ${JSON.stringify(final)}, expected ${JSON.stringify(home)}`);
      return { mode: 'position', ok: close !== false, target: home, final, settle_ms: s.ms };
    } catch (err) {
      note(`could not return the camera (${err.message})`);
      return { mode: homePreset ? 'preset' : 'position', ok: false, reason: err.message, target: home };
    }
  }

  /**
   * The preset tour: one view from each named preset. See the header.
   * @param opts.cameraId       null = first enabled camera
   * @param opts.presets        preset names (default ["Agronomist 1","Agronomist 2","Agronomist 3"], max 3)
   * @param opts.homePreset     preset name to finish on; null = the position before the tour
   * @param opts.source         'noon' | 'manual' (default 'manual')
   * @param opts.framesPerView  frames per view, sharpest kept (1..3, default 2)
   * @param opts.timing         overrides for the settle / focus / threshold constants (tests)
   * @returns the first view's row spread at top level (compat) + `frames` (view order),
   *          `views` (every requested view incl. missing) and `session`
   * @throws when no view could be captured (the session row is written first)
   */
  async captureViews(dateStr, opts = {}) {
    const camera = this._pickCamera(opts.cameraId || null);
    const source = opts.source === 'noon' ? 'noon' : 'manual';
    const names = normalisePresetNames(opts.presets === undefined || opts.presets === null ? DEFAULT_VIEW_PRESETS : opts.presets);
    if (!names.length) throw new Error('No camera presets configured for the agronomist views');
    const framesPerView = Math.min(3, Math.max(1, parseInt(opts.framesPerView, 10) || DEFAULT_FRAMES_PER_VIEW));
    const homePreset = opts.homePreset ? String(opts.homePreset).trim() || null : null;
    const t = this._timing(opts.timing);
    const ptz = this.ptz;
    if (!ptz) throw new Error('PTZ control unavailable: cannot visit the agronomist presets');

    const startedAt = this.now();
    const startedMs = startedAt.getTime();
    const notes = [];
    const note = (msg) => { notes.push(msg); this.log.warn(`[AgronomistCapture] ${camera.name} ${dateStr}: ${msg}`); };
    const views = names.map((name, i) => ({ index: i + 1, name, preset_id: null, status: 'pending' }));
    const kept = [];        // { view, frame }
    let aborted = null;     // 'auth' | 'presets'
    let presets = null;
    let home = null;
    let lastPos = null;
    let moved = false;
    let restore = null;
    let manualWaitMs = null;
    const hintRef = { hint: null };

    ptz.setBusy?.(camera.id, 'agronomist capture');
    try {
      manualWaitMs = await this._waitForManualQuiet(camera, t, note);

      try {
        presets = await ptz.getPresets(camera);
      } catch (err) {
        aborted = isAuthError(err) ? 'auth' : 'presets';
        note(isAuthError(err)
          ? `camera rejected the login (${err.message}); tour stopped, no further requests (lockout guard)`
          : `could not read the camera's preset list (${err.message}); nothing captured`);
      }
      if (presets) {
        for (const v of views) {
          const { preset, duplicates } = findPreset(presets, v.name);
          if (!preset) { v.status = 'missing'; note(`View ${v.index} "${v.name}": preset not found on the camera`); continue; }
          v.preset_id = preset.id;
          if (duplicates.length) note(`View ${v.index} "${v.name}": several presets share this name (${[preset.id, ...duplicates].join(', ')}); using ${preset.id}`);
        }
        if (views.some(v => v.preset_id)) {
          try {
            home = await ptz.getPosition(camera);
            lastPos = home;
            if (!home) note('camera did not report its position; it cannot be put back exactly');
          } catch (err) {
            if (isAuthError(err)) { aborted = 'auth'; note(`camera rejected the login (${err.message}); tour stopped (lockout guard)`); }
            else note(`could not read the starting position (${err.message}); it cannot be put back exactly`);
          }
        }
      }

      for (const v of views) {
        if (v.status !== 'pending') continue;
        if (aborted) {
          v.status = aborted === 'auth' ? 'auth_stopped' : 'not_attempted';
          if (aborted !== 'auth') v.message = 'preset list unavailable';
          continue;
        }
        const tag = `View ${v.index} "${v.name}" (preset ${v.preset_id})`;
        let result = null;
        let firstErr = null;
        try {
          moved = true;
          try {
            result = await this._visitView(camera, v, { t, framesPerView, from: lastPos, hintRef, attempt: 1 });
          } catch (err) {
            if (isAuthError(err)) throw err;
            firstErr = err;
          }
          if (result?.settle?.position) lastPos = result.settle.position;
          const best1 = result ? [...result.candidates].sort(bySharpest)[0] : null;
          const why = !result ? `attempt 1 failed (${firstErr.message})`
            : result.disturbed ? 'someone moved the camera during this view'
              : this._poorReason(best1, t);
          let all = result ? [...result.candidates] : [];
          const settles = result ? [result.settle] : [];
          if (why) {
            note(`${tag}: ${why}; retrying once`);
            v.retried = true;
            v.retry_reason = why;
            try {
              const r2 = await this._visitView(camera, v, { t, framesPerView, from: lastPos, hintRef, attempt: 2 });
              if (r2.settle?.position) lastPos = r2.settle.position;
              settles.push(r2.settle);
              // frames taken while someone was moving the camera only count if nothing else exists
              all = r2.disturbed ? [...all, ...r2.candidates] : [...(result?.disturbed ? [] : all), ...r2.candidates];
              if (r2.disturbed) note(`${tag}: the camera was moved again during the retry`);
            } catch (err) {
              if (isAuthError(err)) throw err;
              note(`${tag}: retry failed (${err.message})`);
              if (!all.length) throw err;
            }
          }
          if (!all.length) throw firstErr || new Error('no frame');
          const best = [...all].sort(bySharpest)[0];
          const poor = this._poorReason(best, t);
          Object.assign(v, {
            status: 'ok',
            sharpness: best.sharpness,
            brightness: best.brightness,
            captured_at: best.capturedAt,
            quality: poor,
            settle: settles.map(s => ({ mode: s.mode, ms: s.ms, reads: s.reads, moved: s.moved })),
            candidates: all.map(c => ({ attempt: c.attempt, frame: c.frame, sharpness: c.sharpness, brightness: c.brightness })),
          });
          for (const s of settles) if (s.mode === 'timeout') note(`${tag}: PTZ did not report a stable position within ${Math.round(t.timeoutMs / 1000)} s; frame taken anyway`);
          if (poor) note(`${tag}: kept frame is ${poor}`);
          kept.push({ view: v, frame: best });
          this.log.log(`[AgronomistCapture] ${camera.name} ${dateStr} ${source} ${tag}: ${best.dims ? `${best.dims.width}x${best.dims.height}` : '?x?'} sharpness=${fmtSharp(best.sharpness)} luma=${best.brightness ?? 'n/a'} settle=${settles.map(s => `${s.mode}:${s.ms}ms`).join('/')} candidates=${all.map(c => fmtSharp(c.sharpness)).join(',')}`);
        } catch (err) {
          if (isAuthError(err)) {
            aborted = 'auth';
            v.status = 'auth_stopped';
            v.message = err.message;
            note(`${tag}: camera rejected the login (${err.message}); tour stopped, no further requests (lockout guard)`);
            continue;
          }
          v.status = err.stage === 'goto' ? 'goto_failed' : 'capture_failed';
          v.message = err.message;
          note(`${tag}: ${missingReason(v)}`);
        }
      }
    } finally {
      try {
        restore = await this._restoreCamera(camera, { home, homePreset, presets, aborted, moved, startedMs, lastPos }, t, note);
      } catch (err) {
        restore = { ok: false, reason: err.message };
      }
      ptz.clearBusy?.(camera.id);
    }

    // Persist: files + rows only now, so a failed noon re-run never erases a good one.
    const finishedAt = this.now();
    const status = kept.length === views.length ? 'complete' : kept.length ? 'partial' : 'failed';
    if (source === 'noon' && kept.length) this._dropNoon(camera.id, dateStr);
    const sessionId = this.db.prepare(`
      INSERT INTO agronomist_capture_sessions (camera_id, capture_date, source, status, started_at, finished_at, views, restore, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(camera.id, dateStr, source, status, startedAt.toISOString(), finishedAt.toISOString(),
      JSON.stringify(views), JSON.stringify(restore), JSON.stringify(notes), finishedAt.toISOString()).lastInsertRowid;
    const base = source === 'noon' ? dateStr : `${dateStr}-manual-${localParts(startedAt, this.tz()).hms.replace(/:/g, '')}`;
    const rows = [];
    for (const { view, frame } of kept) {
      const relPath = this.relativePath(camera.id, `${base}-v${view.index}`);
      const absPath = this.absolutePath(relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, frame.buffer);
      const row = this._insertRow({
        camera, dateStr, relPath, dims: frame.dims, bytes: frame.buffer.length, presetId: view.preset_id,
        sequence: view.index, sharpness: frame.sharpness, source, capturedAt: frame.capturedAt,
        presetName: view.name, sessionId,
      });
      view.capture_id = row.id;
      rows.push(row);
    }
    this.db.prepare('UPDATE agronomist_capture_sessions SET views = ? WHERE id = ?').run(JSON.stringify(views), sessionId);

    const durationMs = finishedAt.getTime() - startedMs;
    const summary = views.map(v => (v.status === 'ok' ? `${v.index}:${fmtSharp(v.sharpness)}` : `${v.index}:${v.status}`)).join(' ');
    this.log.log(`[AgronomistCapture] ${camera.name} ${dateStr} ${source} tour ${status} in ${Math.round(durationMs / 1000)} s [${summary}] restore=${restore?.mode}${restore?.ok ? '' : ' (not restored)'}`);
    const session = {
      id: sessionId, date: dateStr, source, status, layout: 'views', views, restore, notes,
      started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), duration_ms: durationMs,
      manual_wait_ms: manualWaitMs, requested: views.length, frames: rows.length,
    };
    if (!rows.length) {
      const why = views.map(v => `${viewLabel(v)}: ${missingReason(v)}`).join('; ');
      const err = new Error(`no agronomist view captured (${why})`);
      err.session = session;
      throw err;
    }
    return { ...rows[0], camera_name: camera.name, scaled: kept.some(k => k.frame.scaled), note: notes.length ? notes.join('; ') : null, frames: rows, views, session };
  }

  /**
   * The configured session: the preset tour when `capture_presets` names any preset,
   * else the legacy single-preset burst. Used by the noon trigger and capture-now.
   * @param cfg       agronomist config (getConfig())
   * @param overrides { cameraId, presetId (forces the burst), frames, spacingMs }
   */
  runConfiguredSession(dateStr, cfg = {}, { source = 'manual', ...overrides } = {}) {
    const cameraId = overrides.cameraId || cfg.capture_camera_id || null;
    const presets = normalisePresetNames(cfg.capture_presets === undefined ? DEFAULT_VIEW_PRESETS : cfg.capture_presets);
    if (presets.length && !overrides.presetId) {
      return this.captureViews(dateStr, {
        cameraId, presets, source,
        homePreset: cfg.capture_home_preset || null,
        framesPerView: cfg.capture_frames_per_view || DEFAULT_FRAMES_PER_VIEW,
      });
    }
    return this.captureForDate(dateStr, {
      cameraId,
      presetId: overrides.presetId || cfg.capture_preset_id || null,
      source,
      frames: overrides.frames ?? (cfg.capture_frames || DEFAULT_FRAMES),
      spacingMs: overrides.spacingMs ?? (cfg.capture_spacing_seconds ?? 30) * 1000,
    });
  }

  /** agronomist_capture_sessions row with JSON columns parsed, or null. */
  getSession(id) {
    if (id == null) return null;
    let r;
    try { r = this.db.prepare('SELECT * FROM agronomist_capture_sessions WHERE id = ?').get(id); } catch { return null; }
    if (!r) return null;
    const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
    return { ...r, layout: 'views', views: parse(r.views, []), restore: parse(r.restore, null), notes: parse(r.notes, []) };
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
      // a) today's noon session (a preset tour: its latest session only)
      rows = sameSession(this._rowsQuery(`c.capture_date = ? AND c.source = 'noon'${camWhere}`, [dateStr, ...camParams]));
      if (rows.length) mode = 'noon';
      // b) today's manual session in daylight (latest session = same session_id, or legacy file tag)
      if (!rows.length) {
        const manual = this._withLocal(this._rowsQuery(`c.capture_date = ? AND c.source = 'manual'${camWhere}`, [dateStr, ...camParams]), tz)
          .filter(x => x.local && inWindow(x.local.hour, DAYTIME_WINDOW));
        if (manual.length) {
          rows = latestSession(manual.map(x => x.row));
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
        rows = latestSession(manual);
        mode = 'manual_night';
      }
    }
    if (!rows.length) return null;

    // Ordering: preset views in view order (every view is sent: they are different
    // scenes); burst sessions sharpest-first; fallback snapshots newest-first; cap.
    const isSession = mode === 'noon' || mode === 'manual' || mode === 'manual_night';
    const layout = isSession && rows[0]?.session_id != null ? 'views' : 'burst';
    let session = null;
    if (layout === 'views') {
      rows = [...rows].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).slice(0, MAX_IMAGES_PER_REPORT);
      session = this.getSession(rows[0].session_id);
    } else {
      if (isSession) rows = [...rows].sort(bySharpest);
      rows = rows.slice(0, cap);
    }

    const items = [];
    for (const row of rows) {
      let buffer;
      try { buffer = fs.readFileSync(this.absolutePath(row.path)); } catch { continue; }
      const at = parseIso(row.captured_at) || parseIso(row.created_at) || now;
      const ageHours = Math.max(0, (now.getTime() - at.getTime()) / 3600_000);
      items.push({ capture: row, ageHours: Math.round(ageHours * 10) / 10, buffer });
    }
    if (!items.length) return null;
    return {
      mode, layout, date: dateStr, tz, items,
      views: session?.views || null, session_id: session?.id ?? null,
      total_bytes: items.reduce((a, it) => a + it.buffer.length, 0),
    };
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
      // preset tours group by session; legacy bursts by day + camera + source
      const key = r.session_id != null ? `s${r.session_id}` : `${r.capture_date}|${r.camera_id}|${r.source}`;
      if (!groups.has(key)) groups.set(key, { date: r.capture_date, camera_id: r.camera_id, camera_name: r.camera_name, source: r.source, session_id: r.session_id ?? null, frames: [] });
      groups.get(key).frames.push(r);
    }
    // Sessions that captured nothing still matter ("tour failed: camera rejected the login").
    try {
      const cutoff = new Date(this.now().getTime() - (opts.days || 7) * 86400_000).toISOString().slice(0, 10);
      const empty = this.db.prepare(`SELECT id, camera_id, capture_date, source FROM agronomist_capture_sessions WHERE capture_date >= ? AND status = 'failed' ${opts.cameraId ? 'AND camera_id = ?' : ''}`)
        .all(...(opts.cameraId ? [cutoff, opts.cameraId] : [cutoff]));
      for (const e of empty) {
        if (!groups.has(`s${e.id}`)) groups.set(`s${e.id}`, { date: e.capture_date, camera_id: e.camera_id, camera_name: null, source: e.source, session_id: e.id, frames: [] });
      }
    } catch { /* table missing on an old DB: no sessions */ }
    const latest = g => g.frames.reduce((m, f) => ((f.captured_at || '') > m ? f.captured_at : m), '');
    return [...groups.values()].map(g => {
      const session = g.session_id != null ? this.getSession(g.session_id) : null;
      const frames = session ? [...g.frames].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) : g.frames;
      return {
        ...g, frames,
        layout: session ? 'views' : 'burst',
        session: session ? { id: session.id, status: session.status, views: session.views, restore: session.restore, notes: session.notes, started_at: session.started_at, finished_at: session.finished_at } : null,
        best_id: [...g.frames].sort(bySharpest)[0]?.id ?? null,
        _latest: session?.started_at || latest(g),
      };
    }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b._latest).localeCompare(String(a._latest)))
      .map(({ _latest, ...g }) => g);
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
    let sessionsDropped = 0;
    try { sessionsDropped = this.db.prepare('DELETE FROM agronomist_capture_sessions WHERE capture_date < ?').run(cutoff).changes; } catch {}
    return { rows_dropped: rows.length, files_removed: filesRemoved, sessions_dropped: sessionsDropped, cutoff };
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
  DEFAULT_VIEW_PRESETS,
  DEFAULT_FRAMES_PER_VIEW,
  MAX_VIEWS,
  normalisePresetNames,
  findPreset,
  missingReason,
  viewLabel,
};
