const fs = require('fs');
const path = require('path');

/**
 * Resolves the HTTP/RTSP password for a camera.
 *
 * Order of precedence:
 *   1. cameras.password (the DB column) — the intended source of truth.
 *   2. The password embedded in the go2rtc stream source for camera.go2rtc_name,
 *      read from go2rtc's REST API (GET /api/streams -> producers[].url).
 *   3. The same URL parsed straight out of go2rtc.yaml (dev / host runs where the
 *      config file is readable; the backend container does not mount it).
 *
 * The password is never sent to the frontend; callers use it only for outbound
 * requests to the camera. Fallback results are cached per camera id so a PTZ
 * burst (10 moves/s) does not hammer go2rtc, and a one-time warning nudges the
 * operator to save the password in the camera settings.
 */

const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
const DEFAULT_CONFIG_PATHS = [
  process.env.GO2RTC_CONFIG_PATH,
  path.join(__dirname, '../../../go2rtc/config/go2rtc.yaml'),
  '/config/go2rtc.yaml',
].filter(Boolean);

const CACHE_TTL_MS = 5 * 60 * 1000;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Extract { username, password, host } from an rtsp://user:pass@host... URL.
 * Password may be %-encoded (go2rtc stores "Thursday%401" for "Thursday@1").
 */
function parseCredentialsFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^[a-z0-9+.-]+:\/\/([^/@]+)@/i);
  if (!m) return null;
  const idx = m[1].indexOf(':');
  if (idx < 0) return { username: safeDecode(m[1]), password: '' };
  return {
    username: safeDecode(m[1].slice(0, idx)),
    password: safeDecode(m[1].slice(idx + 1)),
  };
}

/** Find the source URL for a go2rtc stream name inside go2rtc.yaml text. */
function findStreamUrlInYaml(yamlText, streamName) {
  if (!yamlText || !streamName) return null;
  const lines = yamlText.split(/\r?\n/);
  const key = `${streamName}:`;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith(key)) continue;
    // Inline form:  name: "rtsp://..."   or   name: rtsp://...
    const inline = t.slice(key.length).trim().replace(/^["']|["']$/g, '');
    if (inline.startsWith('rtsp://') || inline.startsWith('http')) return inline;
    // List form:  name:\n  - rtsp://...
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j].trim();
      if (!s) continue;
      if (s.startsWith('-')) return s.slice(1).trim().replace(/^["']|["']$/g, '');
      break;
    }
    return null;
  }
  return null;
}

class CameraCredentials {
  constructor({ go2rtcUrl = GO2RTC_URL, configPaths = DEFAULT_CONFIG_PATHS, logger = console, fetchImpl } = {}) {
    this.go2rtcUrl = go2rtcUrl;
    this.configPaths = configPaths;
    this.logger = logger;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.cache = new Map();   // camera.id -> { password, source, at }
    this.warned = new Set();  // camera ids we've already warned about
  }

  invalidate(cameraId) {
    if (cameraId == null) this.cache.clear();
    else this.cache.delete(cameraId);
  }

  /**
   * @returns {Promise<{ username: string, password: string|null, source: 'db'|'go2rtc'|'yaml'|'none' }>}
   */
  async resolve(camera) {
    const username = camera.username || 'admin';
    if (camera.password) return { username, password: camera.password, source: 'db' };

    const cached = this.cache.get(camera.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { username, password: cached.password, source: cached.source };
    }

    let found = null;
    const fromApi = await this._fromGo2rtcApi(camera.go2rtc_name);
    if (fromApi) found = { ...fromApi, source: 'go2rtc' };
    if (!found) {
      const fromYaml = this._fromYaml(camera.go2rtc_name);
      if (fromYaml) found = { ...fromYaml, source: 'yaml' };
    }

    if (!found || !found.password) {
      this.cache.set(camera.id, { password: null, source: 'none', at: Date.now() });
      return { username, password: null, source: 'none' };
    }

    if (!this.warned.has(camera.id)) {
      this.warned.add(camera.id);
      this.logger.warn(
        `[CameraCredentials] Camera ${camera.id} (${camera.name}) has no password saved; ` +
        `using the one from the go2rtc stream "${camera.go2rtc_name}" (${found.source}). ` +
        `Save it in the camera settings (Edit camera -> Password) so PTZ/ISAPI keeps working if the stream is reconfigured.`
      );
    }
    this.cache.set(camera.id, { password: found.password, source: found.source, at: Date.now() });
    return { username: camera.username || found.username || 'admin', password: found.password, source: found.source };
  }

  async _fromGo2rtcApi(streamName) {
    if (!streamName) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await this.fetch(`${this.go2rtcUrl}/api/streams`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const streams = await res.json();
      const info = streams && streams[streamName];
      const producers = (info && info.producers) || [];
      for (const p of producers) {
        const creds = parseCredentialsFromUrl(p && p.url);
        if (creds && creds.password) return creds;
      }
      return null;
    } catch {
      return null;
    }
  }

  _fromYaml(streamName) {
    for (const p of this.configPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const url = findStreamUrlInYaml(fs.readFileSync(p, 'utf8'), streamName);
        const creds = parseCredentialsFromUrl(url);
        if (creds && creds.password) return creds;
      } catch {
        // unreadable — try the next path
      }
    }
    return null;
  }
}

const cameraCredentials = new CameraCredentials();

module.exports = { CameraCredentials, cameraCredentials, parseCredentialsFromUrl, findStreamUrlInYaml };
