import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// These asserted against an app that rendered straight away. It has sat behind
// a login for a while now, so every one of them was really asserting things
// about the login screen — and failing. They sign in first now.

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
});

test.describe('App loads', () => {
  test('shows header with Coaching Feedback title', async ({ page }) => {
    // "SR-Coaching Feedback" (DE) or "Referee Coaching Feedback" (EN)
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
  });

  test('shows Swiss Volley logo', async ({ page }) => {
    // The alt text names the region too, so match on the part that matters.
    await expect(page.locator('img[alt*="Swiss Volley"]').first()).toBeVisible();
  });

  test('shows Coachees and Games tab buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Coachees$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Coachee Games|Coachee-Spiele/ })).toBeVisible();
  });
});

test.describe('Language toggle', () => {
  test('toggles between DE and EN', async ({ page }) => {
    const title = page.locator('h1');
    const before = await title.innerText();
    // The button offers the other language, so its name flips with the app.
    await page.getByRole('button', { name: /^(DE|EN)$/ }).click();
    await expect(title).not.toHaveText(before);
  });
});

test.describe('Tab switching', () => {
  test('switches between Coachees and Games tabs', async ({ page }) => {
    await page.getByRole('button', { name: /Coachee Games|Coachee-Spiele/ }).click();
    await expect(page.getByRole('button', { name: /^(Filters|Filter)$/ })).toBeVisible();

    await page.getByRole('button', { name: /^Coachees$/ }).click();
    await expect(page.getByText('Ref One').first()).toBeVisible();
  });
});

test.describe('Admin console', () => {
  // Admin used to be a toggle on the toolbar; it is its own hash route now, and
  // it asks for the admin password when the session has no admin rights.
  test('asks for the admin password when the session has none', async ({ page }) => {
    await page.goto('/#/admin');
    await expect(page.getByRole('button', { name: /Anmelden|Sign in/ })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('an admin session gets the console itself', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    await page.goto('/#/admin');
    await expect(page.getByRole('button', { name: /^Coachees$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Referee Coaches/ })).toBeVisible();
  });

  test('can get back to the app from the console', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Zur App|To app/ }).click();
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
  });
});

test.describe('Search input', () => {
  test('search input is visible and interactive', async ({ page }) => {
    // The list search belongs to the Coachees tab; Home opens first.
    await page.getByRole('button', { name: /^Coachees$/ }).click();
    const search = page.getByPlaceholder(/Suche|Search/).first();
    await expect(search).toBeVisible();
    await search.fill('Ref');
    await expect(search).toHaveValue('Ref');
  });
});
