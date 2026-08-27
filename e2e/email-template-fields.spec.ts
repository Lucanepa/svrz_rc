import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The console mounts every tab and hides the inactive ones, so a field that
// measures itself on mount measures nothing: scrollHeight is 0 inside a
// display:none subtree. The subject box collapsed to its two borders and the
// text sat underneath it, outside the field it belonged to.

const TEMPLATE = {
  subject: 'Coaching-Begleitung bei deinem nächsten Einsatz',
  heading: 'Titel',
  intro: 'Hallo {{name}}\n\nEinsatz am {{datum}}.',
  outro: 'Grüsse',
};

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/email-templates', (r) => r.fulfill({
    json: {
      feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE,
      defaults: { feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE },
      reminder_enabled: true,
      placeholders: { feedback: ['name', 'datum'], reminder: ['name', 'datum'], survey: ['name', 'datum'] },
      accepted: { feedback: ['name', 'datum', 'coachee'], reminder: ['name', 'datum', 'coachee'], survey: ['name', 'datum', 'coachee'] },
    },
  }));
});

test('the subject box is as tall as the text in it, even when the tab was hidden first', async ({ page }) => {
  // Arrive from another tab: the Emails tab is mounted, and hidden, before it
  // is ever shown — the path that broke it.
  await page.goto('/#/admin/coachees');
  // The console opens in German, which is what the club uses.
  await page.getByRole('button', { name: 'E-Mails', exact: true }).click();

  const box = page.locator('textarea.tpl-field').first();
  await expect(box).toBeVisible();
  await expect.poll(async () => Math.round((await box.boundingBox())!.height)).toBeGreaterThan(30);

  // The mirror carries the visible text, so it has to trace the field exactly —
  // one differing pixel and the words drift out of their own box.
  const drift = await page.evaluate(() => {
    const ta = document.querySelector('textarea.tpl-field') as HTMLElement;
    const mirror = ta.parentElement!.querySelector('div.tpl-field') as HTMLElement;
    const a = ta.getBoundingClientRect(), b = mirror.getBoundingClientRect();
    return { top: Math.abs(a.top - b.top), height: Math.abs(a.height - b.height) };
  });
  expect(drift.top).toBeLessThanOrEqual(1);
  expect(drift.height).toBeLessThanOrEqual(1);
});

test('a placeholder the server does substitute is not flagged as unknown', async ({ page }) => {
  await page.goto('/#/admin/emails');
  await page.getByRole('textbox').first().waitFor();
  // {{coachee}} is an alias: not offered as a chip, but it renders — so it must
  // not be marked amber, and the warning must stay away.
  await page.locator('textarea.tpl-field').nth(2).fill('Hallo {{coachee}}');
  await expect(page.getByText(/bleiben im Versand leer/)).toHaveCount(0);
  await page.locator('textarea.tpl-field').nth(2).fill('Hallo {{gibtsnicht}}');
  await expect(page.getByText(/bleiben im Versand leer/).first()).toBeVisible();
});
