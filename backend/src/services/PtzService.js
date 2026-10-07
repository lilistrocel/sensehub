const http = require('http');
const crypto = require('crypto');
const { cameraCredentials } = require('./CameraCredentials');

/**
 * Hikvision ISAPI PTZ client (dependency-free, HTTP Digest auth per RFC 2617/7616).
 *
 * Safety:
 *   - Stop watchdog: every continuous move (re)arms a per-camera timer that issues
 *     an all-zeros "stop" after WATCHDOG_MS unless another move refreshes it. A lost
 *     websocket/mouseup can therefore never leave the camera spinning.
 *   - Rate limit: moves are limited to one per MIN_MOVE_INTERVAL_MS per camera
 *     (~10/s). Stops are never rate-limited.
 *
 * Errors are thrown as PtzError { status: 'unreachable'|'auth'|'rate_limited'|'error', message }.
 */

const REQUEST_TIMEOUT_MS = 3000;
const STATUS_TIMEOUT_MS = 2000;
const WATCHDOG_MS = 2000;
const MIN_MOVE_INTERVAL_MS = 100;
const CAPS_TTL_MS = 10 * 60 * 1000;
// Hikvision locks the client IP for 30 min after 7 bad logins. After one rejected
// credential we stop talking to the camera for a while (or for the lock duration
// the camera reports) so status polling cannot escalate a typo into a lockout.
const AUTH_BACKOFF_MS = 60 * 1000;

class PtzError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'PtzError';
    this.status = status;
    Object.assign(this, extra);
  }
  toJSON() {
    const { status, message } = this;
    const out = { status, message };
    if (this.httpStatus) out.httpStatus = this.httpStatus;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Digest auth
// ---------------------------------------------------------------------------

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseAuthHeader(header) {
  if (!header) return null;
  const m = header.match(/^\s*(Digest|Basic)\s*(.*)$/is);
  if (!m) return null;
  const params = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  let mm;
  while ((mm = re.exec(m[2])) !== null) {
    params[mm[1].toLowerCase()] = mm[2] !== undefined ? mm[2].replace(/\\(.)/g, '$1') : mm[3];
  }
  return { scheme: m[1], params };
}

/**
 * Compute the Digest "response" value.
 * @param {object} p { username, password, realm, nonce, method, uri, qop, nc, cnonce, algorithm }
 */
function computeDigestResponse({ username, password, realm, nonce, method, uri, qop, nc, cnonce, algorithm = 'MD5' }) {
  const alg = String(algorithm || 'MD5').toUpperCase();
  const H = alg.startsWith('SHA-256') ? sha256 : md5;
  let ha1 = H(`${username}:${realm}:${password}`);
  if (alg.endsWith('-SESS')) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  if (qop) return H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return H(`${ha1}:${nonce}:${ha2}`);
}

function buildDigestHeader({ username, password, method, uri, challenge, nc }) {
  const { realm, nonce, opaque } = challenge;
  const algorithm = challenge.algorithm || 'MD5';
  // Server may offer "auth,auth-int" — we always pick "auth" when offered.
  const qop = challenge.qop && challenge.qop.split(',').map(s => s.trim()).includes('auth') ? 'auth' : undefined;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncStr = nc.toString(16).padStart(8, '0');
  const response = computeDigestResponse({ username, password, realm, nonce, method, uri, qop, nc: ncStr, cnonce, algorithm });
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncStr}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Minimal HTTP client with timeout
// ---------------------------------------------------------------------------

function rawRequest({ host, port, method, path, headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    const onTimeout = () => {
      req.destroy(Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    };
    req.on('timeout', onTimeout);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function classifyNetworkError(err) {
  const code = err && err.code;
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return new PtzError('unreachable', `Camera unreachable (${code})`, { code });
  }
  return new PtzError('error', err && err.message ? err.message : 'Request failed');
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlUnescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlTag = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i'));
  return m ? xmlUnescape(m[1].trim()) : null;
};

const clampSpeed = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-100, Math.min(100, Math.round(n)));
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PtzService {
  constructor({
    credentials = cameraCredentials,
    watchdogMs = WATCHDOG_MS,
    minMoveIntervalMs = MIN_MOVE_INTERVAL_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    statusTimeoutMs = STATUS_TIMEOUT_MS,
    logger = console,
  } = {}) {
    this.credentials = credentials;
    this.watchdogMs = watchdogMs;
    this.minMoveIntervalMs = minMoveIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.statusTimeoutMs = statusTimeoutMs;
    this.logger = logger;
    this.digestState = new Map(); // camera.id -> { challenge, nc }
    this.watchdogs = new Map();   // camera.id -> Timeout
    this.lastMoveAt = new Map();  // camera.id -> ms
    this.capsCache = new Map();   // camera.id -> { caps, at }
    this.authBackoff = new Map(); // camera.id -> { until, message }
    this.activity = new Map();    // camera.id -> { at, source, action } — last move/goto by a person (UI)
    this.busy = new Map();        // camera.id -> { label, since } — an automatic PTZ session (agronomist capture)
    this.watchdogFired = 0;       // counter (tests / diagnostics)
  }

  // ---- who is using the camera ---------------------------------------------
  // Every move / stop / preset goto from the live-view UI is recorded as user
  // activity, so an automatic session (the agronomist's noon capture tour) can
  // see that someone is driving the camera and log it instead of fighting them.
  // Automatic callers pass { source: 'agronomist' } and are not recorded.

  _noteActivity(cameraId, source, action) {
    if (source && source !== 'user') return;
    this.activity.set(cameraId, { at: Date.now(), source: 'user', action });
  }

  /** Last user PTZ action on the camera ({ at: ms, source, action }) or null. */
  lastActivity(cameraId) {
    return this.activity.get(cameraId) || null;
  }

  setBusy(cameraId, label) { this.busy.set(cameraId, { label, since: Date.now() }); }
  clearBusy(cameraId) { this.busy.delete(cameraId); }
  getBusy(cameraId) { return this.busy.get(cameraId) || null; }

  /** Forget cached digest state and auth backoff (call after credentials change). */
  clearAuthState(cameraId) {
    this.digestState.delete(cameraId);
    this.authBackoff.delete(cameraId);
  }

  // ---- low-level ISAPI request with digest auth ---------------------------

  async request(camera, method, path, body, { timeoutMs } = {}) {
    const host = camera.ip_address;
    const port = Number(camera.http_port) || 80;
    if (!host) throw new PtzError('error', 'Camera has no IP address configured');
    const timeout = timeoutMs || this.requestTimeoutMs;

    const backoff = this.authBackoff.get(camera.id);
    if (backoff) {
      const left = Math.ceil((backoff.until - Date.now()) / 1000);
      if (left > 0) {
        throw new PtzError('auth', `${backoff.message} — not retrying for ${left} s to avoid a camera lockout`, { httpStatus: 401, retryAfter: left });
      }
      this.authBackoff.delete(camera.id);
    }

    const { username, password } = await this.credentials.resolve(camera);

    const baseHeaders = {
      'Accept': 'application/xml, text/xml, */*',
      'Connection': 'close',
    };
    if (body) {
      baseHeaders['Content-Type'] = 'application/xml';
      baseHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const attempt = async (authHeader) => {
      const headers = authHeader ? { ...baseHeaders, Authorization: authHeader } : baseHeaders;
      try {
        return await rawRequest({ host, port, method, path, headers, body, timeoutMs: timeout });
      } catch (err) {
        throw classifyNetworkError(err);
      }
    };

    // 1. Pre-emptive auth if we already hold a valid challenge (saves a round trip per move).
    let state = this.digestState.get(camera.id);
    let res;
    if (state) {
      state.nc += 1;
      res = await attempt(buildDigestHeader({ username, password: password || '', method, uri: path, challenge: state.challenge, nc: state.nc }));
      if (res.status !== 401) return this._finish(res, path);
      this.digestState.delete(camera.id);
    } else {
      res = await attempt(null);
      if (res.status !== 401) return this._finish(res, path);
    }

    // 2. Answer the challenge.
    const challenge = parseAuthHeader(res.headers['www-authenticate']);
    if (!challenge) throw new PtzError('auth', 'Camera rejected the request (401) without an auth challenge', { httpStatus: 401 });
    if (password == null) {
      throw new PtzError('auth', 'No camera password available — save it in the camera settings', { httpStatus: 401 });
    }

    let authHeader;
    if (challenge.scheme.toLowerCase() === 'digest') {
      state = { challenge: challenge.params, nc: 1 };
      authHeader = buildDigestHeader({ username, password, method, uri: path, challenge: state.challenge, nc: state.nc });
    } else {
      authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    res = await attempt(authHeader);
    if (res.status === 401) {
      const lock = xmlTag(res.body, 'lockStatus');
      const unlock = parseInt(xmlTag(res.body, 'unlockTime'), 10);
      const locked = lock === 'lock';
      const detail = locked ? ` (client IP locked by the camera, unlocks in ${Number.isFinite(unlock) ? unlock : '?'} s)` : '';
      const message = `Camera rejected credentials for user "${username}"${detail}`;
      const backoffMs = locked && Number.isFinite(unlock) ? (unlock + 5) * 1000 : AUTH_BACKOFF_MS;
      this.authBackoff.set(camera.id, { until: Date.now() + backoffMs, message });
      this.logger.warn(`[PTZ] ${message}; pausing ISAPI requests to camera ${camera.id} for ${Math.round(backoffMs / 1000)} s`);
      throw new PtzError('auth', message, { httpStatus: 401, retryAfter: Math.round(backoffMs / 1000) });
    }
    if (state) this.digestState.set(camera.id, state);
    return this._finish(res, path);
  }

  _finish(res, path) {
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 401 || res.status === 403) {
      throw new PtzError('auth', `Camera denied ${path} (${res.status})`, { httpStatus: res.status });
    }
    const statusString = xmlTag(res.body || '', 'statusString') || xmlTag(res.body || '', 'subStatusCode');
    throw new PtzError('error', `Camera returned ${res.status} for ${path}${statusString ? `: ${statusString}` : ''}`, { httpStatus: res.status });
  }

  // ---- watchdog / rate limit ---------------------------------------------

  _armWatchdog(camera) {
    this._disarmWatchdog(camera.id);
    const t = setTimeout(() => {
      this.watchdogs.delete(camera.id);
      this.watchdogFired += 1;
      this.logger.warn(`[PTZ] Watchdog: no refresh for ${this.watchdogMs} ms on camera ${camera.id} — sending stop`);
      this._sendStop(camera).catch((err) => this.logger.warn(`[PTZ] Watchdog stop failed for camera ${camera.id}: ${err.message}`));
    }, this.watchdogMs);
    if (typeof t.unref === 'function') t.unref();
    this.watchdogs.set(camera.id, t);
  }

  _disarmWatchdog(cameraId) {
    const t = this.watchdogs.get(cameraId);
    if (t) clearTimeout(t);
    this.watchdogs.delete(cameraId);
  }

  isMoving(cameraId) {
    return this.watchdogs.has(cameraId);
  }

  // ---- PTZ operations -----------------------------------------------------

  /** Continuous move. Values -100..100; all zeros == stop. */
  async move(camera, { pan = 0, tilt = 0, zoom = 0 } = {}, { source = 'user' } = {}) {
    const p = clampSpeed(pan), t = clampSpeed(tilt), z = clampSpeed(zoom);
    if (p === 0 && t === 0 && z === 0) return this.stop(camera, { source });
    this._noteActivity(camera.id, source, 'move');

    const now = Date.now();
    const last = this.lastMoveAt.get(camera.id) || 0;
    if (now - last < this.minMoveIntervalMs) {
      // Too fast: keep the watchdog alive (caller is clearly still holding the
      // button) but do not send another command.
      this._armWatchdog(camera);
      throw new PtzError('rate_limited', `PTZ moves are limited to ${Math.round(1000 / this.minMoveIntervalMs)}/s`);
    }
    this.lastMoveAt.set(camera.id, now);

    const body = `<PTZData><pan>${p}</pan><tilt>${t}</tilt><zoom>${z}</zoom></PTZData>`;
    this._armWatchdog(camera);
    try {
      await this.request(camera, 'PUT', '/ISAPI/PTZCtrl/channels/1/continuous', body);
    } catch (err) {
      this._disarmWatchdog(camera.id);
      throw err;
    }
    return { ok: true, pan: p, tilt: t, zoom: z, watchdogMs: this.watchdogMs };
  }

  async stop(camera, { source = 'user' } = {}) {
    this._noteActivity(camera.id, source, 'stop');
    this._disarmWatchdog(camera.id);
    await this._sendStop(camera);
    return { ok: true, pan: 0, tilt: 0, zoom: 0 };
  }

  _sendStop(camera) {
    return this.request(camera, 'PUT', '/ISAPI/PTZCtrl/channels/1/continuous',
      '<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>');
  }

  async getPresets(camera) {
    const res = await this.request(camera, 'GET', '/ISAPI/PTZCtrl/channels/1/presets');
    const presets = [];
    const re = /<PTZPreset\b[^>]*>([\s\S]*?)<\/PTZPreset>/gi;
    let m;
    while ((m = re.exec(res.body)) !== null) {
      const id = parseInt(xmlTag(m[1], 'id'), 10);
      if (!Number.isFinite(id)) continue;
      const name = xmlTag(m[1], 'presetName') || `Preset ${id}`;
      const enabled = xmlTag(m[1], 'enabled');
      presets.push({ id, name, enabled: enabled == null ? true : enabled === 'true' });
    }
    presets.sort((a, b) => a.id - b.id);
    return presets;
  }

  async gotoPreset(camera, presetId, { source = 'user' } = {}) {
    const id = this._presetId(presetId);
    this._noteActivity(camera.id, source, 'goto');
    await this.request(camera, 'PUT', `/ISAPI/PTZCtrl/channels/1/presets/${id}/goto`);
    return { ok: true, id };
  }

  /**
   * Current absolute position (GET /ISAPI/PTZCtrl/channels/1/status):
   * { elevation, azimuth, zoom } in the camera's native units (0.1 deg / 0.1x), or
   * null when the camera does not report AbsoluteHigh. Throws PtzError (auth, unreachable).
   */
  async getPosition(camera) {
    const res = await this.request(camera, 'GET', '/ISAPI/PTZCtrl/channels/1/status', null, { timeoutMs: this.statusTimeoutMs });
    const xml = res.body || '';
    const elevation = parseInt(xmlTag(xml, 'elevation'), 10);
    const azimuth = parseInt(xmlTag(xml, 'azimuth'), 10);
    const zoom = parseInt(xmlTag(xml, 'absoluteZoom'), 10);
    if (![elevation, azimuth, zoom].every(Number.isFinite)) return null;
    return { elevation, azimuth, zoom };
  }

  /** Absolute move to a position from getPosition() (used to put the camera back). */
  async gotoAbsolute(camera, pos, { source = 'user' } = {}) {
    const n = (v) => Math.round(Number(v));
    if (!pos || ![pos.elevation, pos.azimuth, pos.zoom].every(v => Number.isFinite(Number(v)))) {
      throw new PtzError('error', 'Absolute position needs elevation, azimuth and zoom', { httpStatus: 400 });
    }
    this._noteActivity(camera.id, source, 'absolute');
    const body = `<PTZData><AbsoluteHigh><elevation>${n(pos.elevation)}</elevation><azimuth>${n(pos.azimuth)}</azimuth><absoluteZoom>${n(pos.zoom)}</absoluteZoom></AbsoluteHigh></PTZData>`;
    await this.request(camera, 'PUT', '/ISAPI/PTZCtrl/channels/1/absolute', body);
    return { ok: true, ...pos };
  }

  async savePreset(camera, presetId, name) {
    const id = this._presetId(presetId);
    const presetName = String(name || `Preset ${id}`).trim().slice(0, 32) || `Preset ${id}`;
    const body = `<PTZPreset><id>${id}</id><presetName>${xmlEscape(presetName)}</presetName></PTZPreset>`;
    await this.request(camera, 'PUT', `/ISAPI/PTZCtrl/channels/1/presets/${id}`, body);
    return { ok: true, id, name: presetName };
  }

  async deletePreset(camera, presetId) {
    const id = this._presetId(presetId);
    await this.request(camera, 'DELETE', `/ISAPI/PTZCtrl/channels/1/presets/${id}`);
    return { ok: true, id };
  }

  _presetId(v) {
    const id = parseInt(v, 10);
    if (!Number.isFinite(id) || id < 1 || id > 300) throw new PtzError('error', 'Preset id must be an integer between 1 and 300', { httpStatus: 400 });
    return id;
  }

  async getCapabilities(camera) {
    const cached = this.capsCache.get(camera.id);
    if (cached && Date.now() - cached.at < CAPS_TTL_MS) return cached.caps;
    let caps = { zoom: true, presets: true, continuous: true, known: false };
    try {
      const res = await this.request(camera, 'GET', '/ISAPI/PTZCtrl/channels/1/capabilities');
      const xml = res.body || '';
      caps = {
        known: true,
        continuous: /<ContinuousPanTiltSpace\b/i.test(xml) || /<continuous/i.test(xml),
        zoom: /<ContinuousZoomSpace\b/i.test(xml) || /<zoom\b/i.test(xml),
        presets: /preset/i.test(xml),
      };
      this.capsCache.set(camera.id, { caps, at: Date.now() });
    } catch (err) {
      if (err.status === 'unreachable' || err.status === 'auth') throw err;
      // Unknown/unsupported capabilities endpoint — assume full support.
    }
    return caps;
  }

  /** Reachability + identity probe (2 s). Returns an info object, throws PtzError otherwise. */
  async getStatus(camera) {
    const res = await this.request(camera, 'GET', '/ISAPI/System/deviceInfo', null, { timeoutMs: this.statusTimeoutMs });
    const xml = res.body || '';
    const info = {
      status: 'online',
      model: xmlTag(xml, 'model'),
      firmware: xmlTag(xml, 'firmwareVersion'),
      serial: xmlTag(xml, 'serialNumber'),
      deviceName: xmlTag(xml, 'deviceName'),
      moving: this.isMoving(camera.id),
      busy: this.getBusy(camera.id),
    };
    try {
      info.capabilities = await this.getCapabilities(camera);
    } catch {
      info.capabilities = { zoom: true, presets: true, continuous: true, known: false };
    }
    return info;
  }

  /** Cancel timers (tests / shutdown). */
  dispose() {
    for (const id of [...this.watchdogs.keys()]) this._disarmWatchdog(id);
  }
}

const ptzService = new PtzService();

module.exports = {
  PtzService,
  PtzError,
  ptzService,
  computeDigestResponse,
  parseAuthHeader,
  buildDigestHeader,
};
