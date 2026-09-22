import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * Naming a page, and coming back to the one you were on.
 *
 * The strip labelled every page with the time it was started, which is no help
 * at all on the third page of one evening. A page can be named now; the name
 * stands on its pill, with the time beside it. And closing the sheet — to look
 * something up mid-observation — is not leaving the page: it reopens where it
 * was left, not on the newest page.
 */

// Must equal src/lib/notebook.ts literally, as in e2e/notebook.spec.ts.
const PAD_DB = 'svrz-notebook';
const PAGES = 'pages';
const INK = 'ink';

type Seed = Record<string, unknown>;

function padPage(over: Seed & { pageId: string; createdAt: number }): Seed {
  const ownerId = RC.id;
  return {
    id: `${ownerId}|${over.pageId}`, schema: 1, ownerId, kind: 'text', text: 'seeded page', title: '', bg: '',
    points: 0, usedIn: [], updatedAt: over.createdAt, deleted: false, dirty: false,
    savedAt: new Date(over.createdAt).toISOString(), rejectedReason: '', ...over,
  };
}

async function seedPad(page: Page, rows: Seed[]): Promise<void> {
  await page.addInitScript(([db, pages, ink, rows]) => {
    const open = indexedDB.open(db as string, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(pages as string)) open.result.createObjectStore(pages as string, { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains(ink as string)) open.result.createObjectStore(ink as string, { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const d = open.result;
      const tx = d.transaction(pages as string, 'readwrite');
      for (const r of rows as Record<string, unknown>[]) tx.objectStore(pages as string).put(r);
      tx.oncomplete = () => d.close();
    };
  }, [PAD_DB, PAGES, INK, rows] as const);
}

function storedPages(page: Page): Promise<{ pageId: string; title: string }[]> {
  return page.evaluate(([db, store]) => new Promise<{ pageId: string; title: string }[]>((resolve, reject) => {
    const open = indexedDB.open(db as string, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction(store as string, 'readonly').objectStore(store as string).getAll();
      all.onsuccess = () => { resolve(all.result as { pageId: string; title: string }[]); open.result.close(); };
      all.onerror = () => reject(all.error);
    };
  }), [PAD_DB, PAGES] as const);
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageBox = (page: Page) => sheet(page).locator('.rich-surface');
const titleBox = (page: Page) => sheet(page).getByTestId('pad-title');
const closeSheet = (page: Page) => sheet(page).getByRole('button', { name: /^(Schliessen|Close)$/ }).click();

const NEWER = padPage({ pageId: 'p-newer', text: 'newer page', createdAt: Date.now() - 60 * 60 * 1000 });
const OLDER = padPage({ pageId: 'p-older', text: 'older page', createdAt: Date.now() - 3 * 60 * 60 * 1000 });

test('a page can be named, and its name stands on its pill with the time beside it', async ({ page }) => {
  await stubSignedInApp(page);
  await seedPad(page, [OLDER, NEWER]);
  await page.goto('/');
  await launcher(page).click();

  await expect(pageBox(page)).toHaveText('newer page');
  await titleBox(page).fill('Halbzeit Rämi');

  // The pill carries the name AND the time: two pages of one evening are still
  // told apart by the clock.
  const pill = sheet(page).locator('button[aria-current="page"]');
  await expect(pill).toContainText('Halbzeit Rämi');
  await expect(pill).toContainText(/\d{1,2}[:.]\d{2}/);

  // It is the page that was named, not the sheet: the other page keeps its own.
  await expect(sheet(page).locator('button', { hasText: 'Halbzeit Rämi' })).toHaveCount(1);

  // And it is written to the device with the page, which is what carries it to
  // the server and back. (Not asserted through a reload: the seed above is an
  // addInitScript and would put the unnamed page back over the named one.)
  await expect.poll(async () => (await storedPages(page)).find((r) => r.pageId === 'p-newer')?.title)
    .toBe('Halbzeit Rämi');
});

test("a page with no title of its own never wears the last page's", async ({ page }) => {
  // The older row carries no `title` KEY at all — which is every page already
  // on a coach's device, written before the field existed. Handed to a
  // controlled input as `undefined`, React lets go of it, and the field goes
  // on showing whatever the page before it was called.
  const untitled: Seed = padPage({ pageId: 'p-untitled', text: 'untitled page', createdAt: Date.now() - 2 * 60 * 60 * 1000 });
  delete untitled.title;
  const titled = padPage({ pageId: 'p-titled', text: 'titled page', createdAt: Date.now() - 60 * 60 * 1000, title: 'Urs 2SR' });

  await stubSignedInApp(page);
  await seedPad(page, [untitled, titled]);
  await page.goto('/');
  await launcher(page).click();

  await expect(titleBox(page)).toHaveValue('Urs 2SR');
  await sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ }).click();
  await expect(pageBox(page)).toHaveText('untitled page');
  await expect(titleBox(page)).toHaveValue('');

  await sheet(page).getByRole('button', { name: /^(Neuere Seite|Newer page)$/ }).click();
  await expect(titleBox(page)).toHaveValue('Urs 2SR');

  // A page not yet written is nameless too, however it was reached.
  await sheet(page).getByRole('button', { name: /^(Text)$/ }).click();
  await expect(titleBox(page)).toHaveValue('');
});

test('the sheet reopens on the page it was closed on, not on the newest', async ({ page }) => {
  await stubSignedInApp(page);
  await seedPad(page, [OLDER, NEWER]);
  await page.goto('/');
  await launcher(page).click();

  await expect(pageBox(page)).toHaveText('newer page');
  await sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ }).click();
  await expect(pageBox(page)).toHaveText('older page');

  await closeSheet(page);
  await launcher(page).click();
  await expect(pageBox(page)).toHaveText('older page');

  // Even across a reload — the sheet is closed and gone, and the choice is not.
  await page.reload();
  await launcher(page).click();
  await expect(pageBox(page)).toHaveText('older page');
});
