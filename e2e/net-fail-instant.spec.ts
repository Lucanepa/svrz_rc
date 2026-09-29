import { test, expect } from '@playwright/test';
import {
  classifyFetchFailure, INSTANT_FAIL_MS, isBackgroundRequest, isResizeObserverLoopNotice,
  noteLeavingPage, noteBackOnPage, noteReloadingPage, resetPageLifecycle,
} from '../src/lib/logger';

/**
 * A fetch that rejects before it could have reached the network is the
 * browser's doing, not the server's. On 10.09.2026 one phone logged all six
 * boot requests as errors — each dead in 6–9 ms at the same instant, never
 * again — and the alert mail went out for a network switch on a handset.
 */
test.describe('classifying a fetch that got no response', () => {
  test('an instant rejection is the browser refusing locally: a warning', () => {
    const r = classifyFetchFailure(6, new TypeError('Failed to fetch'));
    expect(r).toEqual({ evt: 'net.fail.instant', lvl: 'warn' });
  });

  test('a slow one is a real failure: an error', () => {
    const r = classifyFetchFailure(INSTANT_FAIL_MS, new TypeError('Failed to fetch'));
    expect(r).toEqual({ evt: 'net.fail', lvl: 'error' });
    expect(classifyFetchFailure(30_000, new TypeError('Failed to fetch')).lvl).toBe('error');
  });

  test("the app's own cancellation is never downgraded on speed alone", () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError');
    expect(classifyFetchFailure(3, abort)).toEqual({ evt: 'net.fail', lvl: 'error' });
  });

  test('a request cut off by the page reloading itself is a warning, however slow', () => {
    const r = classifyFetchFailure(141, new TypeError('Failed to fetch'), true);
    expect(r).toEqual({ evt: 'net.fail.unload', lvl: 'warn' });
    expect(classifyFetchFailure(30_000, new TypeError('Failed to fetch'), true).lvl).toBe('warn');
    expect(classifyFetchFailure(141, new TypeError('Failed to fetch'), false).lvl).toBe('error');
  });
});

/**
 * 29.09.2026, 21:21: a draft park got no response after 32.6 s on a phone that
 * said it was online, and was mailed as an error. The app itself says nothing
 * to the coach when a park fails that way; the log should not wake anyone either.
 */
test.describe('a background backup that got no response', () => {
  const API = 'https://svrz-rc-api.openvolley.app';

  test('the parked-draft write is a background request, PUT or POST', () => {
    expect(isBackgroundRequest('PUT', `${API}/api/drafts/parked/v7pwt5k36chd61i`)).toBe(true);
    expect(isBackgroundRequest('post', `${API}/api/drafts/parked/v7pwt5k36chd61i`)).toBe(true);
  });

  test('the list and the unpark are not: they answer something the coach did', () => {
    expect(isBackgroundRequest('GET', `${API}/api/drafts/parked`)).toBe(false);
    expect(isBackgroundRequest('GET', `${API}/api/drafts/parked/v7pwt5k36chd61i`)).toBe(false);
    expect(isBackgroundRequest('DELETE', `${API}/api/drafts/parked/v7pwt5k36chd61i`)).toBe(false);
    expect(isBackgroundRequest('PUT', `${API}/api/feedback/submit`)).toBe(false);
  });

  test('its slow failure is a warning, not an alert', () => {
    const r = classifyFetchFailure(32_615, new TypeError('Failed to fetch'), false, true);
    expect(r).toEqual({ evt: 'net.fail.background', lvl: 'warn' });
    expect(classifyFetchFailure(32_615, new TypeError('Failed to fetch'), false, false).lvl).toBe('error');
  });

  test("the app's own cancellation stays loud even there", () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError');
    expect(classifyFetchFailure(32_615, abort, false, true)).toEqual({ evt: 'net.fail', lvl: 'error' });
  });
});

test.describe('the ResizeObserver loop notice', () => {
  test('is recognised in both wordings browsers use', () => {
    expect(isResizeObserverLoopNotice('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isResizeObserverLoopNotice('ResizeObserver loop limit exceeded')).toBe(true);
  });

  test('a real error that merely mentions the observer is not', () => {
    expect(isResizeObserverLoopNotice("TypeError: Cannot read properties of undefined (reading 'ResizeObserver')")).toBe(false);
    expect(isResizeObserverLoopNotice(undefined)).toBe(false);
  });
});

/**
 * Which of the two ways a page goes away survives coming back. Backgrounding
 * does not — the tab is there again, and a failure after that is real news.
 * A reload the app started does: there is nothing to come back to.
 */
test.describe('a reload the app started itself', () => {
  test.afterEach(() => resetPageLifecycle());

  test('is not undone by the tab turning visible in the same instant', () => {
    // 18:33 on 10.09.2026. A phone picked up after half an hour ran both at
    // once: the waiting service worker took over and reloaded the page, and the
    // tab turned visible. Coming back cleared the flag just in time for the
    // three Home requests dying in that reload to be mailed as an API outage.
    noteReloadingPage();
    noteBackOnPage();
    expect(classifyFetchFailure(260, new TypeError('Load failed'))).toEqual({ evt: 'net.fail.unload', lvl: 'warn' });
  });

  test('whereas merely being backgrounded is undone, and failures are loud again', () => {
    noteLeavingPage();
    noteBackOnPage();
    expect(classifyFetchFailure(260, new TypeError('Load failed'))).toEqual({ evt: 'net.fail', lvl: 'error' });
  });
});
