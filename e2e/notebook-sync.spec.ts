import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * The server is the notebook's source of truth: a page is pushed seconds after
 * it was written, a wiped device gets its pages back, two copies merge per page
 * (newer wins, tie to the server, absence never deletes), and a refusal is
 * said in words while a dead network is not.
 */

const PAD_DB = 'svrz-notebook';
const PAGES = 'pages';
const INK = 'ink';
const SYNC = { timeout: 10_000 };   // the push fires 5 s after the last commit

type StoredPage = {
  id: string; schema: number; ownerId: string; pageId: string; kind: string; text: string; bg: string; points: number;
  usedIn: unknown[]; createdAt: number; updatedAt: number; deleted: boolean; dirty: boolean; savedAt: string; rejectedReason: string;
};
type ServerPage = { pageId: string; kind: string; createdAt: number; updatedAt: number; deleted: boolean; schema: number; savedAt: string; text?: string; ink?: unknown };

function local(over: Partial<StoredPage> = {}): StoredPage {
  const ownerId = over.ownerId || RC.id;
  const pageId = over.pageId || 'page-local-0001';
  const at = over.createdAt ?? Date.now() - 60_000;
  return {
    id: `${ownerId}|${pageId}`, schema: 1, ownerId, pageId, kind: 'text', text: 'local copy', bg: '', points: 0, usedIn: [],
    createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: new Date(at).toISOString(), rejectedReason: '', ...over,
  };
}
function remote(over: Partial<ServerPage> = {}): ServerPage {
  const at = over.createdAt ?? Date.now() - 60_000;
  return { pageId: 'page-local-0001', kind: 'text', createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString(), text: 'server copy', ...over };
}

async function seedPad(page: Page, rows: StoredPage[]): Promise<void> {
  await page.addInitScript(([db, pages, ink, rows]) => {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(pages)) open.result.createObjectStore(pages, { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains(ink)) open.result.createObjectStore(ink, { keyPath: 'id' });
    };
    open.onsuccess = () => { const d = open.result; const tx = d.transaction(pages, 'readwrite'); for (const r of rows) tx.objectStore(pages).put(r); tx.oncomplete = () => d.close(); };
  }, [PAD_DB, PAGES, INK, rows] as const);
}
function storedPages(page: Page): Promise<StoredPage[]> {
  return page.evaluate(([db, store]) => new Promise<StoredPage[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; if (!d.objectStoreNames.contains(store)) { d.close(); resolve([]); return; } const req = d.transaction(store, 'readonly').objectStore(store).getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredPage[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), [PAD_DB, PAGES] as const);
}

/** The server, stubbed: an index, and a push that records what arrived and
 *  answers however the test says. Registered AFTER stubSignedInApp so it
 *  overrides the catch-all. */
async function stubNotebook(page: Page, opts: { index?: ServerPage[]; onPush?: (body: { pages: Record<string, unknown>[] }, route: Route) => Promise<void> | void } = {}) {
  const puts: { method: string; pages: Record<string, unknown>[]; keepalive: boolean }[] = [];
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: opts.index || [] } }));
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Record<string, unknown>[] };
    puts.push({ method: r.request().method(), pages: body.pages, keepalive: false });
    if (opts.onPush) { await opts.onPush(body, r); return; }
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date().toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  });
  return puts;
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageBox = (page: Page) => sheet(page).getByPlaceholder(/^(Schreib hier|Write here)/);
const padSynced = (page: Page) => sheet(page).getByText(/Auf dem Server gesichert|Backed up on the server/);

test('a page is pushed within seconds, without its bookkeeping, and marked saved', async ({ page }) => {
  await stubSignedInApp(page);
  const puts = await stubNotebook(page);
  await page.goto('/');
  await launcher(page).click();
  await pageBox(page).fill('pushed');
  await expect.poll(() => puts.length, SYNC).toBeGreaterThanOrEqual(1);
  const sent = puts[0].pages[0];
  expect(sent.text).toBe('pushed');
  expect(sent.kind).toBe('text');
  for (const key of ['ownerId', 'id', 'dirty', 'savedAt', 'rejectedReason']) expect(sent).not.toHaveProperty(key);
  await expect.poll(async () => (await storedPages(page))[0]?.dirty, SYNC).toBe(false);
  await expect(padSynced(page)).toBeVisible();
});

test('a wiped device gets its pages back', async ({ page }) => {
  await stubSignedInApp(page);
  await stubNotebook(page, { index: [remote({ pageId: 'page-server-1', text: 'from the server' })] });
  await page.goto('/');
  await expect(page.getByTestId('pad-total')).toHaveText('1');
  await launcher(page).click();
  await expect(pageBox(page)).toHaveValue('from the server');
  const rows = await storedPages(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].dirty).toBe(false);
  expect(rows[0].ownerId).toBe(RC.id);
});

test('local newer wins, server newer wins, tie goes to the server', async ({ page }) => {
  const now = Date.now();
  await stubSignedInApp(page);
  await seedPad(page, [
    local({ pageId: 'p-local-newer', text: 'local wins', updatedAt: now - 1000, dirty: true, savedAt: '' }),
    local({ pageId: 'p-server-newer', text: 'local loses', updatedAt: now - 3000, dirty: true, savedAt: '' }),
    local({ pageId: 'p-tie', text: 'same', updatedAt: now - 2000, dirty: true, savedAt: '' }),
  ]);
  await stubNotebook(page, { index: [
    remote({ pageId: 'p-local-newer', text: 'server loses', updatedAt: now - 2000 }),
    remote({ pageId: 'p-server-newer', text: 'server wins', updatedAt: now - 2000 }),
    remote({ pageId: 'p-tie', text: 'same', updatedAt: now - 2000 }),
  ] });
  await page.goto('/');
  await expect.poll(async () => Object.fromEntries((await storedPages(page)).map((r) => [r.pageId, r.text])), SYNC)
    .toEqual({ 'p-local-newer': 'local wins', 'p-server-newer': 'server wins', 'p-tie': 'same' });
  // The tie is our own push acknowledged late: the dirty flag clears.
  expect((await storedPages(page)).find((r) => r.pageId === 'p-tie')?.dirty).toBe(false);
});

test('a server tombstone hides an older local copy; absence on the server never deletes', async ({ page }) => {
  const now = Date.now();
  await stubSignedInApp(page);
  await seedPad(page, [
    local({ pageId: 'p-deleted-elsewhere', text: 'deleted on the tablet', updatedAt: now - 2000 }),
    local({ pageId: 'p-only-here', text: 'only on this phone', updatedAt: now - 2000 }),
  ]);
  await stubNotebook(page, { index: [remote({ pageId: 'p-deleted-elsewhere', deleted: true, updatedAt: now - 1000, text: '' })] });
  await page.goto('/');
  await launcher(page).click();
  await expect(pageBox(page)).toHaveValue('only on this phone');
  await expect(sheet(page).getByText('deleted on the tablet')).toHaveCount(0);
  const rows = await storedPages(page);
  expect(rows.find((r) => r.pageId === 'p-deleted-elsewhere')?.deleted).toBe(true);
  expect(rows.find((r) => r.pageId === 'p-only-here')?.deleted).toBe(false);
});

test("the ack's stamps are adopted, so the shown expiry is the enforced one", async ({ page }) => {
  await stubSignedInApp(page);
  const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
  await stubNotebook(page, { onPush: async (body, r) => {
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date().toISOString(), updatedAt: p.updatedAt, createdAt: sixDaysAgo })), stale: [], rejected: [] } });
  } });
  await page.goto('/');
  await launcher(page).click();
  await pageBox(page).fill('clamped');
  await expect.poll(async () => (await storedPages(page))[0]?.createdAt, SYNC).toBe(sixDaysAgo);
  await expect(sheet(page).getByText(/wird morgen gelöscht|deleted tomorrow/)).toBeVisible();
});

test('the server refusing is said in words; the network failing is not', async ({ page }) => {
  await stubSignedInApp(page);
  let mode: 'schema' | 'dead' = 'schema';
  await stubNotebook(page, { onPush: async (_body, r) => {
    if (mode === 'schema') { await r.fulfill({ status: 400, json: { error: 'Die Sammlung „rc_notebook" fehlt in PocketBase — bitte setup-schema.mjs neu ausführen.' } }); return; }
    setTimeout(() => r.abort(), 80);
  } });
  await page.goto('/');
  await launcher(page).click();
  await pageBox(page).fill('refused');
  await expect(sheet(page).getByText(/Die Sammlung „rc_notebook" fehlt/)).toBeVisible(SYNC);
  mode = 'dead';
  await pageBox(page).fill('refused again');
  await expect(sheet(page).getByText(/Server folgt, sobald online|Server follows once online/)).toBeVisible(SYNC);
  await expect(page.locator('[data-testid="toast"][data-toast-kind="error"]')).toHaveCount(0);
});

test('a refused page is not re-sent until edited; 429 is patience, not a refusal', async ({ page }) => {
  await stubSignedInApp(page);
  let answer: 'reject' | 'throttle' | 'ok' = 'reject';
  const puts = await stubNotebook(page, { onPush: async (body, r) => {
    if (answer === 'reject') { await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: [], stale: [], rejected: body.pages.map((p) => ({ pageId: p.pageId, reason: 'too-big' })) } }); return; }
    if (answer === 'throttle') { await r.fulfill({ status: 429, json: { error: 'Zu viele Versuche.', retryAfterMs: 1200 } }); return; }
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date().toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  } });
  await page.goto('/');
  await launcher(page).click();
  await pageBox(page).fill('too big');
  await expect(sheet(page).getByText(/abgelehnt|refused/)).toBeVisible(SYNC);
  const after = puts.length;
  // Close and reopen: no new push for a page the server refused.
  await page.keyboard.press('Escape');
  await launcher(page).click();
  await page.waitForTimeout(800);
  expect(puts.length).toBe(after);
  // An edit clears the refusal; a 429 is waited out, then the page lands.
  answer = 'throttle';
  await pageBox(page).fill('too big, edited');
  await expect.poll(() => puts.length, SYNC).toBeGreaterThan(after);
  answer = 'ok';
  await expect.poll(async () => (await storedPages(page))[0]?.dirty, { timeout: 15_000 }).toBe(false);
});

test('closing the sheet and leaving the page push at once; ink never rides a beacon', async ({ page }) => {
  await stubSignedInApp(page);
  const puts = await stubNotebook(page);
  await page.goto('/');
  await launcher(page).click();
  await pageBox(page).fill('close pushes');
  await page.keyboard.press('Escape');
  await expect.poll(() => puts.length, { timeout: 2500 }).toBeGreaterThanOrEqual(1);
  const before = puts.length;
  await launcher(page).click();
  await pageBox(page).fill('close pushes, and hide too');
  // The pagehide send can only POST (keepalive); the app's flush fires on it.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => puts.length, { timeout: 2500 }).toBeGreaterThan(before);
  expect(puts.slice(before).some((p) => p.method === 'POST')).toBe(true);
  for (const p of puts) for (const pg of p.pages) if (p.method === 'POST') expect(pg).not.toHaveProperty('ink');
});
