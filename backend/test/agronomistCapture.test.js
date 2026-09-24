// In-memory DB for everything that touches utils/database (AgronomistService import).
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const jpeg = require('jpeg-js');

const { AGRONOMIST_CAPTURES_SQL, ensureAgronomistCapturesSchema, needsRebuild } = require(path.join(__dirname, '..', 'src', 'utils', 'agronomistCapturesSchema.js'));
const {
  AgronomistCaptureService, jpegDimensions, buildImageBlock, describeSelection, MAX_EDGE_PX, MAX_IMAGES_PER_REPORT,
} = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistCaptureService.js'));
const { sharpnessScore, downscaleJpeg } = require(path.join(__dirname, '..', 'src', 'services', 'ImageSharpness.js'));
const { DailyLocalTrigger } = require(path.join(__dirname, '..', 'src', 'services', 'DailyLocalTrigger.js'));

const quiet = { warn() {}, log() {}, error() {} };
const TZ = 'Asia/Dubai'; // UTC+4, no DST

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

/** Real (decodable) grayscale JPEG from a pixel function. */
function synthJpeg(w, h, fn, quality = 90) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, quality).data);
}
const checker = (x, y) => (((x >> 3) + (y >> 3)) & 1 ? 230 : 20);
const blurredChecker = (x, y) => { let s = 0; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) s += checker(x + dx, y + dy); return s / 81; };
const gradient = w => (x) => 255 * x / w;

function memDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cameras (id INTEGER PRIMARY KEY, name TEXT, go2rtc_name TEXT, enabled INTEGER DEFAULT 1);
    INSERT INTO cameras (id, name, go2rtc_name, enabled) VALUES (1, 'GreenHouse PTZ', 'greenhouse_1', 1);
    CREATE TABLE camera_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id INTEGER NOT NULL, filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0, captured_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  db.exec(AGRONOMIST_CAPTURES_SQL);
  return db;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agro-cap-'));
}

/** A service with a fake clock, fake sharpness (per-frame list) and no real sleeping. */
function makeSvc({ db = memDb(), root = tmpRoot(), sharpness = null, frames = null, now = '2026-09-24T08:00:00Z', tz = TZ } = {}) {
  let clock = Date.parse(now);
  const sleeps = [];
  let i = 0, k = 0;
  const svc = new AgronomistCaptureService({
    db, rootDir: root, log: quiet, tz,
    now: () => new Date(clock),
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    fetchFrame: frames || (async () => fakeJpeg(1280, 720, 10 + (i++ % 7))),
    sharpness: sharpness ? (() => sharpness[k++ % sharpness.length]) : undefined,
  });
  svc._test = { sleeps, setClock: iso => { clock = Date.parse(iso); }, get clock() { return clock; } };
  return svc;
}

/** Register a 4-hourly snapshot file + row like SnapshotService does. */
function addSnapshot(svc, iso, buf = synthJpeg(64, 48, checker)) {
  const filename = `cam_1_${iso.replace(/[:.]/g, '-')}.jpg`;
  const dir = path.join(svc.rootDir, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buf);
  const r = svc.db.prepare('INSERT INTO camera_snapshots (camera_id, filename, file_size, captured_at) VALUES (1, ?, ?, ?)').run(filename, buf.length, iso);
  return r.lastInsertRowid;
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
// Sharpness (variance of the Laplacian, pure JS via jpeg-js)
// ---------------------------------------------------------------------------

test('sharpnessScore ranks a sharp checkerboard above its blurred copy above a smooth gradient, and is not fooled by sensor grain', () => {
  const sharp = sharpnessScore(synthJpeg(400, 300, checker));
  const blurred = sharpnessScore(synthJpeg(400, 300, blurredChecker));
  const smooth = sharpnessScore(synthJpeg(400, 300, gradient(400)));
  assert.equal(sharp.width, 400);
  assert.ok(sharp.sharpness > 2000, `sharp ${sharp.sharpness}`);
  assert.ok(blurred.sharpness < sharp.sharpness / 10, `blurred ${blurred.sharpness} vs sharp ${sharp.sharpness}`);
  assert.ok(smooth.sharpness < 5, `gradient ${smooth.sharpness}`);
  assert.ok(smooth.sharpness < blurred.sharpness);
  // Pure grain (no structure) must NOT outscore a real, sharp frame — the raw Laplacian did.
  let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const grain = sharpnessScore(synthJpeg(1568, 882, () => 128 + (rnd() * 2 - 1) * 60));
  const structure = sharpnessScore(synthJpeg(1568, 882, (x, y) => (((x >> 5) + (y >> 5)) & 1 ? 200 : 60) + (rnd() * 2 - 1) * 12));
  assert.ok(structure.sharpness > grain.sharpness * 2, `structure ${structure.sharpness} vs grain ${grain.sharpness}`);
});

test('sharpnessScore subsamples large frames to <= 512 px wide and ignores the outer 10 % border', () => {
  // Sharp texture only in the border, flat centre: must score ~0.
  const borderOnly = (x, y) => (x < 30 || x > 570 || y < 20 || y > 380 ? checker(x, y) : 128);
  const s = sharpnessScore(synthJpeg(600, 400, borderOnly));
  assert.equal(s.sampleWidth, 300);
  assert.ok(s.sharpness < 5, `border-only texture leaked into the score: ${s.sharpness}`);
});

test('downscaleJpeg shrinks the long edge to the limit and leaves small images untouched', () => {
  const big = synthJpeg(800, 500, checker);
  const d = downscaleJpeg(big, 400);
  assert.equal(d.scaled, true);
  assert.deepEqual([d.width, d.height], [400, 250]);
  assert.deepEqual(jpegDimensions(d.buffer), { width: 400, height: 250 });
  const same = downscaleJpeg(big, 1568);
  assert.equal(same.scaled, false);
  assert.equal(same.buffer, big);
});

// ---------------------------------------------------------------------------
// captureForDate: a session of N frames, spacing, scoring, files + rows
// ---------------------------------------------------------------------------

test('captureForDate takes a 3-frame session ~30 s apart, stores <date>-<n>.jpg per frame, scores and returns the sharpest', async () => {
  const svc = makeSvc({ sharpness: [120, 480, 300] });
  const calls = [];
  svc.fetchFrame = async (name, opts) => {
    calls.push(opts);
    if (opts.width) return fakeJpeg(opts.width, Math.round(opts.width * 1440 / 2560), 500);
    return fakeJpeg(2560, 1440, 5000);
  };
  const ptzCalls = [];
  svc._ptz = { gotoPreset: async (cam, id) => { ptzCalls.push([cam.id, id]); } }; svc._ptzResolved = true;

  const row = await svc.captureForDate('2026-09-24', { presetId: 3, source: 'noon', frames: 3, spacingMs: 30_000 });
  assert.deepEqual(ptzCalls, [[1, 3]]);
  assert.deepEqual(svc._test.sleeps, [5000, 30_000, 30_000], 'preset settle then two 30 s gaps');
  assert.equal(calls.length, 6, 'native + scaled fetch per frame');
  assert.deepEqual(calls[1], { width: MAX_EDGE_PX });

  assert.equal(row.frames.length, 3);
  assert.deepEqual(row.frames.map(f => f.sequence), [1, 2, 3]);
  assert.deepEqual(row.frames.map(f => f.sharpness), [120, 480, 300]);
  assert.deepEqual(row.frames.map(f => f.source), ['noon', 'noon', 'noon']);
  assert.deepEqual(row.frames.map(f => f.path), [1, 2, 3].map(n => path.join('snapshots', 'agronomist', '1', `2026-09-24-${n}.jpg`)));
  assert.deepEqual(row.frames.map(f => f.captured_at), ['2026-09-24T08:00:05.000Z', '2026-09-24T08:00:35.000Z', '2026-09-24T08:01:05.000Z']);
  for (const f of row.frames) assert.equal(fs.statSync(path.join(svc.rootDir, f.path)).size, f.bytes);
  // top level = the best (sharpest) frame, for compatibility
  assert.equal(row.sequence, 2);
  assert.equal(row.sharpness, 480);
  assert.equal(row.session.best_id, row.id);
  assert.equal(row.width, 1568);
  assert.equal(row.scaled, true);
  assert.equal(row.preset_id, 3);

  // A noon re-run the same day REPLACES the session (still 3 rows, new ids)
  const again = await svc.captureForDate('2026-09-24', { source: 'noon' });
  assert.equal(svc.db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 3);
  assert.ok(again.frames[0].id > row.frames[2].id);
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('captureForDate: manual sessions accumulate with a time-tagged filename; frames clamp to 1..5; one failed frame does not abort the session', async () => {
  const svc = makeSvc({ sharpness: [50, 60, 70, 80, 90, 100] });
  const a = await svc.captureForDate('2026-09-24', { frames: 9, spacingMs: 0 }); // default source manual, clamped to 5
  assert.equal(a.frames.length, 5);
  assert.equal(a.source, 'manual');
  assert.match(a.frames[0].path, /2026-09-24-manual-120000-1\.jpg$/); // session start 08:00:00 UTC = 12:00:00 Dubai
  svc._test.setClock('2026-09-24T09:00:00Z');
  const b = await svc.captureForDate('2026-09-24', { frames: 2, spacingMs: 0 });
  assert.equal(svc.db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 7);
  assert.match(b.frames[0].path, /2026-09-24-manual-130000-1\.jpg$/);

  let n = 0;
  svc.fetchFrame = async () => { n++; if (n === 2) throw new Error('go2rtc frame failed (500)'); return fakeJpeg(800, 600, n); };
  const c = await svc.captureForDate('2026-09-25', { frames: 3, spacingMs: 0 });
  assert.equal(c.frames.length, 2);
  assert.deepEqual(c.frames.map(f => f.sequence), [1, 3]);
  assert.match(c.note, /frame 2 failed/);

  svc.fetchFrame = async () => { throw new Error('camera offline'); };
  await assert.rejects(() => svc.captureForDate('2026-09-26', { frames: 2, spacingMs: 0 }), /no frame captured \(camera offline\)/);
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('captureForDate with real scoring: the sharp frame of a session comes first for the report', async () => {
  const bufs = [synthJpeg(320, 240, blurredChecker), synthJpeg(320, 240, checker), synthJpeg(320, 240, gradient(320))];
  let k = 0;
  const svc = makeSvc({ frames: async () => bufs[k++ % 3] });
  const row = await svc.captureForDate('2026-09-24', { source: 'noon', frames: 3, spacingMs: 0 });
  assert.equal(row.sequence, 2, 'checkerboard (frame 2) is the sharpest');
  const sel = svc.getCapturesForReport('2026-09-24', { now: new Date('2026-09-24T16:00:00Z') });
  assert.equal(sel.mode, 'noon');
  assert.deepEqual(sel.items.map(i => i.capture.sequence), [2, 1, 3]);
  assert.ok(sel.items[0].capture.sharpness > sel.items[1].capture.sharpness && sel.items[1].capture.sharpness > sel.items[2].capture.sharpness);
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getCapturesForReport: noon session → manual (daylight) → 4-hourly fallback → latest daytime → manual night → null
// ---------------------------------------------------------------------------

test('selection (a): today\'s noon session, sharpest first, capped at 3 (cost guard)', async () => {
  const svc = makeSvc({ sharpness: [10, 500, 300, 900, 20] });
  await svc.captureForDate('2026-09-24', { source: 'noon', frames: 5, spacingMs: 30_000 });
  const now = new Date('2026-09-24T16:00:00Z'); // 20:00 Dubai
  const sel = svc.getCapturesForReport('2026-09-24', { now });
  assert.equal(sel.mode, 'noon');
  assert.equal(sel.items.length, MAX_IMAGES_PER_REPORT);
  assert.deepEqual(sel.items.map(i => i.capture.sharpness), [900, 500, 300]);
  assert.deepEqual(sel.items.map(i => i.capture.sequence), [4, 2, 3]);
  assert.equal(sel.items[0].ageHours, 8);
  assert.ok(Buffer.isBuffer(sel.items[0].buffer));
  assert.equal(sel.total_bytes, sel.items.reduce((a, i) => a + i.buffer.length, 0));
  // limit > 3 is still capped; limit 2 respected
  assert.equal(svc.getCapturesForReport('2026-09-24', { now, limit: 9 }).items.length, 3);
  assert.equal(svc.getCapturesForReport('2026-09-24', { now, limit: 2 }).items.length, 2);
  assert.equal(describeSelection(sel, { date: '2026-09-24', tz: TZ }),
    "3 canopy frames from today's 12:00 session (sharpest first: 12:01:30, 12:00:30, 12:01:00)");
  // legacy single-image accessor = the best frame
  const one = svc.getCaptureForReport('2026-09-24', { now });
  assert.equal(one.capture.sharpness, 900);
  assert.equal(one.mode, 'noon');
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('selection (b): no noon session → today\'s manual daylight session (latest session only)', async () => {
  const svc = makeSvc({ sharpness: [100, 200, 300, 400, 500] });
  svc._test.setClock('2026-09-24T05:00:00Z'); // 09:00 Dubai
  await svc.captureForDate('2026-09-24', { frames: 2, spacingMs: 0 });
  svc._test.setClock('2026-09-24T10:30:00Z'); // 14:30 Dubai
  const later = await svc.captureForDate('2026-09-24', { frames: 3, spacingMs: 0 });
  const sel = svc.getCapturesForReport('2026-09-24', { now: new Date('2026-09-24T16:00:00Z') });
  assert.equal(sel.mode, 'manual');
  assert.deepEqual(sel.items.map(i => i.capture.id).sort(), later.frames.map(f => f.id).sort());
  assert.deepEqual(sel.items.map(i => i.capture.sharpness), [500, 400, 300]);
  assert.equal(describeSelection(sel, { date: '2026-09-24', tz: TZ }),
    "No noon session today; 3 canopy frames from today's 14:30 manual capture (sharpest first: 14:30:00, 14:30:00, 14:30:00)");
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('selection (c): no session → 4-hourly snapshots 10:00-14:00 local, newest first, registered as fallback_4h rows (idempotent, downscaled, scored)', async () => {
  const svc = makeSvc({});
  svc.maxEdgePx = 100;
  const early = addSnapshot(svc, '2026-09-24T05:11:00.000Z');                                  // 09:11 — outside window
  const s1 = addSnapshot(svc, '2026-09-24T06:59:00.000Z', synthJpeg(200, 150, blurredChecker)); // 10:59
  const s2 = addSnapshot(svc, '2026-09-24T09:11:00.000Z', synthJpeg(200, 150, checker));        // 13:11
  addSnapshot(svc, '2026-09-24T10:30:00.000Z');                                                 // 14:30 — outside
  addSnapshot(svc, '2026-09-23T08:00:00.000Z');                                                 // yesterday noon — wrong day
  const now = new Date('2026-09-24T16:00:00Z');
  const sel = svc.getCapturesForReport('2026-09-24', { now });
  assert.equal(sel.mode, 'fallback_4h');
  assert.equal(sel.items.length, 2);
  assert.deepEqual(sel.items.map(i => i.capture.captured_at), ['2026-09-24T09:11:00.000Z', '2026-09-24T06:59:00.000Z']);
  assert.deepEqual(sel.items.map(i => i.capture.source), ['fallback_4h', 'fallback_4h']);
  assert.deepEqual(sel.items.map(i => i.capture.sequence), [1, 2]);
  assert.deepEqual(sel.items.map(i => i.capture.path), [s2, s1].map(id => path.join('snapshots', 'agronomist', '1', `2026-09-24-f${id}.jpg`)));
  assert.equal(sel.items[0].capture.width, 100, 'fallback frame downscaled to the long-edge limit');
  assert.ok(sel.items[0].capture.sharpness > sel.items[1].capture.sharpness, 'checkerboard scores above blurred');
  assert.equal(sel.items[0].ageHours, 6.8);
  assert.equal(describeSelection(sel, { date: '2026-09-24', tz: TZ }), 'No noon session today; 2 frames from the 4-hourly snapshots at 13:11 and 10:59');
  void early;

  // idempotent: same rows, no duplicates
  const again = svc.getCapturesForReport('2026-09-24', { now });
  assert.deepEqual(again.items.map(i => i.capture.id), sel.items.map(i => i.capture.id));
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM agronomist_captures WHERE source = 'fallback_4h'").get().n, 2);
  // --ignore-noon style: a noon session exists but is skipped → same fallback
  await svc.captureForDate('2026-09-24', { source: 'noon', frames: 1, spacingMs: 0 });
  assert.equal(svc.getCapturesForReport('2026-09-24', { now }).mode, 'noon');
  assert.equal(svc.getCapturesForReport('2026-09-24', { now, ignoreSession: true }).mode, 'fallback_4h');
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('selection (d)/(e)/(none): latest daytime frame within 36 h with its age; manual night session as last resort; null otherwise', async () => {
  const svc = makeSvc({ sharpness: [400, 100, 250] });
  // yesterday's noon session (12:00 Dubai = 08:00Z on the 23rd) → 32 h old at 20:00 Dubai on the 24th
  svc._test.setClock('2026-09-23T08:00:00Z');
  await svc.captureForDate('2026-09-23', { source: 'noon', frames: 3, spacingMs: 0 });
  const now = new Date('2026-09-24T16:00:00Z');
  let sel = svc.getCapturesForReport('2026-09-24', { now });
  assert.equal(sel.mode, 'latest');
  assert.equal(sel.items.length, 1, 'single image');
  assert.equal(sel.items[0].capture.capture_date, '2026-09-23');
  assert.equal(sel.items[0].capture.sequence, 1, 'the newest daytime frame, not the sharpest');
  assert.equal(sel.items[0].ageHours, 32);
  assert.equal(describeSelection(sel, { date: '2026-09-24', tz: TZ }), 'No daytime capture today; latest frame is from 12:00 yesterday (32 h old)');

  // a night-time manual capture today does NOT beat yesterday's daylight frame...
  svc._test.setClock('2026-09-24T16:06:00Z'); // 20:06 Dubai
  await svc.captureForDate('2026-09-24', { frames: 3, spacingMs: 0 });
  assert.equal(svc.getCapturesForReport('2026-09-24', { now: new Date('2026-09-24T16:30:00Z') }).mode, 'latest');
  // ...but is the last resort once nothing daytime is within 36 h
  const late = new Date('2026-09-24T21:00:00Z'); // 01:00 on the 25th Dubai, yesterday's noon is 37 h old
  sel = svc.getCapturesForReport('2026-09-24', { now: late });
  assert.equal(sel.mode, 'manual_night');
  assert.equal(sel.items.length, 3);
  assert.equal(describeSelection(sel, { date: '2026-09-24', tz: TZ }),
    "No daytime capture within 36 h; 3 frames from today's 20:06 manual capture taken outside daylight hours (sharpest first: 20:06:00, 20:06:00, 20:06:00)");

  assert.equal(svc.getCapturesForReport('2026-09-27', { now: new Date('2026-09-27T16:00:00Z') }), null);
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

test('listCapturesGrouped groups frames per day with the best frame id', async () => {
  const svc = makeSvc({ sharpness: [10, 30, 20] });
  await svc.captureForDate('2026-09-24', { source: 'noon', frames: 3, spacingMs: 0 });
  svc._test.setClock('2026-09-23T08:00:00Z');
  await svc.captureForDate('2026-09-23', { source: 'noon', frames: 3, spacingMs: 0 });
  svc._test.setClock('2026-09-24T12:00:00Z');
  const groups = svc.listCapturesGrouped({ days: 7 });
  assert.deepEqual(groups.map(g => g.date), ['2026-09-24', '2026-09-23']);
  assert.equal(groups[0].frames.length, 3);
  assert.equal(groups[0].frames.find(f => f.id === groups[0].best_id).sharpness, 30);
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Request construction (image blocks before text, photo line wording, cap)
// ---------------------------------------------------------------------------

function svcFor(agronomistService) {
  return { cfg: { ...agronomistService.getConfig(), model: 'claude-sonnet-5' }, snapshot: { date: '2026-09-24', timezone: TZ, sensors: [{ a: 1 }], operator_tasks: [], lab: {} } };
}
function item({ id, seq, sharp, at, date = '2026-09-24', source = 'noon', age = 8, bytes = 300 }) {
  return { capture: { id, camera_name: 'GreenHouse PTZ', capture_date: date, created_at: at, captured_at: at, preset_id: 2, sequence: seq, sharpness: sharp, source }, ageHours: age, buffer: fakeJpeg(1568, 882, bytes) };
}

test('buildDailyRequest puts up to 3 image blocks (sharpest first) before the text and words the noon session exactly', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const { cfg, snapshot } = svcFor(agronomistService);
  const items = [
    item({ id: 7, seq: 1, sharp: 412.4, at: '2026-09-24T08:00:00.000Z', bytes: 300 }),
    item({ id: 8, seq: 2, sharp: 380, at: '2026-09-24T08:00:30.000Z', bytes: 200 }),
    item({ id: 9, seq: 3, sharp: 95, at: '2026-09-24T08:01:00.000Z', bytes: 100 }),
  ];
  const capture = { mode: 'noon', date: '2026-09-24', tz: TZ, items };
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, cfg, capture, clarifications: [], historyBlock: '' });
  assert.equal(requestBody.model, 'claude-sonnet-5');
  const content = requestBody.messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['image', 'image', 'image', 'text']);
  assert.equal(content[0].source.data, items[0].buffer.toString('base64'));
  assert.equal(content[2].source.data, items[2].buffer.toString('base64'));
  const text = content[3].text;
  assert.match(text, /The 3 images above are from camera "GreenHouse PTZ" \(PTZ preset 2\), times in Asia\/Dubai: 3 canopy frames from today's 12:00 session \(sharpest first: 12:00:00, 12:00:30, 12:01:00\)\./);
  assert.match(text, /Sharpness scores \(variance of Laplacian, higher = sharper\): 412, 380, 95\./);
  assert.match(text, /same scene seconds to minutes apart: use the sharpest for detail/);
  assert.match(text, /```json/);
  assert.match(requestBody.system[0].text, /Canopy photos:/);
  assert.match(requestBody.system[0].text, /SAME scene taken seconds to minutes apart/);
  assert.ok(!('temperature' in requestBody) && !requestBody.messages.some(m => m.role === 'assistant'));
  assert.equal(requestBody.output_config.format.type, 'json_schema');
  assert.equal(stats.image_present, true);
  assert.equal(stats.image_count, 3);
  assert.equal(stats.image_bytes, items.reduce((a, i) => a + i.buffer.length, 0));
  assert.equal(stats.image_base64_chars, content.slice(0, 3).reduce((a, c) => a + c.source.data.length, 0));
  assert.equal(stats.capture_id, 7);
  assert.deepEqual(stats.capture_ids, [7, 8, 9]);
  assert.equal(stats.capture_mode, 'noon');
  assert.ok(stats.photo_line.startsWith('The 3 images above'));
  assert.ok(!('snapshot_stats' in stats));
});

test('buildDailyRequest caps at 3 images even if the selection has more, and honours capture_frames_to_send', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const { cfg, snapshot } = svcFor(agronomistService);
  const items = [1, 2, 3, 4, 5].map(n => item({ id: n, seq: n, sharp: 600 - n * 100, at: `2026-09-24T08:0${n}:00.000Z` }));
  const capture = { mode: 'noon', items };
  let r = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, cfg: { ...cfg, capture_frames_to_send: 9 }, capture, clarifications: [], historyBlock: '' });
  assert.equal(r.requestBody.messages[0].content.filter(c => c.type === 'image').length, 3);
  assert.deepEqual(r.stats.capture_ids, [1, 2, 3]);
  assert.match(r.stats.photo_line, /3 canopy frames from today's 12:01 session/);
  r = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, cfg: { ...cfg, capture_frames_to_send: 1 }, capture, clarifications: [], historyBlock: '' });
  assert.equal(r.requestBody.messages[0].content.filter(c => c.type === 'image').length, 1);
  assert.match(r.stats.photo_line, /^The image above is .*1 canopy frame from today's 12:01 session \(sharpest first: 12:01:00\)\./);
});

test('buildDailyRequest photo line: 4-hourly fallback, latest daytime frame, manual night — never called the noon capture', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const { cfg, snapshot } = svcFor(agronomistService);
  const build = capture => agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, cfg, capture, clarifications: [], historyBlock: '' }).stats.photo_line;

  const fb = build({ mode: 'fallback_4h', items: [
    item({ id: 20, seq: 1, sharp: 8100, at: '2026-09-24T08:00:00.000Z', source: 'fallback_4h', age: 8 }),
    item({ id: 21, seq: 2, sharp: 7000, at: '2026-09-24T04:00:00.000Z', source: 'fallback_4h', age: 12 }),
  ] });
  assert.match(fb, /No noon session today; 2 frames from the 4-hourly snapshots at 12:00 and 08:00\./);
  assert.match(fb, /routine 4-hourly monitoring snapshots, NOT the noon canopy session/);
  assert.ok(!/today's noon capture/.test(fb));

  const latest = build({ mode: 'latest', items: [item({ id: 5, seq: 1, sharp: 1360, at: '2026-09-23T16:06:00.000Z', date: '2026-09-23', source: 'manual', age: 18 })] });
  assert.match(latest, /^The image above is from camera "GreenHouse PTZ" \(PTZ preset 2\), times in Asia\/Dubai: No daytime capture today; latest frame is from 20:06 yesterday \(18 h old\)\./);
  assert.match(latest, /NOT from today \(capture date 2026-09-23, 18 h old at report time\)\. State its age/);

  const night = build({ mode: 'manual_night', items: [item({ id: 30, seq: 1, sharp: 1300, at: '2026-09-24T16:06:00.000Z', source: 'manual', age: 1 })] });
  assert.match(night, /No daytime capture within 36 h; 1 frame from today's 20:06 manual capture taken outside daylight hours/);
  assert.match(night, /outside daylight hours \(likely IR\/night mode\)/);

  // legacy single-capture shape still accepted (dry-run --capture file)
  const legacy = build({ capture: { id: 1, camera_name: 'GreenHouse PTZ', capture_date: '2026-09-24', created_at: '2026-09-24T08:00:00.000Z', captured_at: '2026-09-24T08:00:00.000Z', sequence: 1, sharpness: 500, source: 'noon' }, ageHours: 8, buffer: fakeJpeg(100, 50, 10) });
  assert.match(legacy, /1 canopy frame from today's 12:00 session \(sharpest first: 12:00:00\)/);
});

test('buildDailyRequest without a capture sends a single text block that says so, and strips replayed snapshot_stats', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const snapshot = { date: '2026-09-24', timezone: TZ, sensors: [], snapshot_stats: { sensors: 99 } };
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: '2026-09-24', snapshot, capture: null, clarifications: [], historyBlock: '' });
  const content = requestBody.messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /No canopy photo is attached/);
  assert.ok(!content[0].text.includes('snapshot_stats'));
  assert.equal(stats.image_present, false);
  assert.equal(stats.image_count, 0);
  assert.equal(stats.image_bytes, 0);
  assert.deepEqual(stats.capture_ids, []);
});

test('saveConfig clamps the session settings', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const c = agronomistService.saveConfig({ capture_frames: 12, capture_spacing_seconds: 1, capture_frames_to_send: 7 });
  const saved = agronomistService.getConfig();
  assert.equal(saved.capture_frames, 5);
  assert.equal(saved.capture_spacing_seconds, 5);
  assert.equal(saved.capture_frames_to_send, 3);
  void c;
  agronomistService.saveConfig({ capture_frames: 3, capture_spacing_seconds: 30, capture_frames_to_send: 3 });
});

// ---------------------------------------------------------------------------
// Migration: v1 (UNIQUE camera_id+date) → v2 multi-frame, on a file DB with FKs on
// ---------------------------------------------------------------------------

test('ensureAgronomistCapturesSchema rebuilds a v1 table keeping rows, ids and the reports FK; relabels off-noon rows; idempotent', () => {
  const root = tmpRoot();
  const db = new Database(path.join(root, 'copy.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE cameras (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO cameras VALUES (1, 'GreenHouse PTZ');
    CREATE TABLE agronomist_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id INTEGER NOT NULL, capture_date TEXT NOT NULL, path TEXT NOT NULL,
      width INTEGER, height INTEGER, bytes INTEGER DEFAULT 0, preset_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(camera_id, capture_date));
    CREATE INDEX idx_agronomist_captures_date ON agronomist_captures(capture_date);
    INSERT INTO agronomist_captures (id, camera_id, capture_date, path, width, height, bytes, preset_id, created_at)
      VALUES (1, 1, '2026-09-24', 'snapshots/agronomist/1/2026-09-24.jpg', 1568, 882, 82718, NULL, '2026-09-24T16:06:14.372Z'),
             (4, 1, '2026-09-23', 'snapshots/agronomist/1/2026-09-23.jpg', 1568, 882, 80000, 2, '2026-09-23T08:00:10.000Z');
    CREATE TABLE agronomist_reports (id INTEGER PRIMARY KEY, report_date TEXT, capture_id INTEGER REFERENCES agronomist_captures(id) ON DELETE SET NULL);
    INSERT INTO agronomist_reports VALUES (181, '2026-09-24', 1), (180, '2026-09-23', 4);
  `);
  assert.equal(needsRebuild(db), true);
  assert.throws(() => db.prepare("INSERT INTO agronomist_captures (camera_id, capture_date, path) VALUES (1, '2026-09-24', 'x')").run(), /UNIQUE/);

  const res = ensureAgronomistCapturesSchema(db, { log: quiet, tz: TZ });
  assert.deepEqual(res, { created: false, migrated: true, rows: 2, relabelled: 1 });
  assert.equal(needsRebuild(db), false);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FKs re-enabled');

  const rows = db.prepare('SELECT * FROM agronomist_captures ORDER BY id').all();
  assert.deepEqual(rows.map(r => [r.id, r.capture_date, r.sequence, r.sharpness, r.source, r.captured_at, r.bytes, r.preset_id]), [
    [1, '2026-09-24', 1, null, 'manual', '2026-09-24T16:06:14.372Z', 82718, null], // 20:06 Dubai → not the noon trigger
    [4, '2026-09-23', 1, null, 'noon', '2026-09-23T08:00:10.000Z', 80000, 2],     // 12:00 Dubai
  ]);
  assert.deepEqual(db.prepare('SELECT id, capture_id FROM agronomist_reports ORDER BY id').all(), [{ id: 180, capture_id: 4 }, { id: 181, capture_id: 1 }], 'FK values untouched by the rebuild');
  assert.ok(!db.pragma('index_list(agronomist_captures)').some(i => i.origin === 'u'), 'UNIQUE constraint gone');

  // several rows per day now allowed; AUTOINCREMENT continues past the preserved ids
  const ins = db.prepare("INSERT INTO agronomist_captures (camera_id, capture_date, path, sequence, source, captured_at) VALUES (1, '2026-09-24', ?, ?, 'noon', ?)");
  const a = ins.run('snapshots/agronomist/1/2026-09-24-1.jpg', 1, '2026-09-24T08:00:00Z').lastInsertRowid;
  const b = ins.run('snapshots/agronomist/1/2026-09-24-2.jpg', 2, '2026-09-24T08:00:30Z').lastInsertRowid;
  assert.ok(a > 4 && b > a);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agronomist_captures WHERE capture_date = '2026-09-24'").get().n, 3);
  // FK action still wired to the rebuilt table
  db.prepare('DELETE FROM agronomist_captures WHERE id = 4').run();
  assert.equal(db.prepare('SELECT capture_id FROM agronomist_reports WHERE id = 180').get().capture_id, null);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

  assert.deepEqual(ensureAgronomistCapturesSchema(db, { log: quiet, tz: TZ }), { created: false, migrated: false, rows: null }, 'second run is a no-op');
  const fresh = new Database(':memory:');
  assert.deepEqual(ensureAgronomistCapturesSchema(fresh, { log: quiet }), { created: true, migrated: false, rows: 0 });
  db.close(); fresh.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Noon schedule: exactly once per local day
// ---------------------------------------------------------------------------

test('DailyLocalTrigger fires exactly once per local day at 12:00 Asia/Dubai (stub clock, 1-min ticks over 3 days)', async () => {
  let clock = Date.parse('2026-09-23T20:00:00Z'); // 00:00 Dubai on the 24th
  const fired = [];
  const t = new DailyLocalTrigger({ hour: 12, minute: 0, tz: TZ, graceMinutes: 60, now: () => new Date(clock),
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
  const t = new DailyLocalTrigger({ hour: 12, minute: 0, tz: TZ, graceMinutes: 60, now: () => new Date(clock), onFire: () => { n++; } });
  assert.equal(t.tick(), '2026-09-24');
  await Promise.resolve();
  assert.equal(t.tick(), null);
  clock += 30 * 60_000; // 12:50 — same day, no refire
  assert.equal(t.tick(), null);
  assert.equal(n, 1);

  let m = 0;
  clock = Date.parse('2026-09-24T09:30:00Z'); // 13:30 Dubai — past grace
  const t2 = new DailyLocalTrigger({ hour: 12, minute: 0, tz: TZ, graceMinutes: 60, now: () => new Date(clock), onFire: () => { m++; } });
  assert.equal(t2.tick(), null);
  clock = Date.parse('2026-09-25T08:00:00Z');
  assert.equal(t2.tick(), '2026-09-25');
  await Promise.resolve();
  assert.equal(m, 1);

  let k = 0;
  clock = Date.parse('2026-09-24T08:05:00Z');
  const t3 = new DailyLocalTrigger({ hour: 12, minute: 0, tz: TZ, now: () => new Date(clock), onFire: () => { k++; } });
  t3.markFired('2026-09-24');
  assert.equal(t3.tick(), null);
  assert.equal(k, 0);
});

// ---------------------------------------------------------------------------
// Retention: prune captures older than N days (files + rows, every frame of the day)
// ---------------------------------------------------------------------------

test('prune removes every frame (files and rows) of days older than the retention window and keeps newer ones', async () => {
  const svc = makeSvc({});
  const dates = ['2026-07-01', '2026-08-20', '2026-08-25', '2026-08-26', '2026-09-20'];
  for (const d of dates) { svc._test.setClock(`${d}T08:00:00Z`); await svc.captureForDate(d, { source: 'noon', frames: 3, spacingMs: 0 }); }
  svc._test.setClock('2026-09-24T10:00:00Z'); // cutoff = 2026-08-25

  const dry = svc.prune(30, true);
  assert.equal(dry.eligible_rows, 6);
  assert.equal(dry.rows_dropped, 0);
  assert.equal(svc.db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 15);

  const res = svc.prune(30, false);
  assert.equal(res.rows_dropped, 6);
  assert.equal(res.files_removed, 6);
  assert.equal(res.cutoff, '2026-08-25');
  const left = svc.db.prepare('SELECT DISTINCT capture_date FROM agronomist_captures ORDER BY capture_date').all().map(r => r.capture_date);
  assert.deepEqual(left, ['2026-08-25', '2026-08-26', '2026-09-20']);
  assert.equal(fs.readdirSync(path.join(svc.rootDir, 'snapshots', 'agronomist', '1')).length, 9);
  assert.ok(!fs.existsSync(path.join(svc.rootDir, 'snapshots', 'agronomist', '1', '2026-07-01-1.jpg')));
  assert.ok(fs.existsSync(path.join(svc.rootDir, 'snapshots', 'agronomist', '1', '2026-09-20-3.jpg')));
  fs.rmSync(svc.rootDir, { recursive: true, force: true });
});
