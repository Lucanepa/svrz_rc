import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * The first load of a session is the branded spinner, and it stands for the
 * whole app being put on this phone: once it is through, the Offline-Ready
 * check runs for the app (not only for an open form) and warms what the gym
 * with no signal will need. Options says how that went, and prepares again on
 * a tap.
 */

test('after the first load the app is prepared for offline, and Options says so', async ({ page }) => {
  const warmed: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p === '/api/rc-games' || p === '/api/games/calendar-status') warmed.push(p);
  });
  await stubSignedInApp(page);
  await page.goto('/');
  await expect.poll(() => warmed.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: /^(Optionen|Options)$/ }).click();
  const row = page.getByRole('button', { name: /Offline verfügbar|Available offline/ });
  await expect(row).toBeVisible();
  // The dev server has no service worker, so the verdict is "incomplete" —
  // what matters is that the check ran and says something other than "load now".
  await expect(row).not.toContainText(/Jetzt laden|Load now/);
});
