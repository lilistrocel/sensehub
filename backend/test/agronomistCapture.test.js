// In-memory DB for everything that touches utils/database (AgronomistService import).
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { AGRONOMIST_CAPTURES_SQL } = require(path.join(__dirname, '..', 'src', 'utils', 'agronomistCapturesSchema.js'));
const {
  AgronomistCaptureService, jpegDimensions, buildImageBlock, MAX_EDGE_PX,
} = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistCaptureService.js'));
const { DailyLocalTrigger } = require(path.join(__dirname, '..', 'src', 'services', 'DailyLocalTrigger.js'));

const quiet = { warn() {}, log() {}, error() {} };

/** Minimal JPEG: SOI + SOF0 (height/width) + EOI. Enough for the dimension parser and base64 prefix. */
function fakeJpeg(width, height, padBytes = 0) {
  const sof = Buffer.alloc(2 + 17);
  sof[0] = 0xFF; sof[1] = 0xC0;
  sof.writeUInt16BE(17, 2);        // segment length
  sof[4] = 8;                      // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                      // components
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.alloc(padBytes, 0x41), Buffer.from([0xFF, 0xD9])]);
}

function memDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cameras (id INTEGER PRIMARY KEY, name TEXT, go2rtc_name TEXT, enabled INTEGER DEFAULT 1);
    INSERT INTO cameras (id, name, go2rtc_name, enabled) VALUES (1, 'GreenHouse PTZ', 'greenhouse_1', 1);
  `);
  db.exec(AGRONOMIST_CAPTURES_SQL);
  return db;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agro-cap-'));
}

// ---------------------------------------------------------------------------
// JPEG helpers + image block
// ---------------------------------------------------------------------------

test('jpegDimensions parses SOF0 width/height', () => {
  assert.deepEqual(jpegDimensions(fakeJpeg(2560, 1440)), { width: 2560, height: 1440 });
  assert.equal(jpegDimensions(Buffer.from('not a jpeg')), null);
});

test('buildImageBlock produces a base64 JPEG image block', () => {
  const b = buildImageBlock(fakeJpeg(10, 10));
  assert.equal(b.type, 'image');
  assert.equal(b.source.type, 'base64');
  assert.equal(b.source.media_type, 'image/jpeg');
  assert.ok(b.source.data.startsWith('/9j/'), 'base64 of FF D8 FF starts with /9j/');
  assert.ok(!/\n/.test(b.source.data));
});

// ---------------------------------------------------------------------------
// captureForDate: scaling decision, file + row upsert, preset move
// ---------------------------------------------------------------------------

test('captureForDate downscales via go2rtc when the long edge exceeds 1568 px and upserts one row per day', async () => {
  const db = memDb();
  const root = tmpRoot();
  const calls = [];
  const fetchFrame = async (name, opts) => {
    calls.push({ name, opts });
    if (opts.width) return fakeJpeg(opts.width, Math.round(opts.width * 1440 / 2560), 500);
    return fakeJpeg(2560, 1440, 5000);
  };
  const ptzCalls = [];
  const ptz = { gotoPreset: async (cam, id) => { ptzCalls.push([cam.id, id]); } };
  const svc = new AgronomistCaptureService({ db, rootDir: root, fetchFrame, ptz, sleep: async () => {}, log: quiet,
    now: () => new Date('2026-09-24T08:00:00Z') });

  const row = await svc.captureForDate('2026-09-24', { presetId: 3 });
  assert.deepEqual(ptzCalls, [[1, 3]]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].opts, {});
  assert.deepEqual(calls[1].opts, { width: MAX_EDGE_PX });
  assert.equal(row.width, 1568);
  assert.equal(row.height, 882);
  assert.equal(row.scaled, true);
  assert.equal(row.preset_id, 3);
  assert.equal(row.path, path.join('snapshots', 'agronomist', '1', '2026-09-24.jpg'));
  const abs = path.join(root, row.path);
  assert.ok(fs.existsSync(abs));
  assert.equal(fs.statSync(abs).size, row.bytes);

  // Second capture the same day replaces the row (UNIQUE camera_id+date), no duplicate
  await svc.captureForDate('2026-09-24', {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 1);
  assert.equal(db.prepare('SELECT preset_id FROM agronomist_captures').get().preset_id, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('captureForDate keeps the native frame when it is already small enough, and tolerates a failed preset move', async () => {
  const db = memDb();
  const root = tmpRoot();
  let n = 0;
  const svc = new AgronomistCaptureService({ db, rootDir: root, log: quiet, sleep: async () => {},
    fetchFrame: async () => { n++; return fakeJpeg(1280, 720, 100); },
    ptz: { gotoPreset: async () => { throw new Error('camera unreachable'); } } });
  const row = await svc.captureForDate('2026-09-24', { presetId: 9 });
  assert.equal(n, 1);
  assert.equal(row.scaled, false);
  assert.equal(row.width, 1280);
  assert.match(row.note, /preset 9 move failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getCaptureForReport: today, 36 h fallback, none
// ---------------------------------------------------------------------------

test('getCaptureForReport prefers the report day, falls back to <=36 h, else null', async () => {
  const db = memDb();
  const root = tmpRoot();
  const svc = new AgronomistCaptureService({ db, rootDir: root, log: quiet, fetchFrame: async () => fakeJpeg(100, 50) });
  svc.now = () => new Date('2026-09-23T08:00:00Z');
  await svc.captureForDate('2026-09-23');

  const at = new Date('2026-09-24T16:00:00Z'); // 32 h later
  const r = svc.getCaptureForReport('2026-09-24', { now: at });
  assert.ok(r, 'fallback within 36 h');
  assert.equal(r.capture.capture_date, '2026-09-23');
  assert.equal(r.ageHours, 32);
  assert.ok(Buffer.isBuffer(r.buffer));

  assert.equal(svc.getCaptureForReport('2026-09-25', { now: new Date('2026-09-25T08:00:00Z') }), null);

  svc.now = () => new Date('2026-09-24T08:00:00Z');
  await svc.captureForDate('2026-09-24');
  const today = svc.getCaptureForReport('2026-09-24', { now: at });
  assert.equal(today.capture.capture_date, '2026-09-24');
  assert.equal(today.ageHours, 8);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Request construction (image block before text, valid Sonnet 5 shape)
// ---------------------------------------------------------------------------

test('buildDailyRequest puts the image block before the text block and stays a valid request', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const snapshot = { date: '2026-09-24', timezone: 'Asia/Dubai', sensors: [{ a: 1 }], operator_tasks: [], lab: {} };
  const cfg = { ...agronomistService.getConfig(), model: 'claude-sonnet-5' };
  const buffer = fakeJpeg(1568, 882, 300);
  const capture = { capture: { id: 7, camera_name: 'GreenHouse PTZ', capture_date: '2026-09-24', created_at: '2026-09-24T08:00:00.000Z', preset_id: 2 }, ageHours: 8, buffer };

  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, cfg, capture, clarifications: [], historyBlock: '' });
  assert.equal(requestBody.model, 'claude-sonnet-5');
  assert.equal(requestBody.messages.length, 1);
  assert.equal(requestBody.messages[0].role, 'user');
  const content = requestBody.messages[0].content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.type, 'base64');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.ok(content[0].source.data.startsWith('/9j/'));
  assert.equal(content[0].source.data, buffer.toString('base64'));
  assert.equal(content[1].type, 'text');
  assert.match(content[1].text, /canopy photo from camera "GreenHouse PTZ" \(PTZ preset 2\), captured 24 Sept 2026, 12:00 Asia\/Dubai \(today's noon capture, 8 h old/);
  assert.match(content[1].text, /```json/);
  // no prefill, no sampling params
  assert.ok(!('temperature' in requestBody) && !('top_p' in requestBody) && !('top_k' in requestBody));
  assert.ok(!requestBody.messages.some(m => m.role === 'assistant'));
  assert.equal(requestBody.output_config.format.type, 'json_schema');
  assert.match(requestBody.system[0].text, /Canopy photo:/);
  assert.equal(stats.image_present, true);
  assert.equal(stats.image_bytes, buffer.length);
  assert.equal(stats.capture_id, 7);
  assert.equal(typeof stats.sensors, 'number');
  assert.ok(!('snapshot_stats' in stats));
});

test('buildDailyRequest without a capture sends a single text block that says so, and strips replayed snapshot_stats', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const snapshot = { date: '2026-09-24', timezone: 'Asia/Dubai', sensors: [], snapshot_stats: { sensors: 99 } };
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, capture: null, clarifications: [], historyBlock: '' });
  const content = requestBody.messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /No canopy photo is attached/);
  assert.ok(!content[0].text.includes('snapshot_stats'));
  assert.equal(stats.image_present, false);
  assert.equal(stats.image_bytes, 0);
});

// ---------------------------------------------------------------------------
// Noon schedule: exactly once per local day
// ---------------------------------------------------------------------------

test('DailyLocalTrigger fires exactly once per local day at 12:00 Asia/Dubai (stub clock, 1-min ticks over 3 days)', async () => {
  let clock = Date.parse('2026-09-23T20:00:00Z'); // 00:00 Dubai on the 24th
  const fired = [];
  const t = new DailyLocalTrigger({ hour: 12, minute: 0, tz: 'Asia/Dubai', graceMinutes: 60, now: () => new Date(clock),
    onFire: ({ dateStr }) => { fired.push({ dateStr, utc: new Date(clock).toISOString() }); } });
  for (let i = 0; i < 3 * 24 * 60; i++) {
    t.tick();
    await Promise.resolve(); // let the async onFire settle
    clock += 60_000;
  }
  assert.deepEqual(fired, [
    { dateStr: '2026-09-24', utc: '2026-09-24T08:00:00.000Z' },
    { dateStr: '2026-09-25', utc: '2026-09-25T08:00:00.000Z' },
    { dateStr: '2026-09-26', utc: '2026-09-26T08:00:00.000Z' },
  ]);
});

test('DailyLocalTrigger: restart inside the grace window still fires once; outside it waits for tomorrow; markFired suppresses', async () => {
  let clock = Date.parse('2026-09-24T08:20:00Z'); // 12:20 Dubai
  let n = 0;
  const t = new DailyLocalTrigger({ hour: 12, minute: 0, tz: 'Asia/Dubai', graceMinutes: 60, now: () => new Date(clock), onFire: () => { n++; } });
  assert.equal(t.tick(), '2026-09-24');
  await Promise.resolve();
  assert.equal(t.tick(), null);
  clock += 30 * 60_000; // 12:50 — same day, no refire
  assert.equal(t.tick(), null);
  assert.equal(n, 1);

  let m = 0;
  clock = Date.parse('2026-09-24T09:30:00Z'); // 13:30 Dubai — past grace
  const t2 = new DailyLocalTrigger({ hour: 12, minute: 0, tz: 'Asia/Dubai', graceMinutes: 60, now: () => new Date(clock), onFire: () => { m++; } });
  assert.equal(t2.tick(), null);
  clock = Date.parse('2026-09-25T08:00:00Z');
  assert.equal(t2.tick(), '2026-09-25');
  await Promise.resolve();
  assert.equal(m, 1);

  let k = 0;
  clock = Date.parse('2026-09-24T08:05:00Z');
  const t3 = new DailyLocalTrigger({ hour: 12, minute: 0, tz: 'Asia/Dubai', now: () => new Date(clock), onFire: () => { k++; } });
  t3.markFired('2026-09-24');
  assert.equal(t3.tick(), null);
  assert.equal(k, 0);
});

// ---------------------------------------------------------------------------
// Retention: prune captures older than N days (files + rows)
// ---------------------------------------------------------------------------

test('prune removes files and rows older than the retention window and keeps newer ones', async () => {
  const db = memDb();
  const root = tmpRoot();
  const svc = new AgronomistCaptureService({ db, rootDir: root, log: quiet, fetchFrame: async () => fakeJpeg(100, 50) });
  const dates = ['2026-07-01', '2026-08-20', '2026-08-25', '2026-08-26', '2026-09-20'];
  for (const d of dates) { svc.now = () => new Date(`${d}T08:00:00Z`); await svc.captureForDate(d); }
  svc.now = () => new Date('2026-09-24T10:00:00Z'); // cutoff = 2026-08-25

  const dry = svc.prune(30, true);
  assert.equal(dry.eligible_rows, 2);
  assert.equal(dry.rows_dropped, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 5);

  const res = svc.prune(30, false);
  assert.equal(res.rows_dropped, 2);
  assert.equal(res.files_removed, 2);
  assert.equal(res.cutoff, '2026-08-25');
  const left = db.prepare('SELECT capture_date FROM agronomist_captures ORDER BY capture_date').all().map(r => r.capture_date);
  assert.deepEqual(left, ['2026-08-25', '2026-08-26', '2026-09-20']);
  assert.ok(!fs.existsSync(path.join(root, 'snapshots', 'agronomist', '1', '2026-07-01.jpg')));
  assert.ok(fs.existsSync(path.join(root, 'snapshots', 'agronomist', '1', '2026-09-20.jpg')));
  fs.rmSync(root, { recursive: true, force: true });
});
