import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

/**
 * The Offline-Ready check: when a form opens, the app says whether this device
 * can finish and send the observation with no signal — and which piece is
 * missing when it cannot.
 *
 * The Vite dev server registers no service worker, so every run here settles
 * on "missing": the worker row fails, the caches hold nothing. That is the
 * honest outcome for this environment and exactly the state the pill exists
 * to report; what these tests pin is that the check runs, that it says so
 * without throwing, and that "Check again" really checks again rather than
 * repainting the last answer.
 *
 * The app picks its language off the browser's, and the Playwright projects
 * run under an English locale, so every user-facing string is matched in both.
 */

const pill = (page: Page) => page.getByTestId('offline-ready-pill');
const checkRow = (page: Page, key: string) => page.locator(`[data-testid="offline-check-item"][data-key="${key}"]`);

/** The pill once it has an answer — 'checking' is the state in between. */
async function settledPill(page: Page) {
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).not.toHaveAttribute('data-state', 'checking', { timeout: 20_000 });
  return pill(page);
}

type OfflineModule = typeof import('../src/lib/offlineReady');
type OfflineReport = Awaited<ReturnType<OfflineModule['runOfflineCheck']>>;
type BrowserOptions = Omit<Parameters<OfflineModule['runOfflineCheck']>[0], 'loadPdf'> & {
  /** Whether the fake report loader resolves or rejects — a function cannot
   *  cross into page.evaluate, so the choice travels as a flag. */
  pdfLoads: boolean;
  /** Take Cache Storage away first, as some private modes do. */
  withoutCaches?: boolean;
};

/**
 * The module itself, run in the page. Vite serves the source straight from
 * /src, so the browser gets the same file the app bundles — the path is
 * handed in as data rather than written as an import, or tsc would try to
 * resolve it against the repository and fail.
 */
function runInBrowser(page: Page, opts: BrowserOptions): Promise<OfflineReport> {
  return page.evaluate(async ([modulePath, o]) => {
    if (o.withoutCaches) Object.defineProperty(window, 'caches', { get: () => undefined, configurable: true });
    const mod = await import(/* @vite-ignore */ modulePath) as OfflineModule;
    return mod.runOfflineCheck({
      lang: o.lang,
      warm: o.warm,
      apiUrls: o.apiUrls,
      loadPdf: () => (o.pdfLoads ? Promise.resolve() : Promise.reject(new Error('no chunk'))),
    });
  }, ['/src/lib/offlineReady.ts', opts] as const);
}

test('opening the form runs the check and the panel names what is missing', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  // No service worker on the dev server, so the honest answer is "missing".
  const state = await settledPill(page);
  await expect(state).toHaveAttribute('data-state', 'missing');
  await expect(state).toHaveText(/Offline: \d+ (item|Punkt)/);

  await state.click();
  await expect(page.getByTestId('offline-ready-panel')).toBeVisible();
  // The worker is what is missing here; the draft store — IndexedDB — is not.
  await expect(checkRow(page, 'sw')).toHaveAttribute('data-ok', '0');
  await expect(checkRow(page, 'store')).toHaveAttribute('data-ok', '1');
  // Every probe reports, in the module's order, so nothing can silently drop out.
  await expect(page.getByTestId('offline-check-item')).toHaveCount(7);
  await expect(page.getByRole('button', { name: /Check again|Erneut prüfen/ })).toBeVisible();
});

test('"Check again" warms the API reads again instead of repainting the last answer', async ({ page }) => {
  await stubSignedInApp(page);
  const eligibleCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/eligible-games')) eligibleCalls.push(r.url()); });

  await page.goto('/');
  await openFeedbackForm(page);
  const state = await settledPill(page);
  await state.click();

  // The count is read AFTER the automatic run has settled, so a slow first
  // warm-up cannot be mistaken for the re-run this test is about.
  const before = eligibleCalls.length;
  await page.getByRole('button', { name: /Check again|Erneut prüfen/ }).click();
  await expect.poll(() => eligibleCalls.length, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(pill(page)).not.toHaveAttribute('data-state', 'checking', { timeout: 20_000 });
  await expect(pill(page)).toHaveAttribute('data-state', 'missing');
});

test.describe('runOfflineCheck', () => {
  test('reports the missing API reads by label, and an absent Cache Storage without throwing', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    // warm: false, so nothing is fetched — the fake URLs would answer from the
    // catch-all stub anyway, and this asks about the CACHE, not the network.
    const cold = await runInBrowser(page, {
      lang: 'EN',
      warm: false,
      pdfLoads: true,
      apiUrls: [
        { url: '/api/fake-one', must: true, label: 'One' },
        { url: '/api/fake-two', must: false, label: 'Two' },
      ],
    });
    expect(cold.items.map((i) => i.key)).toEqual(['sw', 'shell', 'pdf', 'api', 'store', 'persist', 'quota']);
    const api = cold.items.find((i) => i.key === 'api');
    expect(api?.ok).toBe(false);
    expect(api?.must).toBe(true);
    expect(api?.detail).toBe('Missing: One, Two');
    // A resolving loader is a warm chunk, whatever the caches say.
    expect(cold.items.find((i) => i.key === 'pdf')?.ok).toBe(true);
    expect(cold.ok).toBe(false);

    // Only a nice-to-have missing: the row fails, but it does not block.
    const optional = await runInBrowser(page, {
      lang: 'DE',
      warm: false,
      pdfLoads: true,
      apiUrls: [{ url: '/api/fake-two', must: false, label: 'Zwei' }],
    });
    const optionalApi = optional.items.find((i) => i.key === 'api');
    expect(optionalApi?.ok).toBe(false);
    expect(optionalApi?.must).toBe(false);
    expect(optionalApi?.detail).toBe('Fehlt: Zwei');

    // A browser with no Cache Storage at all (private mode on some engines):
    // the shell and API rows fail, the report still comes back whole.
    const noCaches = await runInBrowser(page, {
      lang: 'EN',
      warm: true,
      pdfLoads: false,
      withoutCaches: true,
      apiUrls: [{ url: '/api/fake-one', must: true, label: 'One' }],
    });
    expect(noCaches.items).toHaveLength(7);
    expect(noCaches.items.find((i) => i.key === 'shell')?.ok).toBe(false);
    expect(noCaches.items.find((i) => i.key === 'api')?.ok).toBe(false);
    // A loader that rejects is a failed row, never an exception into the form.
    expect(noCaches.items.find((i) => i.key === 'pdf')?.ok).toBe(false);
    expect(noCaches.items.find((i) => i.key === 'store')?.ok).toBe(true);
    expect(noCaches.missingMust).toBeGreaterThanOrEqual(3);
  });

  /**
   * The worker hands a response to the page before it stores it (workbox's
   * NetworkFirst defers the cache write behind the fetch), so one look at the
   * cache right after the warm-up fetch found nothing, and the run reported as
   * missing the very URL it had just warmed. There is no worker on the dev
   * server, so the deferred write is played by a Cache Storage stand-in whose
   * entry appears only on the third look after the fetch — and the controller
   * the check keys on is stood in for on the container.
   */
  test('a URL the warm-up fetched is not missing while the worker is still writing it', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    const run = (controlled: boolean) => page.evaluate(async ([modulePath, isControlled]) => {
      let fetched = false;
      let looks = 0;
      const store = {
        // Only the URL under test is counted: the app's document cache reads
        // Cache Storage too, and it would otherwise use up the looks.
        match: async (url: string) => {
          if (url !== '/api/fake-one' || !fetched) return undefined;
          looks += 1;
          return looks >= 3 ? new Response('[]') : undefined;
        },
        keys: async () => [],
      };
      Object.defineProperty(window, 'caches', {
        get: () => ({ open: async () => store, keys: async () => [] }),
        configurable: true,
      });
      Object.defineProperty(navigator.serviceWorker, 'controller', {
        get: () => (isControlled ? {} : null),
        configurable: true,
      });
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/fake-one')) fetched = true;
        return realFetch(input, init);
      };
      const mod = await import(/* @vite-ignore */ modulePath) as OfflineModule;
      const report = await mod.runOfflineCheck({
        lang: 'EN',
        warm: true,
        apiUrls: [{ url: '/api/fake-one', must: true, label: 'One' }],
        loadPdf: () => Promise.resolve(),
      });
      return { api: report.items.find((i) => i.key === 'api'), looks };
    }, ['/src/lib/offlineReady.ts', controlled] as const);

    // Controlled: the cache is asked again until the write lands.
    const controlled = await run(true);
    expect(controlled.api?.ok).toBe(true);
    expect(controlled.looks).toBe(3);

    // No controller: the fetch never passed a worker, so nothing is coming and
    // one look after the fetch is the truth — no half-second wait per URL.
    const bare = await run(false);
    expect(bare.api?.ok).toBe(false);
    expect(bare.api?.detail).toBe('Missing: One');
    expect(bare.looks).toBe(1);
  });
});
