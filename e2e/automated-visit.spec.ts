import { test, expect } from '@playwright/test';
import { isAutomatedVisit } from '../src/lib/logger';
import { classifySwRegisterError, swRegisterErrorLevel } from '../src/lib/swReload';

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

// 12.10.2026: a VirusTotal-style scanner (screen 800x600, a 1024x768 window)
// mailed a service-worker error and a failed auth check. 02.10, 19.10 and
// 21.10.2026: an iPhone's hidden link preview — a WKWebView with no Safari
// token, a 1920x1080 window on a 402x874 screen, no API call at all — mailed
// "Script …/sw.js load failed" three times.
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE_SCREEN = { screenW: 402, screenH: 874 };

test.describe('what the window gives away', () => {
  test('a browser driven by a script, or headless Chrome', () => {
    expect(isAutomatedVisit(DESKTOP, undefined, { webdriver: true, screenW: 1920, screenH: 1080, innerW: 1280 })).toBe(true);
    expect(isAutomatedVisit('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36')).toBe(true);
  });

  test('the scanner: an 800x600 screen with a wider window', () => {
    expect(isAutomatedVisit(DESKTOP, undefined, { screenW: 800, screenH: 600, innerW: 1024 })).toBe(true);
    expect(isAutomatedVisit(DESKTOP, undefined, { screenW: 800, screenH: 600, innerW: 800 })).toBe(false);
  });

  test("the iPhone's hidden link preview", () => {
    expect(isAutomatedVisit(IPHONE, undefined, { ...IPHONE_SCREEN, innerW: 1920, standalone: false })).toBe(true);
    // A phone browser whose window is wider than its screen.
    expect(isAutomatedVisit(IPHONE_SAFARI, undefined, { ...IPHONE_SCREEN, innerW: 1920 })).toBe(true);
  });

  test('a coach is not: the home-screen app, Safari in landscape, Android, a wide desktop, the installed app', () => {
    // The installed home-screen PWA has no Safari token either.
    expect(isAutomatedVisit(IPHONE, undefined, { ...IPHONE_SCREEN, innerW: 402, standalone: true })).toBe(false);
    // iOS reports the portrait width in landscape too; the window is the long side.
    expect(isAutomatedVisit(IPHONE_SAFARI, undefined, { ...IPHONE_SCREEN, innerW: 874, standalone: false })).toBe(false);
    expect(isAutomatedVisit(PHONE, undefined, { screenW: 412, screenH: 915, innerW: 412 })).toBe(false);
    // A desktop window spread over two monitors is wider than the screen it starts on.
    expect(isAutomatedVisit(DESKTOP, undefined, { screenW: 1920, screenH: 1080, innerW: 2400 })).toBe(false);
    // An in-app browser (Instagram, Mail) names no Safari either, and is a coach.
    expect(isAutomatedVisit(IPHONE, undefined, { ...IPHONE_SCREEN, innerW: 402, standalone: false })).toBe(false);
    // The installed app's webview names no Safari and is a person every time.
    expect(isAutomatedVisit(IPHONE, undefined, { ...IPHONE_SCREEN, innerW: 402, native: true })).toBe(false);
    expect(isAutomatedVisit(IPHONE_SAFARI, undefined, { ...IPHONE_SCREEN, innerW: 402, standalone: false })).toBe(false);
  });
});

test.describe('a failed service-worker registration', () => {
  test('a worker served wrong is an error whatever else is true', () => {
    for (const message of [
      "Failed to register a ServiceWorker for scope ('https://svrz-rc.openvolley.app/') with script ('https://svrz-rc.openvolley.app/sw.js'): A bad HTTP response code (404) was received when fetching the script.",
      "Failed to register a ServiceWorker for scope ('https://svrz-rc.openvolley.app/') with script ('https://svrz-rc.openvolley.app/sw.js'): The script has an unsupported MIME type ('text/html').",
      'Failed to register/update a ServiceWorker for scope ‘https://svrz-rc.openvolley.app/’: Load failed with status 404 for script ‘https://svrz-rc.openvolley.app/sw.js’.',
    ]) {
      const kind = classifySwRegisterError(new TypeError(message));
      expect(kind).toBe('broken');
      expect(swRegisterErrorLevel(kind, { excused: true, failuresInARow: 1 })).toBe('error');
    }
    const security = new DOMException('The operation is insecure.', 'SecurityError');
    expect(classifySwRegisterError(security)).toBe('broken');
  });

  test('a worker that did not arrive is a warning once, or while nobody looks; an error the second time', () => {
    const kind = classifySwRegisterError(new TypeError('Script https://svrz-rc.openvolley.app/sw.js load failed'));
    expect(kind).toBe('network');
    expect(classifySwRegisterError(new TypeError('Failed to fetch dynamically imported module: https://svrz-rc.openvolley.app/assets/workbox-window.prod.es5-x.js'))).toBe('network');
    expect(swRegisterErrorLevel(kind, { excused: false, failuresInARow: 1 })).toBe('warn');
    expect(swRegisterErrorLevel(kind, { excused: false, failuresInARow: 2 })).toBe('error');
    expect(swRegisterErrorLevel(kind, { excused: true, failuresInARow: 5 })).toBe('warn');
  });

  test('anything else stays an error', () => {
    expect(classifySwRegisterError(new Error('Rejected'))).toBe('other');
    expect(swRegisterErrorLevel('other', { excused: true, failuresInARow: 1 })).toBe('error');
    expect(classifySwRegisterError(Symbol('odd'))).toBe('other');
  });
});

type LogLine = { lvl: string; evt: string; msg?: string; data?: Record<string, unknown> };

async function throwOurs(page: import('@playwright/test').Page): Promise<{ boom?: LogLine; start?: LogLine }> {
  return page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'boom', filename: `${location.origin}/assets/index-x.js`, error: new Error('boom'),
    }));
    const logs = (window as unknown as { svrzLogs: () => LogLine[] }).svrzLogs();
    return { boom: logs.filter((e) => e.msg === 'boom').pop(), start: logs.find((e) => e.evt === 'app.start') };
  });
}

test('the suite itself looks like a person, so its errors stay errors', async ({ page }) => {
  // playwright.config.ts starts Chromium with AutomationControlled off.
  await page.goto('/');
  const { boom, start } = await throwOurs(page);
  expect(boom).toMatchObject({ lvl: 'error', evt: 'js.error' });
  expect(start?.data).toMatchObject({ webdriver: false, visibility: 'visible' });
});

test('a browser that says a script drives it files its errors as warnings', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => true, configurable: true });
  });
  await page.goto('/');
  const { boom, start } = await throwOurs(page);
  expect(boom).toMatchObject({ lvl: 'warn', evt: 'js.error' });
  expect(start?.data).toMatchObject({ webdriver: true });
});
