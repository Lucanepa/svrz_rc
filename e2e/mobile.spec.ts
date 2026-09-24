import { test, expect } from '@playwright/test';
import { stubSignedInApp, openOptions, COACHEE, COACHEE_LISTED } from './support/app';

// These tests only run in the mobile-chrome project (Pixel 5 viewport). They
// sign in first: the app is behind a login, so without one they were asserting
// about the login screen rather than the mobile layout.
test.describe('Mobile layout', () => {
  test.beforeEach(async ({ page }) => { await stubSignedInApp(page); });

  test('the tabs sit in a bottom nav and the rest behind Options', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    const nav = page.getByRole('navigation', { name: /Main navigation|Hauptnavigation/ });
    for (const name of [/^(Home|Start)$/, /^Coachees$/, /^(Games|Spiele)$/, /^(Options|Optionen)$/]) {
      await expect(nav.getByRole('button', { name })).toBeVisible();
    }
    // Pinned to the bottom of the viewport, not scrolled away with the page.
    const box = await nav.boundingBox();
    const vh = page.viewportSize()!.height;
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(vh - 1);

    await expect(page.getByRole('button', { name: /Abmelden|Log out/ })).toHaveCount(0);
    await openOptions(page);
    await expect(page.getByRole('button', { name: /Abmelden|Log out/ })).toBeVisible();
    await expect(page.getByText(/Load draft|Entwurf laden/)).toBeVisible();
  });

  test('the coachees list stays within the mobile viewport', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');
    // Home opens first; the list this is about lives on the Coachees tab. The
    // previous version never navigated there, so both its assertions sat behind
    // count() guards that were always false — a guaranteed empty pass about
    // Stage/Group columns the layout no longer has.
    await page.getByRole('button', { name: /^Coachees$/ }).click();

    await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();
    const overflow = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
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
    await page.goto('/admin');

    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Anmelden|Sign in/ })).toBeVisible();
  });
});
