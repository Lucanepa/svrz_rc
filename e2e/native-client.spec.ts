import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { jarToCookieLine, nativeClient, versionBelow } from '../server/nativeClient';

/**
 * The installed app (Tauri) signs in with headers instead of cookies, and reads
 * the API offline from its own IndexedDB copy instead of a service worker.
 *
 * Two halves, pinned separately:
 * - the API's door (server/nativeClient.ts): what it lets through from the
 *   jar, what it hands back, and when it refuses an outdated app;
 * - the app's fetch wrapper (src/lib/native.ts), run in a plain page against
 *   mocked routes — the dev server is not a native build, so the wrapper is
 *   created by hand around the page's fetch, exactly as installNativeFetch
 *   does in the app.
 */

// ── The API's door ─────────────────────────────────────────────────────

test.describe('versionBelow', () => {
  test('orders dotted versions numerically', () => {
    expect(versionBelow('1.2.3', '1.2.4')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.9')).toBe(false);
    expect(versionBelow('2.0.0', '2.0.0')).toBe(false);
    expect(versionBelow('native-v1.0.0', 'v1.0.1')).toBe(true);
  });
  test('no minimum lets everything through', () => {
    expect(versionBelow('0.0.1', '')).toBe(false);
  });
});

test('the jar passes our two sessions and nothing else', () => {
  expect(jarToCookieLine('svrz_rc_session=a.b; other=x; svrz_admin_session=c.d; junk'))
    .toBe('svrz_rc_session=a.b; svrz_admin_session=c.d');
  expect(jarToCookieLine('')).toBe('');
});

async function withServer(minVersion: string, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(nativeClient({ minVersion }));
  app.post('/api/login', (_req, res) => {
    res.cookie('svrz_rc_session', 'signed.token', { httpOnly: true, maxAge: 1000 });
    res.cookie('unrelated', 'x');
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => { res.json({ cookie: req.headers.cookie ?? '' }); });
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('a native sign-in answers the token in a header as well as the cookie', async () => {
  await withServer('', async (base) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'X-Svrz-Client': 'native/1.0.0' } });
    expect(JSON.parse(res.headers.get('x-svrz-set-session') || '[]')).toEqual([
      { name: 'svrz_rc_session', value: 'signed.token', maxAge: 1000 },
    ]);
  });
});

test('a browser sign-in is untouched: cookie only, no session header', async () => {
  await withServer('', async (base) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST' });
    expect(res.headers.get('x-svrz-set-session')).toBeNull();
    expect(res.headers.get('set-cookie')).toContain('svrz_rc_session=signed.token');
  });
});

test('the jar replaces the Cookie line of a native request', async () => {
  await withServer('', async (base) => {
    const res = await fetch(`${base}/api/me`, {
      headers: { 'X-Svrz-Client': 'native/1.0.0', 'X-Svrz-Jar': 'svrz_rc_session=t; evil=1', Cookie: 'svrz_admin_session=stolen' },
    });
    expect((await res.json()).cookie).toBe('svrz_rc_session=t');
  });
});

test('an app below the minimum gets 426, except on health', async () => {
  await withServer('1.2.0', async (base) => {
    const old = { 'X-Svrz-Client': 'native/1.1.9' };
    expect((await fetch(`${base}/api/me`, { headers: old })).status).toBe(426);
    expect((await fetch(`${base}/api/health`, { headers: old })).status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: { 'X-Svrz-Client': 'native/1.2.0' } })).status).toBe(200);
    // The web app never sends the header and is never gated.
    expect((await fetch(`${base}/api/me`)).status).toBe(200);
  });
});

// ── The app's fetch wrapper ────────────────────────────────────────────

type NativeModule = typeof import('../src/lib/native');

/** A page that serves /src and talks to no backend on its own. */
async function blankPage(page: Page) {
  await page.goto('/guide');
  await page.evaluate(() => { localStorage.clear(); });
}

test('the wrapper keeps the session the API hands out and sends it back', async ({ page }) => {
  await blankPage(page);
  const seen: Record<string, string | undefined>[] = [];
  await page.route('**/api/test/login', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
    headers: { 'X-Svrz-Set-Session': JSON.stringify([{ name: 'svrz_rc_session', value: 'tok', maxAge: 60_000 }, { name: 'other', value: 'x', maxAge: 1 }]) },
  }));
  await page.route('**/api/test/me', (route) => {
    const h = route.request().headers();
    seen.push({ client: h['x-svrz-client'], jar: h['x-svrz-jar'] });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"me":1}' });
  });
  await page.route('**/api/test/logout', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
    headers: { 'X-Svrz-Set-Session': JSON.stringify([{ name: 'svrz_rc_session', value: '', maxAge: 0 }]) },
  }));

  await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    const f = mod.createNativeFetch(window.fetch.bind(window), location.origin, '9.9.9');
    await f(`${location.origin}/api/test/login`, { method: 'POST' });
    await f(`${location.origin}/api/test/me`, { method: 'POST' });
    await f(`${location.origin}/api/test/logout`, { method: 'POST' });
    await f(`${location.origin}/api/test/me`, { method: 'POST' });
  }, '/src/lib/native.ts');

  expect(seen).toEqual([
    { client: 'native/9.9.9', jar: 'svrz_rc_session=tok' },
    { client: 'native/9.9.9', jar: undefined },
  ]);
});

test('offline, a GET answers from the last good copy; the live stream never does', async ({ page }) => {
  await blankPage(page);
  let online = true;
  await page.route('**/api/test/coachees', (route) => (online
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '[{"id":"c1"}]' })
    : route.abort('internetdisconnected')));
  await page.route('**/api/events', (route) => route.abort('internetdisconnected'));

  const first = await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    await mod.clearNativeApiCache();
    const f = mod.createNativeFetch(window.fetch.bind(window), location.origin, '1.0.0');
    const res = await f(`${location.origin}/api/test/coachees`);
    const body = await res.text();
    // The copy is written a moment after the answer.
    for (let i = 0; i < 20 && !(await mod.readCachedApi(`${location.origin}/api/test/coachees`)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return body;
  }, '/src/lib/native.ts');
  expect(first).toBe('[{"id":"c1"}]');

  online = false;
  const offline = await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    const f = mod.createNativeFetch(window.fetch.bind(window), location.origin, '1.0.0');
    const res = await f(`${location.origin}/api/test/coachees`);
    let events = 'answered';
    try { await f(`${location.origin}/api/events`); } catch { events = 'threw'; }
    return { body: await res.text(), fromCache: res.headers.get('X-Svrz-From-Cache'), events };
  }, '/src/lib/native.ts');
  expect(offline).toEqual({ body: '[{"id":"c1"}]', fromCache: '1', events: 'threw' });
});

test('a 426 raises the update-required event', async ({ page }) => {
  await blankPage(page);
  await page.route('**/api/test/old', (route) => route.fulfill({ status: 426, contentType: 'application/json', body: '{}' }));
  const raised = await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    let hit = false;
    window.addEventListener(mod.UPDATE_REQUIRED_EVENT, () => { hit = true; });
    const f = mod.createNativeFetch(window.fetch.bind(window), location.origin, '1.0.0');
    await f(`${location.origin}/api/test/old`, { method: 'POST' });
    return hit;
  }, '/src/lib/native.ts');
  expect(raised).toBe(true);
});

test('a request to anything but the API goes out untouched', async ({ page }) => {
  await blankPage(page);
  let headers: Record<string, string> = {};
  await page.route('**/elsewhere.json', (route) => { headers = route.request().headers(); return route.fulfill({ status: 200, body: '{}' }); });
  await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    const f = mod.createNativeFetch(window.fetch.bind(window), `${location.origin}/nowhere`, '1.0.0');
    await f(`${location.origin}/elsewhere.json`);
  }, '/src/lib/native.ts');
  expect(headers['x-svrz-client']).toBeUndefined();
});

test('the fetch-based event stream delivers each frame', async ({ page }) => {
  await blankPage(page);
  await page.route('**/api/events', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: ': hello\n\ndata: {"type":"games.synced"}\n\ndata: line one\ndata: line two\r\n\r\n',
  }));
  const frames = await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as NativeModule;
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      const es = new mod.FetchEventSource('/api/events');
      es.onmessage = (m) => { got.push(m.data); if (got.length === 2) { es.close(); resolve(); } };
    });
    return got;
  }, '/src/lib/native.ts');
  expect(frames).toEqual(['{"type":"games.synced"}', 'line one\nline two']);
});

test('update offers compare versions, not strings', async ({ page }) => {
  await blankPage(page);
  const results = await page.evaluate(async (modulePath) => {
    const mod = await import(/* @vite-ignore */ modulePath) as typeof import('../src/lib/nativeShell');
    return [
      mod.newerVersion('native-v1.10.0', '1.9.0'),
      mod.newerVersion('v1.0.0', '1.0.0'),
      mod.newerVersion('1.0.1', '1.0.0'),
    ];
  }, '/src/lib/nativeShell.ts');
  expect(results).toEqual([true, false, true]);
});
