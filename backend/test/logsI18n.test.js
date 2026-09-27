// Unified Logs i18n: system item summaries / actor labels rendered at read time
// in tr / ar (English originals kept in *_en), catalog specs reproduce the English,
// alerts render from message_key, search matches both languages. In-memory DB.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { createAlert } = src('utils', 'alertBroadcast.js');
const Unified = src('services', 'UnifiedLogService.js');
const DC = src('services', 'DoseController.js');

// Fresh-DB quirk (same as auditLog.test.js): relay_events read-back columns.
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const hasArabic = (s) => /[؀-ۿ]/.test(s);
const noPlaceholders = (s) => assert.ok(!/\{[a-z_]+\}/i.test(String(s)), `leftover placeholder in: ${s}`);

const mkEq = (name) => Number(db.prepare("INSERT INTO equipment (name, type, protocol, register_mappings) VALUES (?, 'relay', 'modbus', ?)")
  .run(name, JSON.stringify([{ register: 1, label: 'Pump' }, { register: 5, label: 'Irrigation Zone 3' }, { register: 6, label: 'Irrigation Zone 4' }])).lastInsertRowid);
const irrBoard = mkEq('Waveshare Irrigation 1');
const fanBoard = mkEq('Fan Board 1');
const autoId = Number(db.prepare("INSERT INTO automations (name, enabled, trigger_config, actions) VALUES ('Zones 3&4', 1, '{}', '[]')").run().lastInsertRowid);

function seed() {
  const ins = db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, user_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(irrBoard, 1, 1, 'automation', autoId, 1, 1, null, '2026-09-20 10:15:42');
  ins.run(irrBoard, 5, 1, 'automation', autoId, 1, 1, null, '2026-09-20 10:15:43');
  for (const [eq, ch] of [[fanBoard, 1], [irrBoard, 1], [irrBoard, 5], [irrBoard, 6]]) ins.run(eq, ch, 0, 'stop_all', null, null, null, null, '2026-09-20 10:15:54');
  ins.run(fanBoard, 1, 0, 'watchdog_force_off', null, 0, 1, null, '2026-09-20 10:22:30');
  db.prepare("INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, 'success', 'scheduler trigger executed (2 action(s) skipped by dependency)', '2026-09-20 10:15:42', '2026-09-20 10:15:42')").run(autoId);
  db.prepare("INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, 'failure', 'boom', '2026-09-20 09:00:00', '2026-09-20 09:00:00')").run(autoId);
  // one keyed alert (new style) + one legacy English alert
  const keyed = createAlert({ severity: 'warning', source: 'dose_controller', fingerprint: 'dose_controller:ph_sensor', messageKey: DC.ALERT_SPECS.phNotVerifiable('last pH sample 95 s old').$k, messageParams: DC.ALERT_SPECS.phNotVerifiable('last pH sample 95 s old').$p });
  db.prepare("UPDATE alerts SET created_at = '2026-09-20 10:16:30' WHERE id = ?").run(keyed.id);
  db.prepare("INSERT INTO alerts (severity, message, source, equipment_id, created_at, occurrence_count) VALUES ('critical', 'Irrigation stopped: no water', 'flow_watch', ?, '2026-09-20 10:16:00', 3)").run(irrBoard);
  db.prepare("INSERT INTO irrigation_flow_episodes (kind, equipment_id, channel, zone_name, started_at, ended_at, duration_s, recovered, alarmed, severity, dosing_aborted, detail_json) VALUES ('run_shutdown', ?, 6, 'Irrigation Zone 4', '2026-09-20T10:17:00.000Z', '2026-09-20T10:19:05.000Z', 125, 0, 1, 'critical', 1, ?)")
    .run(irrBoard, JSON.stringify({ retry: { attempt: 1, outcome: 'failed' }, zones_not_irrigated: ['Irrigation Zone 4', 'Irrigation Zone 5'] }));
  db.prepare("INSERT INTO irrigation_runs (run_key, type, status, started_at, ended_at, local_date, duration_s, water_l, automation_id, detail_json) VALUES ('a:1', 'automated', 'cut_short', '2026-09-20T10:15:42.000Z', '2026-09-20T10:25:00.000Z', '2026-09-20', 558, 1234.56, ?, '{}')").run(autoId);
  db.prepare("INSERT INTO irrigation_runs (run_key, type, status, started_at, ended_at, local_date, duration_s, water_l, uncontrolled_dosing, detail_json) VALUES ('c:9', 'manual_panel', 'manual', '2026-09-20T09:30:00.000Z', '2026-09-20T09:40:00.000Z', '2026-09-20', 600, 800, 1, '{}')").run();
  db.prepare("INSERT INTO dose_controller_runs (automation_id, started_at, ended_at, local_date, status, end_reason, water_l, ph_avg, ec_avg) VALUES (?, '2026-09-20T10:15:45.000Z', '2026-09-20T10:24:00.000Z', '2026-09-20', 'aborted', 'stop-all requested', 1100.4, 5.84, 1830.2)").run(autoId);
  db.prepare("INSERT INTO relay_drift_log (equipment_id, equipment_name, channel, expected_state, actual_state, context, created_at) VALUES (?, 'Waveshare Irrigation 1', 5, 0, 1, 'polling_drift', '2026-09-20 10:30:00')").run(irrBoard);
}

const Q = { from: '2026-09-20T08:00:00Z', to: '2026-09-20T11:00:00Z', limit: 200 };

test('logs: catalog specs render the same English as the English code path', () => {
  Unified._resetAuditEraCache();
  seed();
  const en = Unified.queryLogs(Q, { lang: 'en' }).items;
  const forced = Unified.queryLogs(Q, { lang: 'en', renderSpecs: true }).items;
  assert.ok(en.length >= 11, `items: ${en.length}`);
  assert.equal(forced.length, en.length);
  for (let i = 0; i < en.length; i++) {
    assert.equal(forced[i].summary, en[i].summary, `${en[i].id} summary`);
    assert.equal(forced[i].actor_label, en[i].actor_label, `${en[i].id} actor_label`);
    assert.equal(forced[i].target_name, en[i].target_name, `${en[i].id} target_name`);
    assert.equal(en[i]._i18n, undefined, 'internal specs stripped');
  }
});

test('logs: tr / ar render summaries + actor labels at read time; English kept in *_en; alerts from message_key', () => {
  const en = Unified.queryLogs(Q, { lang: 'en' }).items;
  const byId = (items, id) => items.find(i => i.id === id);
  for (const lang of ['tr', 'ar']) {
    const items = Unified.queryLogs(Q, { lang }).items;
    assert.equal(items.length, en.length);
    for (const it of items) {
      const e = byId(en, it.id);
      if (it.source === 'request' || it.source === 'audit') continue;
      noPlaceholders(it.summary);
      assert.notEqual(it.summary, e.summary, `${lang} ${it.id} summary untranslated: ${it.summary}`);
      assert.equal(it.summary_en, e.summary);
      if (lang === 'ar') assert.ok(hasArabic(it.summary), it.summary);
    }
  }
  const tr = Unified.queryLogs(Q, { lang: 'tr' }).items;
  const stop = tr.find(i => i.action === 'relay.stop_all');
  assert.match(stop.summary, /^Tümünü Durdur KAPATTI: 2 panoda 4 kanal/);
  assert.equal(stop.actor_label, 'Tümünü Durdur');
  const auto = tr.find(i => i.action === 'relay.automation');
  assert.equal(auto.actor_label, "Otomasyon 'Zones 3&4'");
  assert.equal(auto.actor_label_en, "Automation 'Zones 3&4'");
  const ran = tr.find(i => i.action === 'automation.run');
  assert.match(ran.summary, /'Zones 3&4' çalıştı \(zamanlama\) — 2 eylem bağımlılıklar nedeniyle bekletildi/);
  const keyed = tr.find(i => i.source === 'alert' && /pH/.test(i.summary_en));
  assert.match(keyed.summary, /^UYARI uyarısı: Doz kontrolcüsü: besleme pH değeri doğrulanamıyor \(son pH örneği 95 sn önce\)/);
  assert.match(keyed.target_name, /^Doz kontrolcüsü/);
  const legacy = tr.find(i => i.source === 'alert' && /no water/.test(i.summary_en));
  assert.equal(legacy.summary, 'KRİTİK uyarısı: Irrigation stopped: no water (×3)', 'legacy alert text stays English, wrapper translated');
  const flow = tr.find(i => i.source === 'flow');
  assert.match(flow.summary, /Debi izleme sulama çalışmasını durdurdu — Irrigation Zone 4 2:05 boyunca; soğuk yeniden başlatma denemesi #1 başarısız; sulanmayan: Irrigation Zone 4, Irrigation Zone 5; dozlama iptal edildi/);
  const dose = tr.find(i => i.source === 'dose_run');
  assert.match(dose.summary, /1100\.4 L su, ort\. pH 5\.84, ort\. EC 1830 — iptal edildi \(Tümünü Durdur istendi\)/);
  const panel = tr.find(i => i.action === 'irrigation.run_manual_panel');
  assert.equal(panel.actor_label, 'Panodaki biri');
  assert.match(panel.summary, /kontrolsüz dozlama/);

  const ar = Unified.queryLogs(Q, { lang: 'ar' }).items;
  const arStop = ar.find(i => i.action === 'relay.stop_all');
  assert.match(arStop.summary, /4 قنوات على 2 لوحات/, 'Arabic plural "few" + Western digits');
  const arFlow = ar.find(i => i.source === 'flow');
  assert.match(arFlow.summary, /Irrigation Zone 4، Irrigation Zone 5/, 'Arabic list separator');
  const drift = ar.find(i => i.source === 'drift');
  assert.match(drift.summary, /المتوقع متوقف، المقروء مشغّل/);
});

test('logs: q search matches the English and the localized text; detail endpoint localized', () => {
  const trHit = Unified.queryLogs({ ...Q, q: 'kapattı' }, { lang: 'tr' }).items;
  assert.ok(trHit.some(i => i.action === 'relay.stop_all'), 'Turkish word finds the item');
  const enHit = Unified.queryLogs({ ...Q, q: 'switched off' }, { lang: 'tr' }).items;
  assert.ok(enHit.some(i => i.action === 'relay.stop_all'), 'English word still finds it in tr');
  const alertRow = db.prepare("SELECT id FROM alerts WHERE message_key IS NOT NULL").get();
  const d = Unified.getLogDetail('alert', String(alertRow.id), { lang: 'ar' });
  assert.ok(hasArabic(d.item.summary));
  assert.ok(hasArabic(d.details.message), 'detail alert message localized');
  assert.match(d.details.message_en, /^Dose controller: feed pH not verifiable/);
  const dEn = Unified.getLogDetail('alert', String(alertRow.id));
  assert.match(dEn.item.summary, /^WARNING alert: Dose controller/);
});
