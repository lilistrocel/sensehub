import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Minimal browser surface (vitest runs in node; no jsdom in this repo).
class FakeDocument extends EventTarget { constructor() { super(); this.visibilityState = 'visible'; } }
globalThis.document = new FakeDocument();
globalThis.window = new EventTarget();
window.location = { href: 'http://hub.local/', origin: 'http://hub.local' };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

let impl = async () => new Response('{}', { status: 200 });
let calls = [];
window.fetch = (input, init) => { calls.push({ input, init }); return impl(input, init); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const netErr = () => Promise.reject(new TypeError('Failed to fetch'));
const ok = (body = '{"ok":true}') => Promise.resolve(new Response(body, { status: 200 }));
const setHidden = (hidden) => {
  document.visibilityState = hidden ? 'hidden' : 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
};

let C;
beforeAll(async () => {
  C = await import('./connectivity');
  const { installResilientFetch } = await import('./resilientFetch');
  installResilientFetch();
});

beforeEach(() => {
  document.visibilityState = 'visible';
  C.__resetConnectivityForTests();
  calls = [];
  impl = () => ok();
});

describe('resilient fetch (steady state = unchanged behaviour)', () => {
  it('rejects a network failure immediately when visible, online and not just resumed', async () => {
    impl = netErr;
    await expect(window.fetch('/api/x', { headers: { Authorization: 'Bearer t' } })).rejects.toThrow('Failed to fetch');
    expect(calls).toHaveLength(1);
  });

  it('passes HTTP errors through untouched', async () => {
    impl = () => Promise.resolve(new Response('no', { status: 500 }));
    const r = await window.fetch('/api/x');
    expect(r.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it('never touches non-/api requests', async () => {
    impl = netErr;
    await expect(window.fetch('/assets/app.js')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('resilient fetch (tab out / tab back)', () => {
  it('parks a GET that fails while hidden and replays it once visible', async () => {
    setHidden(true);
    let n = 0;
    impl = () => (n++ === 0 ? netErr() : ok('{"v":1}'));
    const p = window.fetch('/api/board');
    await sleep(50);
    expect(calls).toHaveLength(1);
    setHidden(false);
    const r = await p;
    expect(await r.json()).toEqual({ v: 1 });
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure inside the resume window instead of rejecting', async () => {
    setHidden(true); await sleep(5); setHidden(false);
    let n = 0;
    impl = () => (n++ < 2 ? netErr() : ok());
    const r = await window.fetch('/api/x');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('retries a gateway 502 inside the resume window', async () => {
    setHidden(true); await sleep(5); setHidden(false);
    let n = 0;
    impl = () => (n++ === 0 ? Promise.resolve(new Response('bad gateway', { status: 502 })) : ok());
    const r = await window.fetch('/api/x');
    expect(r.status).toBe(200);
  });

  it('coalesces identical parked GETs into one replay (no burst on resume)', async () => {
    setHidden(true);
    let n = 0;
    impl = () => (n++ < 3 ? netErr() : ok('{"count":7}'));
    const h = { headers: { Authorization: 'Bearer t' } };
    const ps = [window.fetch('/api/alerts/count', h), window.fetch('/api/alerts/count', h), window.fetch('/api/alerts/count', h)];
    await sleep(50);
    expect(calls).toHaveLength(3);
    setHidden(false);
    const rs = await Promise.all(ps);
    expect(calls).toHaveLength(4); // 3 failures while hidden + ONE shared replay
    for (const r of rs) expect(await r.json()).toEqual({ count: 7 });
  });

  it('never retries non-GET requests, even while hidden', async () => {
    setHidden(true);
    impl = netErr;
    await expect(window.fetch('/api/relay', { method: 'POST' })).rejects.toThrow('Failed to fetch');
    expect(calls).toHaveLength(1);
  });

  it('still rejects a persistent failure once the resume window is over (real outage surfaces)', async () => {
    C.__resetConnectivityForTests({ visibleAt: Date.now() - 9000, lastHiddenMs: 60000 });
    impl = netErr;
    const t0 = Date.now();
    await expect(window.fetch('/api/x')).rejects.toThrow('Failed to fetch');
    expect(calls.length).toBeGreaterThanOrEqual(3); // first try + >= 2 retries
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15000);

  it('replays a request that was in flight when the page froze', async () => {
    let n = 0;
    impl = (input, init) => {
      if (n++ === 0) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }
      return ok('{"fresh":true}');
    };
    const p = window.fetch('/api/status');
    await sleep(20);
    document.dispatchEvent(new Event('freeze'));
    const r = await p;
    expect(await r.json()).toEqual({ fresh: true });
    expect(calls).toHaveLength(2);
  });

  it('honours a caller abort (no replay)', async () => {
    setHidden(true);
    impl = netErr;
    const ctl = new AbortController();
    const p = window.fetch('/api/x', { signal: ctl.signal });
    await sleep(20);
    ctl.abort();
    await expect(p).rejects.toThrow();
    setHidden(false);
    await sleep(700);
    expect(calls).toHaveLength(1);
  });
});

describe('connectivity status and toast suppression', () => {
  it('suppresses network-shaped error text only while transient', () => {
    expect(C.shouldSuppressErrorText('Status board unavailable: Failed to fetch')).toBe(false);
    setHidden(true);
    expect(C.shouldSuppressErrorText('Status board unavailable: Failed to fetch')).toBe(true);
    expect(C.shouldSuppressErrorText('Load failed')).toBe(true);
    expect(C.shouldSuppressErrorText('Trend data unavailable: HTTP 502')).toBe(true);
    expect(C.shouldSuppressErrorText('Status board unavailable: HTTP 500')).toBe(false);
    expect(C.shouldSuppressErrorText('Failed to abort dose cycle: interlock')).toBe(false);
  });

  it('never suppresses the error of a user action (non-GET) that just failed', async () => {
    setHidden(true); await sleep(5); setHidden(false); // inside the resume window
    impl = netErr;
    await expect(window.fetch('/api/irrigation/stop', { method: 'POST' })).rejects.toThrow();
    expect(C.shouldSuppressErrorText('Stop irrigation failed: Failed to fetch')).toBe(false);
  });

  it('suppresses everything briefly after the session expired', () => {
    C.markSessionExpired();
    expect(C.shouldSuppressErrorText('Status board unavailable: HTTP 401')).toBe(true);
  });

  it('reports down only after a persistent visible+online failure', () => {
    const now = Date.now();
    C.__resetConnectivityForTests({ failingSince: now - 5000 });
    expect(C.getStatus(now)).toBe('reconnecting');
    expect(C.getStatus(now + 11000)).toBe('down');
    C.reportOk();
    expect(C.getStatus()).toBe('ok');
  });

  it('reports offline while the browser is offline', () => {
    C.__resetConnectivityForTests({ online: false });
    expect(C.getStatus()).toBe('offline');
  });
});

describe('Accept-Language on /api requests (i18n contract with the backend)', () => {
  const headerOf = (call) => new Headers(call.init && call.init.headers).get('Accept-Language');
  let L;
  beforeAll(async () => { L = await import('../i18n/current'); });

  it('sends the UI language on GET and non-GET /api requests', async () => {
    L.setCurrentLanguage('ar');
    await window.fetch('/api/dashboard/status-board', { headers: { Authorization: 'Bearer t' } });
    await window.fetch('/api/irrigation/stop', { method: 'POST', headers: { Authorization: 'Bearer t' } });
    expect(calls.map(headerOf)).toEqual(['ar', 'ar']);
    // the Authorization header survives the rewrite
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer t');
    L.setCurrentLanguage('en');
  });

  it('keeps a caller-set Accept-Language and leaves non-api URLs alone', async () => {
    L.setCurrentLanguage('tr');
    await window.fetch('/api/reports/daily', { headers: { 'Accept-Language': 'en' } });
    await window.fetch('/assets/logo.svg');
    expect(headerOf(calls[0])).toBe('en');
    expect(calls[1].init).toBeUndefined();
    L.setCurrentLanguage('en');
  });

  it('sends en for the dev pseudo-locale', async () => {
    L.setCurrentLanguage('pseudo');
    await window.fetch('/api/alerts');
    expect(headerOf(calls[0])).toBe('en');
    L.setCurrentLanguage('en');
  });
});
