import { test, expect } from '@playwright/test';

// These tests only run in the mobile-chrome project (Pixel 5 viewport)
test.describe('Mobile layout', () => {
  test('toolbar buttons hide text labels on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    // The first button (Admin toggle) should be visible but its span text hidden
    const firstButton = page.locator('button').first();
    await expect(firstButton).toBeVisible();

    // The span inside should have hidden sm:inline, so not visible on mobile
    const span = firstButton.locator('span');
    if (await span.count() > 0) {
      await expect(span).not.toBeVisible();
    }
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

    const searchInput = page.locator('input[type="text"]').first();
    await expect(searchInput).toBeVisible();
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });

  test('app header is visible on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    await expect(page.locator('img[alt="Swiss Volley"]')).toBeVisible();
  });

  test('admin login form works on mobile', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await page.goto('/');

    // Switch to admin
    await page.locator('button').first().click();

    // Login form should be visible and usable
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});
