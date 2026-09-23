const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PtzService, PtzError, computeDigestResponse, parseAuthHeader } = require(
  path.join(__dirname, '..', 'src', 'services', 'PtzService.js')
);
const { CameraCredentials, parseCredentialsFromUrl, findStreamUrlInYaml } = require(
  path.join(__dirname, '..', 'src', 'services', 'CameraCredentials.js')
);

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {}, log() {}, error() {} };

// ---------------------------------------------------------------------------
// Mock Hikvision ISAPI server: 401 + Digest challenge, validates the response
// hash exactly like a real device would, records every request.
// ---------------------------------------------------------------------------
function startMockIsapi({ password = 'Thursday@1', realm = 'IP Camera(F4137)', nonce = '4d5441774d5759324f545136593255304e5441344f546b3d' } = {}) {
  const requests = [];
  const state = { failNext401: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = parseAuthHeader(req.headers.authorization);
      let authorized = false;
      if (auth && auth.scheme === 'Digest') {
        const p = auth.params;
        const ha1 = md5(`${p.username}:${realm}:${password}`);
        const ha2 = md5(`${req.method}:${p.uri}`);
        const expected = p.qop
          ? md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
          : md5(`${ha1}:${nonce}:${ha2}`);
        authorized = p.nonce === nonce && p.realm === realm && p.uri === req.url && p.response === expected;
      }
      requests.push({ method: req.method, url: req.url, body, authorized, auth: auth && auth.params });

      if (!authorized) {
        res.writeHead(401, {
          'Content-Type': 'text/html',
          'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", stale="FALSE"`,
        });
        return res.end('<html><body><h2>Access Error: 401 -- Unauthorized</h2></body></html>');
      }

      const ok = (xml) => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(xml); };
      if (req.url === '/ISAPI/System/deviceInfo') {
        return ok('<?xml version="1.0"?><DeviceInfo><deviceName>GreenHouse</deviceName><model>DS-2DE4425IW-DE</model><firmwareVersion>V5.7.3</firmwareVersion><serialNumber>DS-2DE4425IW-DE20210101AAWRF4137</serialNumber></DeviceInfo>');
      }
      if (req.url === '/ISAPI/PTZCtrl/channels/1/capabilities') {
        return ok('<?xml version="1.0"?><PTZChanelCap><ContinuousPanTiltSpace><XRange><Min>-100</Min><Max>100</Max></XRange></ContinuousPanTiltSpace><ContinuousZoomSpace><ZRange><Min>-100</Min><Max>100</Max></ZRange></ContinuousZoomSpace><maxPresetNum>300</maxPresetNum></PTZChanelCap>');
      }
      if (req.url === '/ISAPI/PTZCtrl/channels/1/presets' && req.method === 'GET') {
        return ok('<?xml version="1.0"?><PTZPresetList><PTZPreset><enabled>true</enabled><id>1</id><presetName>Door</presetName></PTZPreset><PTZPreset><enabled>true</enabled><id>7</id><presetName>Bay &amp; Bench</presetName></PTZPreset></PTZPresetList>');
      }
      return ok('<?xml version="1.0"?><ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const cam = (port, extra = {}) => ({
  id: 1, name: 'GreenHouse PTZ', ip_address: '127.0.0.1', http_port: port, rtsp_port: 554,
  username: 'admin', password: 'Thursday@1', go2rtc_name: 'greenhouse_1', ...extra,
});

// ---------------------------------------------------------------------------

test('computeDigestResponse follows RFC 2617 (HA1/HA2 from the RFC example; interop with curl --digest checked below)', () => {
  // RFC 2617 §3.5 example: HA1 = MD5("Mufasa:testrealm@host.com:Circle Of Life"), HA2 = MD5("GET:/dir/index.html")
  const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
  const ha2 = md5('GET:/dir/index.html');
  assert.equal(ha1, '939e7578ed9e3c518a452acee763bce9');
  assert.equal(ha2, '39aff3a2bab6126f332b942af96d3366');
  const base = { username: 'Mufasa', password: 'Circle Of Life', realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c6', method: 'GET', uri: '/dir/index.html' };
  assert.equal(computeDigestResponse({ ...base }), md5(`${ha1}:${base.nonce}:${ha2}`));
  assert.equal(computeDigestResponse({ ...base, qop: 'auth', nc: '00000001', cnonce: '0a4f113b' }),
    md5(`${ha1}:${base.nonce}:00000001:0a4f113b:auth:${ha2}`));
  // MD5-sess variant
  const sess = md5(`${ha1}:${base.nonce}:0a4f113b`);
  assert.equal(computeDigestResponse({ ...base, algorithm: 'MD5-sess', qop: 'auth', nc: '00000001', cnonce: '0a4f113b' }),
    md5(`${sess}:${base.nonce}:00000001:0a4f113b:auth:${ha2}`));
});

test('mock ISAPI digest validation interoperates with curl --digest (when curl is installed)', async (t) => {
  const { execFile } = require('child_process');
  const mock = await startMockIsapi();
  try {
    const code = await new Promise((resolve) => {
      execFile('curl', ['-s', '-m', '5', '--digest', '-u', 'admin:Thursday@1', '-o', '/dev/null', '-w', '%{http_code}',
        `http://127.0.0.1:${mock.port}/ISAPI/System/deviceInfo`], (err, stdout) => resolve(err && !stdout ? null : stdout.trim()));
    });
    if (code === null) { t.skip('curl not available'); return; }
    assert.equal(code, '200');
    assert.equal(mock.requests.at(-1).authorized, true);
  } finally {
    await mock.close();
  }
});

test('digest handshake: 401 challenge is answered with a correct response hash, then reused pre-emptively', async () => {
  const mock = await startMockIsapi();
  const svc = new PtzService({ logger: quiet });
  try {
    const info = await svc.getStatus(cam(mock.port));
    assert.equal(info.status, 'online');
    assert.equal(info.model, 'DS-2DE4425IW-DE');
    assert.deepEqual(info.capabilities, { known: true, continuous: true, zoom: true, presets: true });

    // First deviceInfo call: unauthenticated -> 401 -> authorized retry
    assert.equal(mock.requests[0].url, '/ISAPI/System/deviceInfo');
    assert.equal(mock.requests[0].authorized, false);
    assert.equal(mock.requests[1].url, '/ISAPI/System/deviceInfo');
    assert.equal(mock.requests[1].authorized, true);
    assert.equal(mock.requests[1].auth.qop, 'auth');
    assert.equal(mock.requests[1].auth.nc, '00000001');
    // Capabilities call reused the nonce pre-emptively: no extra 401 round trip
    assert.equal(mock.requests[2].url, '/ISAPI/PTZCtrl/channels/1/capabilities');
    assert.equal(mock.requests[2].authorized, true);
    assert.equal(mock.requests[2].auth.nc, '00000002');
    assert.equal(mock.requests.length, 3);
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('wrong password -> PtzError status "auth", then backoff: no further camera requests until cleared', async () => {
  const mock = await startMockIsapi({ password: 'something-else' });
  const svc = new PtzService({ logger: quiet });
  try {
    await assert.rejects(svc.getStatus(cam(mock.port)), (err) => err instanceof PtzError && err.status === 'auth' && err.httpStatus === 401);
    const n = mock.requests.length;
    assert.equal(n, 2, 'one unauthenticated + one authenticated attempt');
    await assert.rejects(svc.getStatus(cam(mock.port)), (err) => err.status === 'auth' && /not retrying/.test(err.message) && err.retryAfter > 0);
    await assert.rejects(svc.move(cam(mock.port), { pan: 10 }), (err) => err.status === 'auth');
    assert.equal(mock.requests.length, n, 'backoff must not touch the camera');
    svc.clearAuthState(1);
    await assert.rejects(svc.getStatus(cam(mock.port)), (err) => err.status === 'auth');
    assert.equal(mock.requests.length, n + 2, 'after clearAuthState the camera is tried again');
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('continuous move / stop / presets send the documented ISAPI requests', async () => {
  const mock = await startMockIsapi();
  const svc = new PtzService({ logger: quiet, minMoveIntervalMs: 0 });
  const c = cam(mock.port);
  try {
    const mv = await svc.move(c, { pan: 50, tilt: -25, zoom: 0 });
    assert.deepEqual({ pan: mv.pan, tilt: mv.tilt, zoom: mv.zoom }, { pan: 50, tilt: -25, zoom: 0 });
    assert.equal(svc.isMoving(c.id), true);
    await svc.stop(c);
    assert.equal(svc.isMoving(c.id), false);
    await svc.gotoPreset(c, 7);
    await svc.savePreset(c, 12, 'Bench <A&B>');
    await svc.deletePreset(c, 12);
    const presets = await svc.getPresets(c);
    assert.deepEqual(presets, [{ id: 1, name: 'Door', enabled: true }, { id: 7, name: 'Bay & Bench', enabled: true }]);

    const authed = mock.requests.filter((r) => r.authorized);
    assert.deepEqual(authed.map((r) => [r.method, r.url, r.body]), [
      ['PUT', '/ISAPI/PTZCtrl/channels/1/continuous', '<PTZData><pan>50</pan><tilt>-25</tilt><zoom>0</zoom></PTZData>'],
      ['PUT', '/ISAPI/PTZCtrl/channels/1/continuous', '<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>'],
      ['PUT', '/ISAPI/PTZCtrl/channels/1/presets/7/goto', ''],
      ['PUT', '/ISAPI/PTZCtrl/channels/1/presets/12', '<PTZPreset><id>12</id><presetName>Bench &lt;A&amp;B&gt;</presetName></PTZPreset>'],
      ['DELETE', '/ISAPI/PTZCtrl/channels/1/presets/12', ''],
      ['GET', '/ISAPI/PTZCtrl/channels/1/presets', ''],
    ]);
    // Values are clamped to -100..100 and all-zero move == stop
    await svc.move(c, { pan: 500, tilt: -999, zoom: 3.7 });
    assert.equal(mock.requests.at(-1).body, '<PTZData><pan>100</pan><tilt>-100</tilt><zoom>4</zoom></PTZData>');
    await svc.stop(c);
    await assert.rejects(svc.gotoPreset(c, 0), (e) => e.status === 'error' && e.httpStatus === 400);
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('stop watchdog issues stop after 2 s without refresh', async () => {
  const mock = await startMockIsapi();
  const svc = new PtzService({ logger: quiet }); // default watchdogMs = 2000
  const c = cam(mock.port);
  try {
    await svc.move(c, { pan: 30 });
    const before = mock.requests.filter((r) => r.authorized).length;
    await sleep(1500);
    assert.equal(mock.requests.filter((r) => r.authorized).length, before, 'no stop before the 2 s deadline');
    assert.equal(svc.isMoving(c.id), true);
    await sleep(800);
    const last = mock.requests.at(-1);
    assert.equal(last.url, '/ISAPI/PTZCtrl/channels/1/continuous');
    assert.equal(last.body, '<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>');
    assert.equal(svc.watchdogFired, 1);
    assert.equal(svc.isMoving(c.id), false);
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('a refreshed move keeps the watchdog from firing; explicit stop disarms it', async () => {
  const mock = await startMockIsapi();
  const svc = new PtzService({ logger: quiet, watchdogMs: 300, minMoveIntervalMs: 0 });
  const c = cam(mock.port);
  try {
    await svc.move(c, { tilt: 40 });
    await sleep(200);
    await svc.move(c, { tilt: 40 }); // keepalive
    await sleep(200);
    assert.equal(svc.watchdogFired, 0, 'refresh must re-arm the watchdog');
    await svc.stop(c);
    await sleep(400);
    assert.equal(svc.watchdogFired, 0, 'explicit stop must disarm the watchdog');
    const stops = mock.requests.filter((r) => r.authorized && /<pan>0<\/pan><tilt>0<\/tilt><zoom>0<\/zoom>/.test(r.body));
    assert.equal(stops.length, 1);
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('moves are rate-limited to ~10/s, stops never are', async () => {
  const mock = await startMockIsapi();
  const svc = new PtzService({ logger: quiet });
  const c = cam(mock.port);
  try {
    await svc.move(c, { pan: 10 });
    await assert.rejects(svc.move(c, { pan: 20 }), (e) => e instanceof PtzError && e.status === 'rate_limited');
    await svc.stop(c); // immediately after — must go through
    assert.equal(mock.requests.at(-1).body, '<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>');
    await sleep(120);
    await svc.move(c, { pan: 20 });
    await svc.stop(c);
  } finally {
    svc.dispose();
    await mock.close();
  }
});

test('unreachable camera (ECONNREFUSED) -> PtzError status "unreachable" and no lingering watchdog', async () => {
  // Grab a free port, then close it so nothing listens there.
  const tmp = await startMockIsapi();
  const port = tmp.port;
  await tmp.close();
  const svc = new PtzService({ logger: quiet });
  const c = cam(port);
  try {
    await assert.rejects(svc.getStatus(c), (e) => e instanceof PtzError && e.status === 'unreachable' && e.code === 'ECONNREFUSED');
    await assert.rejects(svc.move(c, { pan: 50 }), (e) => e.status === 'unreachable');
    assert.equal(svc.isMoving(c.id), false);
    const json = JSON.parse(JSON.stringify(new PtzError('unreachable', 'Camera unreachable (ECONNREFUSED)')));
    assert.deepEqual(json, { status: 'unreachable', message: 'Camera unreachable (ECONNREFUSED)' });
  } finally {
    svc.dispose();
  }
});

test('request timeout is classified as unreachable', async () => {
  const server = http.createServer(() => { /* never answer */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const svc = new PtzService({ logger: quiet, requestTimeoutMs: 150, statusTimeoutMs: 150 });
  try {
    await assert.rejects(svc.getStatus(cam(server.address().port)), (e) => e.status === 'unreachable' && e.code === 'ETIMEDOUT');
  } finally {
    svc.dispose();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

test('parseCredentialsFromUrl decodes %-encoded passwords', () => {
  assert.deepEqual(parseCredentialsFromUrl('rtsp://admin:Thursday%401@192.168.1.101:554/Streaming/Channels/101'),
    { username: 'admin', password: 'Thursday@1' });
  assert.equal(parseCredentialsFromUrl('rtsp://192.168.1.101:554/x'), null);
});

test('findStreamUrlInYaml handles list and inline forms', () => {
  const yaml = 'api:\n  listen: ":1984"\nstreams:\n  greenhouse_1:\n    - rtsp://admin:pw@10.0.0.2:554/a\n  other: "rtsp://u:p@10.0.0.3/b"\n';
  assert.equal(findStreamUrlInYaml(yaml, 'greenhouse_1'), 'rtsp://admin:pw@10.0.0.2:554/a');
  assert.equal(findStreamUrlInYaml(yaml, 'other'), 'rtsp://u:p@10.0.0.3/b');
  assert.equal(findStreamUrlInYaml(yaml, 'missing'), null);
});

test('CameraCredentials: DB password wins; empty DB falls back to go2rtc API, then yaml; warns once', async () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), log() {}, error() {} };
  const go2rtc = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ greenhouse_1: { producers: [{ url: 'rtsp://admin:Thursday%401@192.168.1.101:554/Streaming/Channels/101' }], consumers: null } }));
  });
  await new Promise((r) => go2rtc.listen(0, '127.0.0.1', r));
  const yamlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-')), 'go2rtc.yaml');
  fs.writeFileSync(yamlPath, 'streams:\n  greenhouse_1:\n    - rtsp://admin:fromyaml@192.168.1.101:554/x\n');
  try {
    const creds = new CameraCredentials({ go2rtcUrl: `http://127.0.0.1:${go2rtc.address().port}`, configPaths: [yamlPath], logger });
    const withDb = await creds.resolve({ id: 1, name: 'x', username: 'admin', password: 'dbpw', go2rtc_name: 'greenhouse_1' });
    assert.deepEqual(withDb, { username: 'admin', password: 'dbpw', source: 'db' });

    const noDb = { id: 1, name: 'x', username: 'admin', password: '', go2rtc_name: 'greenhouse_1' };
    const viaApi = await creds.resolve(noDb);
    assert.deepEqual(viaApi, { username: 'admin', password: 'Thursday@1', source: 'go2rtc' });
    await creds.resolve(noDb);
    assert.equal(warnings.length, 1, 'warning logged once');
    assert.match(warnings[0], /Save it in the camera settings/);

    // go2rtc down -> yaml
    const offline = new CameraCredentials({ go2rtcUrl: 'http://127.0.0.1:1', configPaths: [yamlPath], logger });
    const viaYaml = await offline.resolve(noDb);
    assert.deepEqual(viaYaml, { username: 'admin', password: 'fromyaml', source: 'yaml' });

    // nothing anywhere
    const none = new CameraCredentials({ go2rtcUrl: 'http://127.0.0.1:1', configPaths: [], logger });
    assert.deepEqual(await none.resolve(noDb), { username: 'admin', password: null, source: 'none' });
  } finally {
    await new Promise((r) => go2rtc.close(r));
  }
});
