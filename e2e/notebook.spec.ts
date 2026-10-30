import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, RC, GAME, suiteNow } from './support/app';
import { lineHash, linesOf } from '../src/lib/notebookTimes';
import { clockLabel } from '../src/lib/appTime';

/**
 * The Notizblock: pages a coach writes anywhere in the app, kept on the device
 * (IndexedDB `svrz-notebook`), mirrored to the server, deleted a week after
 * they were written, and lifted into the form only on purpose.
 *
 * What this spec pins: the page survives a reload; only its owner sees it; a
 * week is a week; the launcher is on every screen; Escape peels the sheet and
 * nothing else; fullscreen fills the viewport and is remembered; the import
 * writes verbatim into the field of the half on screen and says it is mailed.
 *
 * Every string is matched in both languages — the app follows the browser's
 * locale, and the Playwright projects run under an English one.
 */

// Must equal src/lib/notebook.ts literally, or the seed writes a database the
// app never opens and the test passes for the wrong reason.
const PAD_DB = 'svrz-notebook';
const PAGES = 'pages';
const INK = 'ink';
const DAY = 24 * 60 * 60 * 1000;

type StoredPage = {
  id: string; schema: number; ownerId: string; pageId: string; kind: string; text: string; bg: string; points: number;
  usedIn: { f: string; r: string; g: string; label: string; t: number }[];
  createdAt: number; updatedAt: number; deleted: boolean; dirty: boolean; savedAt: string; rejectedReason: string;
  extra?: Record<string, unknown>;
};

function padPage(over: Partial<StoredPage> & { createdAt?: number } = {}): StoredPage {
  const ownerId = over.ownerId || RC.id;
  const pageId = over.pageId || 'page-seeded-0001';
  const at = over.createdAt ?? suiteNow() - 60_000;
  return {
    id: `${ownerId}|${pageId}`, schema: 1, ownerId, pageId, kind: 'text', text: 'seeded page', bg: '', points: 0, usedIn: [],
    createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: new Date(at).toISOString(), rejectedReason: '',
    ...over,
  };
}

/** Seeds go in BEFORE goto: the app's boot read happens once. Both stores are
 *  created even when only pages are seeded — a one-store database would flip
 *  the app into server-only mode and the test would pass for the wrong reason. */
async function seedPad(page: Page, rows: StoredPage[]): Promise<void> {
  await page.addInitScript(([db, pages, ink, rows]) => {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(pages)) open.result.createObjectStore(pages, { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains(ink)) open.result.createObjectStore(ink, { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const d = open.result;
      const tx = d.transaction(pages, 'readwrite');
      for (const r of rows) tx.objectStore(pages).put(r);
      tx.oncomplete = () => d.close();
    };
  }, [PAD_DB, PAGES, INK, rows] as const);
}

function storedPages(page: Page): Promise<StoredPage[]> {
  return page.evaluate(([db, store]) => new Promise<StoredPage[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(store)) { d.close(); resolve([]); return; }
      const req = d.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => { d.close(); resolve(req.result as StoredPage[]); };
      req.onerror = () => { d.close(); reject(req.error); };
    };
  }), [PAD_DB, PAGES] as const);
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
/** The page is the app's rich editor (a contenteditable): fill() and toHaveText(), never toHaveValue(). */
const pageBox = (page: Page) => sheet(page).locator('.rich-surface');
/** Anchored, and scoped to the sheet: the form's own strip says "gespeichert" too. */
const padSaved = (page: Page) => sheet(page).getByText(/^(Gespeichert|Saved)/);

async function openPad(page: Page): Promise<void> {
  await launcher(page).click();
  await expect(sheet(page)).toBeVisible();
}

/** A new page, on its typed side: one button makes a page, the switch on it
 *  says which side is on screen. */
async function newTypedPage(page: Page): Promise<void> {
  await sheet(page).getByTestId('pad-new-page').click();
  await sheet(page).getByTestId('pad-side-text').click();
  await expect(sheet(page).getByTestId('pad-side-text')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('The device keeps the page', () => {
  test('a reload gives the typed page back, under the derived key', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('19:41 2. SR steht zu weit links');
    await expect(padSaved(page)).toBeVisible();
    const rows = await storedPages(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`${RC.id}|${rows[0].pageId}`);
    expect(rows[0].text).toBe('19:41 2. SR steht zu weit links');
    // The catch-all answers `[]` to the PUT, which is not an ack.
    expect(rows[0].dirty).toBe(true);
    await page.reload();
    await openPad(page);
    await expect(pageBox(page)).toHaveText('19:41 2. SR steht zu weit links');
  });

  test("another coach's pages on this device are not this coach's to see", async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ ownerId: 'rc-someone-else', text: 'not yours' })]);
    await page.goto('/');
    await openPad(page);
    await expect(sheet(page).getByText('not yours')).toHaveCount(0);
    await expect(pageBox(page)).toHaveText('');
  });

  test('the empty notebook writes no row until the first keystroke', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    expect(await storedPages(page)).toHaveLength(0);
    await openPad(page);
    await pageBox(page).fill('x');
    await expect(padSaved(page)).toBeVisible();
    expect(await storedPages(page)).toHaveLength(1);
  });

  test('a schema-newer page is left alone', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ schema: 2, text: 'from the future' })]);
    await page.goto('/');
    await openPad(page);
    await expect(sheet(page).getByText('from the future')).toHaveCount(0);
    await pageBox(page).fill('today');
    await expect(padSaved(page)).toBeVisible();
    const rows = await storedPages(page);
    expect(rows.find((r) => r.schema === 2)?.text).toBe('from the future');
  });

  test('deleting a page tombstones it, and the tombstone survives a reload', async ({ page }) => {
    // Typed, not seeded: an addInitScript seed is re-applied on every
    // navigation and would put the live page back over its own tombstone.
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('gone soon');
    await expect(padSaved(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: /^(Seite löschen|Delete page)$/ }).click();
    await page.getByTestId('confirm-accept').click();
    await expect.poll(async () => (await storedPages(page))[0]?.deleted).toBe(true);
    const row = (await storedPages(page))[0];
    expect(row.dirty).toBe(true);
    expect(row.text).toBe('');
    await page.reload();
    await openPad(page);
    await expect(sheet(page).getByText('gone soon')).toHaveCount(0);
    expect((await storedPages(page))[0]?.deleted).toBe(true);
  });

  test('pages are turned with the arrows and the pills, newest first', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [
      padPage({ pageId: 'p-older', text: 'older page', createdAt: suiteNow() - 3 * 60 * 60 * 1000 }),
      padPage({ pageId: 'p-newer', text: 'newer page', createdAt: suiteNow() - 60 * 60 * 1000 }),
    ]);
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('newer page');
    await expect(sheet(page).getByText(/^(Seite 1 von 2|Page 1 of 2)$/)).toBeVisible();
    await sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ }).click();
    await expect(pageBox(page)).toHaveText('older page');
    await expect(sheet(page).getByText(/^(Seite 2 von 2|Page 2 of 2)$/)).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: /^(Ältere Seite|Older page)$/ })).toBeDisabled();
    await sheet(page).getByRole('button', { name: /^(Neuere Seite|Newer page)$/ }).click();
    await expect(pageBox(page)).toHaveText('newer page');
    // The pills do the same; the current one is marked.
    await sheet(page).locator('button[aria-current="page"]').click();
    await expect(pageBox(page)).toHaveText('newer page');
    // A fresh page sits in front of the others and takes the count with it.
    await newTypedPage(page);
    await pageBox(page).fill('third');
    await expect(padSaved(page)).toBeVisible();
    await expect(sheet(page).getByText(/^(Seite 1 von 3|Page 1 of 3)$/)).toBeVisible();
  });

  test('Zeit inserts the clock at the caret', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await sheet(page).getByRole('button', { name: /^(Zeit|Time)$/ }).click();
    await expect(pageBox(page)).toHaveText(/^\d\d:\d\d\s*$/);
  });

  test('Zeit in the toolbar keeps the caret: the stamp goes on the line being typed', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).click();
    await page.keyboard.type('Netz ');
    // A button that took the focus would append on a new line instead.
    await sheet(page).getByRole('button', { name: /^(Zeit|Time)$/ }).click();
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText))
      .toMatch(/^Netz \d\d:\d\d\s*$/);
  });
});

test.describe('A week is a week', () => {
  test('an expired page is hidden and purged; one written six days ago is not', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [
      padPage({ pageId: 'page-old', text: 'eight days old', createdAt: suiteNow() - 8 * DAY }),
      padPage({ pageId: 'page-fresh', text: 'six days old', createdAt: suiteNow() - 6 * DAY }),
      // Dirty and past its week: the week is the promise, the server would
      // refuse the row by its own clock anyway.
      padPage({ pageId: 'page-old-dirty', text: 'never synced', createdAt: suiteNow() - 9 * DAY, dirty: true, savedAt: '' }),
    ]);
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toHaveText('six days old');
    await expect(sheet(page).locator('span', { hasText: /^(Wird (am .+|morgen) gelöscht|Will be deleted (on .+|tomorrow))$/ })).toBeVisible();
    await expect(sheet(page).getByText('eight days old')).toHaveCount(0);
    await expect.poll(async () => (await storedPages(page)).map((r) => r.pageId).sort()).toEqual(['page-fresh']);
  });

  test('a page within a day of its end says so', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ createdAt: suiteNow() - 6.5 * DAY })]);
    await page.goto('/');
    await openPad(page);
    await expect(sheet(page).getByText(/Wird morgen gelöscht|Will be deleted tomorrow/)).toBeVisible();
  });
});

test.describe('From anywhere', () => {
  test('the launcher is on every screen, exactly once', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await expect(launcher(page)).toHaveCount(1);
    await page.getByRole('button', { name: /^(Coachees)$/ }).click();
    await expect(launcher(page)).toHaveCount(1);
    await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
    await expect(launcher(page)).toHaveCount(1);
    await openFeedbackForm(page);
    await expect(launcher(page)).toHaveCount(1);
  });

  test('the demo has no notebook', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByText(/DEMO/).first()).toBeVisible();
    await expect(launcher(page)).toHaveCount(0);
  });

  test('Escape closes the sheet, not the form; Back closes it too', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
    // The form's address names the game by its match number; the sheet on
    // top of it must not touch that.
    await expect(page).toHaveURL(new RegExp(`/form/${GAME.matchNo}/1sr$`));
    await openPad(page);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/form/${GAME.matchNo}/1sr$`));
    await openPad(page);
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('phone: the sheet fits and the page is reachable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await expect(pageBox(page)).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(wide).toBe(true);
  });

  test('page text never reaches the click log', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ text: 'private words about a referee' })]);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).click();
    const logged = await page.evaluate(() => {
      const w = window as unknown as { svrzLogs?: () => { evt: string; data?: Record<string, unknown> }[] };
      return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.evt === 'ui.click').map((e) => JSON.stringify(e.data || {}));
    });
    expect(logged.join('\n')).not.toContain('private words');
  });
});

test.describe('Fullscreen', () => {
  test('fills the viewport, is remembered, and Escape still closes the sheet only', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await sheet(page).getByRole('button', { name: /^(Vollbild|Fullscreen)$/ }).click();
    await expect(sheet(page)).toHaveAttribute('data-full', 'true');
    const box = (await sheet(page).boundingBox())!;
    const vp = page.viewportSize()!;
    expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - vp.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - vp.height)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => localStorage.getItem('svrz_pad_full'))).toBe('1');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await openPad(page);
    await expect(sheet(page)).toHaveAttribute('data-full', 'true');
    await sheet(page).getByRole('button', { name: /^(Vollbild verlassen|Exit fullscreen)$/ }).click();
    await expect(sheet(page)).toHaveAttribute('data-full', 'false');
    expect(await page.evaluate(() => localStorage.getItem('svrz_pad_full'))).toBe('0');
  });
});

test.describe('Into the form', () => {
  const tipsBox = (page: Page) => page.locator('textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]');
  /** The form's Bemerkungen editor — the first rich surface that is not the notebook's own. */
  const remarks = (page: Page) => page.locator('.rich-surface:not(.notebook-surface)').first();

  test('the current page is inserted verbatim into Bemerkungen, marked used, and the sentence says it is mailed', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ text: 'Pfiff klar, Handzeichen sauber\nAufschlag zu früh gepfiffen' })]);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
    await expect(sheet(page).getByText(/Teil des Feedbacks|part of the feedback/)).toBeVisible();
    await sheet(page).getByRole('button', { name: /1 Seite → Bemerkungen \(1\. SR\)|1 page → Remarks \(1\. SR\)/ }).click();
    await expect(page.getByText(/übernommen|inserted/).first()).toBeVisible();
    // The rich fields are contenteditable: ask for the text, not a value.
    await expect(remarks(page)).toContainText('Pfiff klar, Handzeichen sauber');
    await expect(remarks(page)).toContainText('Aufschlag zu früh gepfiffen');
    await expect(remarks(page).locator('b')).toHaveCount(0);
    await expect.poll(async () => (await storedPages(page))[0]?.usedIn?.[0]?.f).toBe('bemerkungen');
    expect((await storedPages(page))[0].usedIn[0].r).toBe('1. SR');
    expect((await storedPages(page))[0].usedIn[0].g).toBe(GAME.id);
    // The mark's label names the game the way the coach does — by the match
    // number, with the teams beside it — while `g` stays the record id the
    // sheet matches "used here" on. And that label is what the page's own
    // line reads back once the sheet is reopened.
    expect((await storedPages(page))[0].usedIn[0].label).toBe(`#${GAME.matchNo} · ${GAME.homeTeam} vs ${GAME.awayTeam}`);
    await expect(sheet(page).getByText(new RegExp(`(übernommen|inserted) → (Bemerkungen|Remarks) \\(1\\. SR\\) · #${GAME.matchNo} · ${GAME.homeTeam}`))).toBeVisible();
    // The notebook itself is untouched — it is a copy, not a move.
    await expect(pageBox(page)).toHaveText(/Pfiff klar, Handzeichen sauber\s*Aufschlag zu früh gepfiffen/);
  });

  test('insert into Tipps & Tricks, and the warning swaps', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ text: 'seeded page' })]);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
    await sheet(page).getByRole('button', { name: /Tipps & Tricks|Tips & Tricks/ }).click();
    await expect(sheet(page).getByText(/nur per E-Mail|by e-mail only/)).toBeVisible();
    await sheet(page).getByRole('button', { name: /1 Seite →|1 page →/ }).click();
    await expect(tipsBox(page)).toHaveValue(/seeded page/);
  });

  test('formatting made in the notebook survives the insert; a typed "<b>" stays text', async ({ page }) => {
    await stubSignedInApp(page);
    // What the editor stores: real bold from the toolbar, and the escaped
    // characters a coach gets when they TYPE an angle bracket.
    await seedPad(page, [padPage({ text: '<b>fett</b> und a &lt;b&gt;b&lt;/b&gt; &amp; c' })]);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await expect(pageBox(page).locator('b')).toHaveText('fett');
    await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
    await sheet(page).getByRole('button', { name: /1 Seite →|1 page →/ }).click();
    await expect(remarks(page)).toContainText('fett und a <b>b</b> & c');
    await expect(remarks(page).locator('b')).toHaveCount(1);
    await expect(remarks(page).locator('b')).toHaveText('fett');
  });

  test('bold, a bullet and a numbered line from the toolbar land in the page', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('erster Satz');
    await pageBox(page).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); });
    await sheet(page).getByRole('button', { name: /^(Fett|Bold)$/ }).click();
    await expect(pageBox(page).locator('b')).toHaveText('erster Satz');
    // Caret at the end, nothing selected: the list buttons add a new line
    // (a selection would turn the selected lines into items instead).
    await pageBox(page).press('Control+End');
    await sheet(page).getByRole('button', { name: /Aufzählung|Bullet/ }).click();
    await expect(pageBox(page)).toHaveText(/erster Satz\s*•\s?$/);
    await sheet(page).getByRole('button', { name: /Nummerierung|Numbered/ }).click();
    await expect(pageBox(page)).toHaveText(/1\. ?$/);
    await sheet(page).getByRole('button', { name: /Nummerierung|Numbered/ }).click();
    await expect(pageBox(page)).toHaveText(/2\. ?$/);
    await expect(padSaved(page)).toBeVisible();
    expect((await storedPages(page))[0].text).toMatch(/<b>erster Satz<\/b>/);
  });

  test('selected lines become a numbered list, or a checklist, in the page', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('Netz messen');
    await pageBox(page).press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Antennen');
    await pageBox(page).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await sheet(page).getByRole('button', { name: /^1\. (Nummerierung|Numbered)$/ }).click();
    await expect(pageBox(page)).toHaveText(/^1\. Netz messen\s*2\. Antennen$/);
    // Another kind swaps the marks rather than stacking them.
    await sheet(page).getByRole('button', { name: /Checkliste|Checklist/ }).click();
    await expect(pageBox(page)).toHaveText(/^☐ Netz messen\s*☐ Antennen$/);
    await expect.poll(async () => (await storedPages(page))[0]?.text).toMatch(/^☐ Netz messen\n☐ Antennen$/);
  });

  test('a checklist line, ticked and unticked by tapping its box', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('Vor dem Spiel');
    await sheet(page).getByRole('button', { name: /Checkliste|Checklist/ }).click();
    await expect(pageBox(page)).toHaveText(/Vor dem Spiel\s*☐\s?$/);
    await pageBox(page).press('Control+End');
    await page.keyboard.type('Netz messen');
    await expect(pageBox(page)).toHaveText(/☐ Netz messen$/);

    const box = () => pageBox(page).evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = (n.textContent || '').search(/[☐☑]/);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    });

    // A tap on the words is a tap into the text, not a tick.
    await pageBox(page).getByText(/Netz messen/).click();
    await expect(pageBox(page)).toHaveText(/☐ Netz messen$/);

    const at = await box();
    expect(at).not.toBeNull();
    await page.mouse.click(at!.x, at!.y);
    await expect(pageBox(page)).toHaveText(/☑ Netz messen$/);
    await expect.poll(async () => (await storedPages(page))[0]?.text).toMatch(/☑ Netz messen/);

    await page.mouse.click(at!.x, at!.y);
    await expect(pageBox(page)).toHaveText(/☐ Netz messen$/);
    await expect.poll(async () => (await storedPages(page))[0]?.text).toMatch(/☐ Netz messen/);
  });

  test('Enter carries a list on, and Enter on an empty item ends it', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('Vor dem Spiel');
    await sheet(page).getByRole('button', { name: /Checkliste|Checklist/ }).click();
    await pageBox(page).press('Control+End');
    await page.keyboard.type('Netz messen');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Antennen');
    await expect(pageBox(page)).toHaveText(/☐ Netz messen\s*☐ Antennen$/);

    // An item left empty: Enter takes its box back off instead of adding one.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Notizen');
    await expect(pageBox(page)).toHaveText(/☐ Antennen\s*Notizen$/);
    await expect(pageBox(page)).not.toHaveText(/☐\s*Notizen/);

    // Numbers count on, bullets stay bullets.
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. erstens');
    await page.keyboard.press('Enter');
    await page.keyboard.type('zweitens');
    await expect(pageBox(page)).toHaveText(/1\. erstens\s*2\. zweitens$/);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('• a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await expect(pageBox(page)).toHaveText(/• a\s*• b$/);

    await expect.poll(async () => (await storedPages(page))[0]?.text).toMatch(/• a\n• b$/);
  });

  // WebKit fires `beforeinput` for execCommand too, so the newline the list
  // handler inserted came back to it as another Enter: one Enter on an iPad
  // wrote hundreds of bullets and overflowed the stack (30.10.2026). Chromium
  // does not, so CI never saw it; this makes Chromium do what WebKit does.
  test('an Enter on a list line adds one marker where execCommand fires beforeinput (WebKit)', async ({ page }) => {
    await page.addInitScript(() => {
      const original = document.execCommand.bind(document);
      let depth = 0;
      document.execCommand = (command: string, ui?: boolean, value?: string) => {
        if (command === 'insertText' && value?.includes('\n') && depth < 40) {
          depth += 1;
          try {
            document.activeElement?.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
          } finally { depth -= 1; }
        }
        return original(command, ui, value);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('• a');
    await pageBox(page).press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await expect(pageBox(page)).toHaveText(/^• a\s*• b$/);

    // A heading written on a list line is a heading, not the next item.
    await sheet(page).getByTestId('pad-section').click();
    await sheet(page).getByRole('button', { name: /^(Vorspiel|Pre-game)$/ }).click();
    await expect(pageBox(page)).toHaveText(/^• a\s*• b\s*— (Vorspiel|Pre-game) —$/);
    await expect.poll(async () => (await storedPages(page))[0]?.text).toMatch(/^• a\n• b\n— (Vorspiel|Pre-game) —\n?$/);
    expect(errors).toEqual([]);
  });

  test('the phases of a match are headings a thumb can write', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await pageBox(page).fill('Aufwärmen gesehen');

    // Nine phases behind one button: the formatting row is a row, and a
    // wrapped row is height this sheet does not have.
    await sheet(page).getByTestId('pad-section').click();
    await sheet(page).getByRole('button', { name: /^(Vorspiel|Pre-game)$/ }).click();
    await expect(pageBox(page)).toHaveText(/— (Vorspiel|Pre-game) —/);
    // Chosen, so the menu is done.
    await expect(sheet(page).getByRole('button', { name: /^(Satz 1|Set 1)$/ })).toHaveCount(0);

    await sheet(page).getByTestId('pad-section').click();
    await sheet(page).getByRole('button', { name: /^(Satz 3|Set 3)$/ }).click();
    await expect(pageBox(page)).toHaveText(/— (Satz 3|Set 3) —/);

    // Each on its own line, under what was written before it — a heading in
    // the middle of a sentence is not a heading.
    await expect(padSaved(page)).toBeVisible();
    const text = (await storedPages(page))[0].text;
    expect(text).toMatch(/Aufwärmen gesehen[\s\S]*— (Vorspiel|Pre-game) —[\s\S]*— (Satz 3|Set 3) —/);

    // And it can be dismissed without writing anything.
    await sheet(page).getByTestId('pad-section').click();
    await expect(sheet(page).getByRole('button', { name: /^(Satzpause|Between sets)$/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page).getByRole('button', { name: /^(Satzpause|Between sets)$/ })).toHaveCount(0);
    // The menu, and only the menu: the page being written on is not the price
    // of an Escape.
    await expect(sheet(page)).toBeVisible();
    await expect(pageBox(page)).toHaveText(/Aufwärmen gesehen/);
  });

  // A heading as the very first thing on a fresh page is one edit, one page.
  // It used to be three: the multi-line insert fires an input event per line,
  // all before the first page reached the screen, and each one started a page
  // of its own — "Seite 3 von 3", two of them empty (found filming the guide,
  // 2026-10-13).
  test('a heading on a fresh page makes one page, not one per line', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await sheet(page).getByTestId('pad-section').click();
    await sheet(page).getByRole('button', { name: /^(Satz 1|Set 1)$/ }).click();
    await expect(pageBox(page)).toHaveText(/— (Satz 1|Set 1) —/);
    await expect(sheet(page).getByText(/^(Seite 1 von 1|Page 1 of 1)$/)).toBeVisible();
    await pageBox(page).pressSequentially('Pfiff klar');
    await expect(padSaved(page)).toBeVisible();
    const stored = await storedPages(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toMatch(/— (Satz 1|Set 1) —[\s\S]*Pfiff klar/);
  });

  test('a second insert into the same field asks first', async ({ page }) => {
    await stubSignedInApp(page);
    await seedPad(page, [padPage({ text: 'twice' })]);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
    await sheet(page).getByRole('button', { name: /1 Seite →|1 page →/ }).click();
    await sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ }).click();
    // Used pages are hidden until asked for.
    await expect(sheet(page).getByText('twice')).toHaveCount(0);
    await sheet(page).getByLabel(/Bereits übernommene anzeigen|Show inserted pages/).check();
    // The list's own checkbox, not the "show inserted" toggle above it.
    await sheet(page).getByRole('listitem').getByRole('checkbox').first().check();
    await sheet(page).getByRole('button', { name: /1 Seite →|1 page →/ }).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-accept').click();
    // textContent joins the two lines differently per layout; twice is twice.
    await expect(remarks(page)).toHaveText(/twice[\s\S]*twice/);
  });

  test('a closed role offers no insert', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, feedbackClosedRoles: ['1. SR'] }] }));
    await seedPad(page, [padPage()]);
    await page.goto('/');
    await openFeedbackForm(page);
    await openPad(page);
    await expect(sheet(page).getByRole('button', { name: /^(Übernehmen…|Insert…)$/ })).toHaveCount(0);
    await expect(sheet(page).getByText(/gesendet|sent/)).toBeVisible();
    await expect(pageBox(page)).toHaveText('seeded page');
  });
});

test.describe('The time column', () => {
  // Beside every note, small: when it was written (Luca, 2026-10-22). On by
  // default, off by a toggle this device remembers.
  const margin = (page: Page) => sheet(page).getByTestId('pad-times');
  const toggle = (page: Page) => sheet(page).getByTestId('pad-times-toggle');
  const TEXT = 'Netz nicht kontrolliert\n\nDer 2. SR steht zu weit links';
  /** The list the sheet itself keeps: epoch seconds and a hash per line. */
  const stamped = (text: string, seconds: number[]) => ({
    ls: linesOf(text).map((line, i) => (lineHash(line) ? `${seconds[i].toString(36)}.${lineHash(line)}` : '')),
  });
  const label = (sec: number) => clockLabel(sec * 1000, { seconds: true });

  test('each note shows its own time; a new one shows now, and is kept', async ({ page }) => {
    const start = Math.floor((suiteNow() - 40 * 60_000) / 1000);
    await seedPad(page, [padPage({ text: TEXT, extra: stamped(TEXT, [start, 0, start + 25 * 60 + 17]) })]);
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    // The blank line between them has nothing to show.
    // To the second.
    await expect(margin(page).locator('[data-line]')).toHaveText([label(start), label(start + 25 * 60 + 17)]);
    expect(await margin(page).locator('[data-line]').evaluateAll((els) => els.map((el) => el.getAttribute('data-line')))).toEqual(['0', '2']);

    await pageBox(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Pfiff zu spät');
    const labels = margin(page).locator('[data-line]');
    await expect(labels).toHaveCount(3);
    const typed = await labels.nth(2).textContent();
    expect(typed).toMatch(/^\d\d:\d\d:\d\d$/);
    expect([clockLabel(suiteNow()), clockLabel(suiteNow() - 60_000)]).toContain(typed!.slice(0, 5));

    // Each label stands beside its own line, not stacked at the top.
    const tops = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(tops[1]).toBeGreaterThan(tops[0] + 20);
    expect(tops[2]).toBeGreaterThan(tops[1] + 10);

    // Kept with the page, the text itself untouched.
    await expect(padSaved(page)).toBeVisible();
    const row = (await storedPages(page))[0];
    expect(row.text).toBe(`${TEXT}\nPfiff zu spät`);
    expect((row.extra as { ls: string[] }).ls).toHaveLength(4);
  });

  test('the toggle hides the column, and this device remembers it', async ({ page }) => {
    await seedPad(page, [padPage({ text: TEXT, extra: stamped(TEXT, [Math.floor(suiteNow() / 1000), 0, Math.floor(suiteNow() / 1000)]) })]);
    await stubSignedInApp(page);
    await page.goto('/');
    await openPad(page);
    await expect(margin(page)).toBeVisible();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(margin(page)).toHaveCount(0);
    await expect(pageBox(page)).toHaveText(TEXT.replace(/\n/g, ''));

    await page.reload();
    await openPad(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(margin(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(margin(page).locator('[data-line]')).toHaveCount(2);
  });
});
