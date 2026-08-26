import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * The #/admin shortcut in the coach toolbar.
 *
 * It is DISPLAY ONLY. The name on an app session is picked off a list, never
 * proven, so anyone holding the team credential can make the flag true by
 * choosing a different name — and gains a button, nothing more. These tests
 * exist to keep it that way: the day someone reads `adminShortcut` as a
 * permission, the second one here fails.
 */

const adminButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^Admin$/ });

test('an ordinary coach is not shown a door they cannot open', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Coaching Feedback');
  await expect(adminButton(page)).toHaveCount(0);
});

test('the shortcut is cosmetic: it opens the console login, not the console', async ({ page }) => {
  await stubSignedInApp(page, { adminShortcut: true });
  await page.goto('/');
  await expect(adminButton(page)).toBeVisible();

  await adminButton(page).click();
  // The console asks for its own password regardless of how you arrived. If it
  // ever renders its tabs here instead, the flag has become a permission.
  await expect(page.getByText(/Eigener Zugang für diese Seite|This page has its own login/)).toBeVisible();
  await expect(page.getByPlaceholder(/Benutzername|Username/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Coachees$/ })).toHaveCount(0);
});

test('a real console session sees it too, without the flag', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.goto('/');
  await expect(adminButton(page)).toBeVisible();
});
