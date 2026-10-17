import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

// A refused send marks what it was refused over, in red, where it is — not only
// in the sentence at the foot of the form. Asked 17.10.2026: the sentence used
// to list every bottom field whatever was missing, and said nothing about the
// result or the signatures at all until those were the last thing left.

const sendButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ });
const gap = (page: import('@playwright/test').Page, text: RegExp) =>
  page.locator('[data-missing="true"]').filter({ hasText: text });

test('the result and both signatures wear red too, until they are given', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  await sendButton(page).click();
  await expect(page.getByText(/fill in all ratings|alle Bewertungen ausfüllen/)).toBeVisible();

  await expect(gap(page, /^(Result|Ergebnis)/)).toHaveCount(1);
  await expect(gap(page, /Referee signature|Unterschrift Schiedsrichter/)).toHaveCount(1);
  await expect(gap(page, /Referee Coach signature|Unterschrift Referee Coach/)).toHaveCount(1);

  // A recorded refusal is as good as the referee's ink: that box lets go.
  await page.getByRole('button', { name: /Referee refuses to sign|SR verweigert Unterschrift/ }).click();
  await expect(gap(page, /Referee signature|Unterschrift Schiedsrichter/)).toHaveCount(0);
  await expect(gap(page, /Referee Coach signature|Unterschrift Referee Coach/)).toHaveCount(1);
});

test('the form\'s large editor has the checklist too', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  await page.getByRole('button', { name: /Edit larger|Grösser bearbeiten/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Checkliste|Checklist/ }).click();
  await expect(dialog.locator('.rich-surface')).toHaveText(/^☐\s?$/);
});
