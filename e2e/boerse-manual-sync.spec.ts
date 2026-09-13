import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * "Jetzt prüfen" on the SR-Börse card: a tap, and then the result.
 *
 * The poll takes ~80 s against production, and a phone will not hold one
 * request open that long. On 13.09.2026 Android Chrome gave up after 27 s,
 * the run finished at 82 s and answered a socket nobody held, and the second
 * tap hit the account lock: three error lines and an alert mail for a sync
 * that had succeeded. So the server answers 202 at once and the card polls
 * the status until it is stamped AFTER the tap — that stamp is the result.
 */

const OLD = {
  lastAttemptAt: '2026-09-13T09:43:24.656Z', lastSuccessAt: '2026-09-13T09:43:24.656Z', ok: true,
  offers: 254, open: 30, matchedGames: 189,
};

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
});

test('the card waits for the run the tap started, then reports it', async ({ page }) => {
  let polls = 0;
  let tappedAt = '';
  await page.route('**/api/admin/boerse/status', (r) => {
    polls += 1;
    // Two polls still show the previous run; the third is stamped after the tap.
    const status = tappedAt && polls > 2
      ? { ...OLD, lastAttemptAt: new Date(Date.parse(tappedAt) + 1000).toISOString(), lastSuccessAt: new Date(Date.parse(tappedAt) + 1000).toISOString(), offers: 257, open: 31, matchedGames: 191 }
      : OLD;
    return r.fulfill({ json: { status, liveOffers: 31, enabled: true, pollMinutes: 60, accountHeldBy: null } });
  });
  await page.route('**/api/admin/boerse/sync', (r) => {
    tappedAt = new Date().toISOString();
    polls = 0;
    return r.fulfill({ status: 202, json: { started: true, startedAt: tappedAt } });
  });
  await page.goto('/admin/settings');

  await page.getByRole('button', { name: /^(Jetzt prüfen|Check now)$/ }).click();
  await expect(page.getByRole('button', { name: /Läuft…|Running…/ })).toBeVisible();
  // Polled, not guessed: the new numbers can only have come from a status
  // stamped after the tap.
  await expect(page.getByText(/257 (Angebote|offers) \(31 (offen|open)\), 191/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^(Jetzt prüfen|Check now)$/ })).toBeVisible();
});

test('a run the account lock skipped is reported as skipped, not as a failure', async ({ page }) => {
  let tappedAt = '';
  await page.route('**/api/admin/boerse/status', (r) => r.fulfill({
    json: {
      status: tappedAt
        ? { ...OLD, ok: false, lastAttemptAt: new Date(Date.parse(tappedAt) + 1000).toISOString(), skipped: 'VolleyManager busy with games-sync' }
        : OLD,
      liveOffers: 30, enabled: true, pollMinutes: 60, accountHeldBy: null,
    },
  }));
  await page.route('**/api/admin/boerse/sync', (r) => {
    tappedAt = new Date().toISOString();
    return r.fulfill({ status: 202, json: { started: true, startedAt: tappedAt } });
  });
  await page.goto('/admin/settings');

  await page.getByRole('button', { name: /^(Jetzt prüfen|Check now)$/ }).click();
  await expect(page.getByText(/Nicht abgefragt|Not polled/)).toBeVisible({ timeout: 15_000 });
  // The status line carries who held the account; the note does not repeat it.
  await expect(page.getByText(/(Übersprungen|Skipped): VolleyManager busy with games-sync$/)).toBeVisible();
});

test('a second tap while one runs is refused with the reason, in words', async ({ page }) => {
  await page.route('**/api/admin/boerse/status', (r) => r.fulfill({
    json: { status: OLD, liveOffers: 30, enabled: true, pollMinutes: 60, accountHeldBy: null },
  }));
  await page.route('**/api/admin/boerse/sync', (r) => r.fulfill({
    status: 409, json: { error: 'Die Börse wird gerade abgefragt — bitte einen Moment warten.' },
  }));
  await page.goto('/admin/settings');

  await page.getByRole('button', { name: /^(Jetzt prüfen|Check now)$/ }).click();
  // The server's sentence, not the JSON it came wrapped in.
  await expect(page.getByText('Die Börse wird gerade abgefragt — bitte einen Moment warten.')).toBeVisible();
});
