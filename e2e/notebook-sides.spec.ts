import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, RC, suiteNow } from './support/app';

/**
 * A page with two sides (24.10.2026). Jennifer found "+ Text" / "+ Stift"
 * confusing on her iPad and asked for one "new page" with a switch inside it
 * between typing and handwriting (23.10.2026). So: one Neue Seite, a switch
 * Tippen | Handschrift on the page, and a page that keeps what was typed AND
 * what was written by hand on it — on the device, on the wire, and into the
 * report only by its typed side.
 *
 * Every string is matched in both languages — the app follows the browser's
 * locale, and the Playwright projects run under an English one.
 */

const PAD_DB = 'svrz-notebook';
const SYNC = { timeout: 12_000 };   // a stroke is stored after 2 s, pushed 5 s after the last change

type Stroke = { c: number; w: number; p: number; d: number[] };
type StoredPage = { id: string; pageId: string; kind: string; text: string; bg: string; points: number; dirty: boolean; title: string };
type StoredInk = { id: string; ownerId: string; page: { w: number; h: number; strokes: Stroke[] } };
type Wire = { pageId: string; kind: string; text?: string; both?: boolean; points?: number; updatedAt: number; createdAt: number; ink?: { strokes: Stroke[] } };

const STROKE: Stroke = { c: 0, w: 4, p: 0, d: [1000, 1500, 0, 0, 3000, 400, 0, 16, 3000, 400, 0, 16] };

function storedPages(page: Page): Promise<StoredPage[]> {
  return page.evaluate((db) => new Promise<StoredPage[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('pages', 'readonly').objectStore('pages').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredPage[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}
function storedInk(page: Page): Promise<StoredInk[]> {
  return page.evaluate((db) => new Promise<StoredInk[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('ink', 'readonly').objectStore('ink').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredInk[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}

/** A stored page as the sheet writes it, with its strokes beside it. Seeds go
 *  in BEFORE goto, both stores created (a one-store database would put the
 *  app into server-only mode). */
function row(over: Partial<StoredPage> & { pageId: string; createdAt?: number }): Record<string, unknown> {
  const at = over.createdAt ?? suiteNow() - 60 * 60_000;
  return {
    id: `${RC.id}|${over.pageId}`, schema: 1, ownerId: RC.id, kind: 'text', title: '', text: '', bg: '', points: 0, usedIn: [],
    createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: new Date(at).toISOString(), rejectedReason: '', ...over,
  };
}
async function seed(page: Page, rows: Record<string, unknown>[], inks: { pageId: string; strokes: Stroke[] }[] = []): Promise<void> {
  const records = inks.map((i) => ({ id: `${RC.id}|${i.pageId}`, ownerId: RC.id, page: { w: 1000, h: 1414, strokes: i.strokes } }));
  await page.addInitScript(([db, rs, ks]) => {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('pages')) open.result.createObjectStore('pages', { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains('ink')) open.result.createObjectStore('ink', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const d = open.result;
      const tx = d.transaction(['pages', 'ink'], 'readwrite');
      for (const r of rs) tx.objectStore('pages').put(r);
      for (const k of ks) tx.objectStore('ink').put(k);
      tx.oncomplete = () => d.close();
    };
  }, [PAD_DB, rows, records] as const);
}

/** The server, stubbed after stubSignedInApp so it overrides the catch-all:
 *  an index, the strokes of one page, and a push that records what arrived.
 *  `refusePut` keeps every regular push failing, so pages stay dirty. */
async function stubNotebook(page: Page, opts: { index?: Record<string, unknown>[]; ink?: Record<string, Stroke[]>; refusePut?: boolean } = {}) {
  const pushes: { method: string; pages: Wire[] }[] = [];
  const inkAsked: string[] = [];
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: opts.index || [] } }));
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Wire[] };
    const method = r.request().method();
    pushes.push({ method, pages: body.pages });
    if (opts.refusePut && method === 'PUT') { await r.fulfill({ status: 503, json: { error: 'busy' } }); return; }
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date(suiteNow()).toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  });
  await page.route('**/api/notebook/pages/*', async (r) => {
    const pageId = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    inkAsked.push(pageId);
    const listed = (opts.index || []).find((p) => p.pageId === pageId);
    const strokes = opts.ink && opts.ink[pageId];
    if (!listed) { await r.fulfill({ status: 404, json: { error: 'Page not found.' } }); return; }
    await r.fulfill({ json: { ownerId: RC.id, page: { ...listed, ...(strokes ? { ink: { w: 1000, h: 1414, strokes } } : {}) } } });
  });
  return { pushes, inkAsked };
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageBox = (page: Page) => sheet(page).locator('.rich-surface');
const paper = (page: Page) => sheet(page).getByTestId('ink-page');
const stage = (page: Page) => sheet(page).getByTestId('ink-stage');
const sideText = (page: Page) => sheet(page).getByTestId('pad-side-text');
const sideInk = (page: Page) => sheet(page).getByTestId('pad-side-ink');
const newPage = (page: Page) => sheet(page).getByTestId('pad-new-page');
/** The form's Bemerkungen editor — the first rich surface that is not the notebook's own. */
const remarks = (page: Page) => page.locator('.rich-surface:not(.notebook-surface)').first();

async function openPad(page: Page): Promise<void> {
  await launcher(page).click();
  await expect(sheet(page)).toBeVisible();
}

/** A mouse stroke across the top of the paper, where a page opened at its
 *  width is on screen. */
async function draw(page: Page): Promise<void> {
  const box = (await paper(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.12, { steps: 12 });
  await page.mouse.up();
}

/** Ink on the page canvas. */
async function inked(page: Page): Promise<boolean> {
  return stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
}

test('one button makes a new page; the two kinds of new page are gone', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPad(page);
  await expect(newPage(page)).toHaveCount(1);
  await expect(newPage(page)).toHaveAccessibleName(/^(Neue Seite|New page)$/);
  await expect(sheet(page).getByTestId('pad-new-text')).toHaveCount(0);
  await expect(sheet(page).getByTestId('pad-new-ink')).toHaveCount(0);
  // The old pair, by their names: nothing on the typed side is called so.
  await expect(sheet(page).getByRole('button', { name: /^(Text|Stift|Pen)$/ })).toHaveCount(0);
  // The switch is on the page, one side pressed.
  await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet(page).getByRole('group', { name: /^(Tippen oder von Hand schreiben|Type or write by hand)$/ })).toBeVisible();
});

test('a new page opens on the side last used on this device, and the handwriting where a pen was seen', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPad(page);
  // A device that never saw a pen types.
  await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
  await pageBox(page).fill('erste Seite');
  await sideInk(page).click();
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(paper(page)).toBeVisible();
  await newPage(page).click();
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(paper(page)).toBeVisible();
  await sideText(page).click();
  await expect(pageBox(page)).toBeVisible();
  await newPage(page).click();
  await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('svrz_pad_side'))).toBe('text');
  await sideInk(page).click();
  await page.reload();
  await openPad(page);
  await newPage(page).click();
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
});

test('a device that has seen a pen opens a new page on the handwriting', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('svrz_ink_pen_seen', '1'); } catch { /* private mode */ } });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPad(page);
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(paper(page)).toBeVisible();
});

test('typed and handwritten on one page: both stay through a reload, and both travel in one push that says "both"', async ({ page }) => {
  await stubSignedInApp(page);
  const { pushes, inkAsked } = await stubNotebook(page);
  await page.goto('/');
  await openPad(page);
  await pageBox(page).fill('Netz zu hoch');
  await sideInk(page).click();
  await expect(paper(page)).toBeVisible();
  // A page only typed on, not yet on the server: nothing to wait for or fetch.
  await expect(sheet(page).getByText(/Handschrift wird geladen|Loading the handwriting/)).toHaveCount(0);
  await draw(page);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await sideText(page).click();
  await expect(pageBox(page)).toHaveText('Netz zu hoch');
  expect(inkAsked).toEqual([]);

  // The push: one page, its text and its strokes, from a client that writes both.
  await expect.poll(() => pushes.flatMap((p) => p.pages).some((w) => w.text === 'Netz zu hoch' && w.ink?.strokes.length === 1 && w.both === true), SYNC).toBe(true);
  const sent = pushes.flatMap((p) => p.pages).filter((w) => w.ink).at(-1)!;
  // The side last written is the stroke's: the installed apps show a page by
  // its kind, and so show the side with the latest on it (25.10.2026).
  expect(sent.kind).toBe('ink');
  expect(sent.points).toBeGreaterThan(0);
  // A page with strokes goes in a request of its own.
  expect(pushes.find((p) => p.pages.some((w) => w.ink))!.pages).toHaveLength(1);
  await expect.poll(async () => (await storedPages(page))[0]?.dirty, SYNC).toBe(false);

  const rows = await storedPages(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe('Netz zu hoch');
  expect(rows[0].kind).toBe('ink');

  // Typed on again, the strokes the server already has stay home: the push
  // says what changed, and the server keeps the strokes it holds.
  const before = pushes.length;
  await pageBox(page).fill('Netz zu hoch, Antenne schief');
  await expect.poll(() => pushes.slice(before).flatMap((p) => p.pages).some((w) => w.text === 'Netz zu hoch, Antenne schief'), SYNC).toBe(true);
  for (const w of pushes.slice(before).flatMap((p) => p.pages)) expect(w).not.toHaveProperty('ink');
  await expect.poll(async () => (await storedPages(page))[0]?.dirty, SYNC).toBe(false);
  // Typed on last, it is a typed page again.
  expect((await storedPages(page))[0].kind).toBe('text');

  await page.reload();
  await openPad(page);
  await expect(pageBox(page)).toHaveText('Netz zu hoch, Antenne schief');
  // The strip says the page has both sides; the switch marks the one not shown.
  const pill = sheet(page).locator('button[aria-current="page"]');
  await expect(pill.locator('[data-side="text"]')).toHaveCount(1);
  await expect(pill.locator('[data-side="ink"]')).toHaveCount(1);
  await expect(sideInk(page).getByTestId('pad-side-dot')).toHaveCount(1);
  await expect(sideText(page).getByTestId('pad-side-dot')).toHaveCount(0);
  await sideInk(page).click();
  await expect(paper(page)).toBeVisible();
  await expect.poll(() => inked(page), SYNC).toBe(true);
  await expect(sideText(page).getByTestId('pad-side-dot')).toHaveCount(1);
  await expect(sideInk(page).getByTestId('pad-side-dot')).toHaveCount(0);
  // Read from this device, not the server.
  expect(inkAsked).toEqual([]);
});

test('Handschrift leeren takes the strokes and leaves the typed text', async ({ page }) => {
  await seed(page, [row({ pageId: 'page-both-0001', kind: 'ink', text: 'bleibt', points: 3 })], [{ pageId: 'page-both-0001', strokes: [STROKE] }]);
  await stubSignedInApp(page);
  const { pushes } = await stubNotebook(page, { index: [] });
  await page.goto('/');
  await openPad(page);
  await expect(paper(page)).toBeVisible();
  await sheet(page).getByRole('button', { name: /^(Handschrift leeren|Clear handwriting)$/ }).click();
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(0);
  expect((await storedPages(page))[0].text).toBe('bleibt');
  // Explicit empty strokes travel, so the server clears them too.
  await expect.poll(() => pushes.flatMap((p) => p.pages).some((w) => w.ink?.strokes.length === 0 && w.text === 'bleibt'), SYNC).toBe(true);
  await sideText(page).click();
  await expect(pageBox(page)).toHaveText('bleibt');
  await expect(sideInk(page).getByTestId('pad-side-dot')).toHaveCount(0);
});

test('Übernehmen offers a page by its typed side even while it shows the handwriting, and inserts only the text', async ({ page }) => {
  await seed(page, [
    row({ pageId: 'page-both-0001', kind: 'ink', text: 'Getippt für den Bericht', points: 3 }),
    row({ pageId: 'page-pen-0002', kind: 'ink', points: 3, createdAt: suiteNow() - 3 * 60 * 60_000 }),
  ], [{ pageId: 'page-both-0001', strokes: [STROKE] }, { pageId: 'page-pen-0002', strokes: [STROKE] }]);
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
  await openPad(page);
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
  const items = sheet(page).getByRole('listitem');
  await expect(items).toHaveCount(2);
  // The page on screen is offered and ticked, with what goes in and what not.
  await expect(items.nth(0)).toContainText('Getippt für den Bericht');
  await expect(items.nth(0)).toContainText(/Handschrift wird nicht übernommen|Handwriting is not inserted/);
  await expect(items.nth(0).getByRole('checkbox')).toBeChecked();
  // Handwriting only: listed, greyed, nothing to tick.
  await expect(items.nth(1)).toContainText(/Nur Handschrift|Handwriting only/);
  await expect(items.nth(1).getByRole('checkbox')).toHaveCount(0);
  // Enabled first: a click on a button still disabled waited out the whole
  // 30 s action timeout before it said anything.
  const insertOne = sheet(page).getByRole('button', { name: /1 Seite → Bemerkungen \(1\. SR\)|1 page → Remarks \(1\. SR\)/ });
  await expect(insertOne).toBeEnabled();
  await insertOne.click();
  await expect(remarks(page)).toContainText('Getippt für den Bericht');
  await expect.poll(async () => (await storedPages(page)).find((r) => r.pageId === 'page-both-0001') as unknown as { usedIn: unknown[] } | undefined)
    .toMatchObject({ usedIn: [expect.objectContaining({ f: 'bemerkungen' })] });
});

test('a server page shown as handwriting brings its typed text with the index and fetches its strokes', async ({ page }) => {
  const at = suiteNow() - 60 * 60_000;
  const listed = { pageId: 'page-remote-0001', kind: 'ink', title: '', text: 'vom Tablet getippt', bg: 'court', points: 3, usedIn: [], createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString() };
  await stubSignedInApp(page);
  const { inkAsked } = await stubNotebook(page, { index: [listed], ink: { 'page-remote-0001': [STROKE] } });
  await page.goto('/');
  await openPad(page);
  await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => inkAsked, SYNC).toEqual(['page-remote-0001']);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await expect(sideText(page).getByTestId('pad-side-dot')).toHaveCount(1);
  await sideText(page).click();
  await expect(pageBox(page)).toHaveText('vom Tablet getippt');
  const rows = await storedPages(page);
  expect(rows[0]).toMatchObject({ text: 'vom Tablet getippt', bg: 'court', points: 3 });
});

test('the keepalive send as the app goes never carries a page with strokes, whichever side it shows', async ({ page }) => {
  await stubSignedInApp(page);
  // Every regular push fails, so both pages are still waiting when the app goes.
  const { pushes } = await stubNotebook(page, { refusePut: true });
  await page.goto('/');
  await openPad(page);
  await pageBox(page).fill('nur getippt');
  await newPage(page).click();
  await pageBox(page).fill('getippt und gezeichnet');
  await sideInk(page).click();
  await draw(page);
  await sideText(page).click();
  await expect.poll(async () => (await storedPages(page)).filter((r) => r.points > 0).length, SYNC).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => pushes.filter((p) => p.method === 'POST').length, SYNC).toBeGreaterThanOrEqual(1);
  const beaconed = pushes.filter((p) => p.method === 'POST').flatMap((p) => p.pages);
  expect(beaconed.map((w) => w.text)).toEqual(['nur getippt']);
  for (const w of beaconed) expect(w).not.toHaveProperty('ink');
});
