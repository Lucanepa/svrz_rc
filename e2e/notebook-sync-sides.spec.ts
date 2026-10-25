import { test, expect, type Page } from '@playwright/test';
import { mergeNotebookPayload, sanitizeNotebookPage } from '../server/notebook';
import { stubSignedInApp, RC, suiteNow } from './support/app';

/**
 * Pages with two sides meet what is already out there (data-loss review,
 * 25.10.2026): records the frontend before wrote into IndexedDB on the
 * coaches' devices (one side per page — '' as the text of a pen page, '' and
 * 0 as the court and the stroke count of a typed one, strokes whose "older
 * than the server's" mark lived in memory only), the installed apps 1.3.6 and
 * 1.3.7, a server that lost a row, a network that is not there. Nothing any of
 * them meets may cost a side of a page the coach cannot see on her screen.
 *
 * Every string is matched in both languages — the app follows the browser's
 * locale, and the Playwright projects run under an English one.
 */

const PAD_DB = 'svrz-notebook';
const SYNC = { timeout: 12_000 };   // a stroke is stored after 2 s, pushed 5 s after the last change

type Stroke = { c: number; w: number; p: number; d: number[] };
type StoredPage = {
  id: string; pageId: string; kind: string; title: string; text: string; bg: string; points: number; dirty: boolean;
  updatedAt: number; savedAt: string; rejectedReason: string; sides?: number; inkRejected?: string; deleted?: boolean;
};
type StoredInk = { id: string; ownerId: string; page: { w: number; h: number; strokes: Stroke[] }; stale?: boolean };
type Wire = { pageId: string; kind: string; title?: string; text?: string; bg?: string; both?: boolean; points?: number; updatedAt: number; createdAt: number; ink?: { strokes: Stroke[] } };

/** A stroke `w` wide with `samples` samples: the width tells whose it is. */
const stroke = (w: number, samples = 3): Stroke => ({ c: 0, w, p: 0, d: [1000, 1500, 0, 0, ...Array.from({ length: samples - 1 }, () => [3000, 400, 0, 16]).flat()] });
/** Drawn on this device (and every stroke the mouse makes here is 4 wide). */
const MINE = stroke(4);
/** The server's, from another device. */
const THEIRS = stroke(7);
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 60 * 60_000;

/** A stored page as the frontend BEFORE 25.10.2026 wrote it: no `sides`. */
function row(over: Partial<StoredPage> & { pageId: string; createdAt?: number }): Record<string, unknown> {
  const at = over.createdAt ?? suiteNow() - HOUR;
  return {
    id: `${RC.id}|${over.pageId}`, schema: 1, ownerId: RC.id, kind: 'text', title: '', text: '', bg: '', points: 0, usedIn: [],
    createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: iso(at), rejectedReason: '', ...over,
  };
}
/** A stored page as this frontend writes it. */
const marked = (over: Partial<StoredPage> & { pageId: string; createdAt?: number }) => row({ sides: 2, ...over });
/** A row of the server's index. */
function listed(over: Record<string, unknown> & { pageId: string }): Record<string, unknown> {
  const at = (over.createdAt as number | undefined) ?? suiteNow() - HOUR;
  const updatedAt = (over.updatedAt as number | undefined) ?? at;
  return { kind: 'text', title: '', text: '', bg: '', points: 0, usedIn: [], createdAt: at, updatedAt, deleted: false, schema: 1, savedAt: iso(updatedAt), ...over };
}

/** Seeds go in BEFORE goto, both stores created (a one-store database would
 *  put the app into server-only mode). */
async function seed(page: Page, rows: Record<string, unknown>[], inks: { pageId: string; strokes: Stroke[]; stale?: boolean }[] = []): Promise<void> {
  const records = inks.map((i) => ({ id: `${RC.id}|${i.pageId}`, ownerId: RC.id, page: { w: 1000, h: 1414, strokes: i.strokes }, ...(i.stale ? { stale: true } : {}) }));
  await page.addInitScript(([db, rs, ks]) => {
    // Once per test, not on every reload: a reload must find what the app wrote.
    try {
      if (sessionStorage.getItem('pad-seeded') === '1') return;
      sessionStorage.setItem('pad-seeded', '1');
    } catch { /* no session storage on this document: seed it anyway */ }
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

function readStore<T>(page: Page, store: 'pages' | 'ink'): Promise<T[]> {
  return page.evaluate(([db, name]) => new Promise<T[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction(name, 'readonly').objectStore(name).getAll(); req.onsuccess = () => { d.close(); resolve(req.result as T[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), [PAD_DB, store] as const);
}
const storedPages = (page: Page) => readStore<StoredPage>(page, 'pages');
const storedInk = (page: Page) => readStore<StoredInk>(page, 'ink');
const pageRow = async (page: Page, pageId: string) => (await storedPages(page)).find((r) => r.pageId === pageId);
const inkWidths = async (page: Page, pageId: string) => (await storedInk(page)).find((i) => i.id === `${RC.id}|${pageId}`)?.page.strokes.map((s) => s.w);

type Stub = {
  index?: Record<string, unknown>[];
  /** The index request fails while this says so. */
  indexFails?: () => boolean;
  /** The strokes the server holds, by page. A page not named has none at all (no `ink` in its row). */
  ink?: Record<string, Stroke[]>;
  /** Holds a page's strokes back until the promise settles. */
  inkGate?: (pageId: string) => Promise<void> | undefined;
  inkFails?: (pageId: string) => boolean;
  /** What a page's own fetch finds, where it is not its row in the index. */
  getRow?: (pageId: string) => Record<string, unknown> | undefined;
  /** How the server answers a push: refusals, and the pages whose row it had to make. */
  onPush?: (pages: Wire[]) => { rejected?: { pageId: string; reason: string }[]; newRow?: string[]; status?: number } | void;
};

/** The server, stubbed after stubSignedInApp so it overrides the catch-all. */
async function stubNotebook(page: Page, opts: Stub = {}) {
  const pushes: Wire[][] = [];
  const inkAsked: string[] = [];
  const order: string[] = [];
  await page.route('**/api/notebook', async (r) => {
    order.push('index');
    if (opts.indexFails && opts.indexFails()) { await r.abort('internetdisconnected'); return; }
    await r.fulfill({ json: { ownerId: RC.id, pages: opts.index || [] } });
  });
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Wire[] };
    pushes.push(body.pages);
    const answer = (opts.onPush && opts.onPush(body.pages)) || {};
    if (answer.status) { await r.fulfill({ status: answer.status, json: { error: 'busy' } }); return; }
    const refused = new Set((answer.rejected || []).map((x) => x.pageId));
    const fresh = new Set(answer.newRow || []);
    await r.fulfill({ json: {
      ok: true, ownerId: RC.id,
      saved: body.pages.filter((p) => !refused.has(p.pageId)).map((p) => ({ pageId: p.pageId, savedAt: iso(suiteNow()), updatedAt: p.updatedAt, createdAt: p.createdAt, ...(fresh.has(p.pageId) ? { newRow: true } : {}) })),
      stale: [], rejected: answer.rejected || [],
    } });
  });
  await page.route('**/api/notebook/pages/*', async (r) => {
    const pageId = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    if (r.request().method() !== 'GET') { await r.fulfill({ json: { removed: 1 } }); return; }
    inkAsked.push(pageId);
    const gate = opts.inkGate && opts.inkGate(pageId);
    if (gate) await gate;
    if (opts.inkFails && opts.inkFails(pageId)) { await r.abort('internetdisconnected').catch(() => {}); return; }
    const row = (opts.getRow && opts.getRow(pageId)) || (opts.index || []).find((p) => p.pageId === pageId);
    if (!row) { await r.fulfill({ status: 404, json: { error: 'Page not found.' } }).catch(() => {}); return; }
    const strokes = opts.ink && opts.ink[pageId];
    await r.fulfill({ json: { ownerId: RC.id, page: { ...row, ...(strokes ? { ink: { w: 1000, h: 1414, strokes } } : {}) } } }).catch(() => {});
  });
  return { pushes, inkAsked, order };
}

type ServerRow = { kind: string; createdAt: number; updatedAt: number; deleted: boolean; savedAt: string; payload: Record<string, unknown> };

/** The server by its own rules (server/notebook.ts): what it stores of a
 *  push, what it keeps of the side a push did not vouch for, what its index
 *  and a page's fetch say. For the cases where the answer depends on what was
 *  stored before. `failFirstPush`: the first push meets a 503. */
async function fakeServer(page: Page, seedRows: Record<string, ServerRow>, opts: { failFirstPush?: boolean } = {}) {
  const rows = new Map(Object.entries(seedRows));
  const pushes: Wire[][] = [];
  let failed = !opts.failFirstPush;
  const wire = (pageId: string, row: ServerRow, withInk: boolean) => {
    const { ink, ...rest } = row.payload;
    return { pageId, kind: row.kind, createdAt: row.createdAt, updatedAt: row.updatedAt, deleted: row.deleted, schema: 1, savedAt: row.savedAt, ...rest, ...(withInk && ink ? { ink } : {}) };
  };
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: [...rows].map(([id, row]) => wire(id, row, false)) } }));
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Wire[] };
    pushes.push(body.pages);
    if (!failed) { failed = true; await r.fulfill({ status: 503, json: { error: 'busy' } }); return; }
    const now = suiteNow();
    const saved: Record<string, unknown>[] = [];
    const stale: Record<string, unknown>[] = [];
    const rejected: Record<string, unknown>[] = [];
    for (const raw of body.pages) {
      const s = sanitizeNotebookPage(raw, now);
      if (!s.page) { rejected.push({ pageId: s.pageId, reason: s.reason }); continue; }
      const prev = rows.get(s.page.pageId);
      if (prev && prev.updatedAt >= s.page.updatedAt) { stale.push({ pageId: s.page.pageId, updatedAt: prev.updatedAt }); continue; }
      const live = !!prev && !prev.deleted;
      const payload = mergeNotebookPayload(live ? prev.payload : null, s.page, s.both);
      const createdAt = prev ? prev.createdAt : s.page.createdAt;
      rows.set(s.page.pageId, { kind: s.page.kind, createdAt, updatedAt: s.page.updatedAt, deleted: s.page.deleted, savedAt: iso(now), payload });
      saved.push({ pageId: s.page.pageId, savedAt: iso(now), updatedAt: s.page.updatedAt, createdAt, ...(!s.page.deleted && !live ? { newRow: true } : {}) });
    }
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved, stale, rejected } });
  });
  await page.route('**/api/notebook/pages/*', async (r) => {
    const pageId = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    const row = rows.get(pageId);
    if (!row) { await r.fulfill({ status: 404, json: { error: 'Page not found.' } }); return; }
    await r.fulfill({ json: { ownerId: RC.id, page: wire(pageId, row, true) } });
  });
  return { rows, pushes };
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageBox = (page: Page) => sheet(page).locator('.rich-surface');
const paper = (page: Page) => sheet(page).getByTestId('ink-page');
const stage = (page: Page) => sheet(page).getByTestId('ink-stage');
const sideText = (page: Page) => sheet(page).getByTestId('pad-side-text');
const sideInk = (page: Page) => sheet(page).getByTestId('pad-side-ink');
const olderPage = (page: Page) => sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ });
const inkFailed = (page: Page) => sheet(page).getByText(/Handschrift konnte nicht geladen werden|Could not load the handwriting/);
const inkLoading = (page: Page) => sheet(page).getByText(/Handschrift wird geladen|Loading the handwriting/);
const retry = (page: Page) => sheet(page).getByRole('button', { name: /^(Erneut versuchen|Try again)$/ });
const pushedFor = (pushes: Wire[][], pageId: string) => pushes.flat().filter((w) => w.pageId === pageId);

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

/** A mouse stroke across the middle of the sheet, whatever is on screen there:
 *  the pen page, or the line saying its strokes are on the way. */
async function drawBlind(page: Page): Promise<void> {
  const box = (await sheet(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
}

/** Ink on the page canvas. */
async function inked(page: Page): Promise<boolean> {
  if (await stage(page).count() === 0) return false;
  return stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
}

test.describe('Records the frontend before wrote', () => {
  test('an old pen page whose typed side the server kept: the pull brings the text in, and a stroke never pushes it away', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-oldpen-0001';
    await seed(page, [row({ pageId: id, kind: 'ink', text: '', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    const { pushes } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', text: 'auf dem Tablet getippt', points: 3, createdAt: at })], ink: { [id]: [MINE] } });
    await page.goto('/');
    await openPad(page);
    await expect(paper(page)).toBeVisible();
    await expect.poll(async () => (await pageRow(page, id))?.text, SYNC).toBe('auf dem Tablet getippt');
    await draw(page);
    await expect.poll(() => pushedFor(pushes, id).some((w) => w.ink?.strokes.length === 2), SYNC).toBe(true);
    for (const w of pushedFor(pushes, id)) expect(w.text, 'no push may say the typed side is empty').toBe('auf dem Tablet getippt');
    await sideText(page).click();
    await expect(pageBox(page)).toHaveText('auf dem Tablet getippt');
  });

  test('an old typed page whose court and strokes the server kept: the pull brings them in, and typing never pushes them away', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-oldtext-001';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'getippt', bg: '', points: 0, createdAt: at })]);
    await stubSignedInApp(page);
    const { pushes, inkAsked } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'text', text: 'getippt', bg: 'court', points: 3, createdAt: at })], ink: { [id]: [THEIRS] } });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('getippt');
    await expect.poll(async () => { const r = await pageRow(page, id); return r && { bg: r.bg, points: r.points }; }, SYNC).toEqual({ bg: 'court', points: 3 });
    await pageBox(page).fill('getippt, und mehr');
    await expect.poll(() => pushedFor(pushes, id).some((w) => w.text === 'getippt, und mehr'), SYNC).toBe(true);
    for (const w of pushedFor(pushes, id)) {
      expect(w).not.toHaveProperty('ink');
      if (w.both) expect(w.bg, 'a push that vouches for both sides keeps the court').toBe('court');
    }
    await sideInk(page).click();
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    await expect.poll(() => inked(page), SYNC).toBe(true);
    await expect(sheet(page).getByRole('button', { name: /^(Spielfeld|Court)$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('an old typed page turned to Handschrift waits for the strokes the server has: nothing drawn meanwhile replaces them', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-oldtext-002';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'getippt', bg: '', points: 0, createdAt: at })]);
    await stubSignedInApp(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { pushes, inkAsked } = await stubNotebook(page, {
      index: [listed({ pageId: id, kind: 'text', text: 'getippt', bg: 'court', points: 3, createdAt: at })],
      ink: { [id]: [THEIRS] },
      inkGate: (pageId) => (pageId === id ? held : undefined),
    });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('getippt');
    await sideInk(page).click();
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    // The strokes are on the way. A stroke now must not become the page.
    await drawBlind(page);
    await page.waitForTimeout(300);
    release();
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7, 4]);
    await expect.poll(() => pushedFor(pushes, id).filter((w) => w.ink).at(-1)?.ink?.strokes.map((s) => s.w), SYNC).toEqual([7, 4]);
    for (const w of pushedFor(pushes, id)) {
      if (w.ink) expect(w.ink.strokes.map((s) => s.w)[0], 'every push with strokes starts with the server\'s').toBe(7);
      if (w.both) expect(w.bg).toBe('court');
    }
  });

  test('an old pen page whose typed side has not come in yet says so, rather than offering an empty page to type over', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-oldpen-0002';
    await seed(page, [row({ pageId: id, kind: 'ink', text: '', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    let offline = true;
    await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', text: 'auf dem Tablet getippt', points: 3, createdAt: at })], indexFails: () => offline });
    await page.goto('/');
    await openPad(page);
    await expect(paper(page)).toBeVisible();
    await sideText(page).click();
    await expect(sheet(page).getByText(/Getippter Text konnte nicht geladen werden|Could not load the typed text/)).toBeVisible(SYNC);
    await expect(pageBox(page)).toHaveCount(0);
    offline = false;
    await retry(page).click();
    await expect(pageBox(page)).toHaveText('auf dem Tablet getippt', SYNC);
  });

  test('an ink record the frontend before left unmarked, older than its page says, is fetched before it is written on', async ({ page }) => {
    // The old frontend kept "these strokes are older than the server's" in
    // memory only: the page took the server's count, the strokes stayed old.
    const at = suiteNow() - HOUR;
    const id = 'page-oldink-0001';
    await seed(page, [row({ pageId: id, kind: 'ink', points: 5, createdAt: at })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    const { pushes, inkAsked } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 5, createdAt: at })], ink: { [id]: [stroke(7, 5)] } });
    await page.goto('/');
    await openPad(page);
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => pushedFor(pushes, id).filter((w) => w.ink).at(-1)?.ink?.strokes.map((s) => s.w), SYNC).toEqual([7, 4]);
  });

  test('an old typed page with edits not yet pushed, drawn on: its typed text survives the push and the pull after it', async ({ page }) => {
    // The pull kept the newer local copy and left it unmarked; drawn on, it
    // went without `both` as a pen page, the server kept its older text (rule
    // b), and the pull after it wrote that text over the coach's (review of
    // the fix round, 25.10.2026, N1).
    test.setTimeout(60_000);
    const at = suiteNow() - HOUR;
    const id = 'page-oldtext-003';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'alt und neu getippt', dirty: true, createdAt: at, updatedAt: at + 60_000 })]);
    await stubSignedInApp(page);
    const server = await fakeServer(page, { [id]: { kind: 'text', createdAt: at, updatedAt: at, deleted: false, savedAt: iso(at), payload: { title: '', text: 'alt', bg: 'court', points: 3, usedIn: [], ink: { w: 1000, h: 1414, strokes: [THEIRS] } } } }, { failFirstPush: true });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('alt und neu getippt');
    await sideInk(page).click();
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => (server.rows.get(id)?.payload.ink as { strokes: Stroke[] } | undefined)?.strokes.length, { timeout: 30_000 }).toBe(2);
    expect(server.rows.get(id)!.payload).toMatchObject({ text: 'alt und neu getippt', bg: 'court' });
    await expect.poll(async () => (await pageRow(page, id))?.dirty, SYNC).toBe(false);
    expect(await pageRow(page, id)).toMatchObject({ text: 'alt und neu getippt', bg: 'court', sides: 2 });
  });

  test('an old typed page with edits not yet pushed keeps the court put under it', async ({ page }) => {
    // The same record, its first push lost, the court toggled on: pushed as
    // a typed page without `both`, the server kept its own background (rule
    // c) and the court went.
    test.setTimeout(60_000);
    const at = suiteNow() - HOUR;
    const id = 'page-oldtext-004';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'neu getippt', dirty: true, createdAt: at, updatedAt: at + 60_000 })]);
    await stubSignedInApp(page);
    const server = await fakeServer(page, { [id]: { kind: 'text', createdAt: at, updatedAt: at, deleted: false, savedAt: iso(at), payload: { title: '', text: 'alt', bg: '', points: 3, usedIn: [], ink: { w: 1000, h: 1414, strokes: [THEIRS] } } } }, { failFirstPush: true });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('neu getippt');
    await sideInk(page).click();
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    const court = sheet(page).getByRole('button', { name: /^(Spielfeld|Court)$/ });
    await expect(court).toBeEnabled();
    await court.click();
    await expect(court).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => server.rows.get(id)?.payload.bg, { timeout: 30_000 }).toBe('court');
    expect(server.rows.get(id)!.payload).toMatchObject({ text: 'neu getippt' });
    await expect.poll(async () => (await pageRow(page, id))?.dirty, SYNC).toBe(false);
    expect(await pageRow(page, id)).toMatchObject({ bg: 'court', text: 'neu getippt' });
  });

  test('an old typed page with edits not yet pushed, emptied, is handed to the strokes the server holds', async ({ page }) => {
    // Its count said 0 whatever the server held: emptied, it stayed a typed
    // page, and the installed apps showed an empty page over the strokes (N5).
    const at = suiteNow() - HOUR;
    const id = 'page-oldtext-005';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'nur kurz', dirty: true, createdAt: at, updatedAt: at + 60_000 })]);
    await stubSignedInApp(page);
    const server = await fakeServer(page, { [id]: { kind: 'text', createdAt: at, updatedAt: at, deleted: false, savedAt: iso(at), payload: { title: '', text: 'alt', bg: '', points: 3, usedIn: [], ink: { w: 1000, h: 1414, strokes: [THEIRS] } } } }, { failFirstPush: true });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('nur kurz');
    // The boot's pull is in and its push has failed: emptied before the push
    // goes again.
    await expect.poll(() => server.pushes.length, SYNC).toBeGreaterThan(0);
    await pageBox(page).fill('');
    await expect.poll(async () => (await pageRow(page, id))?.kind, SYNC).toBe('ink');
    await expect.poll(() => server.rows.get(id)?.kind, { timeout: 30_000 }).toBe('ink');
    expect(server.rows.get(id)!.payload).toMatchObject({ text: '', points: 3 });
  });

  test('an old pen page at the server\'s version is read from the server once, even when its strokes count the same', async ({ page }) => {
    // Same count, older strokes: a count cannot tell them apart (N3).
    const at = suiteNow() - HOUR;
    const id = 'page-oldink-0003';
    await seed(page, [row({ pageId: id, kind: 'ink', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    const { pushes, inkAsked } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })], ink: { [id]: [THEIRS] } });
    await page.goto('/');
    await openPad(page);
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => pushedFor(pushes, id).filter((w) => w.ink).at(-1)?.ink?.strokes.map((s) => s.w), SYNC).toEqual([7, 4]);
    expect(inkAsked.filter((p) => p === id)).toHaveLength(1);
  });

  test('a waiting push of such a record does not carry its old strokes', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-oldink-0002';
    // Renamed on the old frontend, not yet pushed.
    await seed(page, [row({ pageId: id, kind: 'ink', points: 5, title: 'Halbzeit', dirty: true, createdAt: at, updatedAt: at + 60_000 })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    const { pushes } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 5, text: 'auf dem Tablet', createdAt: at })], ink: { [id]: [stroke(7, 5)] } });
    await page.goto('/');
    await expect.poll(() => pushedFor(pushes, id).some((w) => w.title === 'Halbzeit'), SYNC).toBe(true);
    for (const w of pushedFor(pushes, id)) {
      expect(w, 'strokes older than the server\'s stay home').not.toHaveProperty('ink');
      // The side it could not show came in with the pull before the push:
      // a push that vouches for both sides carries the server's text.
      if (w.both) expect(w.text).toBe('auf dem Tablet');
    }
    await expect.poll(async () => (await pageRow(page, id))?.dirty, SYNC).toBe(false);
  });
});

test.describe('Strokes that are not known to be current', () => {
  test('turning from a pen page to another never shows, or writes, the strokes of the one before', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const a = 'page-pen-a-0001';
    const b = 'page-pen-b-0001';
    await seed(page, [
      marked({ pageId: a, kind: 'ink', points: 3, createdAt: at }),
      marked({ pageId: b, kind: 'ink', points: 0, createdAt: at - 10 * 60_000 }),
    ], [{ pageId: a, strokes: [MINE] }]);
    await stubSignedInApp(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { pushes } = await stubNotebook(page, {
      index: [listed({ pageId: a, kind: 'ink', points: 3, createdAt: at }), listed({ pageId: b, kind: 'ink', points: 0, createdAt: at - 10 * 60_000 })],
      ink: { [a]: [MINE] },
      inkGate: (pageId) => (pageId === b ? held : undefined),
    });
    await page.goto('/');
    await openPad(page);
    await expect(paper(page)).toBeVisible();
    await expect.poll(() => inked(page), SYNC).toBe(true);
    await olderPage(page).click();
    await expect(sheet(page).getByText(/Seite 2 von 2|Page 2 of 2/)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await inked(page), 'the page before\'s strokes on this one').toBe(false);
    await drawBlind(page);
    await page.waitForTimeout(300);
    release();
    await expect(paper(page)).toBeVisible();
    await expect(inkLoading(page)).toHaveCount(0);
    await draw(page);
    await expect.poll(() => inkWidths(page, b), SYNC).toEqual([4]);
    for (const w of pushedFor(pushes, b)) if (w.ink) expect(w.ink.strokes).toHaveLength(1);
    expect(await inkWidths(page, a)).toEqual([4]);
  });

  test('strokes known to be older than the server\'s, whose fetch fails, are shown read-only with a way to try again', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-stale-0001';
    await seed(page, [marked({ pageId: id, kind: 'ink', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE], stale: true }]);
    await stubSignedInApp(page);
    let offline = true;
    const { pushes } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })], ink: { [id]: [THEIRS] }, inkFails: () => offline });
    await page.goto('/');
    await openPad(page);
    await expect(inkFailed(page)).toBeVisible(SYNC);
    await expect(paper(page)).toBeVisible();
    await expect.poll(() => inked(page), SYNC).toBe(true);
    await draw(page);
    await page.waitForTimeout(2_500);
    expect(await inkWidths(page, id)).toEqual([4]);
    expect(pushedFor(pushes, id).filter((w) => w.ink)).toEqual([]);
    offline = false;
    await retry(page).click();
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7]);
    await expect(inkFailed(page)).toHaveCount(0);
    await draw(page);
    await expect.poll(() => inkWidths(page, id), SYNC).toEqual([7, 4]);
  });

  test('with no copy here, a failed fetch gives a read-only page, not one whose next stroke replaces the server\'s strokes', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-remote-0009';
    await stubSignedInApp(page);
    const { pushes } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })], ink: { [id]: [THEIRS] }, inkFails: () => true });
    await page.goto('/');
    await openPad(page);
    await expect(inkFailed(page)).toBeVisible(SYNC);
    await drawBlind(page);
    await page.waitForTimeout(2_500);
    expect(await inkWidths(page, id)).toBeUndefined();
    expect(pushedFor(pushes, id)).toEqual([]);
  });

  test('a fetch of the strokes that never answers ends, and offers to try again', async ({ page }) => {
    // A gym's signal that is there in name only: no error, no answer. The
    // wait for the strokes had no end, and nothing to press (review,
    // 25.10.2026). The browser's clock is Playwright's here.
    await page.clock.install({ time: suiteNow() });
    const at = suiteNow() - HOUR;
    const id = 'page-remote-0010';
    await stubSignedInApp(page);
    await stubNotebook(page, { index: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })], ink: { [id]: [THEIRS] }, inkGate: () => new Promise<void>(() => {}) });
    await page.goto('/');
    await openPad(page);
    await expect(inkLoading(page)).toBeVisible(SYNC);
    await page.clock.fastForward(10_000);
    await expect(inkLoading(page)).toBeVisible();
    await page.clock.fastForward(25_000);
    await expect(inkFailed(page)).toBeVisible(SYNC);
    await expect(retry(page)).toBeVisible();
  });

  test('a fetch that finds the page deleted elsewhere takes the deletion, and does not bring the page back', async ({ page }) => {
    // The pull saw the page live; by the fetch, the tablet had deleted it.
    // The tombstone holds no strokes, and the strokes held here were kept as
    // the only copy — as a new version that revived the page (N4).
    const at = suiteNow() - HOUR;
    const id = 'page-gone-00001';
    await seed(page, [marked({ pageId: id, kind: 'ink', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE], stale: true }]);
    await stubSignedInApp(page);
    const { pushes, inkAsked } = await stubNotebook(page, {
      index: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })],
      getRow: (pageId) => (pageId === id ? listed({ pageId: id, kind: 'ink', deleted: true, createdAt: at, updatedAt: at + 5_000, points: 0 }) : undefined),
    });
    await page.goto('/');
    await openPad(page);
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    await expect.poll(async () => (await pageRow(page, id))?.deleted, SYNC).toBe(true);
    await page.waitForTimeout(6_500);
    expect(pushedFor(pushes, id).filter((w) => !(w as { deleted?: boolean }).deleted)).toEqual([]);
    expect((await pageRow(page, id))?.deleted).toBe(true);
    expect(await inkWidths(page, id)).toBeUndefined();
  });

  test('a page that never reached the server stays writable with the network gone', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/notebook', (r) => r.abort('internetdisconnected'));
    await page.route('**/api/notebook/pages', (r) => r.abort('internetdisconnected'));
    await page.route('**/api/notebook/pages/*', (r) => r.abort('internetdisconnected'));
    await page.goto('/');
    await openPad(page);
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
    await expect(inkFailed(page)).toHaveCount(0);
  });
});

test.describe('Per page, the newer copy wins: what is left to lose is bounded', () => {
  test('a newer server copy over strokes this device never pushed: the server is asked at once, and strokes it does not have are kept and pushed', async ({ page }) => {
    // Drawn here offline; meanwhile the tablet typed on the same page.
    const at = suiteNow() - HOUR;
    const id = 'page-orphan-0001';
    await seed(page, [marked({ pageId: id, kind: 'ink', points: 3, dirty: true, createdAt: at, updatedAt: at + 1_000, savedAt: iso(at) })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    const { pushes, inkAsked } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'text', text: 'vom Tablet getippt', points: 0, createdAt: at, updatedAt: at + 5_000 })] });
    await page.goto('/');
    await expect.poll(() => inkAsked, SYNC).toContain(id);
    await expect.poll(() => pushedFor(pushes, id).some((w) => w.ink?.strokes.length === 1 && w.text === 'vom Tablet getippt'), SYNC).toBe(true);
    await expect.poll(async () => { const r = await pageRow(page, id); return r && { text: r.text, points: r.points, dirty: r.dirty }; }, SYNC)
      .toEqual({ text: 'vom Tablet getippt', points: 3, dirty: false });
    await openPad(page);
    const pill = sheet(page).locator('button[aria-current="page"]');
    await expect(pill.locator('[data-side="text"]')).toHaveCount(1);
    await expect(pill.locator('[data-side="ink"]')).toHaveCount(1);
  });

  test('strokes held here that the server\'s copy does not count still show in the strip and by the switch', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const id = 'page-orphan-0002';
    await seed(page, [marked({ pageId: id, kind: 'ink', points: 3, dirty: true, createdAt: at, updatedAt: at + 1_000, savedAt: iso(at) })], [{ pageId: id, strokes: [MINE] }]);
    await stubSignedInApp(page);
    // The server's answer about the strokes never comes.
    await stubNotebook(page, { index: [listed({ pageId: id, kind: 'text', text: 'vom Tablet getippt', points: 0, createdAt: at, updatedAt: at + 5_000 })], inkGate: () => new Promise<void>(() => {}) });
    await page.goto('/');
    // The newer copy is in before the sheet opens: the page opens on its side.
    await expect.poll(async () => (await pageRow(page, id))?.text, SYNC).toBe('vom Tablet getippt');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('vom Tablet getippt', SYNC);
    const pill = sheet(page).locator('button[aria-current="page"]');
    await expect(pill.locator('[data-side="ink"]')).toHaveCount(1);
    await expect(sideInk(page).getByTestId('pad-side-dot')).toHaveCount(1);
  });
});

test.describe('The sync engine', () => {
  test('a pull asked for while the boot is still reading the store waits for it', async ({ page }) => {
    // The boot reads the pages, then which of them hold strokes here. A pull
    // between the two merged as if no page held any (review, 25.10.2026).
    const at = suiteNow() - HOUR;
    const id = 'page-boot-0001';
    await seed(page, [marked({ pageId: id, kind: 'ink', points: 3, createdAt: at })], [{ pageId: id, strokes: [MINE] }]);
    const order: string[] = [];
    await page.exposeFunction('__padKeysRead', () => { order.push('keys'); });
    await page.addInitScript(() => {
      // The boot's read of which pages hold strokes here, slowed down: the
      // one caller of getAllKeys. Every boot's — StrictMode mounts the app
      // twice in development, and boots twice.
      const original = IDBObjectStore.prototype.getAllKeys;
      IDBObjectStore.prototype.getAllKeys = function (this: IDBObjectStore, ...args: unknown[]) {
        const tx = this.transaction;
        const done = tx.oncomplete;
        tx.oncomplete = (ev) => {
          window.setTimeout(() => {
            (window as unknown as { __padKeysRead: () => void }).__padKeysRead();
            if (done) done.call(tx, ev);
          }, 2_500);
        };
        return (original as (...a: unknown[]) => IDBRequest).apply(this, args);
      } as typeof IDBObjectStore.prototype.getAllKeys;
    });
    await stubSignedInApp(page);
    await page.route('**/api/notebook', async (r) => { order.push('index'); await r.fulfill({ json: { ownerId: RC.id, pages: [listed({ pageId: id, kind: 'ink', points: 3, createdAt: at })] } }); });
    await page.goto('/');
    // Opening the sheet asks for a pull at once.
    await openPad(page);
    await expect.poll(() => order.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(order[0], `in order: ${order.join(', ')}`).toBe('keys');
  });

  test('strokes the server refuses do not hold the page back: it goes again without them, the text syncs, the strokes stay here with a word', async ({ page }) => {
    await stubSignedInApp(page);
    const { pushes } = await stubNotebook(page, { onPush: (pages) => ({ rejected: pages.filter((p) => p.ink).map((p) => ({ pageId: p.pageId, reason: 'ink-too-big' })) }) });
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('Text bleibt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => pushes.flat().some((w) => w.ink), SYNC).toBe(true);
    await expect.poll(async () => (await storedPages(page))[0]?.dirty, SYNC).toBe(false);
    const [rowNow] = await storedPages(page);
    expect(rowNow.inkRejected).toBe('ink-too-big');
    expect(rowNow.rejectedReason).toBe('');
    expect((await storedInk(page))[0]?.page.strokes).toHaveLength(1);
    const firstRefused = pushes.flat().findIndex((w) => w.ink);
    expect(pushes.flat().slice(firstRefused + 1).some((w) => !w.ink && w.text === 'Text bleibt')).toBe(true);
    await expect(sheet(page).getByText(/abgelehnt \(ink-too-big\)|refused this page \(ink-too-big\)/)).toBeVisible();
    // Typed on again: the text goes, the refused strokes do not, every time.
    const withInk = pushes.flat().filter((w) => w.ink).length;
    await sideText(page).click();
    await pageBox(page).fill('Text bleibt, und mehr');
    await expect.poll(() => pushes.flat().some((w) => w.text === 'Text bleibt, und mehr'), SYNC).toBe(true);
    expect(pushes.flat().filter((w) => w.ink).length).toBe(withInk);
  });

  test('strokes a new row needs still go when a later request of the same push fails', async ({ page }) => {
    test.setTimeout(60_000);
    const at = suiteNow() - HOUR;
    const lost = 'page-lostrow-002';
    await seed(page, [marked({ pageId: lost, kind: 'ink', points: 3, createdAt: at })], [{ pageId: lost, strokes: [MINE] }]);
    await stubSignedInApp(page);
    // The server lost the row; the first request with strokes in it fails.
    let failed = false;
    const { pushes } = await stubNotebook(page, {
      onPush: (pages) => {
        if (pages.some((p) => p.ink) && !failed) { failed = true; return { status: 503 }; }
        return { newRow: pages.filter((p) => p.pageId === lost && !p.ink).map((p) => p.pageId) };
      },
    });
    await page.goto('/');
    await openPad(page);
    await expect(paper(page)).toBeVisible();
    // Renamed here (metadata only), and a new page drawn on: one push, two requests.
    await sheet(page).getByTestId('pad-title').fill('Umbenannt');
    await sheet(page).getByTestId('pad-new-page').click();
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(() => failed, SYNC).toBe(true);
    await expect.poll(() => pushedFor(pushes, lost).some((w) => w.ink?.strokes.length === 1), { timeout: 40_000 }).toBe(true);
  });

  test('strokes go with a page the server never confirmed, and again when the ack says it had to make the row', async ({ page }) => {
    const at = suiteNow() - HOUR;
    const never = 'page-unsaved-001';
    const lost = 'page-lostrow-001';
    await seed(page, [
      marked({ pageId: never, kind: 'ink', points: 3, savedAt: '', createdAt: at }),
      marked({ pageId: lost, kind: 'ink', points: 3, createdAt: at - 10 * 60_000 }),
    ], [{ pageId: never, strokes: [MINE] }, { pageId: lost, strokes: [MINE] }]);
    await stubSignedInApp(page);
    // The server lost the second page's row: it makes a new one, and says so.
    const { pushes } = await stubNotebook(page, {
      index: [listed({ pageId: lost, kind: 'ink', points: 3, createdAt: at - 10 * 60_000 })],
      onPush: (pages) => ({ newRow: pages.filter((p) => p.pageId === never || (p.pageId === lost && !p.ink)).map((p) => p.pageId) }),
    });
    await page.goto('/');
    await openPad(page);
    const title = sheet(page).getByTestId('pad-title');
    await title.fill('Nie gesichert');
    await expect.poll(() => pushedFor(pushes, never).some((w) => w.title === 'Nie gesichert'), SYNC).toBe(true);
    expect(pushedFor(pushes, never).every((w) => w.ink?.strokes.length === 1), 'a page the server never confirmed goes with its strokes').toBe(true);
    await olderPage(page).click();
    await title.fill('Zeile verloren');
    await expect.poll(() => pushedFor(pushes, lost).some((w) => w.title === 'Zeile verloren' && !w.ink), SYNC).toBe(true);
    await expect.poll(() => pushedFor(pushes, lost).some((w) => w.ink?.strokes.length === 1), { timeout: 15_000 }).toBe(true);
  });
});
