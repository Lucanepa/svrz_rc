import { test, expect } from '@playwright/test';
import { isAutomatedVisit } from '../src/lib/logger';

// Google's readers and renderers run the app's JavaScript, and Google's Web
// Rendering Service refuses every service worker by design. Up to 21.10.2026
// eleven "service worker registration failed: Rejected" errors came from it,
// ten of them as Google-Read-Aloud, the eleventh as a plain Android Chrome
// whose stack still named the renderer's own `wrsParams` stub.

const READ_ALOUD = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)';
const PHONE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('Google and named crawlers are recognised, a coach\'s phone is not', () => {
  expect(isAutomatedVisit(READ_ALOUD)).toBe(true);
  expect(isAutomatedVisit('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
  expect(isAutomatedVisit('BitsExplorerBot/1.0 (+https://bitsexplorer.com/crawler)')).toBe(true);
  expect(isAutomatedVisit(PHONE)).toBe(false);
  expect(isAutomatedVisit(IPHONE)).toBe(false);
});

test('the renderer behind a plain user agent gives itself away in the stack', () => {
  const stub = { name: 'Error', message: 'Rejected', stack: 'Error: Rejected\n    at wrsParams.serviceWorkers.navigator.serviceWorker.register (<anonymous>:12:648)' };
  expect(isAutomatedVisit(PHONE, stub)).toBe(true);
  const real = new TypeError('Script https://svrz-rc.openvolley.app/sw.js load failed');
  expect(isAutomatedVisit(IPHONE, real)).toBe(false);
});

test.describe('in the browser', () => {
  test.use({ userAgent: READ_ALOUD });
  test('an error from Read Aloud is written as a warning', async ({ page }) => {
    await page.goto('/');
    const entry = await page.evaluate(() => {
      // An error thrown from our own bundle: an error for any person.
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'boom', filename: `${location.origin}/assets/index-x.js`, error: new Error('boom'),
      }));
      const logs = (window as unknown as { svrzLogs: () => { lvl: string; evt: string; msg?: string }[] }).svrzLogs();
      return logs.filter((e) => e.msg === 'boom').pop();
    });
    expect(entry).toMatchObject({ lvl: 'warn', evt: 'js.error' });
  });
});
