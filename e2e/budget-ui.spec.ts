import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Admin → Finance & operations: the budget card over the coaches' table, and a
// CHF column per coach.

const OVERVIEW = [
  { id: 'rc1', fullName: 'Anna Muster', done: 10, outstanding: 1, planned: 2, paidAt: null, paidBy: '', meetingsAttended: ['m1'] },
  { id: 'rc2', fullName: 'Beat Beispiel', done: 5, outstanding: 0, planned: 0, paidAt: '2026-12-01T10:00:00Z', paidBy: 'admin', meetingsAttended: [] },
];

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/settings', (r) => r.fulfill({ json: {
    default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10,
    paid_cap: 12, expense_rates: { visit: 60, meeting: 60, meetingDate: '' },
  } }));
  await page.route(/\/api\/rc-overview\?season=2026$/, (r) => r.fulfill({ json: OVERVIEW }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/admin/rc-meetings?*', (r) => r.fulfill({ json: { season: 2026, meetings: [
    { id: 'm1', title: 'RC-Sitzung', date: '2026-10-09', start: '19:00', end: '19:45', link: '', notes: '', rate: 60, attended: ['rc1'] },
  ] } }));
});

test('the card adds up visits, committed games, meetings and extras against the budget', async ({ page }) => {
  let stored = { budget: 5500, extras: [] as Array<{ id: string; label: string; amount: number }> };
  const puts: unknown[] = [];
  await page.route('**/api/admin/budget*', async (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON();
      puts.push(body);
      stored = { budget: body.budget, extras: body.extras };
    }
    await r.fulfill({ json: { season: 2026, ...stored } });
  });
  await page.goto('/admin/overview');
  await expect(page.getByRole('button', { name: 'Finance & operations' })).toBeVisible();
  const card = page.getByTestId('budget-card');
  // 15 paid games × 60 = 900; 2 committed × 60 = 120 (Anna's third taken game
  // is past the cap of 12); 1 meeting × 60 = 60.
  await expect(card.getByTestId('budget-visits')).toContainText('15 Spiele × CHF 60.00');
  await expect(card.getByTestId('budget-visits')).toContainText('900.00');
  await expect(card.getByTestId('budget-upcoming')).toContainText('2 Spiele');
  await expect(card.getByTestId('budget-upcoming')).toContainText('120.00');
  await expect(card.getByTestId('budget-meetings')).toContainText('60.00');
  await expect(card.getByTestId('budget-remaining')).toContainText(/CHF 4.420\.00/);
  // Paid out: rc2's 300; still to pay: rc1's 600 + 60.
  await expect(card.getByTestId('budget-payout')).toContainText(/Ausbezahlt CHF 300\.00 · Noch auszuzahlen CHF 660\.00/);

  // An extra comes off the remaining budget at once.
  await card.getByRole('button', { name: 'Extra hinzufügen' }).click();
  await card.getByLabel('Bezeichnung').fill('Kursmaterial');
  await card.getByLabel('CHF', { exact: true }).fill('80');
  await card.getByRole('button', { name: 'Speichern' }).click();
  await expect(card.getByTestId('budget-remaining')).toContainText(/CHF 4.340\.00/);
  expect((puts[0] as { extras: Array<{ label: string; amount: number }> }).extras).toMatchObject([{ label: 'Kursmaterial', amount: 80 }]);

  // The budget itself is changeable per season.
  await card.getByTestId('budget-amount').getByRole('button', { name: 'Ändern' }).click();
  await card.getByLabel('Budget').fill('6000');
  await card.getByTestId('budget-amount').getByRole('button', { name: 'Speichern' }).click();
  await expect(card.getByTestId('budget-remaining')).toContainText(/CHF 4.840\.00/);
  expect(puts[1]).toMatchObject({ season: 2026, budget: 6000 });
});

test('each coach shows what they can claim in CHF', async ({ page }) => {
  await page.route('**/api/admin/budget*', (r) => r.fulfill({ json: { season: 2026, budget: 5500, extras: [] } }));
  await page.goto('/admin/overview');
  const anna = page.getByRole('row', { name: /Anna Muster/ });
  await expect(anna).toContainText('660.00'); // 10 × 60 + one meeting
  const beat = page.getByRole('row', { name: /Beat Beispiel/ });
  await expect(beat).toContainText('300.00');
});
