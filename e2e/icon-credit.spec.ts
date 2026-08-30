import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The spinner's ball and whistle are Game Icons artwork, which is CC BY 3.0.
// That licence is only satisfied while the credit is actually on screen, and a
// credit in a footer is exactly the kind of line that gets tidied away by
// somebody who does not know it is load-bearing. If this test fails, either put
// the credit back or stop shipping the icons — not the other way round.

test('the Game Icons credit is on screen, as the licence requires', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/#/home');
  await expect(page.getByRole('link', { name: 'Game Icons' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CC BY 3.0' })).toBeVisible();
});
