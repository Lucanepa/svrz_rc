import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stubSignedInApp } from './support/app';

// Phone notifications (web push, asked 2026-10-10): the same news a coach is
// mailed about their games, on each device they switch it on for.

/** A browser with a service worker and the Push API, faked — the dev server
 *  registers no worker, so the real one cannot be asked. */
async function fakePush(page: Page, opts: { permission?: NotificationPermission; subscribed?: boolean; ua?: string } = {}) {
  await page.addInitScript(({ permission, subscribed }) => {
    let perm = permission;
    let sub: { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
    const make = () => ({
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => { sub = null; return true; },
    });
    if (subscribed) sub = make();
    const pushManager = {
      getSubscription: async () => sub,
      subscribe: async () => { sub = make(); return sub; },
    };
    const reg = { pushManager };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => reg, ready: Promise.resolve(reg), register: async () => reg, addEventListener() {}, removeEventListener() {}, controller: null },
    });
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => perm });
    Notification.requestPermission = async () => { perm = 'granted'; return perm; };
  }, { permission: opts.permission ?? 'default', subscribed: opts.subscribed ?? false });
}

async function openOptions(page: Page) {
  await page.goto('/home');
  await page.getByRole('button', { name: /^(Optionen|Options)$/ }).first().click();
}

test('switching notifications on asks the browser, tells the server, and sends a first test', async ({ page }) => {
  const calls: Array<{ path: string; body: string }> = [];
  await stubSignedInApp(page);
  await fakePush(page);
  await page.route('**/api/push/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    calls.push({ path, body: r.request().postData() ?? '' });
    if (path.endsWith('/config')) await r.fulfill({ json: { publicKey: 'fake-public-key' } });
    else await r.fulfill({ json: { ok: true, sent: 1 } });
  });
  await openOptions(page);

  const option = page.getByTestId('push-option');
  await expect(option).toHaveAttribute('data-state', 'off');
  await option.click();
  await expect(option).toHaveAttribute('data-state', 'on');
  expect(calls.map((c) => c.path)).toEqual(['/api/push/config', '/api/push/subscribe', '/api/push/test']);
  expect(JSON.parse(calls[1].body).subscription).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
});

test('switching them off unsubscribes the device on both sides', async ({ page }) => {
  const calls: string[] = [];
  await stubSignedInApp(page);
  await fakePush(page, { permission: 'granted', subscribed: true });
  await page.route('**/api/push/**', async (r) => { calls.push(new URL(r.request().url()).pathname); await r.fulfill({ json: { ok: true } }); });
  await openOptions(page);

  const option = page.getByTestId('push-option');
  await expect(option).toHaveAttribute('data-state', 'on');
  // Signing in told the server whose device it is.
  await expect.poll(() => calls).toContain('/api/push/subscribe');
  await option.click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Turn off|Ausschalten)$/ }).click();
  await expect(option).toHaveAttribute('data-state', 'off');
  expect(calls).toContain('/api/push/unsubscribe');
});

test('on an iPhone in a browser tab it says what Apple asks for first', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  await stubSignedInApp(page);
  await fakePush(page);
  await openOptions(page);
  const option = page.getByTestId('push-option');
  await expect(option).toHaveAttribute('data-state', 'ios-home-screen');
  await option.click();
  await expect(page.getByText(/Add to Home Screen|Zum Home-Bildschirm/).first()).toBeVisible();
  await context.close();
});

test('where there is no service worker the option is not offered at all', async ({ page }) => {
  await stubSignedInApp(page);
  // An installed app's webview, or a browser without workers.
  await page.addInitScript(() => { delete (Navigator.prototype as unknown as Record<string, unknown>).serviceWorker; });
  await openOptions(page);
  await expect(page.getByRole('button', { name: /^(Language|Sprache)/ })).toBeVisible();
  await expect(page.getByTestId('push-option')).toHaveCount(0);
});

test('the service worker shows the notification and a tap opens the app there', async () => {
  const source = readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8');
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: Array<{ title: string; opts: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const waits: Promise<unknown>[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  };
  runInNewContext(source, { self });
  listeners.push({
    data: { json: () => ({ title: 'Spiel verschoben: A – B', body: 'Neuer Termin', url: 'https://svrz-rc.openvolley.app/games', tag: 't' }) },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  expect(shown).toEqual([{ title: 'Spiel verschoben: A – B', opts: expect.objectContaining({ body: 'Neuer Termin', tag: 't', data: { url: 'https://svrz-rc.openvolley.app/games' } }) }]);

  listeners.notificationclick({
    notification: { close() {}, data: { url: 'https://svrz-rc.openvolley.app/games' } },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  expect(opened).toEqual(['https://svrz-rc.openvolley.app/games']);
});

test('the server sends the push beside every coach mail, never in test mode, and the worker is imported', () => {
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  expect(server).toMatch(/if \(!n\.testMode && n\.coachId && n\.push\) void pushToCoach\(n\.coachId, n\.push\)/);
  // The Börse alert mails through its own send, so it pushes on its own too.
  expect(server).toMatch(/if \(!testMode\) void pushToCoach\(coach\.id, \{ title: `SR-Börse:/);
  // A subscription the push service says is gone is removed.
  expect(server).toMatch(/status === 404 \|\| status === 410/);
  expect(vite).toMatch(/importScripts: \['push-sw\.js'\]/);
});
