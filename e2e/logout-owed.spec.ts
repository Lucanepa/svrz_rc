import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * A logout the server never saw, and a session that ended without one
 * (audit 2026-09-28, frontend-1 and frontend-2).
 *
 * The console cookie is signed and stateless for 8 h; only the server's
 * Set-Cookie ends it. An "Abmelden" pressed offline used to show the login form
 * while that cookie lived on, so the next reload — of /admin, or of the app,
 * which opens for `rc || admin` — walked straight back in. And the offline
 * response cache was only emptied on an explicit logout, so a session that
 * simply expired left its data behind for whoever used the profile next.
 *
 * The server is modelled by two booleans: which cookies are still alive.
 */

async function stubServer(page: Page, opts: { rc: boolean }) {
  const server = { rcAlive: opts.rc, adminAlive: true, networkUp: false, adminLogoutCalls: 0 };
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: {
      rc: server.rcAlive ? { id: 'rc1', name: 'Test RC' } : null,
      admin: server.adminAlive ? { email: 'admin@example.ch' } : null,
      surveyReader: false, adminShortcut: false,
    },
  }));
  await page.route('**/api/admin/auth/status', (r) => r.fulfill({
    json: { authenticated: server.adminAlive, email: server.adminAlive ? 'admin@example.ch' : '', role: server.adminAlive ? 'admin' : null },
  }));
  await page.route('**/api/auth/rc/logout', (r) => { server.rcAlive = false; return r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/admin/auth/logout', (r) => {
    server.adminLogoutCalls += 1;
    if (!server.networkUp) return r.abort('internetdisconnected');
    server.adminAlive = false;
    return r.fulfill({ json: { ok: true } });
  });
  return server;
}

const pendingFlag = (page: Page) => page.evaluate(() => localStorage.getItem('svrz_pending_admin_logout'));

test('a console logout that fails keeps the console shut until the server confirms it', async ({ page }) => {
  const server = await stubServer(page, { rc: false });
  await page.goto('/admin');
  const consoleTab = page.getByRole('button', { name: /^Coachees$/ });
  await expect(consoleTab).toBeVisible();

  await page.getByRole('button', { name: /^(Abmelden|Sign out)$/ }).click();
  await expect(page.locator('#admin-pw')).toBeVisible();
  expect(await pendingFlag(page)).toBe('1');

  // The cookie is still alive and the status endpoint says so — the reload
  // must not believe it.
  await page.reload();
  await expect(page.locator('#admin-pw')).toBeVisible();
  await expect(consoleTab).toHaveCount(0);
  expect(server.adminAlive).toBe(true);

  // Network back: the next load settles the revocation, and only then drops the flag.
  server.networkUp = true;
  await page.reload();
  await expect(page.locator('#admin-pw')).toBeVisible();
  await expect.poll(() => server.adminAlive).toBe(false);
  expect(await pendingFlag(page)).toBeNull();
  expect(server.adminLogoutCalls).toBeGreaterThanOrEqual(2);
});

test('the coach app does not re-adopt an admin cookie whose logout is still owed', async ({ page }) => {
  const server = await stubServer(page, { rc: false });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('svrz_pending_admin_logout', '1'));
  await page.reload();

  // Without the guard, {rc:null, admin:{…}} is a signed-in session and the app
  // forwards it to the console.
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page).not.toHaveURL(/\/admin/);
  await expect(page.getByRole('button', { name: /^Coachees$/ })).toHaveCount(0);
  expect(server.adminAlive).toBe(true);
});

test('the offline cache is emptied when the session changes without a logout', async ({ page }) => {
  const server = await stubServer(page, { rc: true });
  server.adminAlive = false;
  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  // The first answer on a device only records whose the cache is.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('svrz_api_cache_owner'))).not.toBeNull();

  const putProbe = () => page.evaluate(async () => {
    const cache = await caches.open('svrz-api-get');
    await cache.put('/__probe', new Response('secret'));
  });
  const probeThere = () => page.evaluate(async () => {
    const cache = await caches.open('svrz-api-get');
    return Boolean(await cache.match('/__probe'));
  });

  // Same person on reload: the cache stays — this is the RCs' offline data.
  await putProbe();
  await page.reload();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  expect(await probeThere()).toBe(true);

  // The cookie expired: /auth/me now answers "nobody", and the cache goes.
  server.rcAlive = false;
  await page.reload();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect.poll(probeThere).toBe(false);
});
