/**
 * Per-user language: NULL = never chosen.
 *
 * A user whose language was never set starts in their device language (the
 * frontend decides and writes it back on first sign-in), so the backend keeps
 * user_preferences.language NULL and returns `language: null` from the
 * preferences, login and session payloads. Existing phase-1 rows (NOT NULL
 * DEFAULT 'en') are migrated to a nullable column without changing any value.
 * In-memory DBs only.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { ensureNullableUserLanguage } = src('utils', 'i18nSchema.js');
const { languageMiddleware } = src('middleware', 'language.js');
const { authMiddleware } = src('middleware', 'auth.js');

// ─── migration ──────────────────────────────────────────────────────────────

function phase1Db() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
    CREATE TABLE user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      sound_alerts_enabled INTEGER DEFAULT 0,
      sound_volume REAL DEFAULT 0.5,
      alert_sound_critical TEXT DEFAULT 'alarm',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_user_preferences_user ON user_preferences(user_id);
    ALTER TABLE user_preferences ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','tr','ar'));
    INSERT INTO users (email) VALUES ('a@x'), ('b@x'), ('c@x'), ('d@x');
    INSERT INTO user_preferences (user_id, sound_alerts_enabled, sound_volume, alert_sound_critical, language) VALUES (1, 1, 0.8, 'siren', 'tr');
    INSERT INTO user_preferences (user_id, language) VALUES (2, 'ar');
    INSERT INTO user_preferences (user_id) VALUES (3);
  `);
  return d;
}

test('migration: phase-1 NOT NULL DEFAULT en column becomes nullable, every value and column kept, idempotent', () => {
  const d = phase1Db();
  const before = d.prepare('SELECT * FROM user_preferences ORDER BY id').all();

  assert.equal(ensureNullableUserLanguage(d), 'migrated');
  assert.equal(ensureNullableUserLanguage(d), 'ok', 'second run is a no-op');

  const after = d.prepare('SELECT * FROM user_preferences ORDER BY id').all();
  assert.deepEqual(after, before, 'existing users keep their language (en stays en) and all other columns');

  const col = d.pragma('table_info(user_preferences)').find(c => c.name === 'language');
  assert.equal(col.notnull, 0);
  assert.equal(col.dflt_value, null);

  // new row without a language → NULL; invalid code still rejected; explicit reset allowed
  d.prepare('INSERT INTO user_preferences (user_id) VALUES (4)').run();
  assert.equal(d.prepare('SELECT language FROM user_preferences WHERE user_id = 4').get().language, null);
  assert.throws(() => d.prepare("UPDATE user_preferences SET language = 'fr' WHERE user_id = 4").run(), /CHECK/);
  d.prepare('UPDATE user_preferences SET language = NULL WHERE user_id = 1').run();
  assert.equal(d.prepare('SELECT language FROM user_preferences WHERE user_id = 1').get().language, null);

  // index, UNIQUE and foreign key survive
  assert.ok(d.pragma('index_list(user_preferences)').some(i => i.name === 'idx_user_preferences_user'));
  assert.throws(() => d.prepare('INSERT INTO user_preferences (user_id) VALUES (2)').run(), /UNIQUE/);
  d.prepare('DELETE FROM users WHERE id = 2').run();
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 2').get().n, 0, 'ON DELETE CASCADE kept');
});

test('migration: a table without the column gets a nullable one', () => {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE user_preferences (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE)');
  d.exec('INSERT INTO user_preferences (user_id) VALUES (1)');
  assert.equal(ensureNullableUserLanguage(d), 'added');
  assert.equal(ensureNullableUserLanguage(d), 'ok');
  assert.equal(d.prepare('SELECT language FROM user_preferences').get().language, null);
});

test('schema: the app database has a nullable language column with no default', () => {
  const col = db.pragma('table_info(user_preferences)').find(c => c.name === 'language');
  assert.ok(col);
  assert.equal(col.notnull, 0);
  assert.equal(col.dflt_value, null);
});

// ─── HTTP ───────────────────────────────────────────────────────────────────

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', languageMiddleware);
  app.use('/api/auth', src('routes', 'auth.js'));
  app.use('/api/users', authMiddleware, src('routes', 'users.js'));
  app.get('/api/echo-lang', authMiddleware, (req, res) => res.json({ lang: req.lang, source: req.langSource, user: req.user.language }));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise(r => server.close(r)));

const call = (method, p, token, body, headers = {}) => fetch(base + p, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));

const login = (email, password) => call('POST', '/auth/login', null, { email, password });

test('HTTP: never-chosen language is null everywhere; saving sets it; null resets; request language still concrete', async () => {
  // setup wizard creates the first admin without a language
  let r = await call('POST', '/auth/setup', null, { email: 'boss@farm.test', password: 'password123', name: 'Boss' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); // was a 500: datetime("now") under DQS=0

  r = await login('boss@farm.test', 'password123');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.language, null, 'login: null, not en');
  const token = r.body.token;

  r = await call('GET', '/auth/session', token);
  assert.equal(r.body.user.language, null, 'session: null');

  r = await call('GET', '/users/me/preferences', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.language, null, 'preferences: null');

  // no stored preference and no explicit header → request language falls back to en
  r = await call('GET', '/echo-lang', token, undefined, { 'Accept-Language': 'tr-TR,tr;q=0.9' });
  assert.deepEqual(r.body, { lang: 'en', source: 'default', user: null });

  // first sign-in: the frontend writes the device language
  r = await call('PUT', '/users/me/preferences', token, { language: 'ar' });
  assert.equal(r.status, 200);
  assert.equal(r.body.preferences.language, 'ar');
  r = await login('boss@farm.test', 'password123');
  assert.equal(r.body.user.language, 'ar');
  r = await call('GET', '/auth/session', token);
  assert.equal(r.body.user.language, 'ar');
  r = await call('GET', '/echo-lang', token);
  assert.deepEqual(r.body, { lang: 'ar', source: 'user', user: 'ar' });

  // validation unchanged; explicit null resets to "never chosen"
  r = await call('PUT', '/users/me/preferences', token, { language: 'de' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/users/me/preferences', token, { language: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.preferences.language, null);

  // admin-created users: no language → null; given language → kept
  r = await call('POST', '/users', token, { email: 'new@farm.test', password: 'password123', name: 'New', role: 'operator' });
  assert.equal(r.status, 201);
  assert.equal(r.body.language, null);
  const newId = r.body.id;
  r = await call('POST', '/users', token, { email: 'tr@farm.test', password: 'password123', name: 'Tr', role: 'viewer', language: 'tr' });
  assert.equal(r.body.language, 'tr');
  r = await call('GET', `/users/${newId}`, token);
  assert.equal(r.body.language, null);
  r = await call('GET', '/users', token);
  assert.equal(r.body.find(u => u.id === newId).language, null);
  assert.equal(r.body.find(u => u.email === 'tr@farm.test').language, 'tr');
  r = await login('new@farm.test', 'password123');
  assert.equal(r.body.user.language, null);

  // admin can set and clear another user's language
  r = await call('PUT', `/users/${newId}`, token, { language: 'tr' });
  assert.equal(r.status, 200);
  r = await call('GET', `/users/${newId}`, token);
  assert.equal(r.body.language, 'tr');
  r = await call('PUT', `/users/${newId}`, token, { language: null });
  assert.equal(r.status, 200);
  r = await call('GET', `/users/${newId}`, token);
  assert.equal(r.body.language, null);
});
