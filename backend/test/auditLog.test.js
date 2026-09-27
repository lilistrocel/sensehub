// Action audit trail + unified Logs API. In-memory DB; no Modbus, no MQTT:
// hardware routes (relay control, trigger, stop-all) are replaced by stubs
// mounted at the real paths so the audit middleware sees real URLs.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { authMiddleware, requireRole, JWT_SECRET } = src('middleware', 'auth.js');
const { auditMiddleware, _finalize } = src('middleware', 'auditLog.js');
const AuditLog = src('services', 'AuditLogService.js');
const Unified = src('services', 'UnifiedLogService.js');
const { diffSnapshots, describeChanges } = src('services', 'AuditDiff.js');
const { DataRetentionService } = src('services', 'DataRetentionService.js');

// Fresh-DB quirk (same as flowWatch.test.js): relay_events loses its read-back columns on first init.
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// request_log is created by index.js at boot (not by utils/database); mirror it.
db.exec(`CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, path TEXT NOT NULL,
  status INTEGER, response_bytes INTEGER, duration_ms INTEGER, ip TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);`);

// ----- fixtures ------------------------------------------------------------
function mkUser(email, role, password = 'Secret123!') {
  const id = Number(db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(email, bcrypt.hashSync(password, 4), email.split('@')[0], role).lastInsertRowid);
  const token = jwt.sign({ userId: id, jti: `${email}-${Math.random()}` }, JWT_SECRET, { expiresIn: '8h' });
  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(id, token, new Date(Date.now() + 8 * 3600e3).toISOString());
  return { id, email, token };
}
const admin = mkUser('boss@farm.test', 'admin');
const operator = mkUser('lili@farm.test', 'operator');
const viewer = mkUser('guest@farm.test', 'viewer');

const FAN_MAPS = JSON.stringify([
  { name: '01-03-05 Big Fan', label: '01-03-05 Big Fan', type: 'coil', register: 1 },
  { name: '02-04-06 Big Fan', label: '02-04-06 Big Fan', type: 'coil', register: 2 },
]);
const IRR_MAPS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' },
  { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const fanBoard = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, register_mappings) VALUES ('Fan Board 1', 'relay', 'modbus', '192.0.2.7:502', ?)").run(FAN_MAPS).lastInsertRowid);
const irrBoard = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, register_mappings) VALUES ('Waveshare Irrigation 1', 'relay', 'modbus', '192.0.2.7:502', ?)").run(IRR_MAPS).lastInsertRowid);
const autoActions = [
  { type: 'control', action: 'on', equipment_id: irrBoard, channel: 5, channel_name: 'Irrigation Zone 3', delay_seconds: 0, duration_seconds: 248 },
  { type: 'control', action: 'on', equipment_id: irrBoard, channel: 6, channel_name: 'Irrigation Zone 4', delay_seconds: 249, duration_seconds: 248 },
];
const autoId = Number(db.prepare("INSERT INTO automations (name, enabled, trigger_config, conditions, actions) VALUES ('Zones 3&4 Manual WATER ONLY', 1, '{\"type\":\"manual\"}', '[]', ?)").run(JSON.stringify(autoActions)).lastInsertRowid);

// ----- app -----------------------------------------------------------------
let server; let base;
const calls = { relay: 0, trigger: 0, stopAll: 0 };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(auditMiddleware);
  app.use('/api/auth', src('routes', 'auth.js'));
  app.use('/api/users', authMiddleware, src('routes', 'users.js'));
  app.use('/api/settings', authMiddleware, src('routes', 'settings.js'));
  // Hardware stubs at the real paths (the real handlers would talk Modbus).
  const hw = express.Router();
  hw.post('/automations/stop-all', requireRole('admin', 'operator'), (req, res) => { calls.stopAll++; res.json({ timersCancelled: 2, attempted: 54, succeeded: 54, failed: [] }); });
  hw.post('/automations/:id/trigger', requireRole('admin', 'operator'), (req, res) => { calls.trigger++; res.json({ success: true, executed_actions: [{}, {}] }); });
  hw.post('/equipment/:id/relay/control', requireRole('admin', 'operator'), (req, res) => { calls.relay++; res.json({ success: true, channel: req.body.channel, state: !!req.body.state, confirmed: true, readback: !!req.body.state }); });
  hw.post('/equipment/:id/boom', requireRole('admin', 'operator'), () => { throw new Error('kaboom'); });
  app.use('/api', authMiddleware, hw);
  app.use('/api/automations', authMiddleware, src('routes', 'automations.js'));
  app.use('/api/logs', authMiddleware, src('routes', 'logs.js'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'Internal Server Error', message: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(r => server.close(r)));

const settle = () => new Promise(r => setTimeout(r, 40));
async function call(method, url, { user, body, ua = ANDROID_UA, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Forwarded-For': '203.0.113.9, 172.18.0.2', ...headers };
  if (user) h.Authorization = `Bearer ${user.token}`;
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  await settle();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}
const lastAudit = () => {
  const r = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
  if (r && r.details) r.detailsObj = JSON.parse(r.details);
  return r;
};

// ----- tests -----------------------------------------------------------------

test('relay control: user, role, client IP (X-Forwarded-For from the proxy), device, channel name, domain category', async () => {
  const r = await call('POST', `/api/equipment/${fanBoard}/relay/control`, { user: operator, body: { channel: 1, state: true } });
  assert.equal(r.status, 200);
  assert.equal(calls.relay, 1);
  const a = lastAudit();
  assert.equal(a.action, 'relay.control');
  assert.equal(a.actor_email, 'lili@farm.test');
  assert.equal(a.actor_role, 'operator');
  assert.equal(a.actor_type, 'user');
  assert.equal(a.ip, '203.0.113.9');
  assert.equal(a.device, 'Android phone');
  assert.equal(a.category, 'climate');
  assert.match(a.tags, /,equipment,/);
  assert.equal(a.target_type, 'equipment');
  assert.equal(a.target_id, String(fanBoard));
  assert.equal(a.target_name, 'Fan Board 1 › 01-03-05 Big Fan');
  assert.match(a.summary, /Switched ON Fan Board 1 › 01-03-05 Big Fan \(read-back confirmed\)/);
  assert.equal(a.result, 'ok');
  assert.equal(a.status_code, 200);
  assert.ok(a.duration_ms >= 0);
  assert.equal(a.detailsObj.channel, 1);
});

test('automation update (real route): BEFORE/AFTER snapshots, field diff and a human summary', async () => {
  const actions = JSON.parse(JSON.stringify(autoActions));
  actions[1].delay_seconds = 270; // Zone 4 start 4:09 -> 4:30
  const r = await call('PUT', `/api/automations/${autoId}`, { user: operator, body: { name: 'Zones 3&4 Manual WATER ONLY', trigger_config: { type: 'manual' }, conditions: [], actions, enabled: true } });
  assert.equal(r.status, 200, r.text);
  const a = lastAudit();
  assert.equal(a.action, 'automation.update');
  assert.equal(a.category, 'irrigation');
  assert.match(a.tags, /,automations,/);
  assert.equal(a.target_type, 'automation');
  assert.equal(a.target_id, String(autoId));
  assert.equal(a.target_name, 'Zones 3&4 Manual WATER ONLY');
  assert.match(a.summary, /^Edited automation 'Zones 3&4 Manual WATER ONLY': Irrigation Zone 4 start 4:09 → 4:30/);
  const d = a.detailsObj;
  assert.equal(d.before.actions[1].delay_seconds, 249);
  assert.equal(d.after.actions[1].delay_seconds, 270);
  assert.ok(d.diff.some(x => x.path === 'actions[1].delay_seconds' && x.before === 249 && x.after === 270));
  assert.ok(!d.diff.some(x => x.path === 'updated_at'), 'bookkeeping fields are not diffs');
});

test('manual trigger and Stop All are recorded with their results', async () => {
  let r = await call('POST', `/api/automations/${autoId}/trigger`, { user: operator });
  assert.equal(r.status, 200);
  let a = lastAudit();
  assert.equal(a.action, 'automation.trigger');
  assert.equal(a.category, 'irrigation');
  assert.match(a.summary, /Ran automation 'Zones 3&4 Manual WATER ONLY' by hand \(2 actions\)/);

  r = await call('POST', '/api/automations/stop-all', { user: operator });
  assert.equal(r.status, 200);
  a = lastAudit();
  assert.equal(a.action, 'stop_all');
  assert.equal(a.category, 'system');
  assert.equal(a.severity, 'warning');
  assert.match(a.summary, /Pressed Stop All — 54\/54 channels OFF, 2 timer\(s\) cancelled/);
  assert.equal(a.actor_email, 'lili@farm.test');
  assert.equal(a.detailsObj.response.succeeded, 54);
});

test('login success and failure: actor from the body, password never stored, token never stored', async () => {
  let r = await call('POST', '/api/auth/login', { body: { email: 'lili@farm.test', password: 'Secret123!' }, ua: WINDOWS_UA });
  assert.equal(r.status, 200);
  const token = r.json.token;
  let a = lastAudit();
  assert.equal(a.action, 'auth.login');
  assert.equal(a.actor_email, 'lili@farm.test');
  assert.equal(a.actor_role, 'operator');
  assert.equal(a.device, 'Windows PC');
  assert.equal(a.result, 'ok');
  assert.ok(!a.details.includes('Secret123!'), 'password stored');
  assert.ok(!a.details.includes(token), 'session token stored');
  assert.equal(a.detailsObj.body.password, '[redacted]');

  r = await call('POST', '/api/auth/login', { body: { email: 'lili@farm.test', password: 'wrong-guess-1' } });
  assert.equal(r.status, 401);
  a = lastAudit();
  assert.equal(a.action, 'auth.login_failed');
  assert.equal(a.result, 'denied');
  assert.equal(a.severity, 'warning');
  assert.equal(a.actor_email, 'lili@farm.test');
  assert.ok(!a.details.includes('wrong-guess-1'));

  // Logout: the session is deleted by the handler, the actor is resolved before it.
  r = await call('POST', '/api/auth/logout', { user: { token } });
  a = lastAudit();
  assert.equal(a.action, 'auth.logout');
  assert.equal(a.actor_email, 'lili@farm.test');
});

test('settings update: secrets redacted in body, snapshots and diff; the change is still visible', async () => {
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('telegram_bot_token', 'old-bot-token-123')").run();
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('timezone', 'UTC')").run();
  const r = await call('PUT', '/api/settings', {
    user: admin,
    body: { timezone: 'Asia/Dubai', telegram_bot_token: 'new-bot-token-456', cloud_config: { url: 'https://c.example', api_key: 'sk-live-999' } },
  });
  assert.equal(r.status, 200);
  const a = lastAudit();
  assert.equal(a.action, 'settings.update');
  assert.equal(a.category, 'settings');
  for (const secret of ['old-bot-token-123', 'new-bot-token-456', 'sk-live-999']) assert.ok(!a.details.includes(secret), `leaked ${secret}`);
  const d = a.detailsObj;
  assert.equal(d.body.telegram_bot_token, '[redacted]');
  assert.equal(d.body.cloud_config.api_key, '[redacted]');
  assert.ok(d.diff.some(x => x.path === 'telegram_bot_token' && x.redacted), 'secret change still listed');
  assert.ok(d.diff.some(x => x.path === 'timezone' && x.before === 'UTC' && x.after === 'Asia/Dubai'));
  assert.match(a.summary, /timezone UTC → Asia\/Dubai/);
  assert.match(a.summary, /telegram_bot_token changed \(secret\)/);
});

test('denied (403) and error (500) results; unmapped routes still get a generic entry', async () => {
  let r = await call('POST', '/api/users', { user: viewer, body: { email: 'x@y.z', password: 'abcdefgh1', name: 'x', role: 'admin' } });
  assert.equal(r.status, 403);
  let a = lastAudit();
  assert.equal(a.action, 'user.create');
  assert.equal(a.result, 'denied');
  assert.equal(a.status_code, 403);
  assert.equal(a.actor_email, 'guest@farm.test');
  assert.equal(a.actor_role, 'viewer');
  assert.match(a.summary, /refused \(403/);
  assert.ok(!a.details.includes('abcdefgh1'));

  r = await call('POST', `/api/equipment/${fanBoard}/boom`, { user: operator, body: {} });
  assert.equal(r.status, 500);
  a = lastAudit();
  assert.equal(a.result, 'error');
  assert.equal(a.severity, 'critical');
  assert.equal(a.action, 'post.request');
  assert.equal(a.category, 'equipment');
  assert.equal(a.detailsObj.unmapped_route, true);
  assert.equal(a.detailsObj.error, 'kaboom');

  // No token at all -> 401, recorded without an actor.
  r = await call('POST', '/api/automations/stop-all', {});
  assert.equal(r.status, 401);
  a = lastAudit();
  assert.equal(a.action, 'stop_all');
  assert.equal(a.result, 'denied');
  assert.equal(a.actor_email, null);
  assert.equal(calls.stopAll, 1, 'stub not reached without auth');
});

test('never breaks the request: audit insert failure, throwing loaders and GETs', async () => {
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    const r = await call('POST', `/api/equipment/${fanBoard}/relay/control`, { user: operator, body: { channel: 2, state: false } });
    assert.equal(r.status, 200, 'request still succeeds when the audit insert fails');
    assert.equal(r.json.success, true);
    assert.ok(errors.some(e => /AuditLog/.test(e) && /disk full/.test(e)));
  } finally {
    db.exec('DROP TRIGGER IF EXISTS audit_fail');
    console.error = origErr;
  }
  // A def whose every hook throws: finalize swallows it.
  const boom = () => { throw new Error('x'); };
  assert.doesNotThrow(() => _finalize(
    { method: 'POST', query: {}, headers: {} },
    { statusCode: 200 },
    { def: { action: boom, category: boom, target: boom, summary: boom, before: boom, after: boom }, params: {}, path: '/api/x', startIso: new Date().toISOString(), body: {} },
  ));
  const n = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  await call('GET', '/api/logs?limit=1', { user: admin });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, n, 'GETs are not audited');
});

test('body size is bounded and PTZ moves coalesce into one row', async () => {
  const big = 'x'.repeat(20000);
  await call('PUT', '/api/settings', { user: admin, body: { note_blob: big } });
  const a = lastAudit();
  assert.ok(a.details.length < 64 * 1024);
  assert.equal(a.detailsObj.body._truncated, true);
  // coalescing (service level)
  const k = { coalesceKey: 'k1', coalesceSeconds: 60 };
  const id1 = AuditLog.recordAudit({ action: 'camera.ptz_move', category: 'cameras', summary: 'moved' }, k);
  const id2 = AuditLog.recordAudit({ action: 'camera.ptz_move', category: 'cameras', summary: 'moved' }, k);
  assert.equal(id1, id2);
  assert.equal(db.prepare('SELECT repeat_count FROM audit_log WHERE id = ?').get(id1).repeat_count, 2);
});

test('device labels and diff wording', () => {
  assert.equal(AuditLog.deviceFromUA(ANDROID_UA), 'Android phone');
  assert.equal(AuditLog.deviceFromUA('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36'), 'Android tablet');
  assert.equal(AuditLog.deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
  assert.equal(AuditLog.deviceFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'Mac');
  assert.equal(AuditLog.deviceFromUA('curl/8.5.0'), 'headless/script');
  assert.equal(AuditLog.deviceFromUA('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120'), 'headless/script');
  assert.equal(AuditLog.deviceFromUA(''), 'unknown device');
  const diff = diffSnapshots({ enabled: 1, actions: '[{"channel_name":"Zone 1","duration_seconds":60}]' }, { enabled: true, actions: [{ channel_name: 'Zone 1', duration_seconds: 90 }, { channel_name: 'Zone 2' }] });
  assert.deepEqual(describeChanges(diff, { before: null, after: { actions: [{ channel_name: 'Zone 1' }, { channel_name: 'Zone 2' }] } }), ['Zone 1 duration 1:00 → 1:30', 'added Zone 2']);
});

// ----- unified read API -------------------------------------------------------

function seedSystemEvents() {
  const ins = db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, user_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Automation burst (3 writes in 2 s) -> one item
  ins.run(irrBoard, 1, 1, 'automation', autoId, 1, 1, null, '2026-09-20 10:15:42');
  ins.run(irrBoard, 5, 1, 'automation', autoId, 1, 1, null, '2026-09-20 10:15:43');
  ins.run(irrBoard, 6, 1, 'automation', autoId, 1, 1, null, '2026-09-20 10:15:44');
  // Stop All burst on two boards -> one item
  for (const [eq, ch] of [[fanBoard, 1], [fanBoard, 2], [irrBoard, 1], [irrBoard, 5], [irrBoard, 6]]) ins.run(eq, ch, 0, 'stop_all', null, null, null, null, '2026-09-20 10:15:54');
  // Manual fan writes by a user (pre-audit era) -> grouped, attributed
  ins.run(fanBoard, 1, 1, 'manual', null, 1, 1, 'lili@farm.test', '2026-09-20 10:21:49');
  ins.run(fanBoard, 2, 1, 'manual', null, 1, 1, 'lili@farm.test', '2026-09-20 10:21:50');
  // Separate burst 30 s later (gap > 5 s)
  ins.run(fanBoard, 1, 0, 'watchdog_force_off', null, 0, 1, null, '2026-09-20 10:22:30');
  db.prepare("INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, 'success', 'manual trigger executed', '2026-09-20 10:15:42', '2026-09-20 10:15:42')").run(autoId);
  db.prepare("INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, 'failure', 'boom', '2026-09-20 09:00:00', '2026-09-20 09:00:00')").run(autoId);
  db.prepare("INSERT INTO alerts (severity, message, source, equipment_id, created_at) VALUES ('critical', 'Irrigation stopped: no water', 'flow_watch', ?, '2026-09-20 10:16:00')").run(irrBoard);
  db.prepare("INSERT INTO irrigation_flow_episodes (kind, equipment_id, channel, zone_name, started_at, ended_at, duration_s, recovered, alarmed, severity) VALUES ('valve_no_flow', ?, 6, 'Irrigation Zone 4', '2026-09-20T10:17:00.000Z', '2026-09-20T10:17:13.500Z', 13.5, 1, 0, NULL)").run(irrBoard);
  db.prepare("INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, created_at) VALUES (?, 'Waveshare Irrigation 1', 5, 0, 1, 'polling_drift', '2026-09-20 10:30:00')").run(irrBoard);
  // Legacy request_log (router-relative paths, no user)
  const rq = db.prepare('INSERT INTO request_log (method, path, status, response_bytes, duration_ms, ip, user_agent, created_at) VALUES (?, ?, 200, 10, 5, ?, ?, ?)');
  rq.run('POST', '/stop-all', '::ffff:172.18.0.2', ANDROID_UA, '2026-09-20T10:15:54.629Z');
  rq.run('POST', `/${autoId}/trigger`, '::ffff:172.18.0.2', ANDROID_UA, '2026-09-20T10:15:42.549Z');
  rq.run('POST', `/${fanBoard}/relay/control`, '::ffff:172.18.0.2', ANDROID_UA, '2026-09-20T10:21:49.100Z');
}

function collectAll(query, limit) {
  const all = [];
  let cursor = null; let pages = 0;
  do {
    const res = Unified.queryLogs({ ...query, limit, cursor });
    all.push(...res.items);
    cursor = res.next_cursor;
    pages++;
    assert.ok(pages < 500, 'pagination terminates');
  } while (cursor);
  return all;
}

test('unified API: merges sources, groups relay bursts, attributes legacy manual writes, no duplicates across pages', () => {
  // Pretend the audit era started after the seeded history.
  Unified._resetAuditEraCache();
  seedSystemEvents();
  const q = { from: '2026-09-20T08:00:00Z', to: '2026-09-20T11:00:00Z' };
  const big = Unified.queryLogs({ ...q, limit: 200 });
  const ids = big.items.map(i => i.id);
  const bySource = (s) => big.items.filter(i => i.source === s);
  assert.equal(bySource('relay').length, 4, 'automation burst, stop-all burst, manual burst, watchdog');
  const burst = bySource('relay').find(i => i.action === 'relay.automation');
  assert.equal(burst.count, 3);
  assert.equal(burst.actor_label, "Automation 'Zones 3&4 Manual WATER ONLY'");
  assert.equal(burst.category, 'irrigation');
  const stop = bySource('relay').find(i => i.action === 'relay.stop_all');
  assert.equal(stop.count, 5);
  assert.match(stop.summary, /Stop All switched OFF 5 channels on 2 boards/);
  const manual = bySource('relay').find(i => i.action === 'relay.control');
  assert.equal(manual.actor_type, 'user');
  assert.equal(manual.actor_email, 'lili@farm.test');
  assert.equal(manual.device, 'Android phone', 'device borrowed from request_log');
  assert.equal(manual.category, 'climate');
  const wd = bySource('relay').find(i => i.action === 'relay.watchdog_force_off');
  assert.equal(wd.severity, 'warning', 'unconfirmed write is a warning');
  assert.equal(bySource('automation').length, 2);
  assert.equal(bySource('alert').length, 1);
  assert.equal(bySource('flow').length, 1);
  assert.equal(bySource('drift').length, 1);
  const legacy = bySource('request');
  assert.equal(legacy.length, 2, 'relay/control requests are covered by relay_events');
  const legacyStop = legacy.find(i => i.action === 'stop_all');
  assert.ok(legacyStop, 'legacy /stop-all mapped to stop_all');
  assert.equal(legacyStop.device, 'Android phone');
  assert.match(legacy.find(i => i.action === 'automation.trigger').summary, /Ran automation 'Zones 3&4 Manual WATER ONLY' by hand/);
  // newest first
  const times = big.items.map(i => i.time);
  assert.deepEqual(times, [...times].sort().reverse());
  // Paging with tiny pages returns exactly the same sequence.
  for (const lim of [1, 2, 3, 5]) {
    const paged = collectAll(q, lim).map(i => i.id);
    assert.deepEqual(paged, ids, `page size ${lim}`);
  }
});

test('unified API filters: category, actor, actor_type, target, action list, severity, text', () => {
  const q = { from: '2026-09-20T08:00:00Z', to: '2026-09-20T11:00:00Z', limit: 200 };
  const climate = Unified.queryLogs({ ...q, category: 'climate' }).items;
  assert.ok(climate.length >= 2 && climate.every(i => i.categories.includes('climate')));
  const lili = Unified.queryLogs({ ...q, actor: 'LILI@farm.test' }).items;
  assert.ok(lili.length >= 1 && lili.every(i => i.actor_email === 'lili@farm.test'));
  const people = Unified.queryLogs({ ...q, actor_type: 'user' }).items;
  assert.ok(people.every(i => i.actor_type === 'user'));
  assert.ok(people.some(i => i.source === 'request'));
  const sys = Unified.queryLogs({ ...q, actor_type: 'system' }).items;
  assert.ok(sys.every(i => i.actor_type === 'system') && sys.length >= 6);
  const forAuto = Unified.queryLogs({ ...q, target_type: 'automation', target_id: String(autoId) }).items;
  assert.ok(forAuto.some(i => i.source === 'relay') && forAuto.some(i => i.source === 'automation'));
  const forFan = Unified.queryLogs({ ...q, target_type: 'equipment', target_id: String(fanBoard) }).items;
  assert.ok(forFan.length >= 3 && forFan.every(i => i.target_id === String(fanBoard) || (i.related || []).some(r => r.id === String(fanBoard))));
  const stops = Unified.queryLogs({ ...q, action: 'stop_all,emergency_stop,irrigation.stop' }).items;
  assert.ok(stops.length >= 1 && stops.every(i => ['stop_all', 'emergency_stop', 'irrigation.stop'].includes(i.action)));
  const crit = Unified.queryLogs({ ...q, severity: 'critical' }).items;
  assert.ok(crit.length >= 1 && crit.every(i => i.severity === 'critical'));
  const text = Unified.queryLogs({ ...q, q: 'zone 4' }).items;
  assert.ok(text.length >= 1 && text.every(i => JSON.stringify(i).toLowerCase().includes('zone 4')));
});

test('audit era: user relay writes come from audit_log only; legacy request rows stop at the first audit row', () => {
  Unified._resetAuditEraCache();
  const era = db.prepare('SELECT MIN(created_at) AS t FROM audit_log').get().t;
  assert.ok(era);
  // A user relay write after the era start is not repeated from relay_events.
  const t = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("INSERT INTO relay_events (equipment_id, channel, state, source, user_email, created_at) VALUES (?, 1, 1, 'manual', 'lili@farm.test', ?)").run(fanBoard, t);
  db.prepare("INSERT INTO request_log (method, path, status, created_at) VALUES ('POST', '/stop-all', 200, ?)").run(new Date().toISOString());
  const recent = Unified.queryLogs({ range: '24h', limit: 200 }).items;
  assert.ok(!recent.some(i => i.source === 'relay' && i.action === 'relay.control'), 'no duplicate of an audited relay write');
  assert.ok(!recent.some(i => i.source === 'request'), 'no legacy request rows in the audit era');
  assert.ok(recent.some(i => i.source === 'audit' && i.action === 'relay.control'));
});

test('API routes: roles, detail with diff, CSV export, facets', async () => {
  let r = await call('GET', '/api/logs?limit=5', { user: viewer });
  assert.equal(r.status, 403, 'viewer cannot read the audit log');
  r = await call('GET', '/api/logs?limit=5&range=24h', { user: operator });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.items) && r.json.items.length === 5);
  assert.ok(r.json.next_cursor);
  const upd = db.prepare("SELECT id FROM audit_log WHERE action = 'automation.update' ORDER BY id DESC LIMIT 1").get();
  r = await call('GET', `/api/logs/audit/${upd.id}`, { user: admin });
  assert.equal(r.status, 200);
  assert.ok(r.json.details.diff.length >= 1);
  assert.equal(r.json.item.action, 'automation.update');
  const relay = db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM relay_events WHERE source = 'stop_all'").get();
  r = await call('GET', `/api/logs/relay/${relay.lo}-${relay.hi}`, { user: admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.details.writes.length, 5);
  r = await call('GET', '/api/logs/nope/1', { user: admin });
  assert.equal(r.status, 400);
  r = await call('GET', '/api/logs/audit/999999', { user: admin });
  assert.equal(r.status, 404);
  r = await call('GET', '/api/logs/export.csv?from=2026-09-20T08:00:00Z&to=2026-09-20T11:00:00Z', { user: admin });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\n');
  assert.match(lines[0], /^time_utc,time_local/);
  assert.equal(lines.length - 1, Unified.queryLogs({ from: '2026-09-20T08:00:00Z', to: '2026-09-20T11:00:00Z', limit: 200 }).items.length);
  r = await call('GET', '/api/logs/facets', { user: operator });
  assert.equal(r.status, 200);
  assert.ok(r.json.users.some(u => u.email === 'lili@farm.test'));
  assert.ok(r.json.categories.includes('irrigation'));
  assert.ok(r.json.automations.some(a => a.id === autoId));
});

test('retention: audit_log pruned after audit_log_retention_days (default 365)', () => {
  const svc = new DataRetentionService();
  assert.equal(svc.getConfig().audit_log_retention_days, 365);
  const old = new Date(Date.now() - 400 * 86400e3).toISOString();
  const young = new Date(Date.now() - 300 * 86400e3).toISOString();
  const oldId = AuditLog.recordAudit({ created_at: old, action: 'x.old', category: 'system' });
  const youngId = AuditLog.recordAudit({ created_at: young, action: 'x.young', category: 'system' });
  const dry = svc.runOnce({ ...svc.getConfig(), readings_retention_days: 9999, dry_run: true });
  assert.ok(dry.audit_log.eligible_rows >= 1);
  assert.ok(db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(oldId), 'dry run keeps rows');
  const res = svc.runOnce({ ...svc.getConfig(), readings_retention_days: 9999 });
  assert.ok(res.audit_log.rows_dropped >= 1);
  assert.equal(db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(oldId), undefined);
  assert.ok(db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(youngId));
  const custom = svc.runOnce({ ...svc.getConfig(), readings_retention_days: 9999, audit_log_retention_days: 200 });
  assert.ok(custom.audit_log.rows_dropped >= 1, 'configurable window');
  assert.equal(db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(youngId), undefined);
});
