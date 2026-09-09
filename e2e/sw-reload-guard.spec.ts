import { test, expect } from '@playwright/test';
import {
  decideSwReload, recentSwReloads, noteSwReload, retryDelayMs,
  SW_RELOAD_MIN_UPTIME_MS, SW_RELOAD_MAX_IN_A_ROW, SW_RELOAD_FORGET_MS,
} from '../src/lib/swReload';

/**
 * The rule that decides whether a new service worker may reload the page.
 *
 * On 09.09.2026 it could not say no: an iPhone reloaded 111 times in one
 * session, eight times a minute, and the app was unusable from start. The
 * causes were fixed (a 15-second update check, and the PWA plugin's own reload
 * beside the guarded one) — this is the belt that holds if either comes back,
 * so it is worth testing without needing a browser, a worker and a deploy.
 */
const MINUTE = 60 * 1000;

test.describe('the service-worker reload guard', () => {
  test('takes a deploy on a page that has been up a while', () => {
    expect(decideSwReload({ uptimeMs: 5 * MINUTE, reloadsSoFar: 0 })).toBe('reload');
    expect(decideSwReload({ uptimeMs: 5 * MINUTE, reloadsSoFar: 1 })).toBe('reload');
  });

  test('waits out the first minute instead of interrupting a fresh page', () => {
    expect(decideSwReload({ uptimeMs: 0, reloadsSoFar: 0 })).toBe('too-soon');
    expect(decideSwReload({ uptimeMs: SW_RELOAD_MIN_UPTIME_MS - 1, reloadsSoFar: 0 })).toBe('too-soon');
    // ...and asks again once it is old enough, rather than dropping the event:
    // the worker has already taken control, so the page is running against a
    // precache that no longer holds its lazily-imported chunks.
    expect(retryDelayMs(0)).toBeGreaterThan(SW_RELOAD_MIN_UPTIME_MS);
    expect(retryDelayMs(SW_RELOAD_MIN_UPTIME_MS - 500)).toBeGreaterThanOrEqual(1_000);
  });

  test('stops after two in a row — this is the line the iPhone crossed', () => {
    expect(decideSwReload({ uptimeMs: 10 * MINUTE, reloadsSoFar: SW_RELOAD_MAX_IN_A_ROW })).toBe('looping');
    expect(decideSwReload({ uptimeMs: 10 * MINUTE, reloadsSoFar: 111 })).toBe('looping');
  });

  test('a loop outranks the age of the page', () => {
    // Both conditions true: it must read as looping, because that is the one
    // the log line and the "keep this build" decision are about.
    expect(decideSwReload({ uptimeMs: 0, reloadsSoFar: 99 })).toBe('looping');
  });

  test('counts consecutive reloads and forgets quiet ones', () => {
    const t0 = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(recentSwReloads(null, t0)).toBe(0);
    expect(recentSwReloads('not json', t0)).toBe(0);

    const first = noteSwReload(null, t0);
    expect(recentSwReloads(first, t0)).toBe(1);

    const second = noteSwReload(first, t0 + 2_000);
    expect(recentSwReloads(second, t0 + 2_000)).toBe(2);
    // Two is the bound, so the third controllerchange is refused.
    expect(decideSwReload({ uptimeMs: 10 * MINUTE, reloadsSoFar: recentSwReloads(second, t0 + 2_000) })).toBe('looping');

    // A deploy days later is not a loop: after ten quiet minutes the count is
    // gone and the page takes the new build. The window runs from the LAST
    // reload (t0 + 2s), not from the first — quiet is measured from the most
    // recent noise.
    const later = t0 + 2_000 + SW_RELOAD_FORGET_MS + 1_000;
    expect(recentSwReloads(second, later)).toBe(0);
    expect(decideSwReload({ uptimeMs: 10 * MINUTE, reloadsSoFar: recentSwReloads(second, later) })).toBe('reload');
  });
});
