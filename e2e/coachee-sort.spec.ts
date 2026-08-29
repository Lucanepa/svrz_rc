import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The list is looked up by surname, so it is both ordered and now SHOWN that
// way — "Nachname, Vorname". It used to be sorted on the displayed "Vorname
// Nachname", filing everyone under their first name, which is not how anyone
// looks a referee up. See lib/coacheeName.ts.

const status = { needsObservation: true, count: 0 };

// First names ascend A→C while surnames descend Z→X, so a list sorted the old
// way and a list sorted by surname are exact reverses of one another — no
// ordering can satisfy both by accident.
const COACHEES = [
  { id: 'a', full_name: 'Anna Zwahlen', first_name: 'Anna', last_name: 'Zwahlen', referee_level: 'N3', stage: '2', observation_status: status },
  { id: 'b', full_name: 'Bea Yerly', first_name: 'Bea', last_name: 'Yerly', referee_level: 'N3', stage: '2', observation_status: status },
  { id: 'c', full_name: 'Carla Xavier', first_name: 'Carla', last_name: 'Xavier', referee_level: 'N3', stage: '2', observation_status: status },
  // No split columns — the surname has to come out of the full name.
  { id: 'd', full_name: 'Dora Ammann', referee_level: 'N3', stage: '2', observation_status: status },
  // Umlaut: files under A, not after Z.
  { id: 'e', full_name: 'Eva Äbi', first_name: 'Eva', last_name: 'Äbi', referee_level: 'N3', stage: '2', observation_status: status },
];

const names = (page: import('@playwright/test').Page) =>
  page.locator('div.font-semibold.text-sm.text-stone-900');

test('the coachee list is ordered by surname, not by first name', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.goto('/');
  // Home opens first; the list is on the Coachees tab.
  await page.getByRole('button', { name: /^Coachees$/ }).click();

  await expect(names(page).first()).toBeVisible();
  await expect(names(page)).toHaveText([
    'Äbi, Eva',
    'Ammann, Dora',  // surname taken from the full name alone
    'Xavier, Carla',
    'Yerly, Bea',
    'Zwahlen, Anna',
  ]);
});

test('the header toggle still reverses it', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.goto('/');
  // Home opens first; the list is on the Coachees tab.
  await page.getByRole('button', { name: /^Coachees$/ }).click();

  await expect(names(page).first()).toBeVisible();
  await page.getByText(/^Name/).first().click();
  await expect(names(page)).toHaveText([
    'Zwahlen, Anna',
    'Yerly, Bea',
    'Xavier, Carla',
    'Ammann, Dora',
    'Äbi, Eva',
  ]);
});
