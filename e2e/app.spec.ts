import { test, expect } from '@playwright/test';

test.describe('App loads', () => {
  test('shows header with Coaching Feedback title', async ({ page }) => {
    await page.goto('/');
    // Title is either "SR-Coaching Feedback" (DE) or "Referee Coaching Feedback" (EN)
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
  });

  test('shows Swiss Volley logo', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('img[alt="Swiss Volley"]')).toBeVisible();
  });

  test('shows Coachees and Games tab buttons', async ({ page }) => {
    await page.goto('/');
    // Tab text is "Coachees" in both DE/EN, "Games" (EN) or "Coachee-Spiele" (DE)
    await expect(page.getByRole('button', { name: /Coachees/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Games|Coachee-Spiele/i })).toBeVisible();
  });
});

test.describe('Language toggle', () => {
  test('toggles between DE and EN', async ({ page }) => {
    await page.goto('/');
    // The language button shows the *other* language to switch to
    const langButton = page.locator('button').filter({ has: page.locator('svg') }).nth(1);
    await expect(langButton).toBeVisible();
    // Get current h1 text
    const titleBefore = await page.locator('h1').innerText();
    await langButton.click();
    // Title should change after toggling
    await expect(page.locator('h1')).not.toContainText(titleBefore);
  });
});

test.describe('Tab switching', () => {
  test('switches between Coachees and Games tabs', async ({ page }) => {
    await page.goto('/');

    // Click Games tab
    await page.getByRole('button', { name: /Games|Coachee-Spiele/i }).click();

    // Games tab is now active — verify either a table header or an empty state message
    const gamesSection = page.locator('div.bg-white').first();
    await expect(gamesSection).toBeVisible();

    // Click Coachees tab back
    await page.getByRole('button', { name: /^Coachees$/i }).click();

    // The coachees tab content should be visible
    await expect(page.locator('div.bg-white').first()).toBeVisible();
  });
});

test.describe('Admin mode', () => {
  test('shows admin login form when switching to admin mode', async ({ page }) => {
    await page.goto('/');

    // Click the first button (Admin/Database toggle)
    await page.locator('button').first().click();

    // Verify login form appears
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('can switch back to feedback mode', async ({ page }) => {
    await page.goto('/');

    // Switch to admin
    await page.locator('button').first().click();
    await expect(page.locator('input[type="email"]')).toBeVisible();

    // Switch back to feedback
    await page.locator('button').first().click();
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
  });
});

test.describe('Search input', () => {
  test('search input is visible and interactive', async ({ page }) => {
    await page.goto('/');
    // Placeholder is "Suche..." (DE) or "Search..." (EN)
    const searchInput = page.locator('input[type="text"]').first();
    await expect(searchInput).toBeVisible();
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });
});
