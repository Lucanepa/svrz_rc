import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The chair's own console has a Finanzen tab (Jasmin, 2026-10-05: "budget
// si"): the same budget card as the admin's, read from /api/finance, and what
// each coach can claim. The admin keeps theirs on Finanzen & Betrieb.

const FINANCE = {
  season: 2026, cap: 12, visitRate: 60,
  rows: [
    { id: 'rc1', fullName: 'Anna Muster', done: 10, outstanding: 1, planned: 2, paidAt: null },
    { id: 'rc2', fullName: 'Beat Beispiel', done: 5, outstanding: 0, planned: 0, paidAt: '2026-12-01T10:00:00Z' },
  ],
  meetings: [{ id: 'm1', title: 'RC-Sitzung', date: '2026-10-09', rate: 60, attended: ['rc1'] }],
  budget: { budget: 5500, extras: [] },
};

test('the chair sees the budget and each coach\'s claim, and may change the budget', async ({ page }) => {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  await page.route('**/api/finance', (r) => r.fulfill({ json: FINANCE }));
  const puts: unknown[] = [];
  await page.route('**/api/admin/budget*', async (r) => {
    if (r.request().method() === 'PUT') puts.push(r.request().postDataJSON());
    await r.fulfill({ json: { season: 2026, budget: puts.length ? 6000 : 5500, extras: [] } });
  });
  await page.goto('/admin/finance');
  await expect(page.getByRole('button', { name: 'Finanzen', exact: true })).toBeVisible();
  const view = page.getByTestId('finance-chair');
  await expect(view.getByTestId('budget-remaining')).toContainText(/CHF 4.420\.00/);
  await expect(view.getByRole('row', { name: /Anna Muster/ })).toContainText('660.00');
  await expect(view.getByRole('row', { name: /Beat Beispiel/ })).toContainText('300.00');
  await view.getByTestId('budget-amount').getByRole('button', { name: 'Ändern' }).click();
  await view.getByLabel('Budget').fill('6000');
  await view.getByTestId('budget-amount').getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toMatchObject({ season: 2026, budget: 6000 });
});

test('the admin sent to the chair\'s Finanzen lands on Finanzen & Betrieb', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/budget*', (r) => r.fulfill({ json: { season: 2026, budget: 5500, extras: [] } }));
  await page.goto('/admin/finance');
  await expect(page.getByTestId('budget-card')).toBeVisible();
  await expect(page.getByTestId('finance-chair')).toHaveCount(0);
});
