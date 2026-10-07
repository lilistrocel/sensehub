// Preset-view noon capture (operator request 2026-10-07): one view from each of the
// camera presets "Agronomist 1/2/3" instead of a 3-frame burst from one preset.
// Fake PTZ + fake clock; no camera, no go2rtc, no API call. Credentials are dummies.
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { AGRONOMIST_CAPTURES_SQL, ensureAgronomistCapturesSchema } = require(path.join(__dirname, '..', 'src', 'utils', 'agronomistCapturesSchema.js'));
const {
  AgronomistCaptureService, describeSelection, DEFAULT_VIEW_PRESETS, normalisePresetNames, findPreset,
} = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistCaptureService.js'));
const { PtzService, PtzError } = require(path.join(__dirname, '..', 'src', 'services', 'PtzService.js'));

const quiet = { warn() {}, log() {}, error() {} };
const TZ = 'Asia/Dubai';
const DATE = '2026-10-07';
const NOON = '2026-10-07T08:00:00Z'; // 12:00 Dubai

// The real camera's list (ids as found on 2026-10-07): names are NOT in id order.
const CAMERA_PRESETS = [
  { id: 1, name: 'Agronomist 2', enabled: true },
  { id: 2, name: 'lower area', enabled: true },
  { id: 4, name: 'overview 1', enabled: true },
  { id: 5, name: 'Agronomist 3', enabled: true },
  { id: 6, name: 'Agronomist 1', enabled: true },
  { id: 34, name: 'Back to origin', enabled: true },
];
const POS = {
  1: { elevation: 120, azimuth: 900, zoom: 30 },
  2: { elevation: 50, azimuth: 1500, zoom: 10 },
  5: { elevation: 200, azimuth: 2400, zoom: 40 },
  6: { elevation: 80, azimuth: 300, zoom: 20 },
  34: { elevation: 0, azimuth: 0, zoom: 10 },
};
const HOME = { elevation: -51, azimuth: 70, zoom: 58 };

function fakeJpeg(width, height, padBytes = 0) {
  const sof = Buffer.alloc(2 + 17);
  sof[0] = 0xFF; sof[1] = 0xC0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.alloc(padBytes, 0x41), Buffer.from([0xFF, 0xD9])]);
}

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

/**
 * Fake Hikvision PTZ. A goto moves the camera to the preset's position over
 * `moveReads` status reads (intermediate positions), like the real dome.
 * Options: presets, missing status (statusNull), endless motion (neverSettles),
 * per-preset goto failures (failGoto: { id: n failures }), auth failure at a step.
 */
function fakePtz(clock, opts = {}) {
  const calls = [];
  const state = { pos: { ...HOME }, target: null, readsLeft: 0, activity: null, moving: false };
  const failGoto = { ...(opts.failGoto || {}) };
  let jitter = 0;
  const authAt = opts.authAt || null; // 'presets' | 'position' | `goto:<id>`
  const auth = (what) => {
    if (authAt === what) {
      const err = new PtzError('auth', 'Camera rejected credentials for user "dummy"', { httpStatus: 401 });
      throw err;
    }
  };
  return {
    calls, state,
    async getPresets() { calls.push(['presets']); auth('presets'); return opts.presets || CAMERA_PRESETS; },
    async getPosition() {
      calls.push(['status']);
      auth('position');
      if (opts.statusNull) return null;
      if (opts.neverSettles && state.target) { jitter++; return { ...state.target, azimuth: state.target.azimuth + jitter }; }
      if (state.target && state.readsLeft > 0) {
        state.readsLeft--;
        const t = state.target;
        state.pos = { elevation: Math.round((state.pos.elevation + t.elevation) / 2), azimuth: Math.round((state.pos.azimuth + t.azimuth) / 2), zoom: t.zoom };
        if (state.readsLeft === 0) state.pos = { ...t };
      }
      return { ...state.pos };
    },
    async gotoPreset(camera, id, o = {}) {
      calls.push(['goto', id, o.source]);
      auth(`goto:${id}`);
      if (failGoto[id] > 0) { failGoto[id]--; throw new PtzError('error', `Camera returned 500 for preset ${id}`, { httpStatus: 500 }); }
      if (opts.onGoto) opts.onGoto(id, state);
      state.target = POS[id] || { elevation: 1, azimuth: id, zoom: 1 };
      state.readsLeft = opts.moveReads ?? 2;
      return { ok: true, id };
    },
    async gotoAbsolute(camera, pos, o = {}) {
      calls.push(['absolute', { ...pos }, o.source]);
      state.target = { ...pos };
      state.readsLeft = opts.moveReads ?? 2;
      return { ok: true };
    },
    isMoving() { return state.moving; },
    lastActivity() { return state.activity; },
    setBusy() { calls.push(['busy']); },
    clearBusy() { calls.push(['free']); },
    _clock: clock,
  };
}

/** Service with a fake clock (sleep advances it) and a scripted frame/score sequence. */
function makeSvc({ db = memDb(), ptzOpts = {}, scores = null, frameFails = 0, now = NOON } = {}) {
  let clock = Date.parse(now);
  const sleeps = [];
  const clockRef = { get now() { return clock; } };
  const ptz = fakePtz(clockRef, ptzOpts);
  let frameN = 0, scoreN = 0, fails = frameFails;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agro-views-'));
  const svc = new AgronomistCaptureService({
    db, rootDir: root, log: quiet, tz: TZ, ptz,
    now: () => new Date(clock),
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    fetchFrame: async () => {
      if (fails > 0) { fails--; throw new Error('go2rtc frame failed (500)'); }
      clock += 1000; // a frame takes about a second
      return fakeJpeg(1568, 882, 10 + (frameN++ % 5));
    },
    sharpness: () => (scores ? scores[scoreN++ % scores.length] : { sharpness: 100, brightness: 120 }),
  });
  svc._t = { sleeps, ptz, root, advance: ms => { clock += ms; }, get clock() { return clock; } };
  return svc;
}

const s = (sharpness, brightness = 120) => ({ sharpness, brightness });
const gotos = calls => calls.filter(c => c[0] === 'goto').map(c => c[1]);
const isapi = calls => calls.filter(c => ['presets', 'status', 'goto', 'absolute'].includes(c[0]));

// ---------------------------------------------------------------------------------

test('config default: Agronomist 1/2/3, home = where it was, 2 frames per view; saveConfig normalises', () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const cfg = agronomistService.getConfig();
  assert.deepEqual(cfg.capture_presets, ['Agronomist 1', 'Agronomist 2', 'Agronomist 3']);
  assert.deepEqual(DEFAULT_VIEW_PRESETS, ['Agronomist 1', 'Agronomist 2', 'Agronomist 3']);
  assert.equal(cfg.capture_home_preset, null);
  assert.equal(cfg.capture_frames_per_view, 2);
  let saved = agronomistService.saveConfig({ capture_presets: ['  Agronomist 1 ', 'agronomist 1', '', 'B', 'C', 'D'], capture_frames_per_view: 9, capture_home_preset: '  Back to origin ' });
  assert.deepEqual(saved.capture_presets, ['Agronomist 1', 'B', 'C']); // trimmed, deduped, max 3
  assert.equal(saved.capture_frames_per_view, 3);
  assert.equal(saved.capture_home_preset, 'Back to origin');
  saved = agronomistService.saveConfig({ capture_presets: [], capture_home_preset: '' });
  assert.deepEqual(saved.capture_presets, []);          // empty = legacy single-preset burst
  assert.equal(saved.capture_home_preset, null);
  agronomistService.saveConfig({ capture_presets: [...DEFAULT_VIEW_PRESETS] });
});

test('findPreset / normalisePresetNames: by name, case and spacing insensitive, lowest id wins', () => {
  assert.equal(findPreset(CAMERA_PRESETS, 'agronomist  1').preset.id, 6);
  assert.equal(findPreset(CAMERA_PRESETS, 'Agronomist 9').preset, null);
  const dup = findPreset([{ id: 9, name: 'X' }, { id: 3, name: 'x' }], 'X');
  assert.equal(dup.preset.id, 3);
  assert.deepEqual(dup.duplicates, [9]);
  assert.deepEqual(normalisePresetNames('nope'), []);
});

test('sequence: remember position -> each preset by name (6, 1, 5) -> settle -> frames -> back to the start', async () => {
  const svc = makeSvc({ scores: [s(50), s(90), s(80), s(70), s(100), s(40)] });
  const r = await svc.captureViews(DATE, { source: 'noon' });
  const calls = svc._t.ptz.calls;

  // order of ISAPI work: list, position, then one goto per view (by name -> id), then the restore
  assert.equal(calls[0][0], 'busy');
  assert.deepEqual(isapi(calls).slice(0, 2).map(c => c[0]), ['presets', 'status']);
  assert.deepEqual(gotos(calls), [6, 1, 5]);
  assert.ok(calls.filter(c => c[0] === 'goto').every(c => c[2] === 'agronomist'));
  const abs = calls.filter(c => c[0] === 'absolute');
  assert.equal(abs.length, 1);
  assert.deepEqual(abs[0][1], HOME);
  assert.equal(calls[calls.length - 1][0], 'free');
  // no continuous moves, ever
  assert.ok(!calls.some(c => c[0] === 'move'));

  // sharpest of 2 frames kept per view
  assert.deepEqual(r.views.map(v => [v.index, v.name, v.preset_id, v.status, v.sharpness]), [
    [1, 'Agronomist 1', 6, 'ok', 90], [2, 'Agronomist 2', 1, 'ok', 80], [3, 'Agronomist 3', 5, 'ok', 100],
  ]);
  assert.deepEqual(r.views[0].candidates.map(c => c.sharpness), [50, 90]);
  assert.ok(r.views.every(v => v.settle[0].mode === 'polled' && v.settle[0].moved));

  // stored: one row + one file per view, named and labelled
  assert.equal(r.frames.length, 3);
  assert.deepEqual(r.frames.map(f => [f.sequence, f.preset_name, f.preset_id, f.source]), [
    [1, 'Agronomist 1', 6, 'noon'], [2, 'Agronomist 2', 1, 'noon'], [3, 'Agronomist 3', 5, 'noon'],
  ]);
  assert.deepEqual(r.frames.map(f => path.basename(f.path)), [`${DATE}-v1.jpg`, `${DATE}-v2.jpg`, `${DATE}-v3.jpg`]);
  for (const f of r.frames) assert.ok(fs.existsSync(svc.absolutePath(f.path)));
  assert.ok(r.frames.every(f => f.session_id === r.session.id && f.captured_at));

  const sess = svc.getSession(r.session.id);
  assert.equal(sess.status, 'complete');
  assert.equal(sess.restore.mode, 'position');
  assert.equal(sess.restore.ok, true);
  assert.deepEqual(sess.restore.final, HOME);
  assert.deepEqual(sess.views.map(v => v.capture_id), r.frames.map(f => f.id));
});

test('settle: focus wait follows a stable position; a dome that never reports stable times out, frame taken and noted', async () => {
  const svc = makeSvc({ ptzOpts: { moveReads: 3 } });
  const r = await svc.captureViews(DATE, { presets: ['Agronomist 1'], framesPerView: 1 });
  const st = r.views[0].settle[0];
  assert.equal(st.mode, 'polled');
  // 3 moving reads, then 3 identical reads at 500 ms
  assert.ok(st.reads >= 4 && st.reads <= 6, `reads ${st.reads}`);
  assert.ok(svc._t.sleeps.includes(3000), 'focus/exposure settle before the first frame');

  const svc2 = makeSvc({ ptzOpts: { neverSettles: true } });
  const r2 = await svc2.captureViews(DATE, { presets: ['Agronomist 1'], framesPerView: 1 });
  assert.equal(r2.views[0].status, 'ok');
  assert.equal(r2.views[0].settle[0].mode, 'timeout');
  assert.ok(r2.views[0].settle[0].ms >= 20_000 && r2.views[0].settle[0].ms < 21_000);
  assert.ok(r2.session.notes.some(n => /did not report a stable position within 20 s/.test(n)));
});

test('settle: no PTZ status -> fixed 8 s fallback, and the restore says the camera reported no position', async () => {
  const svc = makeSvc({ ptzOpts: { statusNull: true } });
  const r = await svc.captureViews(DATE, { presets: ['Agronomist 1'], framesPerView: 1 });
  assert.equal(r.views[0].settle[0].mode, 'fixed');
  assert.equal(r.views[0].settle[0].ms, 8000);
  assert.equal(r.session.restore.mode, 'none');
  assert.equal(r.session.restore.ok, false);
  assert.ok(r.session.notes.some(n => /did not report its position/.test(n)));
});

test('blurry view is retried once (goto again) and the sharpest of all frames is kept', async () => {
  const svc = makeSvc({ scores: [s(10), s(12), s(95), s(60), s(100), s(100), s(100), s(100)] });
  const r = await svc.captureViews(DATE, {});
  assert.deepEqual(gotos(svc._t.ptz.calls), [6, 6, 1, 5]);
  assert.equal(r.views[0].retried, true);
  assert.match(r.views[0].retry_reason, /blurry \(sharpness 12 < 30\)/);
  assert.equal(r.views[0].sharpness, 95);
  assert.deepEqual(r.views[0].candidates.map(c => [c.attempt, c.sharpness]), [[1, 10], [1, 12], [2, 95], [2, 60]]);
  assert.equal(r.views[0].quality, null);
  assert.ok(!r.views[1].retried && !r.views[2].retried);
});

test('dark view is retried once; still dark after the retry is kept but labelled', async () => {
  const svc = makeSvc({ scores: [s(100, 10), s(100, 12), s(100, 15), s(100, 14), s(100), s(100), s(100), s(100)] });
  const r = await svc.captureViews(DATE, {});
  assert.deepEqual(gotos(svc._t.ptz.calls), [6, 6, 1, 5]);
  assert.equal(r.views[0].status, 'ok');
  assert.match(r.views[0].quality, /too dark/);
  assert.ok(r.session.notes.some(n => /View 1 .*kept frame is too dark/.test(n)));
});

test('missing preset: the other views are captured, the gap is labelled, nothing is substituted', async () => {
  const presets = CAMERA_PRESETS.filter(p => p.name !== 'Agronomist 2');
  const svc = makeSvc({ ptzOpts: { presets } });
  const r = await svc.captureViews(DATE, { source: 'noon' });
  assert.deepEqual(gotos(svc._t.ptz.calls), [6, 5]); // never preset 1 or any other preset
  assert.deepEqual(r.views.map(v => v.status), ['ok', 'missing', 'ok']);
  assert.deepEqual(r.frames.map(f => f.sequence), [1, 3]);
  assert.equal(r.session.status, 'partial');
  assert.ok(r.session.notes.some(n => /View 2 "Agronomist 2": preset not found on the camera/.test(n)));

  const sel = svc.getCapturesForReport(DATE, { now: new Date('2026-10-07T16:00:00Z') });
  assert.equal(sel.layout, 'views');
  assert.equal(sel.items.length, 2);
  const line = describeSelection(sel, { date: DATE, tz: TZ });
  assert.match(line, /^2 of 3 canopy views from today's 12:00 noon session/);
  assert.match(line, /View 2 "Agronomist 2" MISSING: preset "Agronomist 2" not found on the camera/);
});

test('goto failure: retried once, then labelled goto_failed; the other views still captured', async () => {
  const svc = makeSvc({ ptzOpts: { failGoto: { 1: 2 } } });
  const r = await svc.captureViews(DATE, {});
  assert.deepEqual(r.views.map(v => v.status), ['ok', 'goto_failed', 'ok']);
  assert.match(r.views[1].message, /Camera returned 500/);
  assert.equal(r.frames.length, 2);
  assert.deepEqual(gotos(svc._t.ptz.calls), [6, 1, 1, 5]);
});

test('go2rtc failure on a view: retried once and recovers', async () => {
  const svc = makeSvc({ frameFails: 2 });
  const r = await svc.captureViews(DATE, {});
  assert.deepEqual(r.views.map(v => v.status), ['ok', 'ok', 'ok']);
  assert.equal(r.views[0].retried, true);
  assert.match(r.views[0].retry_reason, /attempt 1 failed \(no frame from go2rtc/);
});

test('auth failure on the preset list: exactly one ISAPI request, nothing else, session failed', async () => {
  const svc = makeSvc({ ptzOpts: { authAt: 'presets' } });
  await assert.rejects(svc.captureViews(DATE, { source: 'noon' }), (err) => {
    assert.match(err.message, /no agronomist view captured/);
    assert.match(err.message, /camera rejected the login/);
    assert.equal(err.session.status, 'failed');
    assert.deepEqual(err.session.views.map(v => v.status), ['auth_stopped', 'auth_stopped', 'auth_stopped']);
    assert.equal(err.session.restore.mode, 'skipped');
    return true;
  });
  assert.deepEqual(isapi(svc._t.ptz.calls), [['presets']]);
  assert.equal(svc._t.ptz.calls[svc._t.ptz.calls.length - 1][0], 'free');
  // the failed session is still visible to the UI
  const groups = svc.listCapturesGrouped({ days: 1 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].frames.length, 0);
  assert.equal(groups[0].session.status, 'failed');
});

test('auth failure mid-tour: stops at the first 401 (no retry, no restore, no later views)', async () => {
  const svc = makeSvc({ ptzOpts: { authAt: 'goto:1' } });
  const r = await svc.captureViews(DATE, {});
  const calls = isapi(svc._t.ptz.calls);
  const failed = calls.findIndex(c => c[0] === 'goto' && c[1] === 1);
  assert.ok(failed > 0);
  assert.equal(failed, calls.length - 1, 'the 401 is the last request sent to the camera');
  assert.deepEqual(r.views.map(v => v.status), ['ok', 'auth_stopped', 'auth_stopped']);
  assert.equal(r.session.restore.mode, 'skipped');
  assert.equal(r.frames.length, 1);
});

test('someone driving the camera at noon: wait up to 60 s, proceed, log it; moved again during the tour -> view retried, no restore', async () => {
  const svc = makeSvc();
  const ptz = svc._t.ptz;
  ptz.state.activity = { at: svc._t.clock - 5000, source: 'user', action: 'move' };
  // keep "using" it for ~20 s, then stop
  const until = svc._t.clock + 20_000;
  const origLast = ptz.lastActivity;
  ptz.lastActivity = () => (svc._t.clock < until ? { at: svc._t.clock - 1000, source: 'user' } : origLast());
  const r = await svc.captureViews(DATE, {});
  assert.ok(r.session.notes[0].startsWith('someone is using the camera'));
  assert.ok(r.session.notes.some(n => /camera free after \d+ s/.test(n)));
  assert.ok(r.session.manual_wait_ms >= 20_000 && r.session.manual_wait_ms <= 60_000);
  assert.equal(r.session.status, 'complete');
  assert.equal(r.session.restore.mode, 'position');

  // a user goto lands in the middle of view 2: that view is retried; they stopped
  // > 30 s before the end, so the camera is still put back
  const svc2 = makeSvc({ ptzOpts: { onGoto: (id, state) => { if (id === 1 && !state.done) { state.done = true; state.activity = { at: svc2._t.clock + 1, source: 'user', action: 'goto' }; } } } });
  const r2 = await svc2.captureViews(DATE, {});
  assert.equal(r2.views[1].retried, true);
  assert.match(r2.views[1].retry_reason, /someone moved the camera/);
  assert.equal(r2.session.restore.mode, 'position');

  // still driving it when the tour ends: left where they put it, no restore move
  let driving = false;
  const svc3 = makeSvc({ ptzOpts: { onGoto: (id) => { if (id === 5) driving = true; } } });
  const plain = svc3._t.ptz.lastActivity;
  svc3._t.ptz.lastActivity = () => (driving ? { at: svc3._t.clock - 1000, source: 'user' } : plain());
  const r3 = await svc3.captureViews(DATE, {});
  assert.equal(r3.session.restore.mode, 'skipped');
  assert.ok(r3.session.notes.some(n => /left it where they put it/.test(n)));
  assert.ok(!svc3._t.ptz.calls.some(c => c[0] === 'absolute'));
});

test('still in use after 60 s: capture proceeds anyway and says so', async () => {
  const svc = makeSvc();
  svc._t.ptz.lastActivity = () => ({ at: svc._t.clock - 1000, source: 'user' });
  const r = await svc.captureViews(DATE, { presets: ['Agronomist 1'], framesPerView: 1 });
  assert.ok(r.session.notes.some(n => /still in use after 60 s; capture proceeds anyway/.test(n)));
  assert.equal(r.views[0].status, 'ok');
});

test('home preset configured: finishes on that preset instead of the starting position', async () => {
  const svc = makeSvc();
  const r = await svc.captureViews(DATE, { homePreset: 'back to origin' });
  assert.deepEqual(gotos(svc._t.ptz.calls), [6, 1, 5, 34]);
  assert.equal(r.session.restore.mode, 'preset');
  assert.equal(r.session.restore.preset_id, 34);
  assert.ok(!svc._t.ptz.calls.some(c => c[0] === 'absolute'));
});

test('noon re-run replaces the day\'s tour; a failed re-run keeps the good one', async () => {
  const db = memDb();
  const svc = makeSvc({ db });
  const first = await svc.captureViews(DATE, { source: 'noon' });
  const second = await svc.captureViews(DATE, { source: 'noon' });
  const rows = db.prepare("SELECT * FROM agronomist_captures WHERE source = 'noon'").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.session_id === second.session.id));
  assert.equal(svc.getSession(first.session.id), null);

  const svc2 = makeSvc({ db, ptzOpts: { authAt: 'presets' } });
  await assert.rejects(svc2.captureViews(DATE, { source: 'noon' }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agronomist_captures WHERE source = 'noon'").get().n, 3);
});

test('report selection: today\'s views in view order (not by sharpness), with the session\'s views', async () => {
  const svc = makeSvc({ scores: [s(300), s(300), s(50), s(50), s(200), s(200)] });
  await svc.captureViews(DATE, { source: 'noon' });
  const sel = svc.getCapturesForReport(DATE, { now: new Date('2026-10-07T16:00:00Z'), limit: 1 });
  assert.equal(sel.mode, 'noon');
  assert.equal(sel.layout, 'views');
  assert.deepEqual(sel.items.map(it => it.capture.sequence), [1, 2, 3]); // limit does not trim views
  assert.deepEqual(sel.views.map(v => v.name), DEFAULT_VIEW_PRESETS);
  const groups = svc.listCapturesGrouped({ days: 1 });
  assert.equal(groups[0].layout, 'views');
  assert.deepEqual(groups[0].frames.map(f => f.preset_name), DEFAULT_VIEW_PRESETS);
});

test('prompt: 3 images, each preceded by its "View N of 3 — preset" label; photo line says they are different views', async () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const svc = makeSvc({ scores: [s(105), s(100), s(88), s(80), s(120), s(110)] });
  await svc.captureViews(DATE, { source: 'noon' });
  const capture = svc.getCapturesForReport(DATE, { now: new Date('2026-10-07T16:00:00Z') });
  const cfg = { ...agronomistService.getConfig(), model: 'claude-sonnet-5', capture_frames_to_send: 1 };
  const snapshot = { date: DATE, timezone: TZ, sensors: [{ a: 1 }], operator_tasks: [], lab: {} };
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: DATE, snapshot, cfg, capture, clarifications: [], historyBlock: '' });
  const content = requestBody.messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['text', 'image', 'text', 'image', 'text', 'image', 'text']);
  assert.match(content[0].text, /^View 1 of 3 — preset "Agronomist 1" \(id 6\) at 12:00:\d\d Asia\/Dubai, sharpness 105:$/);
  assert.match(content[2].text, /^View 2 of 3 — preset "Agronomist 2" \(id 1\)/);
  assert.match(content[4].text, /^View 3 of 3 — preset "Agronomist 3" \(id 5\).*sharpness 120:$/);
  assert.equal(content[1].source.data, fs.readFileSync(svc.absolutePath(capture.items[0].capture.path)).toString('base64'));
  const text = content[6].text;
  assert.match(text, /The 3 images above are from camera "GreenHouse PTZ", times in Asia\/Dubai: 3 of 3 canopy views from today's 12:00 noon session/);
  assert.match(text, /DIFFERENT parts of the crop, one per camera preset/);
  assert.match(requestBody.system[0].text, /VIEWS \(the normal noon capture\)/);
  assert.equal(stats.image_count, 3);
  assert.equal(stats.capture_layout, 'views');
  assert.deepEqual(stats.capture_views.map(v => v.status), ['ok', 'ok', 'ok']);
  // report row -> UI fields carry the views
  const fields = agronomistService._captureFields({ capture_ids: JSON.stringify(stats.capture_ids), capture_id: stats.capture_id, input_snapshot: JSON.stringify({ snapshot_stats: stats }) });
  assert.equal(fields.capture_layout, 'views');
  assert.deepEqual(fields.capture_views.map(v => v.name), DEFAULT_VIEW_PRESETS);
});

test('prompt with a missing view: 2 labelled images and the gap stated', async () => {
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const svc = makeSvc({ ptzOpts: { presets: CAMERA_PRESETS.filter(p => p.id !== 5) } });
  await svc.captureViews(DATE, { source: 'noon' });
  const capture = svc.getCapturesForReport(DATE, { now: new Date('2026-10-07T16:00:00Z') });
  const cfg = { ...agronomistService.getConfig(), model: 'claude-sonnet-5' };
  const snapshot = { date: DATE, timezone: TZ, sensors: [], operator_tasks: [], lab: {} };
  const { requestBody, stats } = agronomistService.buildDailyRequest({ date: DATE, snapshot, cfg, capture, clarifications: [], historyBlock: '' });
  const content = requestBody.messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['text', 'image', 'text', 'image', 'text']);
  assert.match(content[0].text, /^View 1 of 3/);
  assert.match(content[2].text, /^View 2 of 3/);
  assert.match(stats.photo_line, /View 3 "Agronomist 3" MISSING: preset "Agronomist 3" not found on the camera/);
  assert.match(stats.photo_line, /Only 2 of 3 views are available/);
});

test('runConfiguredSession: presets -> tour; empty list or an explicit preset_id -> legacy burst', async () => {
  const svc = makeSvc();
  let r = await svc.runConfiguredSession(DATE, { capture_presets: ['Agronomist 1'], capture_frames_per_view: 1 }, { source: 'manual' });
  assert.equal(r.session.layout, 'views');
  r = await svc.runConfiguredSession(DATE, { capture_presets: [], capture_preset_id: 1, capture_frames: 2, capture_spacing_seconds: 5 }, { source: 'manual' });
  assert.equal(r.session.layout, undefined);
  assert.equal(r.frames.length, 2);
  r = await svc.runConfiguredSession(DATE, { capture_presets: ['Agronomist 1'] }, { source: 'manual', presetId: 4, frames: 1 });
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].preset_id, 4);
});

test('schema v3 is additive: an old v2 table gains preset_name/session_id and the sessions table, rows kept', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agronomist_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id INTEGER NOT NULL, capture_date TEXT NOT NULL, path TEXT NOT NULL,
    width INTEGER, height INTEGER, bytes INTEGER DEFAULT 0, preset_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    sequence INTEGER DEFAULT 1, sharpness REAL, source TEXT DEFAULT 'noon', captured_at TEXT)`);
  db.prepare("INSERT INTO agronomist_captures (camera_id, capture_date, path) VALUES (1, '2026-10-06', 'a.jpg')").run();
  const r = ensureAgronomistCapturesSchema(db, { log: quiet });
  assert.equal(r.migrated, false);
  const cols = db.pragma('table_info(agronomist_captures)').map(c => c.name);
  assert.ok(cols.includes('preset_name') && cols.includes('session_id'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agronomist_capture_sessions'").get());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agronomist_captures').get().n, 1);
  ensureAgronomistCapturesSchema(db, { log: quiet }); // idempotent
});

// ---- PtzService additions --------------------------------------------------------

test('PtzService: position read, absolute return body, user activity vs automatic calls, busy flag', async () => {
  const ptz = new PtzService({ logger: quiet, credentials: { resolve: async () => ({ username: 'dummy', password: 'dummy-pass' }) } });
  const sent = [];
  ptz.request = async (camera, method, p, body) => {
    sent.push([method, p, body || null]);
    if (p.endsWith('/status')) return { body: '<PTZStatus><AbsoluteHigh><elevation>-51</elevation><azimuth>70</azimuth><absoluteZoom>58</absoluteZoom></AbsoluteHigh></PTZStatus>' };
    return { body: '' };
  };
  const cam = { id: 1 };
  assert.deepEqual(await ptz.getPosition(cam), { elevation: -51, azimuth: 70, zoom: 58 });
  await ptz.gotoAbsolute(cam, { elevation: -51, azimuth: 70, zoom: 58 }, { source: 'agronomist' });
  assert.deepEqual(sent[1], ['PUT', '/ISAPI/PTZCtrl/channels/1/absolute', '<PTZData><AbsoluteHigh><elevation>-51</elevation><azimuth>70</azimuth><absoluteZoom>58</absoluteZoom></AbsoluteHigh></PTZData>']);
  await ptz.gotoPreset(cam, 6, { source: 'agronomist' });
  assert.equal(ptz.lastActivity(1), null, 'automatic calls are not user activity');
  await ptz.gotoPreset(cam, 2);
  assert.equal(ptz.lastActivity(1).action, 'goto');
  await ptz.move(cam, { pan: 20 });
  assert.equal(ptz.lastActivity(1).action, 'move');
  assert.ok(ptz.isMoving(1));
  ptz.dispose();
  ptz.setBusy(1, 'agronomist capture');
  assert.equal(ptz.getBusy(1).label, 'agronomist capture');
  ptz.clearBusy(1);
  assert.equal(ptz.getBusy(1), null);
  await assert.rejects(ptz.gotoAbsolute(cam, { elevation: 1 }), /needs elevation, azimuth and zoom/);
  const noAbs = new PtzService({ logger: quiet });
  noAbs.request = async () => ({ body: '<PTZStatus></PTZStatus>' });
  assert.equal(await noAbs.getPosition(cam), null);
});
