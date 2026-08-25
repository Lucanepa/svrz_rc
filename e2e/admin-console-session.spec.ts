import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The admin-console login is a machine credential, not a person: it carries no
// RC record, so the session has admin rights and no identity. That combination
// used to strand it — the Home tab said "Welcome." and nothing else, and the
// sign-out button was gated on having a name, so the only way out of the app
// was to type #/admin and sign out from the console instead.

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  // Last matching handler wins: the session keeps its admin rights but loses
  // the RC the helper puts on every session.
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: { rc: null, admin: { email: 'admin@example.ch' }, surveyReader: false },
  }));
});

test('lands on the RC list instead of a Home tab it has no data for', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByRole('button', { name: /Referee Coaches/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Start|Home)$/ })).toHaveCount(0);
  // Replaced, not pushed — Back must not land on #/home and bounce forward again.
  await expect(page).toHaveURL(/#\/rc$/);
});

test('can sign out of the app itself', async ({ page }) => {
  const hit: string[] = [];
  for (const path of ['/api/auth/rc/logout', '/api/admin/auth/logout']) {
    await page.route(`**${path}`, (r) => { hit.push(path); return r.fulfill({ json: { ok: true } }); });
  }
  await page.goto('/#/home');
  await page.getByRole('button', { name: /Abmelden|Log out/ }).click();

  // Both cookies, or the gate — which opens for `rc || admin` — lets the next
  // reload walk straight back in.
  await expect.poll(() => hit.slice().sort()).toEqual(['/api/admin/auth/logout', '/api/auth/rc/logout']);
});
