import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';
import { responseLevel } from '../src/lib/logger';

/**
 * How loud an answered request is in the activity log. Since b8603cd the
 * document proxy answers 503 (with Retry-After) when svrz.ch is down and it
 * holds no copy — svrz.ch's outage, recorded once by the API as
 * docs.unavailable. Mailed from every browser that asked, the next outage
 * would have filled the operator's inbox the way 21.10.2026 did.
 */

test('a 503 from the document proxy is a warning; every other 5xx is still an error', () => {
  expect(responseLevel(503, 'https://svrz-rc-api.openvolley.app/api/docs/regulations/sr-reglement.pdf')).toBe('warn');
  expect(responseLevel(503, '/api/docs/x.pdf?v=2')).toBe('warn');
  // A 500 from the proxy is our own bug.
  expect(responseLevel(500, '/api/docs/x.pdf')).toBe('error');
  expect(responseLevel(502, '/api/docs/x.pdf')).toBe('error');
  // A 503 anywhere else is an outage.
  expect(responseLevel(503, '/api/coachees')).toBe('error');
  // Not fooled by the words in a query string.
  expect(responseLevel(503, '/api/coachees?from=/api/docs/x')).toBe('error');
  expect(responseLevel(404, '/api/docs/x.pdf')).toBe('warn');
  expect(responseLevel(200, '/api/docs/x.pdf')).toBe('debug');
});

test('in the browser, the proxy\'s 503 is written as a warning and a 503 elsewhere as an error', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/docs/**', (r) => r.fulfill({ status: 503, headers: { 'Retry-After': '120' }, json: { error: 'unavailable' } }));
  await page.route('**/api/down-for-real', (r) => r.fulfill({ status: 503, json: { error: 'down' } }));
  await page.goto('/');
  const lines = await page.evaluate(async () => {
    await fetch('/api/docs/regulations/test.pdf').catch(() => {});
    await fetch('/api/down-for-real').catch(() => {});
    const logs = (window as unknown as { svrzLogs: () => { lvl: string; evt: string; msg?: string; data?: Record<string, unknown> }[] }).svrzLogs();
    return logs.filter((e) => e.evt === 'net.fetch' && e.data?.status === 503).map((e) => ({ lvl: e.lvl, url: String(e.data?.url) }));
  });
  expect(lines.find((l) => l.url.includes('/api/docs/'))).toMatchObject({ lvl: 'warn' });
  expect(lines.find((l) => l.url.includes('/api/down-for-real'))).toMatchObject({ lvl: 'error' });
});
