import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// Regressions for the pre-season audit's blocking findings. The server-side
// halves (season clause, recipient cross-check, survey mail split, president
// note mode test) are covered by their own reasoning in server/index.ts; what is
// testable from here is the client surface each one depends on.

test.describe('Ambiguous contact-sync names are surfaced, not guessed at', () => {
  test('the admin console shows names VolleyManager holds twice', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    await page.route('**/api/admin/coachees/sync-contacts', (r) => r.fulfill({
      json: {
        refereesFetched: 136, coachees: 59, updated: 3, alreadySet: 40,
        notFound: 1, missing: ['Nobody In VM'],
        // Two different referees answer to this name — nothing was written.
        ambiguous: ['Marco Simon'],
        updatedFromGames: 0, gameRefereesFound: 0, gamesError: '',
      },
    }));
    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Fetch contacts|Kontakte/ }).click();

    await expect(page.getByText(/Marco Simon/)).toBeVisible();
    await expect(page.getByText(/Ambiguous name|Mehrdeutiger Name/)).toBeVisible();
    // The "not found" list is a different, milder outcome and stays separate.
    await expect(page.getByText(/Not found in VolleyManager|Nicht in VolleyManager/)).toBeVisible();
  });
});

test.describe('A colleague\'s queued observation is visible after a hand-off', () => {
  test('the banner names the owner instead of silently reading zero', async ({ page }) => {
    await stubSignedInApp(page);
    // An item queued by SOMEONE ELSE on this device, i.e. the state left behind
    // when a shared tablet changes hands mid-outage.
    // Names must match src/lib/offlineQueue.ts exactly, or this seeds a database
    // the app never opens and the test passes for the wrong reason.
    await page.addInitScript(() => {
      const open = indexedDB.open('svrz-offline', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('feedback-outbox')) {
          open.result.createObjectStore('feedback-outbox', { keyPath: 'id' });
        }
      };
      open.onsuccess = () => {
        open.result.transaction('feedback-outbox', 'readwrite').objectStore('feedback-outbox').put({
          id: 'stranded-1',
          ownerId: 'rc-someone-else',
          createdAt: Date.now(),
          label: 'Spiel 2345678',
          payload: {},
        });
      };
    });
    await page.goto('/');
    // Owner id is not in this session's roster stub, so it falls back to the
    // generic wording — the point is that it is mentioned AT ALL.
    await expect(page.getByText(/unsent feedback|nicht gesendete/i)).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Capability tokens do not reach the activity log', () => {
  test('a shipped log line carries <token>, never the survey token', async ({ page }) => {
    const shipped: string[] = [];
    await stubSignedInApp(page);
    await page.route('**/api/client-logs', async (r) => {
      shipped.push(r.request().postData() || '');
      await r.fulfill({ json: { ok: true } });
    });
    await page.goto('/#/survey/SECRET-TOKEN-abc123');
    await page.waitForTimeout(1200);
    // Force a flush: the logger ships on hide.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(800);

    const body = shipped.join('\n');
    expect(body).not.toContain('SECRET-TOKEN-abc123');
    if (body.includes('survey')) expect(body).toContain('<token>');
  });
});
