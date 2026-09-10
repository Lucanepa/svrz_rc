import { test, expect } from '@playwright/test';
import { classifyFetchFailure, INSTANT_FAIL_MS, isResizeObserverLoopNotice } from '../src/lib/logger';

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
