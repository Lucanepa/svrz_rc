import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, RC, COACHEE } from './support/app';
import { isRcSessionRefusal } from '../src/lib/logger';

/**
 * A session that is gone has to look gone.
 *
 * 09.10.2026, 17:16: a coach's /api/auth/me took 6010 ms. That was the service
 * worker giving up on the network after its 6 s and answering from its cache,
 * with an old "signed in". The app opened on cached data; for the next seven
 * minutes 18 of her requests came back 401 and nothing sent her to the login
 * screen, so what she saved never arrived. These pin the way back: a cached
 * "signed in" is asked again as soon as the server answers, a 401 from an RC
 * route asks again (once per burst), and the open form's work is written to
 * its draft before the screen changes.
 *
 * The suite runs on Vite's dev server, which has no service worker. The
 * worker's "answered from cache" broadcast (vite.config.ts, svrz-sw-cache) is
 * posted from the page instead, at the moment the worker would post it.
 */

const tipsBox = (page: Page) =>
  page.locator('textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]');

const passwordInput = (page: Page) => page.locator('input[type="password"]');

const SIGNED_IN = { rc: { id: RC.id, name: RC.name }, admin: null, shared: true, needsIdentity: false };
const SIGNED_OUT = { rc: null, admin: null, shared: false, needsIdentity: false };
const NO_RC = { rc: null, admin: null, shared: true, needsIdentity: true };

/** What the service worker says when it answers a URL from its cache. */
async function broadcastCacheHit(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const channel = new BroadcastChannel('svrz-sw-cache');
    channel.postMessage({ url: new URL(p, location.href).href });
    channel.close();
  }, path);
}

/** auth/me under the test's control, counting how often it is asked. */
async function stubAuthMe(page: Page, first: { body: unknown; fromCache?: boolean; then?: unknown }) {
  const state = { body: first.body as unknown, calls: 0, cacheNext: Boolean(first.fromCache) };
  await page.route('**/api/auth/me', async (r) => {
    state.calls++;
    const body = state.body;
    if (state.cacheNext) {
      state.cacheNext = false;
      await broadcastCacheHit(page, '/api/auth/me');
    }
    if (first.then !== undefined) state.body = first.then;
    await r.fulfill({ json: body });
  });
  return state;
}

/** Waits out the boot's own questions — the probe, twice under React's dev
 *  StrictMode — and says how many there were. The offline warm-up asks
 *  auth/me too, seconds into the boot, unless the API cache already holds it;
 *  so it is put there first, and every later question is a re-check. */
async function bootQuestionsDone(page: Page, me: { calls: number }): Promise<number> {
  for (;;) {
    const seen = me.calls;
    await page.waitForTimeout(1000);
    if (me.calls === seen) return seen;
  }
}

async function authMeAlreadyCached(page: Page): Promise<void> {
  await page.addInitScript(() => {
    void caches.open('svrz-api-get').then((cache) => cache.put(new URL('/api/auth/me', location.href).href, new Response('{}')));
  });
}

test.describe('rules', () => {
  test('only a 401 from the RC app session counts', () => {
    expect(isRcSessionRefusal(401, 'https://api.example/api/coachees')).toBe(true);
    expect(isRcSessionRefusal(401, '/api/feedback/submit')).toBe(true);
    expect(isRcSessionRefusal(401, '/api/drafts?season=2026')).toBe(true);
    expect(isRcSessionRefusal(401, '/api/signature/start')).toBe(true);
    expect(isRcSessionRefusal(401, '/api/ical/me')).toBe(true);
    // Not a refusal at all.
    expect(isRcSessionRefusal(403, '/api/coachees')).toBe(false);
    expect(isRcSessionRefusal(200, '/api/coachees')).toBe(false);
    // Another credential: the login itself, the console cookie, a referee's
    // PIN, a link token.
    for (const url of [
      '/api/auth/me', '/api/auth/shared/login', '/api/admin/auth/status', '/api/admin/coachees',
      '/api/coachee-file', '/api/coachee-file/forms/abc/file', '/api/signature/sig-test',
      '/api/survey/tok123', '/api/survey-responses', '/api/president-notes', '/api/forms/index',
      '/api/feedback-archive?season=2026', '/api/finance', '/api/referee-coaches', '/api/vm/x',
      '/api/ical/abcdef', 'https://cdn.example/font.woff2',
    ]) expect(isRcSessionRefusal(401, url), url).toBe(false);
  });
});

test.describe('in the app', () => {
  test('a cached "signed in" is asked again once the server answers, and a gone session goes to the login screen', async ({ page }) => {
    await stubSignedInApp(page);
    // The cache says signed in; the server, when it is finally asked, nobody.
    const me = await stubAuthMe(page, { body: SIGNED_IN, fromCache: true, then: SIGNED_OUT });
    await page.goto('/');

    await expect(passwordInput(page)).toBeVisible();
    await expect(page.getByTestId('session-expired')).toContainText(/Sitzung abgelaufen|Session expired/);
  });

  test('a cached "signed in" that the server confirms stays in the app', async ({ page }) => {
    await stubSignedInApp(page);
    await stubAuthMe(page, { body: SIGNED_IN, fromCache: true });
    await page.goto('/');

    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toBeVisible();
    // Long enough for the re-ask (the first test proves it happens) to land.
    await page.waitForTimeout(1500);
    await expect(passwordInput(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toBeVisible();
  });

  test('a 401 from an RC route while a form is open: the typed work is kept and comes back after signing in', async ({ page }) => {
    await stubSignedInApp(page);
    const me = await stubAuthMe(page, { body: SIGNED_IN });
    let gone = false;
    await page.route('**/api/coachees*', (r) => (gone
      ? r.fulfill({ status: 401, json: { error: 'Unauthorized' } })
      : r.fulfill({ json: [COACHEE] })));
    // The way back in, as shared-login.spec.ts stubs it.
    await page.route('**/api/auth/shared/login', (r) => { me.body = NO_RC; return r.fulfill({ json: { ok: true } }); });
    await page.route('**/api/auth/rc/roster', (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name }] }));
    await page.route('**/api/auth/rc/identify', (r) => {
      me.body = SIGNED_IN;
      return r.fulfill({ json: { ok: true, rc: { id: RC.id, name: RC.name } } });
    });

    await page.goto('/');
    await openFeedbackForm(page);
    const typed = 'Typed a moment before the session ran out';
    await tipsBox(page).fill(typed);

    // Inside the autosave's debounce: only the flush on the way out can keep it.
    gone = true;
    me.body = SIGNED_OUT;
    await page.evaluate(() => { void fetch('/api/coachees'); });

    await expect(passwordInput(page)).toBeVisible();
    await expect(page.getByTestId('session-expired')).toBeVisible();

    const stored = await page.evaluate(() => new Promise<{ tipsAndTricks: string; status: string }[]>((resolve, reject) => {
      const open = indexedDB.open('svrz-drafts', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const req = db.transaction('form-drafts', 'readonly').objectStore('form-drafts').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    }));
    expect(stored.map((d) => d.tipsAndTricks)).toContain(typed);

    // Back in as the same coach: the form opens again with the work in it.
    gone = false;
    await page.getByPlaceholder(/Benutzername|Username/).fill('Referee-Coaching');
    await page.getByPlaceholder(/^(Passwort|Password)$/).fill('not-a-real-password');
    await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();
    await page.getByRole('button', { name: RC.name }).click();
    await page.getByRole('button', { name: /Weiter|Continue/ }).click();
    await expect(tipsBox(page)).toHaveValue(typed);
  });

  test('a burst of 401s asks the server once, and a valid session stays open', async ({ page }) => {
    await stubSignedInApp(page);
    const me = await stubAuthMe(page, { body: SIGNED_IN });
    await authMeAlreadyCached(page);
    await page.route('**/api/rc-route-under-test*', (r) => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toBeVisible();
    const before = await bootQuestionsDone(page, me);

    await page.evaluate(() => { for (let i = 0; i < 6; i++) void fetch(`/api/rc-route-under-test?n=${i}`); });
    await expect.poll(() => me.calls).toBe(before + 1);
    // Another refusal inside the 30 s window is not another question.
    await page.waitForTimeout(800);
    await page.evaluate(() => { void fetch('/api/rc-route-under-test?again=1'); });
    await page.waitForTimeout(800);
    expect(me.calls).toBe(before + 1);
    await expect(passwordInput(page)).toHaveCount(0);
  });

  test('a 401 from somebody else\'s credential asks nothing', async ({ page }) => {
    await stubSignedInApp(page);
    const me = await stubAuthMe(page, { body: SIGNED_IN });
    await authMeAlreadyCached(page);
    await page.route('**/api/survey-responses*', (r) => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toBeVisible();
    const before = await bootQuestionsDone(page, me);
    await page.evaluate(() => { void fetch('/api/survey-responses'); });
    await page.waitForTimeout(800);
    expect(me.calls).toBe(before);
  });

  test('a team session that lost its RC lands on the picker, not the login form', async ({ page }) => {
    await stubSignedInApp(page);
    const me = await stubAuthMe(page, { body: SIGNED_IN });
    await page.route('**/api/auth/rc/roster', (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name }] }));
    await page.route('**/api/rc-route-under-test*', (r) => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toBeVisible();

    me.body = NO_RC;
    await page.evaluate(() => { void fetch('/api/rc-route-under-test'); });

    await expect(page.getByRole('heading', { name: /Wer bist du\?|Who are you\?/ })).toBeVisible();
    await expect(passwordInput(page)).toHaveCount(0);
  });
});
