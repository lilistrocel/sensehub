/**
 * Multilingual core (en / tr / ar): the t() renderer, request-language
 * resolution, the per-user language preference, alerts stored in English with
 * a message key and rendered per request language, the WebSocket payload, and
 * the Telegram text per configured language.
 * In-memory DB; the real auth middleware + routers on an ephemeral port.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const i18n = src('i18n', 'index.js');
const { createAlert, updateOpenAlert, localizeAlert, broadcastPayload } = src('utils', 'alertBroadcast.js');
const { resolveLanguage, explicitLanguage, languageMiddleware } = src('middleware', 'language.js');
const { authMiddleware, JWT_SECRET } = src('middleware', 'auth.js');
const { formatTelegramAlert, TelegramService } = src('services', 'TelegramService.js');

// ─── t() ────────────────────────────────────────────────────────────────────

test('t(): interpolation, nested descriptors, lists, durations', () => {
  assert.equal(i18n.t('en', 'common.relay', { channel: 4 }), 'relay 4');
  assert.equal(i18n.t('tr', 'common.relay', { channel: 4 }), 'röle 4');
  assert.equal(i18n.t('ar', 'common.relay', { channel: 4 }), 'المرحّل 4');
  const nested = { title: i18n.M('common.relay', { channel: 2 }), message: i18n.list(['A', 'B']) };
  assert.equal(i18n.t('en', 'common.titled', nested), 'relay 2: A, B');
  assert.equal(i18n.t('ar', 'common.titled', nested), 'المرحّل 2: A، B');
  assert.equal(i18n.formatDuration('en', 25000), '25 s');
  assert.equal(i18n.formatDuration('en', 125000), '2 min 5 s');
  assert.equal(i18n.formatDuration('en', 95 * 60000), '95 min');
  assert.equal(i18n.formatDuration('tr', 125000), '2 dk 5 sn');
  assert.equal(i18n.formatDuration('ar', 120000), '2 د');
  assert.equal(i18n.formatDuration('en', 125 * 60000, { units: 'hm' }), '2 h 5 min');
  assert.equal(i18n.t('tr', 'common.titled', { title: 'X', message: i18n.dur(30000) }), 'X: 30 sn');
});

test('t(): missing params render empty, unknown key renders the key, arrays drop empties', () => {
  assert.equal(i18n.t('en', 'common.relay', {}), 'relay');
  assert.equal(i18n.t('tr', 'no.such.key'), 'no.such.key');
  assert.equal(i18n.render('en', ['a', null, '', i18n.M('common.none')]), 'a none');
  assert.equal(i18n.render('ar', 'plain text'), 'plain text');
  assert.equal(i18n.render('tr', { key: 'common.none', params: {} }), 'yok');
});

test('t(): Western digits in every language', () => {
  assert.equal(i18n.formatNumber('ar', 8820), '8,820');
  assert.equal(i18n.formatNumber('tr', 1.25, { dp: 2 }), '1.25');
  const s = i18n.t('ar', 'common.equipment_relay', { equipment: 'Irrigation', channel: 12 });
  assert.match(s, /12/);
  assert.doesNotMatch(s, /[٠-٩]/);
});

test('plural rules: en/tr one-other, Arabic six forms', () => {
  assert.deepEqual([0, 1, 2, 5].map(n => i18n.pluralCategory('en', n)), ['other', 'one', 'other', 'other']);
  assert.deepEqual([1, 2].map(n => i18n.pluralCategory('tr', n)), ['one', 'other']);
  assert.deepEqual([0, 1, 2, 3, 10, 11, 99, 100, 102, 111].map(n => i18n.pluralCategory('ar', n)),
    ['zero', 'one', 'two', 'few', 'few', 'many', 'many', 'other', 'other', 'many']);
});

test('t(): plural leaf picks the form by count, and falls back to English for a missing language', () => {
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'i18n-'));
  const fs = require('fs');
  for (const l of ['en', 'tr', 'ar']) fs.mkdirSync(path.join(dir, l));
  fs.writeFileSync(path.join(dir, 'en', 'x.json'), JSON.stringify({ n: { one: '{count} start cancelled', other: '{count} starts cancelled' }, only_en: 'English only' }));
  fs.writeFileSync(path.join(dir, 'tr', 'x.json'), JSON.stringify({ n: { one: '{count} başlatma iptal edildi', other: '{count} başlatma iptal edildi' } }));
  fs.writeFileSync(path.join(dir, 'ar', 'x.json'), JSON.stringify({ n: { zero: 'لم يُلغَ أي تشغيل', one: 'أُلغي تشغيل واحد', two: 'أُلغي تشغيلان', few: 'أُلغيت {count} تشغيلات', many: 'أُلغي {count} تشغيلًا', other: 'أُلغي {count} تشغيل' } }));
  const cats = i18n.loadCatalogs(dir);
  assert.equal(cats.en['x.n'].one, '{count} start cancelled');
  // swap the live catalogs for the fixture (restored below)
  const live = i18n.catalogs();
  const saved = { ...live };
  for (const l of Object.keys(live)) live[l] = cats[l];
  try {
    assert.equal(i18n.t('en', 'x.n', { count: 1 }), '1 start cancelled');
    assert.equal(i18n.t('en', 'x.n', { count: 3 }), '3 starts cancelled');
    assert.equal(i18n.t('ar', 'x.n', { count: 0 }), 'لم يُلغَ أي تشغيل');
    assert.equal(i18n.t('ar', 'x.n', { count: 2 }), 'أُلغي تشغيلان');
    assert.equal(i18n.t('ar', 'x.n', { count: 5 }), 'أُلغيت 5 تشغيلات');
    assert.equal(i18n.t('ar', 'x.n', { count: 12 }), 'أُلغي 12 تشغيلًا');
    assert.equal(i18n.t('tr', 'x.only_en'), 'English only'); // fallback
  } finally {
    for (const l of Object.keys(saved)) live[l] = saved[l];
  }
});

// ─── request language ───────────────────────────────────────────────────────

test('language resolution: explicit header / query → user preference → en', () => {
  assert.equal(resolveLanguage({ acceptLanguage: 'tr' }), 'tr');
  assert.equal(resolveLanguage({ acceptLanguage: 'ar-AE', userPreference: 'tr' }), 'ar');
  assert.equal(resolveLanguage({ acceptLanguage: 'fr', userPreference: 'tr' }), 'tr');
  // a browser-generated list is not an explicit SenseHub choice
  assert.equal(resolveLanguage({ acceptLanguage: 'tr-TR,tr;q=0.9,en;q=0.8', userPreference: 'ar' }), 'ar');
  assert.equal(resolveLanguage({ acceptLanguage: 'en-US,en;q=0.9' }), 'en');
  assert.equal(resolveLanguage({ query: 'ar', acceptLanguage: 'tr', userPreference: 'en' }), 'ar');
  assert.equal(resolveLanguage({}), 'en');
  assert.equal(resolveLanguage({ userPreference: 'xx' }), 'en');
  assert.equal(explicitLanguage({ acceptLanguage: '*' }), null);
});

// ─── HTTP: preferences, admin, alerts ───────────────────────────────────────

function mkUser(email, role) {
  const id = Number(db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(email, 'x', email, role).lastInsertRowid);
  const token = jwt.sign({ userId: id, jti: `${email}-${Math.random()}` }, JWT_SECRET, { expiresIn: '1h' });
  db.prepare("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(id, token);
  return { id, token };
}

let server; let base; let admin; let operator;
test.before(async () => {
  global.broadcast = () => {}; // routes/alerts.js broadcasts on acknowledge
  admin = mkUser('admin@farm.test', 'admin');
  operator = mkUser('op@farm.test', 'operator');
  const app = express();
  app.use(express.json());
  app.use('/api', languageMiddleware);
  app.use('/api/users', authMiddleware, src('routes', 'users.js'));
  app.use('/api/alerts', authMiddleware, src('routes', 'alerts.js'));
  app.use('/api/notifications', authMiddleware, src('routes', 'notifications.js'));
  app.get('/api/echo-lang', authMiddleware, (req, res) => res.json({ lang: req.lang, source: req.langSource }));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise(r => server.close(r)));

const call = (method, p, token, body, headers = {}) => fetch(base + p, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('preferences: default null (never chosen), set tr, reject invalid, drives req.lang', async () => {
  let r = await call('GET', '/users/me/preferences', operator.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.language, null, 'never chosen → null (frontend uses the device language)');
  r = await call('PUT', '/users/me/preferences', operator.token, { language: 'fr' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/users/me/preferences', operator.token, { language: 'tr' });
  assert.equal(r.status, 200);
  assert.equal(r.body.preferences.language, 'tr');
  assert.equal(r.body.preferences.sound_alerts_enabled, false, 'other preferences untouched');
  r = await call('GET', '/users/me/preferences', operator.token);
  assert.equal(r.body.language, 'tr');
  // stored preference applies when the request does not choose …
  r = await call('GET', '/echo-lang', operator.token, undefined, { 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' });
  assert.deepEqual(r.body, { lang: 'tr', source: 'user' });
  // … the frontend's explicit header wins
  r = await call('GET', '/echo-lang', operator.token, undefined, { 'Accept-Language': 'ar' });
  assert.deepEqual(r.body, { lang: 'ar', source: 'request' });
});

test('admin: set / read a user\'s language; validation', async () => {
  let r = await call('PUT', `/users/${operator.id}`, admin.token, { language: 'ar' });
  assert.equal(r.status, 200);
  r = await call('GET', `/users/${operator.id}`, admin.token);
  assert.equal(r.body.language, 'ar');
  r = await call('GET', '/users', admin.token);
  assert.equal(r.body.find(u => u.id === operator.id).language, 'ar');
  r = await call('PUT', `/users/${operator.id}`, admin.token, { language: 'de' });
  assert.equal(r.status, 400);
  r = await call('PUT', `/users/${operator.id}`, operator.token, { language: 'en' });
  assert.equal(r.status, 403, 'only admins manage other users');
  r = await call('POST', '/users', admin.token, { email: 'new@farm.test', password: 'password123', name: 'New', role: 'viewer', language: 'tr' });
  assert.equal(r.status, 201);
  assert.equal(r.body.language, 'tr');
  r = await call('PUT', `/users/${operator.id}`, admin.token, { language: 'tr' });
  assert.equal(r.status, 200);
});

test('alerts: key+params stored with the English message; API renders per request language', async () => {
  const row = createAlert({
    severity: 'warning', source: 'test', fingerprint: 'i18n:test:1',
    messageKey: 'common.titled', messageParams: { title: i18n.M('common.equipment_relay', { equipment: 'Irrigation', channel: 6 }), message: i18n.M('common.none') },
  });
  assert.equal(row.message, 'Irrigation relay 6: none');
  assert.equal(row.message_key, 'common.titled');
  const stored = db.prepare('SELECT message, message_key, message_params FROM alerts WHERE id = ?').get(row.id);
  assert.equal(stored.message, 'Irrigation relay 6: none', 'DB keeps English');
  assert.ok(JSON.parse(stored.message_params).title.$k);

  const legacy = createAlert({ severity: 'info', source: 'test', message: 'Plain English alert' });
  assert.equal(legacy.message_key, null);

  let r = await call('GET', '/alerts?source=test', operator.token, undefined, { 'Accept-Language': 'tr' });
  const tr = r.body.items.find(a => a.id === row.id);
  assert.equal(tr.message, 'Irrigation röle 6: yok');
  assert.equal(tr.message_en, 'Irrigation relay 6: none');
  assert.equal(tr.message_key, 'common.titled');
  assert.equal(typeof tr.message_params, 'object');
  const trLegacy = r.body.items.find(a => a.id === legacy.id);
  assert.equal(trLegacy.message, 'Plain English alert', 'old / keyless alerts stay English');
  assert.equal(trLegacy.message_key, null);

  r = await call('GET', '/alerts?source=test', operator.token, undefined, { 'Accept-Language': 'ar' });
  assert.equal(r.body.items.find(a => a.id === row.id).message, 'Irrigation المرحّل 6: لا يوجد');
  // user preference (tr, set above) when the header is a browser list
  r = await call('GET', '/alerts?source=test', operator.token, undefined, { 'Accept-Language': 'en-US,en;q=0.9' });
  assert.equal(r.body.items.find(a => a.id === row.id).message, 'Irrigation röle 6: yok');
  r = await call('GET', '/alerts?source=test', operator.token, undefined, { 'Accept-Language': 'en' });
  assert.equal(r.body.items.find(a => a.id === row.id).message, 'Irrigation relay 6: none');

  // acknowledge response is localized too
  r = await call('POST', `/alerts/${row.id}/acknowledge`, operator.token, {}, { 'Accept-Language': 'ar' });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, 'Irrigation المرحّل 6: لا يوجد');
});

test('alerts: dedupe and updateOpenAlert keep key/params in step with the English message', () => {
  const fp = 'i18n:test:dedupe';
  const a = createAlert({ severity: 'warning', source: 'test', fingerprint: fp, messageKey: 'common.relay', messageParams: { channel: 1 } });
  const b = createAlert({ severity: 'warning', source: 'test', fingerprint: fp, messageKey: 'common.relay', messageParams: { channel: 2 } });
  assert.equal(b.id, a.id);
  assert.equal(b.deduplicated, true);
  assert.equal(b.message, 'relay 2');
  assert.equal(localizeAlert(b, 'tr').message, 'röle 2');
  const u = updateOpenAlert(fp, { messageKey: 'common.equipment_relay', messageParams: { equipment: 'Dosing', channel: 3 }, severity: 'info' });
  assert.equal(u.message, 'Dosing relay 3');
  assert.equal(u.severity, 'info');
  assert.equal(localizeAlert(u, 'ar').message, 'Dosing المرحّل 3');
  // an English-only update clears the key (the text no longer matches it)
  const e = updateOpenAlert(fp, { message: 'Free text' });
  assert.equal(e.message_key, null);
  assert.equal(localizeAlert(e, 'tr').message, 'Free text');
  // severity-only update keeps the message and key
  createAlert({ severity: 'warning', source: 'test', fingerprint: `${fp}:2`, messageKey: 'common.relay', messageParams: { channel: 9 } });
  const s = updateOpenAlert(`${fp}:2`, { severity: 'critical' });
  assert.equal(s.message_key, 'common.relay');
  assert.equal(localizeAlert(s, 'tr').message, 'röle 9');
});

test('alerts: WebSocket payload stays backward compatible and carries every language', () => {
  const sent = [];
  const prev = global.broadcast;
  global.broadcast = (type, data) => sent.push({ type, data });
  db.prepare("UPDATE alerts SET acknowledged = 1 WHERE fingerprint = 'i18n:ws'").run();
  try {
    createAlert({ severity: 'info', source: 'test', fingerprint: 'i18n:ws', messageKey: 'common.relay', messageParams: { channel: 5 }, metadata: { x: 1 } });
  } finally { global.broadcast = prev; }
  assert.equal(sent.length, 1);
  const { type, data } = sent[0];
  assert.equal(type, 'new_alert');
  assert.equal(data.message, 'relay 5', 'message stays English for old clients');
  assert.equal(data.message_en, 'relay 5');
  assert.equal(data.message_key, 'common.relay');
  assert.deepEqual(data.message_params, { channel: 5 });
  assert.deepEqual(data.message_i18n, { en: 'relay 5', tr: 'röle 5', ar: 'المرحّل 5' });
  assert.deepEqual(data.metadata, { x: 1 });
  assert.ok(data.id && data.severity && data.created_at);
  // legacy row
  const p = broadcastPayload({ id: 1, message: 'x', message_key: null, message_params: null });
  assert.deepEqual(p.message_i18n, { en: 'x', tr: 'x', ar: 'x' });
});

test('alerts: title descriptors are kept as common.titled', () => {
  const row = createAlert({ severity: 'info', source: 'test', fingerprint: 'i18n:title', title: i18n.M('common.none'), messageKey: 'common.relay', messageParams: { channel: 7 } });
  assert.equal(row.message, 'none: relay 7');
  assert.equal(localizeAlert(row, 'tr').message, 'yok: röle 7');
});

// ─── Telegram ───────────────────────────────────────────────────────────────

test('telegram: language setting (default en, validated) and per-language rendering', async () => {
  let r = await call('GET', '/notifications/telegram', admin.token);
  assert.equal(r.body.language, 'en');
  r = await call('PUT', '/notifications/telegram', admin.token, { language: 'xx' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/notifications/telegram', operator.token, { language: 'tr' });
  assert.equal(r.status, 403);
  r = await call('PUT', '/notifications/telegram', admin.token, { language: 'ar' });
  assert.equal(r.status, 200);
  r = await call('GET', '/notifications/telegram', admin.token);
  assert.equal(r.body.language, 'ar');
  const svc = new TelegramService();
  assert.equal(svc.getLanguage(), 'ar');

  const at = new Date('2026-09-27T10:05:00Z');
  const spec = i18n.M('common.equipment_relay', { equipment: 'Irrigation', channel: 6 });
  const en = formatTelegramAlert({ title: i18n.M('common.none'), details: spec, severity: 'critical', lang: 'en', tz: 'Asia/Dubai', at });
  const tr = formatTelegramAlert({ title: i18n.M('common.none'), details: spec, severity: 'critical', lang: 'tr', tz: 'Asia/Dubai', at });
  const ar = formatTelegramAlert({ title: i18n.M('common.none'), details: spec, severity: 'critical', lang: 'ar', tz: 'Asia/Dubai', at });
  assert.equal(en, '🚨 *none*\n\nIrrigation relay 6\n\n🕐 9/27/2026, 2:05:00 PM');
  assert.equal(tr, '🚨 *yok*\n\nIrrigation röle 6\n\n🕐 27/09/2026, 14:05:00');
  assert.equal(ar, '🚨 *لا يوجد*\n\nIrrigation المرحّل 6\n\n🕐 27/09/2026, 14:05:00');
  // plain strings are sent as-is (legacy callers)
  assert.match(formatTelegramAlert({ title: 'Hello', details: 'World', lang: 'ar', tz: 'UTC', at }), /\*Hello\*\n\nWorld/);

  // sendAlert renders in the configured language
  const sent = [];
  svc.sendMessage = async (text) => { sent.push(text); return { ok: true }; };
  await svc.sendAlert(i18n.M('common.none'), spec, 'warning');
  assert.match(sent[0], /^⚠️ \*لا يوجد\*\n\nIrrigation المرحّل 6\n\n🕐 /);
  r = await call('PUT', '/notifications/telegram', admin.token, { language: 'en' });
  assert.equal(r.status, 200);
});
