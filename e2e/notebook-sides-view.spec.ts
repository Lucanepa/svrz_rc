import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, RC, suiteNow } from './support/app';

/**
 * Tippen | Handschrift is a VIEW (25.10.2026). Switching changes what the
 * sheet shows and nothing else: no new version, no "Bearbeitet", no push, no
 * fetch of its own. A page's `kind` is the side last WRITTEN — typing makes
 * it 'text', the first stroke 'ink' — which is the side the installed apps
 * 1.3.6 and 1.3.7 show, so they show the side that has something on it. And
 * the round trip between the two sides leaves each as it was: the caret and
 * the scroll of the typed side, the zoom and the place of the handwriting.
 *
 * Every string is matched in both languages — the app follows the browser's
 * locale, and the Playwright projects run under an English one.
 */

const PAD_DB = 'svrz-notebook';
const SYNC = { timeout: 12_000 };

type Stroke = { c: number; w: number; p: number; d: number[] };
type StoredPage = { id: string; pageId: string; kind: string; text: string; points: number; dirty: boolean; updatedAt: number };
type StoredInk = { id: string; page: { strokes: Stroke[] } };
type Wire = { pageId: string; kind: string; text?: string; updatedAt: number; createdAt: number; ink?: { strokes: Stroke[] } };

const STROKE: Stroke = { c: 0, w: 4, p: 0, d: [1000, 1500, 0, 0, 3000, 400, 0, 16, 3000, 400, 0, 16] };
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 60 * 60_000;

function readStore<T>(page: Page, store: 'pages' | 'ink'): Promise<T[]> {
  return page.evaluate(([db, name]) => new Promise<T[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction(name, 'readonly').objectStore(name).getAll(); req.onsuccess = () => { d.close(); resolve(req.result as T[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), [PAD_DB, store] as const);
}
const storedPages = (page: Page) => readStore<StoredPage>(page, 'pages');
const storedInk = (page: Page) => readStore<StoredInk>(page, 'ink');

/** A stored page as this frontend writes it (marked: both sides known). */
function row(over: Record<string, unknown> & { pageId: string; createdAt?: number }): Record<string, unknown> {
  const at = over.createdAt ?? suiteNow() - HOUR;
  return {
    id: `${RC.id}|${over.pageId}`, schema: 1, ownerId: RC.id, kind: 'text', title: '', text: '', bg: '', points: 0, usedIn: [],
    createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: iso(at), rejectedReason: '', sides: 2, ...over,
  };
}
function listed(over: Record<string, unknown> & { pageId: string }): Record<string, unknown> {
  const at = (over.createdAt as number | undefined) ?? suiteNow() - HOUR;
  return { kind: 'text', title: '', text: '', bg: '', points: 0, usedIn: [], createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: iso(at), ...over };
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
async function stubNotebook(page: Page, opts: { index?: Record<string, unknown>[] } = {}) {
  const pushes: Wire[][] = [];
  const inkAsked: string[] = [];
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: opts.index || [] } }));
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Wire[] };
    pushes.push(body.pages);
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: iso(suiteNow()), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  });
  await page.route('**/api/notebook/pages/*', async (r) => {
    const pageId = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() || '');
    inkAsked.push(pageId);
    const found = (opts.index || []).find((p) => p.pageId === pageId);
    if (!found) { await r.fulfill({ status: 404, json: { error: 'Page not found.' } }); return; }
    await r.fulfill({ json: { ownerId: RC.id, page: found } });
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

async function openPad(page: Page): Promise<void> {
  await launcher(page).click();
  await expect(sheet(page)).toBeVisible();
}

async function draw(page: Page): Promise<void> {
  const box = (await paper(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.12, { steps: 12 });
  await page.mouse.up();
}

/** How colourful a CSS colour is, 0 for a grey: oklch's chroma, or the spread
 *  of an rgb triple. Tailwind 4 names its palette in oklch. */
function chroma(css: string): number {
  const ok = /oklch\(\s*[\d.]+%?\s+([\d.]+)/.exec(css);
  if (ok) return Number(ok[1]);
  const rgb = /rgba?\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(css);
  if (rgb) { const v = [rgb[1], rgb[2], rgb[3]].map(Number); return (Math.max(...v) - Math.min(...v)) / 255; }
  return 1;
}

test.describe('The switch is a view', () => {
  test('switching sides only changes what is on screen: nothing is saved or pushed, and the page is not "Bearbeitet"', async ({ page }) => {
    const at = suiteNow() - 2 * HOUR;
    const id = 'page-view-0001';
    await seed(page, [row({ pageId: id, kind: 'text', text: 'getippt', createdAt: at })]);
    await stubSignedInApp(page);
    const { pushes } = await stubNotebook(page, { index: [listed({ pageId: id, kind: 'text', text: 'getippt', createdAt: at })] });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('getippt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sideText(page).click();
    await expect(pageBox(page)).toHaveText('getippt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await expect(sheet(page).getByText(/^(Bearbeitet|Edited) \d/)).toHaveCount(0);
    // Closing the sheet sends whatever waits at once: nothing does.
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(pushes).toEqual([]);
    expect((await storedPages(page))[0]).toMatchObject({ kind: 'text', updatedAt: at, dirty: false });
  });

  test('a page\'s kind is the side last written on it, and it reopens there whatever side was on screen', async ({ page }) => {
    await stubSignedInApp(page);
    await stubNotebook(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('erst getippt');
    await expect.poll(async () => (await storedPages(page))[0]?.kind, SYNC).toBe('text');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await draw(page);
    await expect.poll(async () => (await storedPages(page))[0]?.kind, SYNC).toBe('ink');
    await sideText(page).click();
    await pageBox(page).fill('erst getippt, dann wieder');
    await expect.poll(async () => (await storedPages(page))[0]?.kind, SYNC).toBe('text');
    // On screen, not written on: the page keeps its kind ...
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await openPad(page);
    // ... and reopens on it.
    await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(pageBox(page)).toHaveText('erst getippt, dann wieder');
    expect((await storedPages(page))[0].kind).toBe('text');
  });

  test('a side written empty stays on screen while the page becomes the other side\'s', async ({ page }) => {
    // Every letter deleted, or the last stroke undone: the page's kind goes to
    // the side that still holds something, and the side on screen stays — the
    // editor was swapped for the pen page under the coach's fingers (review,
    // 25.10.2026).
    const at = suiteNow() - HOUR;
    await seed(page, [
      row({ pageId: 'page-empty-0101', kind: 'text', text: 'weg damit', points: 3, createdAt: at }),
      row({ pageId: 'page-empty-0102', kind: 'ink', text: 'bleibt getippt', points: 3, createdAt: at - 10 * 60_000 }),
    ], [{ pageId: 'page-empty-0101', strokes: [STROKE] }, { pageId: 'page-empty-0102', strokes: [STROKE] }]);
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('weg damit');
    await pageBox(page).fill('');
    await expect.poll(async () => (await storedPages(page)).find((r) => r.pageId === 'page-empty-0101')?.kind, SYNC).toBe('ink');
    await expect(pageBox(page)).toBeVisible();
    await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
    await sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ }).click();
    await expect(paper(page)).toBeVisible();
    const undo = sheet(page).getByRole('button', { name: /^(Rückgängig|Undo)$/ });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(async () => (await storedPages(page)).find((r) => r.pageId === 'page-empty-0102')?.kind, SYNC).toBe('text');
    await expect(paper(page)).toBeVisible();
    await expect(sideInk(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('Handschrift on a synced page that was only ever typed asks the server for nothing, and takes a stroke at once', async ({ page }) => {
    const at = suiteNow() - HOUR;
    await stubSignedInApp(page);
    const { inkAsked } = await stubNotebook(page, { index: [listed({ pageId: 'page-typed-0001', kind: 'text', text: 'nur getippt', createdAt: at })] });
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('nur getippt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await expect(sheet(page).getByText(/Handschrift wird geladen|Loading the handwriting/)).toHaveCount(0);
    await draw(page);
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
    expect(inkAsked).toEqual([]);
  });
});

test.describe('A round trip between the sides', () => {
  test('back from Handschrift, typing goes on where the caret was', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).click();
    await page.keyboard.type('Hallo Welt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sideText(page).click();
    await page.keyboard.type('!');
    await expect(pageBox(page)).toHaveText('Hallo Welt!');
    // Mid-line too: the caret comes back where it was left.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sideText(page).click();
    await page.keyboard.type(',');
    await expect(pageBox(page)).toHaveText('Hallo, Welt!');
  });

  test('back from Handschrift, a long page is where it was scrolled to', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill(Array.from({ length: 80 }, (_, i) => `Zeile ${i + 1}`).join('\n'));
    const scroller = () => pageBox(page).locator('xpath=..');
    expect(await scroller().evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
    await scroller().evaluate((el) => { el.scrollTop = 240; });
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sideText(page).click();
    await expect(pageBox(page)).toBeVisible();
    await expect.poll(() => scroller().evaluate((el) => Math.round(el.scrollTop))).toBeGreaterThan(230);
    expect(await scroller().evaluate((el) => Math.round(el.scrollTop))).toBeLessThan(250);
  });

  test('back from Tippen, the pen page is where it was: its zoom and its place; a new page still opens at its top', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: /^(Vergrössern|Zoom in)$/ }).click();
    await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
    // Down and to the right, by the wheel: a page bigger than the stage moves.
    const s = (await stage(page).boundingBox())!;
    await stage(page).evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 300, bubbles: true, cancelable: true })); });
    await expect.poll(async () => (await paper(page).boundingBox())!.y).toBeLessThan(s.y - 100);
    const before = (await paper(page).boundingBox())!;
    expect(before.x).toBeLessThan(s.x - 20);
    await sideText(page).click();
    await expect(pageBox(page)).toBeVisible();
    await sideInk(page).click();
    await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
    await expect.poll(async () => { const b = (await paper(page).boundingBox())!; return Math.max(Math.abs(b.x - before.x), Math.abs(b.y - before.y)); }).toBeLessThan(2);
    await newPage(page).click();
    await expect(paper(page)).toBeVisible();
    await expect.poll(async () => (await paper(page).boundingBox())!.y).toBeGreaterThan(s.y - 1);
  });

  test('a switch by keyboard while a stroke is on the page keeps the stroke', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    await sideText(page).focus();
    const box = (await paper(page).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.14, { steps: 10 });
    await page.keyboard.press('Enter');
    await expect(pageBox(page)).toBeVisible();
    await page.mouse.up();
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
  });
});

test.describe('The switch and the line it sits on', () => {
  test('the side switch and Neue Seite are big enough for a finger', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    for (const el of [sideText(page), sideInk(page), newPage(page)]) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  });

  test('the pressed side shows its focus ring when reached by keyboard', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    // By the keyboard: from Neue Seite, the switch is the next stop.
    await expect(newPage(page)).toBeEnabled();
    await newPage(page).focus();
    await page.keyboard.press('Tab');
    await expect(sideText(page)).toBeFocused();
    await expect(sideText(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await sideText(page).evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
  });

  test('the dot on the other side is a neutral one, and the side says in words that it holds something', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('getippt');
    await sideInk(page).click();
    await expect(paper(page)).toBeVisible();
    const dot = sideText(page).getByTestId('pad-side-dot');
    await expect(dot).toHaveCount(1);
    expect(chroma(await dot.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeLessThan(0.06);
    await expect(sideText(page)).toHaveAccessibleName(/^(Tippen — hat Inhalt|Typing — has content)$/);
    await expect(sideInk(page)).toHaveAccessibleName(/^(Handschrift|Handwriting)$/);
  });

  test.describe('in German, its longest', () => {
    test.use({ locale: 'de-CH' });
    for (const vp of [{ width: 390, height: 844 }, { width: 744, height: 1133 }]) {
      test(`at ${vp.width} px the dates stay on one line each beside "übernommen →", and the turner stays on the row`, async ({ page }) => {
        await page.setViewportSize(vp);
        const at = suiteNow() - 3 * HOUR;
        await seed(page, [row({
          pageId: 'page-used-0001', text: 'übernommen', createdAt: at, updatedAt: suiteNow() - HOUR,
          usedIn: [{ f: 'bemerkungen', r: '1. SR', g: 'game-1', label: 'Volley Smash Wiedikon 3 vs TV Unterstrass Herren 2', t: suiteNow() - HOUR }],
        })]);
        await stubSignedInApp(page);
        await page.goto('/');
        await openPad(page);
        await expect(pageBox(page)).toHaveText('übernommen');
        for (const el of [sheet(page).getByText(/^Erstellt /), sheet(page).getByText(/^Wird am .* gelöscht$/)]) {
          const b = (await el.boundingBox())!;
          expect(b.height, `"${await el.textContent()}" on one line`).toBeLessThanOrEqual(18);
        }
        await expect(sheet(page).getByText(/übernommen →/)).toBeVisible();
        const sw = (await sideInk(page).boundingBox())!;
        const turner = (await sheet(page).getByRole('button', { name: /^Ältere Seite$/ }).boundingBox())!;
        expect(Math.abs((sw.y + sw.height / 2) - (turner.y + turner.height / 2))).toBeLessThan(8);
        expect(turner.x + turner.width).toBeLessThanOrEqual(vp.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      });
    }
  });
});

test.describe('What the page and the dialogs say', () => {
  test('one line break after the text does not bring the placeholder back; an empty page and an empty form field still show it', async ({ page }) => {
    await seed(page, [row({ pageId: 'page-br-0001', text: 'Hallo\n' })]);
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
    const before = (el: ReturnType<Page['locator']>) => el.evaluate((n) => getComputedStyle(n, '::before').content);
    const remarks = page.locator('.rich-surface:not(.notebook-surface)').first();
    expect(await before(remarks)).not.toBe('none');
    await remarks.click();
    await page.keyboard.type('x');
    await expect.poll(() => before(remarks)).toBe('none');
    await openPad(page);
    await expect(pageBox(page)).toContainText('Hallo');
    expect(await before(pageBox(page))).not.toMatch(/Schreib|Write/);
    await newPage(page).click();
    await expect(pageBox(page)).toHaveText('');
    expect(await before(pageBox(page))).toMatch(/Schreib hier|Write here/);
  });

  test('Handschrift leeren says the typed text stays only where there is some', async ({ page }) => {
    const at = suiteNow() - HOUR;
    await seed(page, [
      row({ pageId: 'page-inkonly-001', kind: 'ink', points: 12, createdAt: at }),
      row({ pageId: 'page-inktext-001', kind: 'ink', text: 'bleibt', points: 12, createdAt: at - 10 * 60_000 }),
    ], [{ pageId: 'page-inkonly-001', strokes: [STROKE, STROKE, STROKE, STROKE] }, { pageId: 'page-inktext-001', strokes: [STROKE, STROKE, STROKE, STROKE] }]);
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await expect(paper(page)).toBeVisible();
    const clear = sheet(page).getByRole('button', { name: /^(Handschrift leeren|Clear handwriting)$/ });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByTestId('confirm-message')).toHaveText(/^(Alle Striche auf dieser Seite werden gelöscht\.|Every stroke on this page is removed\.)$/);
    await page.getByTestId('confirm-cancel').click();
    await sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ }).click();
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByTestId('confirm-message')).toHaveText(/getippte Text bleibt|typed text stays/);
    await page.getByTestId('confirm-cancel').click();
  });
});
