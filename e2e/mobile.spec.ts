import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// These tests only run in the mobile-chrome project (Pixel 5 viewport). They
// sign in first: the app is behind a login, so without one they were asserting
// about the login screen rather than the mobile layout.
test.describe('Mobile layout', () => {
  test.beforeEach(async ({ page }) => { await stubSignedInApp(page); });

  test('toolbar buttons hide text labels on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    // The sign-out button carries the coach's name beside its icon on a wide
    // screen and drops to the icon alone here — the button stays, the label goes.
    const signOut = page.getByRole('button', { name: /Abmelden|Log out/ });
    await expect(signOut).toBeVisible();
    await expect(signOut.getByText('Anna Muster')).toBeHidden();
  });

  test('coachees table hides Stage and Group columns on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    // Stage and Group columns should be hidden (hidden md:table-cell)
    // Note: if no coachees loaded, the table may not render at all
    const stageHeader = page.locator('th', { hasText: 'Stage' });
    const groupHeader = page.locator('th', { hasText: /Gruppe|Group/ });

    if (await stageHeader.count() > 0) {
      await expect(stageHeader).not.toBeVisible();
    }
    if (await groupHeader.count() > 0) {
      await expect(groupHeader).not.toBeVisible();
    }
  });

  test('search input is accessible on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');
    // The list search belongs to the Coachees tab; Home opens first.
    await page.getByRole('button', { name: /^Coachees$/ }).click();

    const searchInput = page.locator('input[type="text"]').first();
    await expect(searchInput).toBeVisible();
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });

  test('app header is visible on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    // The alt names the region too, so match the part that matters.
    await expect(page.locator('img[alt*="Swiss Volley"]').first()).toBeVisible();
  });

  test('admin login form works on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    // Admin is its own hash route now, not a toolbar toggle, and it asks for
    // the admin password when the session carries no admin rights.
    await page.goto('/#/admin');

    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Anmelden|Sign in/ })).toBeVisible();
  });
});
