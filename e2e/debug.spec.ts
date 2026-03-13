import { test, expect } from '@playwright/test';
test('debug', async ({ page }) => {
  await page.goto('/');
  await page.locator('table').waitFor();
  await page.locator('tbody tr').first().click();
  await page.waitForTimeout(1500);
  // Look for the action button
  const buttons = await page.locator('button').allInnerTexts();
  console.log('=== ALL BUTTONS ===');
  console.log(buttons.join('\n'));
  // Check for the detail panel
  const detail = page.locator('text=/Ackermann/');
  const count = await detail.count();
  console.log('Ackermann mentions:', count);
  // Try to find the Games/Feedback button
  const actionBtn = page.locator('button', { hasText: /Games|Spiele/ });
  console.log('Games buttons:', await actionBtn.count());
  const allActionBtns = await actionBtn.allInnerTexts();
  console.log('Texts:', allActionBtns);
});
