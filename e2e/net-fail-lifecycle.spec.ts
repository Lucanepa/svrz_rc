import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, fillWholeForm, GAME } from './support/app';
import { LEAVE_GRACE_MS } from '../src/lib/logger';

/**
 * Which failures the page's own lifecycle excuses — the half of
 * classifyFetchFailure that only a real browser can exercise.
 * e2e/net-fail-instant.spec.ts covers the rule itself; this covers what sets
 * the flag it reads, and what clears it again.
 *
 * Clearing it is the point. A page restored from the back/forward cache, or an
 * app simply brought back to the front, never unloaded: with nothing to reset
 * the flag, the first `pagehide` of a visit downgraded every failure for the
 * rest of that session, and a genuine outage would have reached the operator
 * as a warning nobody is mailed about.
 */

type Entry = { lvl: string; evt: string; msg?: string; data?: Record<string, unknown> };

/** The logger's own in-memory tail, as the support line reads it over the phone.
 *  Read after the grace period: a failure that would be an outage is held
 *  that long in case the page is leaving, so an immediate read sees nothing. */
async function lastFailure(page: Page): Promise<Entry | undefined> {
  await page.waitForTimeout(LEAVE_GRACE_MS + 200);
  return page.evaluate(() => {
    const logs = (window as unknown as { svrzLogs: () => Entry[] }).svrzLogs();
    return logs.filter((e) => e.evt.startsWith('net.fail')).pop();
  });
}

/** Slow enough that only the lifecycle can excuse it — past INSTANT_FAIL_MS. */
async function failSlowly(page: Page, url = '/api/lost-cause'): Promise<void> {
  await page.evaluate(async (u) => {
    await new Promise((r) => setTimeout(r, 80));
    await fetch(u).catch(() => {});
  }, url);
}

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // Nothing answers here, so the fetch rejects the way a dead network does:
  // TypeError, no status. Only the lifecycle around it differs.
  await page.route('**/api/lost-cause', (r) => setTimeout(() => r.abort(), 80));
  await page.route('**/api/survey/**', (r) => setTimeout(() => r.abort(), 80));
  await page.goto('/');
});

test('a request that outlives the page is a warning', async ({ page }) => {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await failSlowly(page);
  expect(await lastFailure(page)).toMatchObject({ lvl: 'warn', evt: 'net.fail.unload' });
});

test('a navigation that aborts the request before pagehide fires still excuses it', async ({ page }) => {
  // Pull-to-refresh on Android Chrome, 13.09.2026: the browser cancels every
  // request in flight first, and only tells the page it is going away when
  // the next document commits — 700 ms later. Three console requests the
  // server had already answered went out as an outage.
  await failSlowly(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await lastFailure(page)).toMatchObject({ lvl: 'warn', evt: 'net.fail.unload' });
});

test('switching to another app counts as leaving', async ({ page }) => {
  // 141ms and mailed as an API failure on 10.09.2026: too slow for the instant
  // rule, and backgrounding did not mark the page as going anywhere.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await failSlowly(page);
  expect(await lastFailure(page)).toMatchObject({ lvl: 'warn', evt: 'net.fail.unload' });
});

test('and coming back makes a failure loud again', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await failSlowly(page);
  expect(await lastFailure(page)).toMatchObject({ lvl: 'error', evt: 'net.fail' });
});

test('a page restored from the back/forward cache is not still leaving', async ({ page }) => {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await failSlowly(page);
  expect(await lastFailure(page)).toMatchObject({ lvl: 'error', evt: 'net.fail' });
});

test('a failure does not carry a capability token into the log', async ({ page }) => {
  // Whoever holds a survey token can answer AS the referee, so it is masked
  // everywhere a URL is logged. This line was the one place it was not.
  await failSlowly(page, '/api/survey/tok-abcdef123456');
  const entry = await lastFailure(page);
  expect(JSON.stringify(entry)).not.toContain('tok-abcdef123456');
  expect(entry?.msg).toContain('/api/survey/<token>');
});

// What a send that the network lost is called once it is back on screen. The
// outbox keeps the game's record id as its key, and the row used to read the
// teams and the role only; a coach with two reports in the failed list had
// nothing to tell the commission but "the one from Saturday".
test.describe('the outbox row', () => {
  test('names the game by its match number', async ({ page }) => {
    // No server behind the submit: the send from a gym with no signal, which
    // goes to the outbox. The park on every signature still answers.
    await page.route('**/api/feedback/submit', (r) => r.abort('failed'));
    await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
      json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
    }));
    await openFeedbackForm(page);
    await fillWholeForm(page);
    await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(Save|Speichern)$/ }).click();
    await expect(page.getByText(/Being sent — waiting in the queue|Wird gesendet — wartet in der Warteschlange/).first()).toBeVisible();

    // Back online, the server now answers — and refuses: a 422 is a permanent
    // failure, which is what puts the item on the failed list with its label.
    await page.route('**/api/feedback/submit', (r) => r.fulfill({ status: 422, json: { error: 'Coachee hat keine E-Mail-Adresse.' } }));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await page.getByRole('button', { name: /^(Back|Zurück)$/ }).click();
    await page.getByRole('button', { name: /^(Home|Start)$/ }).click();
    await expect(page.getByText(/submission failed|Übermittlung fehlgeschlagen/)).toBeVisible({ timeout: 15000 });
    // The failed row, with the role — the draft banner above it names the
    // same game the same way, without the role.
    await expect(page.getByText(`#${GAME.matchNo} · ${GAME.homeTeam} vs ${GAME.awayTeam} · 1. SR`, { exact: true })).toBeVisible();
    await expect(page.getByText(GAME.id, { exact: true })).toHaveCount(0);
  });
});
