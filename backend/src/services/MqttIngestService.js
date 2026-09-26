/**
 * MqttIngestService — subscribes to the local Mosquitto broker and ingests
 * irrigation-monitor telemetry (farm/<farmId>/...) into SenseHub.
 *
 * READ-ONLY TELEMETRY. This service never publishes to a device topic and never
 * touches a relay, coil or setpoint. Its only writes are to SQLite
 * (equipment row, readings, irrigation_cycles, mqtt_monitors) and alerts.
 *
 * Modelling: one equipment row per farm id ("Irrigation Monitor <id>",
 * protocol 'mqtt', address 'farm/<id>/#'), auto-provisioned on the first valid
 * message and remembered in mqtt_monitors so restarts never duplicate it. The
 * device has ONE connection, ONE LWT and ONE online state, so flow and dosing
 * metrics live on the same equipment row, exactly like a multi-metric Modbus
 * sensor (last_reading = { values: { name: {value, unit} } }, readings.name).
 *
 * Liveness: only NON-retained messages count as the device talking. Retained
 * status/state/report/meta are re-delivered on every (re)subscribe and prove
 * nothing about the present. Equipment status is derived by effectiveStatus():
 * no live data for 60 s => 'offline' (even if the last status said online).
 * The sustained-offline alert is the existing WatchdogService path (status
 * offline + last_communication > 5 min => createAlert fingerprint
 * `equipment_offline:<id>`, Telegram, "recovered" notice), so there is exactly
 * one offline alert per device, not two. Non-zero flow-meter error_flags raise a
 * fingerprinted alert once per distinct value.
 *
 * Disk: readings are downsampled (MqttDownsampler); full-rate values stay in
 * memory and go out over WebSocket at most 1 Hz per monitor.
 */

const os = require('os');
const P = require('./MqttPayloads');
const { Downsampler, effectiveStatus, STALE_AFTER_MS } = require('./MqttDownsampler');

const SUBSCRIBE_TOPIC = 'farm/+/#';
const TICK_MS = 1000;
const EQUIPMENT_WRITE_MS = 5000;     // equipment row (last_reading/last_communication) at most every 5 s
const BROADCAST_MS = 1000;           // WebSocket live push at most 1 Hz per monitor
const ENABLED_REFRESH_MS = 30000;    // re-read equipment.enabled / existence
const LOG_WINDOW_MS = 10 * 60 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const POLL_INTERVAL_HINT_MS = 30000; // equipment.polling_interval_ms: UI renders stale after 2x = 60 s

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function parseDbTs(s) {
  if (!s) return null;
  const str = String(s);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

class MqttIngestService {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {Function} [deps.createAlert]   utils/alertBroadcast createAlert
   * @param {Function} [deps.broadcast]     (type, data) => void; defaults to global.broadcast
   * @param {Function} [deps.now]           () => epoch ms
   * @param {object}   [deps.logger]        console-like
   * @param {Function} [deps.connect]       mqtt.connect-compatible factory
   * @param {object}   [deps.config]        { url, username, password, clientId, enabled }
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.createAlert = deps.createAlert || (() => null);
    this._broadcast = deps.broadcast || null;
    this.now = deps.now || (() => Date.now());
    this.log = deps.logger || console;
    this.connectFn = deps.connect || null;
    const env = process.env;
    this.config = {
      enabled: env.MQTT_ENABLED !== 'false',
      url: env.MQTT_URL || 'mqtt://127.0.0.1:1883',
      username: env.MQTT_USERNAME || 'sensehub',
      password: env.MQTT_PASSWORD || '',
      clientId: env.MQTT_CLIENT_ID || `sensehub-backend-${os.hostname()}`,
      ...(deps.config || {}),
    };

    this.downsampler = new Downsampler(deps.downsampler || {});
    this.monitors = new Map(); // farmId -> monitor state
    this.client = null;
    this.timer = null;
    this._logSeen = new Map();
    this._reconnectDelay = RECONNECT_MIN_MS;
    this.health = {
      connected: false,
      subscribed: false,
      connectedSince: null,
      lastConnectAt: null,
      lastDisconnectAt: null,
      lastError: null,
      lastErrorAt: null,
      reconnects: 0,
      lastMessageAt: null,
      messages: { received: 0, accepted: 0, rejected: 0, ignored: 0, replayed: 0, byKind: {} },
      readingsWritten: 0,
      tsFallbacks: 0,
    };
    this._stmts = null;
    this._liveListeners = new Set();
  }

  /**
   * Subscribe to the full-rate LIVE stream (flowmeter / dosing / irrigation
   * state), i.e. every accepted non-retained sample before downsampling. Used by
   * the irrigation flow watch. Listener errors are caught and never break
   * ingest. Returns an unsubscribe function.
   *
   * Event: { kind: 'flowmeter'|'dosing'|'irrigation_state', farmId, equipmentId,
   *          receivedMs, tsMs, live, values? , tanks?, active?, since? }
   */
  onLive(fn) {
    this._liveListeners.add(fn);
    return () => this._liveListeners.delete(fn);
  }

  _emitLive(evt) {
    for (const fn of this._liveListeners) {
      try { fn(evt); } catch (e) {
        this._logLimited(`live:${e.message}`, `[MQTT] live listener failed: ${e.message}`);
      }
    }
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start() {
    this._loadState();
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.tick(); } catch (e) { this._logLimited('tick', `[MQTT] tick failed: ${e.message}`); }
      }, TICK_MS);
      if (this.timer.unref) this.timer.unref();
    }
    if (!this.config.enabled) {
      this.log.log('[MQTT] Ingest disabled (MQTT_ENABLED=false)');
      return;
    }
    if (!this.config.password) {
      this.log.warn('[MQTT] MQTT_PASSWORD not set — connecting without a password will be refused by the broker');
    }
    const connect = this.connectFn || require('mqtt').connect;
    this.client = connect(this.config.url, {
      username: this.config.username,
      password: this.config.password || undefined,
      clientId: this.config.clientId,
      clean: true,
      keepalive: 30,
      connectTimeout: 10000,
      reconnectPeriod: RECONNECT_MIN_MS,
      protocolVersion: 4,
    });
    this.client.on('connect', () => this._onConnect());
    this.client.on('reconnect', () => { this.health.reconnects++; });
    this.client.on('close', () => this._onClose());
    this.client.on('error', (err) => this._onError(err));
    this.client.on('message', (topic, payload, packet) => {
      try { this.handleMessage(topic, payload, packet); } catch (e) {
        this._logLimited(`handle:${e.message}`, `[MQTT] message handler failed on ${topic}: ${e.message}`);
      }
    });
    this.log.log(`[MQTT] Connecting to ${this._safeUrl()} as ${this.config.username}`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.client) {
      try { this.client.end(true); } catch (_) { /* ignore */ }
      this.client = null;
    }
    this.health.connected = false;
  }

  _safeUrl() {
    try {
      const u = new URL(this.config.url);
      u.username = ''; u.password = '';
      return u.toString().replace(/\/$/, '');
    } catch (_) { return 'mqtt://(invalid url)'; }
  }

  _onConnect() {
    const was = this.health.lastDisconnectAt;
    this.health.connected = true;
    this.health.connectedSince = iso(this.now());
    this.health.lastConnectAt = this.health.connectedSince;
    this.health.lastError = null;
    this._reconnectDelay = RECONNECT_MIN_MS;
    if (this.client && this.client.options) this.client.options.reconnectPeriod = RECONNECT_MIN_MS;
    this.client.subscribe(SUBSCRIBE_TOPIC, { qos: 1 }, (err) => {
      if (err) {
        this.health.subscribed = false;
        this.health.lastError = `subscribe failed: ${err.message}`;
        this.log.error(`[MQTT] Subscribe ${SUBSCRIBE_TOPIC} failed: ${err.message}`);
      } else {
        this.health.subscribed = true;
        this.log.log(`[MQTT] Connected to ${this._safeUrl()}, subscribed ${SUBSCRIBE_TOPIC}${was ? ' (reconnected)' : ''}`);
      }
    });
  }

  _onClose() {
    const wasConnected = this.health.connected;
    this.health.connected = false;
    this.health.subscribed = false;
    if (wasConnected) {
      this.health.lastDisconnectAt = iso(this.now());
      this.log.warn(`[MQTT] Disconnected from ${this._safeUrl()}; reconnecting with backoff`);
    }
    // Exponential backoff: mqtt.js reads options.reconnectPeriod when it schedules the next attempt.
    if (this.client && this.client.options) {
      this.client.options.reconnectPeriod = this._reconnectDelay;
      this._reconnectDelay = Math.min(RECONNECT_MAX_MS, this._reconnectDelay * 2);
    }
  }

  _onError(err) {
    const msg = (err && err.message) || String(err);
    this.health.lastError = msg;
    this.health.lastErrorAt = iso(this.now());
    this._logLimited(`err:${msg}`, `[MQTT] ${msg}`);
  }

  _logLimited(key, msg, level = 'warn') {
    const now = this.now();
    const last = this._logSeen.get(key);
    if (last && now - last < LOG_WINDOW_MS) return;
    this._logSeen.set(key, now);
    if (this._logSeen.size > 500) this._logSeen.clear();
    (this.log[level] || this.log.log).call(this.log, msg);
  }

  _emit(type, data) {
    try {
      const b = this._broadcast || global.broadcast;
      if (b) b(type, data);
    } catch (e) { /* a broadcast failure never breaks ingest */ }
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  get stmts() {
    if (this._stmts) return this._stmts;
    const db = this.db;
    this._stmts = {
      insertReading: db.prepare('INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (?, ?, ?, ?, ?)'),
      getMonitorRow: db.prepare('SELECT * FROM mqtt_monitors WHERE farm_id = ?'),
      getEquipment: db.prepare('SELECT id, name, enabled, last_communication FROM equipment WHERE id = ?'),
      findEquipmentByAddress: db.prepare("SELECT id FROM equipment WHERE protocol = 'mqtt' AND address = ? ORDER BY id LIMIT 1"),
      insertEquipment: db.prepare(`
        INSERT INTO equipment (name, description, type, protocol, address, status, enabled, polling_interval_ms, created_at, updated_at)
        VALUES (?, ?, 'sensor', 'mqtt', ?, 'offline', 1, ?, datetime('now'), datetime('now'))
      `),
      upsertMonitor: db.prepare(`
        INSERT INTO mqtt_monitors (farm_id, equipment_id, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(farm_id) DO UPDATE SET equipment_id = excluded.equipment_id, updated_at = datetime('now')
      `),
      setBrokerState: db.prepare("UPDATE mqtt_monitors SET broker_state = ?, broker_state_at = ?, updated_at = datetime('now') WHERE farm_id = ?"),
      setMeta: db.prepare("UPDATE mqtt_monitors SET meta_json = ?, meta_received_at = ?, updated_at = datetime('now') WHERE farm_id = ?"),
      setIrrigation: db.prepare("UPDATE mqtt_monitors SET irrigation_active = ?, irrigation_since = ?, irrigation_state_ts = ?, updated_at = datetime('now') WHERE farm_id = ?"),
      setErrorFlags: db.prepare("UPDATE mqtt_monitors SET last_error_flags = ?, updated_at = datetime('now') WHERE farm_id = ?"),
      updateEquipmentLive: db.prepare('UPDATE equipment SET status = ?, last_reading = ?, last_communication = ?, updated_at = ? WHERE id = ?'),
      updateEquipmentStatus: db.prepare('UPDATE equipment SET status = ?, updated_at = ? WHERE id = ?'),
      upsertCycle: db.prepare(`
        INSERT INTO irrigation_cycles
          (farm_id, equipment_id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json, raw_payload, received_at)
        VALUES (@farm_id, @equipment_id, @cycle_id, @start_time, @end_time, @duration_s, @water_m3, @dosing_json, @raw_payload, @received_at)
        ON CONFLICT(farm_id, cycle_id) DO UPDATE SET
          start_time = excluded.start_time, end_time = excluded.end_time, duration_s = excluded.duration_s,
          water_m3 = excluded.water_m3, dosing_json = excluded.dosing_json, raw_payload = excluded.raw_payload,
          equipment_id = COALESCE(irrigation_cycles.equipment_id, excluded.equipment_id),
          updated_at = excluded.received_at
        WHERE irrigation_cycles.raw_payload IS NOT excluded.raw_payload
      `),
      getCycle: db.prepare('SELECT * FROM irrigation_cycles WHERE farm_id = ? AND cycle_id = ?'),
    };
    return this._stmts;
  }

  /** Rehydrate per-farm state from mqtt_monitors + equipment so restarts don't lose context. */
  _loadState() {
    let rows = [];
    try { rows = this.db.prepare('SELECT * FROM mqtt_monitors').all(); } catch (e) {
      this.log.error(`[MQTT] Failed to load monitor state: ${e.message}`);
      return;
    }
    for (const r of rows) {
      const m = this._blankMonitor(r.farm_id);
      m.equipmentId = r.equipment_id || null;
      if (m.equipmentId) {
        const eq = this.stmts.getEquipment.get(m.equipmentId);
        if (eq) {
          m.name = eq.name;
          m.enabled = !!eq.enabled;
          m.lastLiveMs = parseDbTs(eq.last_communication);
        } else {
          m.equipmentId = null;
        }
      }
      m.brokerState = r.broker_state || null;
      m.brokerStateMs = parseDbTs(r.broker_state_at);
      if (r.meta_json) m.meta = { json: r.meta_json, receivedMs: parseDbTs(r.meta_received_at) };
      if (r.irrigation_active !== null && r.irrigation_active !== undefined) {
        m.irrigation = { active: !!r.irrigation_active, since: r.irrigation_since || null, tsMs: parseDbTs(r.irrigation_state_ts), live: false };
      }
      m.lastAlertedErrorFlags = r.last_error_flags || 0;
      m.status = null; // force a status evaluation on the first tick
      this.monitors.set(r.farm_id, m);
    }
  }

  _blankMonitor(farmId) {
    return {
      farmId,
      equipmentId: null,
      name: `Irrigation Monitor ${farmId}`,
      enabled: true,
      enabledCheckedMs: 0,
      brokerState: null,
      brokerStateMs: null,
      lastLiveMs: null,
      flow: null,
      dosing: null,
      irrigation: null,
      meta: null,
      errorFlags: 0,
      lastAlertedErrorFlags: 0,
      status: null,
      dirtyWrite: false,
      dirtyBroadcast: false,
      lastEquipmentWriteMs: 0,
      lastBroadcastMs: 0,
      counts: { messages: 0, rejected: 0, readings: 0 },
    };
  }

  /**
   * The monitor state for a farm id, provisioning the equipment row on first
   * sight. Idempotent: mqtt_monitors remembers the equipment id, and an orphaned
   * equipment row with the same address is re-adopted instead of duplicated.
   */
  _ensureMonitor(farmId) {
    let m = this.monitors.get(farmId);
    if (!m) {
      m = this._blankMonitor(farmId);
      this.monitors.set(farmId, m);
    }
    if (m.equipmentId) return m;

    const address = `farm/${farmId}/#`;
    const tx = this.db.transaction(() => {
      const row = this.stmts.getMonitorRow.get(farmId);
      if (row && row.equipment_id && this.stmts.getEquipment.get(row.equipment_id)) return { id: row.equipment_id, created: false };
      const existing = this.stmts.findEquipmentByAddress.get(address);
      if (existing) {
        this.stmts.upsertMonitor.run(farmId, existing.id);
        return { id: existing.id, created: false };
      }
      const info = this.stmts.insertEquipment.run(
        m.name,
        `Irrigation monitor (ultrasonic flow meter + dosing counters) on MQTT ${address}. Auto-provisioned by the MQTT ingest; read-only telemetry, nothing here can actuate.`,
        address,
        POLL_INTERVAL_HINT_MS,
      );
      const id = Number(info.lastInsertRowid);
      this.stmts.upsertMonitor.run(farmId, id);
      return { id, created: true };
    });
    const { id, created } = tx();
    m.equipmentId = id;
    const eq = this.stmts.getEquipment.get(id);
    if (eq) { m.name = eq.name; m.enabled = !!eq.enabled; }
    m.enabledCheckedMs = this.now();
    if (created) {
      this.log.log(`[MQTT] Provisioned equipment #${id} "${m.name}" for farm/${farmId}`);
      try {
        const full = this.db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
        this._emit('equipment_created', full);
      } catch (_) { /* ignore */ }
    } else {
      this.log.log(`[MQTT] farm/${farmId} -> equipment #${id} "${m.name}"`);
    }
    return m;
  }

  // ─── message handling ────────────────────────────────────────────────────

  /**
   * Handle one MQTT message. `packet.retain` is true for retained messages the
   * broker replays on subscribe; those never count as liveness.
   */
  handleMessage(topic, payload, packet = {}) {
    const h = this.health;
    h.messages.received++;
    const t = P.parseTopic(topic);
    if (!t) { h.messages.ignored++; return { ok: false, reason: 'ignored_topic' }; }
    const receivedMs = this.now();
    const live = !packet.retain;
    if (!live) h.messages.replayed++;

    let obj;
    try {
      obj = P.parseEnvelope(payload);
    } catch (e) {
      return this._reject(t, e, topic);
    }

    let m;
    try {
      m = this._ensureMonitor(t.farmId);
    } catch (e) {
      this._logLimited(`prov:${t.farmId}`, `[MQTT] Could not provision farm/${t.farmId}: ${e.message}`, 'error');
      return { ok: false, reason: 'provision_failed' };
    }
    m.counts.messages++;
    h.lastMessageAt = iso(receivedMs);
    h.messages.byKind[t.kind] = (h.messages.byKind[t.kind] || 0) + 1;

    let result;
    try {
      switch (t.kind) {
        case 'status': result = this._onStatus(m, obj, receivedMs, live); break;
        case 'meta': result = this._onMeta(m, payload, receivedMs); break;
        case 'flowmeter': result = this._onFlowmeter(m, obj, receivedMs, live); break;
        case 'dosing': result = this._onDosing(m, obj, receivedMs, live); break;
        case 'irrigation_state': result = this._onIrrigationState(m, obj, receivedMs, live); break;
        case 'irrigation_report': result = this._onReport(m, obj, payload, receivedMs); break;
        default: result = { ok: false, reason: 'unknown_kind' };
      }
    } catch (e) {
      if (e instanceof P.PayloadError) { m.counts.rejected++; return this._reject(t, e, topic); }
      throw e;
    }
    h.messages.accepted++;
    this._refresh(m, receivedMs);
    return result;
  }

  _reject(t, e, topic) {
    this.health.messages.rejected++;
    const code = e.code || 'error';
    // One log line per farm/kind/reason per 10 min — never per message.
    this._logLimited(`rej:${t.farmId}:${t.kind}:${code}:${code === 'bad_version' ? e.message : ''}`,
      `[MQTT] Ignored ${topic}: ${e.message}`);
    return { ok: false, reason: code };
  }

  _onStatus(m, obj, receivedMs, live) {
    const { state } = P.parseStatus(obj);
    const changed = m.brokerState !== state;
    m.brokerState = state;
    // A replayed retained status is old news; its time is "no later than now".
    // Keep the stored time if the state is unchanged so a replay can't make an
    // old LWT look newer than live data we already have.
    if (changed || live) m.brokerStateMs = receivedMs;
    this.stmts.setBrokerState.run(state, iso(m.brokerStateMs), m.farmId);
    if (changed && live) this.log.log(`[MQTT] farm/${m.farmId} reports ${state}`);
    this._touch(m);
    return { ok: true, kind: 'status', state };
  }

  _onMeta(m, payload, receivedMs) {
    const json = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    if (!m.meta || m.meta.json !== json) {
      m.meta = { json, receivedMs };
      this.stmts.setMeta.run(json, iso(receivedMs), m.farmId);
    }
    return { ok: true, kind: 'meta' };
  }

  _isActive(m) {
    if (m.irrigation && typeof m.irrigation.active === 'boolean') return m.irrigation.active;
    return !!(m.flow && m.flow.values.flow_lph > 0);
  }

  _ts(obj, receivedMs) {
    const ts = P.pickTimestamp(obj, receivedMs);
    if (ts.source === 'receive' && obj.ts !== undefined) this.health.tsFallbacks++;
    return ts;
  }

  _record(m, metrics, tsMs, active) {
    if (!m.enabled || !m.equipmentId || metrics.length === 0) return 0;
    const rows = this.downsampler.filter(m.equipmentId, metrics, tsMs, active);
    if (rows.length === 0) return 0;
    const at = iso(tsMs);
    const ins = this.stmts.insertReading;
    this.db.transaction(() => {
      for (const r of rows) ins.run(m.equipmentId, r.name, r.value, r.unit, at);
    })();
    m.counts.readings += rows.length;
    this.health.readingsWritten += rows.length;
    return rows.length;
  }

  _onFlowmeter(m, obj, receivedMs, live) {
    const { values, invalid } = P.parseFlowmeter(obj);
    if (invalid.length) this._logLimited(`inv:${m.farmId}:flow:${invalid.join(',')}`, `[MQTT] farm/${m.farmId} flowmeter: dropped invalid field(s) ${invalid.join(', ')}`);
    if (!live) return { ok: true, kind: 'flowmeter', replay: true, recorded: 0 };
    const ts = this._ts(obj, receivedMs);
    m.lastLiveMs = receivedMs;
    m.flow = { values, tsMs: ts.ms, tsSource: ts.source, receivedMs };
    if ('error_flags' in values) this._onErrorFlags(m, values.error_flags);
    const recorded = this._record(m, P.flowmeterMetrics(values), ts.ms, this._isActive(m));
    this._touch(m);
    this._emitLive({ kind: 'flowmeter', farmId: m.farmId, equipmentId: m.equipmentId, receivedMs, tsMs: ts.ms, live, values });
    return { ok: true, kind: 'flowmeter', recorded };
  }

  _onDosing(m, obj, receivedMs, live) {
    const { tanks, invalid } = P.parseDosing(obj);
    if (invalid.length) this._logLimited(`inv:${m.farmId}:dosing:${invalid.join(',')}`, `[MQTT] farm/${m.farmId} dosing: dropped invalid field(s) ${invalid.join(', ')}`);
    if (!live) return { ok: true, kind: 'dosing', replay: true, recorded: 0 };
    const ts = this._ts(obj, receivedMs);
    m.lastLiveMs = receivedMs;
    m.dosing = { tanks, tsMs: ts.ms, tsSource: ts.source, receivedMs };
    const recorded = this._record(m, P.dosingMetrics(tanks), ts.ms, this._isActive(m));
    this._touch(m);
    this._emitLive({ kind: 'dosing', farmId: m.farmId, equipmentId: m.equipmentId, receivedMs, tsMs: ts.ms, live, tanks });
    return { ok: true, kind: 'dosing', recorded };
  }

  _onIrrigationState(m, obj, receivedMs, live) {
    const { active, since } = P.parseIrrigationState(obj);
    const prev = m.irrigation ? m.irrigation.active : null;
    const changed = prev === null || prev !== active;
    // Device time is honest for a state change even if the message is a late
    // retained replay; fall back to receive time only when ts is absent/absurd.
    let tsMs = receivedMs;
    if (typeof obj.ts === 'number' && Number.isFinite(obj.ts) && obj.ts <= receivedMs + P.TS_MAX_FUTURE_MS && obj.ts > 0) tsMs = Math.round(obj.ts);
    if (live) m.lastLiveMs = receivedMs;
    m.irrigation = { active, since, tsMs, live };
    this.stmts.setIrrigation.run(active ? 1 : 0, since, iso(tsMs), m.farmId);

    let recorded = 0;
    if (changed) {
      if (prev !== null) {
        this.log.log(`[MQTT] farm/${m.farmId} irrigation ${active ? 'started' : 'stopped'}${live ? '' : ' (seen on replay)'}`);
        // Bracket the transition in history: next sample of every metric is stored.
        if (m.equipmentId) this.downsampler.forceAll(m.equipmentId);
      }
      recorded = this._record(m, [{ name: 'Irrigation Active', value: active ? 1 : 0, unit: '' }], tsMs, active);
    } else if (live) {
      recorded = this._record(m, [{ name: 'Irrigation Active', value: active ? 1 : 0, unit: '' }], tsMs, active);
    }
    this._touch(m);
    this._emitLive({ kind: 'irrigation_state', farmId: m.farmId, equipmentId: m.equipmentId, receivedMs, tsMs, live, active, since });
    return { ok: true, kind: 'irrigation_state', changed, recorded };
  }

  _onReport(m, obj, payload, receivedMs) {
    const r = P.parseReport(obj);
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    const info = this.stmts.upsertCycle.run({
      farm_id: m.farmId,
      equipment_id: m.equipmentId,
      cycle_id: r.cycle_id,
      start_time: r.start,
      end_time: r.end,
      duration_s: r.duration_s,
      water_m3: r.water_m3,
      dosing_json: JSON.stringify(r.dosing),
      raw_payload: raw,
      received_at: iso(receivedMs),
    });
    const row = this.stmts.getCycle.get(m.farmId, r.cycle_id);
    let outcome = 'unchanged';
    if (info.changes > 0) outcome = row && row.updated_at ? 'updated' : 'inserted';
    if (outcome !== 'unchanged') {
      this.log.log(`[MQTT] farm/${m.farmId} irrigation cycle ${r.cycle_id} ${outcome} (${r.duration_s}s, water ${r.water_m3 ?? 'n/a'} m³)`);
      this._emit('irrigation_cycle', this.formatCycle(row));
    }
    return { ok: true, kind: 'irrigation_report', outcome, cycle_id: r.cycle_id };
  }

  _onErrorFlags(m, flags) {
    m.errorFlags = flags;
    if (flags !== 0 && flags !== m.lastAlertedErrorFlags) {
      m.lastAlertedErrorFlags = flags;
      this.stmts.setErrorFlags.run(flags, m.farmId);
      this.log.warn(`[MQTT] farm/${m.farmId} flow meter error_flags=${flags}`);
      this.createAlert({
        severity: 'warning',
        source: 'mqtt_ingest',
        equipment_id: m.equipmentId,
        fingerprint: `mqtt_error_flags:${m.equipmentId}:${flags}`,
        message: `${m.name}: flow meter reports error_flags=${flags} (0x${flags.toString(16).toUpperCase()}). Flow readings may be unreliable until it clears.`,
      });
    } else if (flags === 0 && m.lastAlertedErrorFlags !== 0) {
      this.log.log(`[MQTT] farm/${m.farmId} flow meter error_flags cleared (was ${m.lastAlertedErrorFlags})`);
      m.lastAlertedErrorFlags = 0;
      this.stmts.setErrorFlags.run(0, m.farmId);
    }
  }

  // ─── status / equipment row / broadcast ──────────────────────────────────

  _touch(m) {
    m.dirtyWrite = true;
    m.dirtyBroadcast = true;
  }

  _statusOf(m, nowMs) {
    return effectiveStatus({
      lastLiveMs: m.lastLiveMs,
      brokerState: m.brokerState,
      brokerStateMs: m.brokerStateMs,
      errorFlags: m.errorFlags,
    }, nowMs);
  }

  _lastReading(m) {
    const values = {};
    if (m.flow) Object.assign(values, P.flowmeterDisplayValues(m.flow.values));
    if (m.dosing) for (const r of P.dosingMetrics(m.dosing.tanks)) values[r.name] = { value: r.value, unit: r.unit };
    if (m.irrigation) values['Irrigation Active'] = { value: m.irrigation.active ? 1 : 0, unit: '' };
    return JSON.stringify({ values, source: 'mqtt', farm_id: m.farmId });
  }

  /**
   * Re-evaluate status; write the equipment row on a status change immediately,
   * otherwise at most every EQUIPMENT_WRITE_MS; broadcast at most every BROADCAST_MS.
   */
  _refresh(m, nowMs) {
    if (!m.equipmentId) return;
    const status = this._statusOf(m, nowMs);
    const statusChanged = status !== m.status;
    const writeDue = m.dirtyWrite && nowMs - m.lastEquipmentWriteMs >= EQUIPMENT_WRITE_MS;
    if (statusChanged || writeDue) {
      const at = iso(nowMs);
      if (m.enabled) {
        if (m.lastLiveMs !== null) {
          this.stmts.updateEquipmentLive.run(status, this._lastReading(m), iso(m.lastLiveMs), at, m.equipmentId);
        } else {
          this.stmts.updateEquipmentStatus.run(status, at, m.equipmentId);
        }
      }
      m.lastEquipmentWriteMs = nowMs;
      m.dirtyWrite = false;
      if (statusChanged && m.enabled) {
        if (m.status !== null) this.log.log(`[MQTT] ${m.name} (#${m.equipmentId}) ${m.status} -> ${status}`);
        this._emit('equipment_status', {
          id: m.equipmentId, equipmentId: m.equipmentId, name: m.name, status,
          last_reading: m.lastLiveMs !== null ? this._lastReading(m) : null, timestamp: at,
        });
      }
    }
    m.status = status;
    if (m.dirtyBroadcast && nowMs - m.lastBroadcastMs >= BROADCAST_MS) {
      m.lastBroadcastMs = nowMs;
      m.dirtyBroadcast = false;
      if (m.enabled && m.lastLiveMs !== null && nowMs - m.lastLiveMs <= STALE_AFTER_MS) {
        this._emit('equipment_reading', {
          equipmentId: m.equipmentId, equipment_id: m.equipmentId, name: m.name, status,
          lastReading: this._lastReading(m), timestamp: iso(m.lastLiveMs),
        });
      }
      this._emit('irrigation_monitor_live', this.snapshot(m, nowMs));
    }
  }

  /** Periodic: staleness, deferred writes/broadcasts, equipment enabled/deleted refresh. */
  tick(nowMs = this.now()) {
    for (const m of this.monitors.values()) {
      if (m.equipmentId && nowMs - m.enabledCheckedMs >= ENABLED_REFRESH_MS) {
        m.enabledCheckedMs = nowMs;
        const eq = this.stmts.getEquipment.get(m.equipmentId);
        if (!eq) {
          // Operator deleted it: forget the monitor entirely (memory + mqtt_monitors).
          // Cycle reports stay (equipment_id -> NULL). The next message re-provisions.
          this.log.log(`[MQTT] Equipment #${m.equipmentId} for farm/${m.farmId} was deleted; monitor forgotten (re-provisions on next message)`);
          this.forgetMonitor(m.farmId);
          continue;
        }
        m.enabled = !!eq.enabled;
        m.name = eq.name;
      }
      this._refresh(m, nowMs);
    }
  }

  /** Drop all state for a farm id (in-memory, downsampler, mqtt_monitors row). */
  forgetMonitor(farmId) {
    const m = this.monitors.get(farmId);
    if (m && m.equipmentId) {
      for (const key of [...this.downsampler.last.keys()]) {
        if (key.startsWith(`${m.equipmentId}|`)) { this.downsampler.last.delete(key); this.downsampler.forced.delete(key); }
      }
    }
    this.monitors.delete(farmId);
    try { this.db.prepare('DELETE FROM mqtt_monitors WHERE farm_id = ?').run(farmId); } catch (e) {
      this.log.error(`[MQTT] Failed to forget farm/${farmId}: ${e.message}`);
    }
  }

  // ─── read API ─────────────────────────────────────────────────────────────

  snapshot(m, nowMs = this.now()) {
    const status = m.equipmentId ? this._statusOf(m, nowMs) : 'offline';
    let meta = null;
    if (m.meta) { try { meta = JSON.parse(m.meta.json); } catch (_) { meta = null; } }
    const ageS = m.lastLiveMs === null ? null : Math.max(0, Math.round((nowMs - m.lastLiveMs) / 1000));
    return {
      farm_id: m.farmId,
      equipment_id: m.equipmentId,
      name: m.name,
      enabled: m.enabled,
      status,
      stale: m.lastLiveMs === null || nowMs - m.lastLiveMs > STALE_AFTER_MS,
      last_seen: iso(m.lastLiveMs),
      age_s: ageS,
      broker_state: m.brokerState,
      broker_state_at: iso(m.brokerStateMs),
      error_flags: m.flow && 'error_flags' in m.flow.values ? m.flow.values.error_flags : null,
      irrigation: m.irrigation ? { active: m.irrigation.active, since: m.irrigation.since, ts: iso(m.irrigation.tsMs) } : null,
      flowmeter: m.flow ? { ...m.flow.values, ts: iso(m.flow.tsMs), ts_source: m.flow.tsSource, received_at: iso(m.flow.receivedMs) } : null,
      dosing: m.dosing ? { tanks: m.dosing.tanks, ts: iso(m.dosing.tsMs), ts_source: m.dosing.tsSource, received_at: iso(m.dosing.receivedMs) } : null,
      meta,
      meta_received_at: m.meta ? iso(m.meta.receivedMs) : null,
      counts: { ...m.counts },
    };
  }

  getSnapshots(nowMs = this.now()) {
    return [...this.monitors.values()]
      .sort((a, b) => String(a.farmId).localeCompare(String(b.farmId)))
      .map(m => this.snapshot(m, nowMs));
  }

  getSnapshot(farmId, nowMs = this.now()) {
    const m = this.monitors.get(String(farmId));
    return m ? this.snapshot(m, nowMs) : null;
  }

  getHealth() {
    return {
      enabled: this.config.enabled,
      url: this._safeUrl(),
      username: this.config.username,
      client_id: this.config.clientId,
      subscription: SUBSCRIBE_TOPIC,
      connected: this.health.connected,
      subscribed: this.health.subscribed,
      connected_since: this.health.connected ? this.health.connectedSince : null,
      last_connect_at: this.health.lastConnectAt,
      last_disconnect_at: this.health.lastDisconnectAt,
      last_error: this.health.lastError,
      last_error_at: this.health.lastErrorAt,
      reconnect_attempts: this.health.reconnects,
      last_message_at: this.health.lastMessageAt,
      messages: { ...this.health.messages, byKind: { ...this.health.messages.byKind } },
      readings_written: this.health.readingsWritten,
      device_ts_fallbacks: this.health.tsFallbacks,
      monitors: this.monitors.size,
    };
  }

  formatCycle(row) {
    if (!row) return null;
    let dosing = [];
    try { dosing = JSON.parse(row.dosing_json); } catch (_) { dosing = []; }
    return {
      id: row.id,
      farm_id: row.farm_id,
      equipment_id: row.equipment_id,
      cycle_id: row.cycle_id,
      start: row.start_time,
      end: row.end_time,
      duration_s: row.duration_s,
      water_m3: row.water_m3,
      dosing,
      received_at: row.received_at,
      updated_at: row.updated_at || null,
    };
  }
}

let singleton = null;
function getMqttIngestService() {
  if (!singleton) {
    const { db } = require('../utils/database');
    const { createAlert } = require('../utils/alertBroadcast');
    singleton = new MqttIngestService({ db, createAlert });
  }
  return singleton;
}

module.exports = { MqttIngestService, getMqttIngestService, parseDbTs, SUBSCRIBE_TOPIC };
