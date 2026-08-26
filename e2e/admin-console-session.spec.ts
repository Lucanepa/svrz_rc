import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The admin-console login is a machine credential, not a person: it carries no
// RC record, so the session has admin rights and no identity.
//
// That combination used to be given a home inside the coach app — it landed on
// an RC-overview tab built for it. Admin work now lives entirely on the admin
// page, so the coach app has nothing to show a session with no coach in it, and
// inventing a screen for one is how the app ended up with two personalities.
// It gets sent where it was going instead.

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  // Last matching handler wins: the session keeps its admin rights but loses
  // the RC the helper puts on every session.
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: { rc: null, admin: { email: 'admin@example.ch' }, surveyReader: false, adminShortcut: true },
  }));
});

test('a session with no coach in it is sent to the admin page', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page).toHaveURL(/#\/admin$/);
  // And it really lands on the console — this session is stubbed as already
  // signed in there, so what should appear is the console itself.
  await expect(page.getByRole('button', { name: /^Coachees$/ })).toBeVisible();
  // Not a coach screen. Counted rather than negated on the element itself:
  // there is no h1 here at all, and .not.toContainText errors on a missing
  // element instead of passing.
  await expect(page.locator('h1', { hasText: 'Coaching Feedback' })).toHaveCount(0);
});

test('the coach app offers it no RC overview to land on', async ({ page }) => {
  await page.goto('/#/rc');
  // The route is gone, so this is not a screen any more — it falls through to
  // the redirect above rather than rendering an admin-only list.
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByRole('button', { name: /Referee Coaches/ })).toHaveCount(0);
});
