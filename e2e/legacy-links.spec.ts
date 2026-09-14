import { test, expect } from '@playwright/test';
import { stubSignedInApp, COACHEE, COACHEE_LISTED, GAME } from './support/app';

/**
 * The `#/…` links keep working, forever.
 *
 * Routes lived in the URL hash until 13.09.2026, and those links are out in
 * the world for good: in mails already sent, in the retired GitHub Pages kill
 * switch that forwards `location.hash` verbatim and can never be updated
 * again, in home-screen icons captured before the change. Cloudflare cannot
 * help — a fragment is never sent to the server — so main.tsx rewrites the
 * URL in place before anything reads a route. These tests are the contract
 * for that rewrite; deleting it breaks all three sources silently.
 */

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
});

test('a hash link to a tab lands on the path, on that tab', async ({ page }) => {
  await page.goto('/#/games');

  await expect(page).toHaveURL(/\/games$/);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toHaveClass(/bg-slate-900/);
});

test('the rewrite leaves no Back step behind — Back leaves the app', async ({ page }) => {
  await page.goto('/#/coachees');
  await expect(page).toHaveURL(/\/coachees$/);

  // replaceState, not a push: the hash form must not survive as an entry the
  // Back button bounces through. Nothing to go back to means Playwright
  // returns null here, and the URL is not the hash form afterwards.
  const previous = await page.goBack();
  expect(previous).toBeNull();
  expect(page.url()).not.toContain('#/');
});

test('a hash link that carries an id keeps the id, case intact', async ({ page }) => {
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [{ ...GAME, assignedRoles: ['1. SR'] }],
  }));
  await page.goto(`/#/games/${COACHEE.id}`);

  await expect(page).toHaveURL(new RegExp(`/games/${COACHEE.id}$`));
  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
});

test('the slashless form the old router also accepted is rewritten too', async ({ page }) => {
  await page.goto('/#coachees');

  await expect(page).toHaveURL(/\/coachees$/);
  await expect(page.getByText(COACHEE_LISTED)).toBeVisible();
});

test('a hash link to the admin console opens the console', async ({ page }) => {
  await page.goto('/#/admin/settings');

  await expect(page).toHaveURL(/\/admin\/settings$/);
  // The console's own login, not the app: the console is a different root.
  await expect(page.getByRole('button', { name: /Anmelden|Sign in/ })).toBeVisible();
});

test('a survey link is NOT rewritten — its token stays in the fragment', async ({ page }) => {
  await page.goto('/#/survey/tok123');

  // Served from "/", token still in the hash, which is what keeps it out of
  // every request log and Referer header. See routes.ts, "Two transports".
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('#/survey/tok123');
});

test('a plain anchor is not a route and is left exactly where it is', async ({ page }) => {
  await page.goto('/#section-2');

  // `#section-2` matched the route pattern once and would have become
  // /section-2 — a path public/_redirects has never heard of, fine until the
  // reader hits reload and gets a 404 on a URL that used to work.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('#section-2');
  // And the app lands where an unknown route always landed: Home, whose tab
  // is the selected one (bg-slate-900 is the selected tab's colour).
  await expect(page.getByRole('button', { name: /^(Home|Start)$/ })).toHaveClass(/bg-slate-900/);
});

test.describe('the hidden demo entry', () => {
  // No stub: the demo is a promise of zero backend calls, and the routes
  // registered by stubSignedInApp would mask a broken promise. The dev
  // proxy points at a closed port, so anything that leaks fails loudly.
  for (const entry of ['/#/demo', '/demo']) {
    test(`${entry} turns the demo on and drops the route from the URL`, async ({ page }) => {
      await page.goto(entry);

      await expect(page.getByText(/^DEMO — /)).toBeVisible();
      // The entry is a switch, not a place: the URL is the plain app afterwards,
      // so a reload stays in the demo by the sessionStorage flag, not by re-entering.
      // main.tsx drops the route to `/`, and the app — now a signed-in coach on
      // Home — writes its own Home URL over that a tick later, the same URL a
      // coach who logged in sees. Wait for that settled URL: asserting `/` the
      // instant the banner shows raced the sync and lost on a fast machine.
      await expect(page).toHaveURL(/\/home$/);
      expect(new URL(page.url()).pathname).toBe('/home');
      expect(new URL(page.url()).hash).toBe('');
    });
  }
});
