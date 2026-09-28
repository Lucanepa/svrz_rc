import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';
import {
  ConnectionTracker, deriveState, isTimedRead, isNoResponseMessage, SLOW_AFTER_MS,
} from '../src/lib/connection';

/**
 * A slow or dead network has to SAY it is the network. On 28.09.2026 a coach's
 * phone took exactly 6 s over every request — the service worker's cache
 * timeout — and the login probe, on the same 6 s timer, flashed the login
 * screen first. Nothing on screen pointed at the connection, so it read as an
 * app fault. These pin the words, and the rules behind when they appear.
 */

test.describe('rules', () => {
  test('the pending read outranks how the last one ended; the device being offline outranks all', () => {
    expect(deriveState(true, 0, 'ok')).toBe('ok');
    expect(deriveState(true, 0, 'stale')).toBe('stale');
    expect(deriveState(true, 0, 'unreachable')).toBe('unreachable');
    expect(deriveState(true, 1, 'unreachable')).toBe('slow');
    expect(deriveState(false, 1, 'ok')).toBe('offline');
  });

  test('only everyday API reads start the slow clock', () => {
    expect(isTimedRead('GET', 'https://api.example/api/coachees')).toBe(true);
    expect(isTimedRead('POST', 'https://api.example/api/feedback/submit')).toBe(false);
    // Slow because of the work behind them, not the network.
    expect(isTimedRead('GET', 'https://api.example/api/admin/games/sync-status')).toBe(false);
    expect(isTimedRead('GET', 'https://api.example/api/forms/index')).toBe(false);
    expect(isTimedRead('GET', 'https://api.example/api/feedback-archive?season=2026')).toBe(false);
    expect(isTimedRead('GET', 'https://api.example/api/docs/regeln.pdf')).toBe(false);
    // Not ours to judge the network by.
    expect(isTimedRead('GET', 'https://api.example/api/events')).toBe(false);
    expect(isTimedRead('GET', 'https://cdn.example/font.woff2')).toBe(false);
  });

  test("each browser's words for no response are recognised, a server's are not", () => {
    for (const m of ['Failed to fetch', 'TypeError: Failed to fetch', 'Load failed',
      'NetworkError when attempting to fetch resource.', 'The Internet connection appears to be offline.']) {
      expect(isNoResponseMessage(m), m).toBe(true);
    }
    expect(isNoResponseMessage('Unauthorized')).toBe(false);
    expect(isNoResponseMessage('Failed to fetch games from VolleyManager')).toBe(false);
  });

  test('a failure says unreachable until a live answer clears it; a cached answer says stale', async () => {
    const tracker = new ConnectionTracker(true);
    tracker.start('GET', 'https://api.example/api/coachees').failed();
    expect(tracker.get()).toBe('unreachable');

    tracker.start('GET', 'https://api.example/api/coachees').answered(120);
    await new Promise((r) => setTimeout(r, 250));
    expect(tracker.get()).toBe('ok');

    const req = tracker.start('GET', 'https://api.example/api/settings');
    tracker.noteCacheHit('https://api.example/api/settings');
    req.answered(6010);
    await new Promise((r) => setTimeout(r, 250));
    expect(tracker.get()).toBe('stale');

    // A cancelled request says nothing about the network.
    tracker.start('GET', 'https://api.example/api/settings').answered(80);
    await new Promise((r) => setTimeout(r, 250));
    tracker.start('GET', 'https://api.example/api/coachees').dropped();
    expect(tracker.get()).toBe('ok');
  });
});

test.describe('in the app', () => {
  test('a read that hangs past the threshold shows the slow-network note, which leaves once it answers', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);

    await page.route('**/api/slow-read', (r) => setTimeout(() => r.fulfill({ json: [] }).catch(() => {}), SLOW_AFTER_MS + 1200));
    await page.evaluate(() => { void fetch('/api/slow-read'); });

    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'slow', { timeout: SLOW_AFTER_MS + 1000 });
    await expect(banner).toContainText(/Netz|network/);
    await expect(banner).toHaveCount(0, { timeout: 3000 });
  });

  test('no response to the session probe is a no-connection screen, not the login form', async ({ page }) => {
    await stubSignedInApp(page);
    let dead = true;
    // Past INSTANT_FAIL_MS: a rejection faster than that is the browser
    // cancelling locally, which the banner — like the log — does not blame on
    // the network.
    await page.route('**/api/auth/me', (r) => (dead
      ? setTimeout(() => r.abort('internetdisconnected').catch(() => {}), 100)
      : r.fulfill({ json: { rc: { id: RC.id, name: RC.name }, admin: null } })));
    await page.goto('/');

    await expect(page.getByTestId('no-connection')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-state', 'unreachable');

    // Back on a network: one tap, straight into the app — no sign-in needed.
    dead = false;
    await page.getByTestId('no-connection').getByRole('button').first().click();
    await expect(page.getByTestId('no-connection')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 3000 });
  });

  test('an answer from the server, even an error, still means sign in', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/auth/me', (r) => r.fulfill({ status: 500, body: 'boom' }));
    await page.goto('/');
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByTestId('no-connection')).toHaveCount(0);
  });
});
