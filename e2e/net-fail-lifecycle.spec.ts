import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

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

/** The logger's own in-memory tail, as the support line reads it over the phone. */
function lastFailure(page: Page): Promise<Entry | undefined> {
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
