import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// "Send the reminder now" — for a coach who took a game the day after tomorrow,
// or who wants the referee to know today. The unattended job runs at 10:00 the
// day BEFORE and only when the commission has switched it on, so until this
// there was no way for a coach to say it themselves.

const PLANNED = {
  coacheeName: 'Ref One', coacheeId: 'c1', doneFeedbacks: [], outstandingGames: [],
  plannedGames: [{
    gameId: 'g1', gameDate: '2026-11-15T19:30:00Z', league: '3L',
    teams: 'VBC Züri Unterland vs Volley Näfels II', refereeName: 'Ref One', result: '',
  }],
};

test('a planned game can be reminded from Home, after confirming', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route(`**/api/rc-overview/**/coachees*`, (r) => r.fulfill({ json: [PLANNED] }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  let posted = 0;
  await page.route('**/api/games/g1/reminder', (r) => {
    posted += 1;
    return r.fulfill({ json: { sent: 1, suppressed: false, recipients: ['ref.one@example.ch'] } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Send reminder|Erinnerung senden/ }).click();

  // Nothing is sent until it is confirmed: the mail cannot be unsent.
  await expect(page.getByText(/Send the reminder now\?|Erinnerung jetzt senden\?/)).toBeVisible();
  expect(posted).toBe(0);

  await page.getByRole('button', { name: /^(Send|Senden)$/ }).click();
  await expect(page.getByText(/Reminder sent to 1|Erinnerung an 1/)).toBeVisible();
  expect(posted).toBe(1);
});

test('test mode says so instead of claiming a mail went out', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route(`**/api/rc-overview/**/coachees*`, (r) => r.fulfill({ json: [PLANNED] }));
  await page.route('**/api/games/g1/reminder', (r) => r.fulfill({
    json: { sent: 0, suppressed: true, recipients: ['ref.one@example.ch'] },
  }));

  await page.goto('/');
  await page.getByRole('button', { name: /Send reminder|Erinnerung senden/ }).click();
  await page.getByRole('button', { name: /^(Send|Senden)$/ }).click();

  await expect(page.getByText(/Test mode is on|Test-Modus ist aktiv/)).toBeVisible();
});
