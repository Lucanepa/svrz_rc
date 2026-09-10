import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * How the browser log gets to /api/client-logs.
 *
 * The endpoint takes no session on purpose — a beacon fires after logout, and
 * before login there is nothing to authenticate with — so it marks a batch it
 * cannot verify as `unverified:<name>` rather than filing an anonymous POST
 * under a real coach's name. On 09.09.2026 the Protokoll showed one signed-in
 * coach BOTH ways in the same session: `unverified:Luca Canepa` for the lines
 * shipped while the app was open, and their real name for the lines shipped as
 * they closed it.
 *
 * That was not an auth problem. In production the API is a different origin,
 * where a fetch sends no cookie unless it is asked to; sendBeacon (the pagehide
 * path) always carries credentials, which is exactly why only half the batches
 * looked authenticated. Nothing could catch it here, because the option is
 * invisible in the request the server receives — so the test watches the call
 * the logger makes.
 */

type RecordedFlush = { credentials?: string; user?: string };

function recorded(page: import('@playwright/test').Page): Promise<RecordedFlush[]> {
  return page.evaluate(() => (window as unknown as { __logFlushes?: RecordedFlush[] }).__logFlushes ?? []);
}

test('the log batch that names the coach goes out with credentials', async ({ page }) => {
  // Wraps fetch before any app script runs, so this is the function the logger
  // captures as its uninstrumented `originalFetch` — the one flush() calls.
  await page.addInitScript(() => {
    const store: RecordedFlush[] = [];
    (window as unknown as Record<string, unknown>).__logFlushes = store;
    const real = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/client-logs')) {
        let user: string | undefined;
        try { user = JSON.parse(String(init?.body ?? '{}')).user; } catch { /* not the shape we ship */ }
        // Left out, `credentials` means same-origin — which is the omission
        // this test exists to catch, so record the default rather than blank.
        store.push({ credentials: init?.credentials ?? 'same-origin', user });
      }
      return real(input as RequestInfo, init);
    }) as typeof fetch;
  });

  await stubSignedInApp(page);
  await page.goto('/');

  // The batch worth asserting on is one shipped after the session was adopted:
  // it carries the coach's name, so it is the batch the marker was about.
  await expect
    .poll(async () => (await recorded(page)).filter((f) => f.user === RC.name).length, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Every batch, not just that one: a flush that goes out before the session is
  // adopted still has to carry the cookie, or it files the same lines twice over.
  for (const flush of await recorded(page)) expect(flush.credentials).toBe('include');
});
