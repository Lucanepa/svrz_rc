import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { stubSignedInApp, openFeedbackForm, ratingControl, RC, COACHEE, GAME } from './support/app';

/**
 * An unfinished observation, and the three ways it is allowed to survive: the
 * device's own store, a file the coach can carry, and the same file coming back.
 *
 * The reload round trip below is the release gate. Before drafts existed the
 * service worker refused to swap builds while a form held work — crude, but it
 * never lost anything. That deferral has been relaxed on the promise that the
 * work is already on disk, so a restore that half-works is strictly worse than
 * the behaviour it replaced: the deploy now goes ahead and takes the evening
 * with it.
 *
 * The app picks its language off the browser's, and the Playwright projects run
 * under an English locale, so every user-facing string is matched in both.
 */

/** What a selected rating looks like in either layout — RATING_COLORS in App.tsx. */
const RATING_CLASS: Record<string, RegExp> = {
  A: /bg-green-400/, B: /bg-green-700/, C: /bg-blue-600/, D: /bg-orange-500/, E: /bg-red-600/,
};

const DRAFT_LABEL = `${GAME.homeTeam} vs ${GAME.awayTeam}`;
/** The first criterion of the 1. SR catalogue. The id is shared by SECTIONS_1SR_DE
 *  and SECTIONS_1SR_EN, which is what lets a file written in one be read in the other. */
const FIRST_CRITERION_ID = '1sr-prep-1';

const tipsBox = (page: Page) =>
  page.locator('textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]');

/** The autosave's own report. Anchored, or "Draft could not be saved" matches too. */
const savedStrip = (page: Page) => page.getByText(/^(Draft saved|Entwurf gespeichert)/);

const draftsBanner = (page: Page) =>
  page.getByText(/Unfinished observations?|Nicht abgeschlossene Beobachtung(en)?/);

/** The "Draft" pill on a game row. Only the pill carries this title. */
const draftPill = (page: Page) =>
  page.getByTitle(/^(Unfinished observation|Nicht abgeschlossene Beobachtung)$/);

const errorToast = (page: Page) => page.locator('[data-testid="toast"][data-toast-kind="error"]');

/** Games tab -> reveal the games a coach already holds. Proves the games list has
 *  arrived, which every restore path needs: a draft whose game is not on this
 *  device is deliberately kept and NOT opened. */
async function openHeldGames(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
}

/**
 * One stored draft, with everything a test wants to vary handed in.
 *
 * The id is DERIVED rather than passed: `${ownerId}|${gameId}|${role}` is the
 * key the app upserts on, and a seed whose id disagrees with its own fields
 * writes a record every reader then looks straight past.
 */
function draftRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const ownerId = (over.ownerId as string) || RC.id;
  const gameId = (over.gameId as string) || GAME.id;
  const role = (over.role as string) || '1. SR';
  return {
    id: `${ownerId}|${gameId}|${role}`,
    schema: 1,
    ownerId,
    gameId,
    role,
    updatedAt: Date.now(),
    status: 'editing',
    submissionKey: '',
    label: DRAFT_LABEL,
    matchNo: GAME.matchNo,
    observationTarget: '1SR',
    resultUnlocked: false,
    coacheeId: COACHEE.id,
    coacheeName: COACHEE.full_name,
    coacheeLevel: COACHEE.referee_level,
    lang: 'EN',
    meta: {},
    ratings: { [FIRST_CRITERION_ID]: 'D' },
    results: {},
    signature: '',
    rcSignature: '',
    tipsAndTricks: 'left half-written on this device',
    ...over,
  };
}

/**
 * Drafts already on the device when the page opens.
 *
 * Seeded through `addInitScript` so they are in the store BEFORE the app's boot
 * read, which happens once and is never retried — a draft that lands after it
 * would simply not be there as far as the app is concerned.
 *
 * The database name, the store name and the version must match
 * src/lib/formDraft.ts exactly, or this seeds a database the app never opens and
 * the test passes for the wrong reason. Same trap as the outbox seed in
 * e2e/go-live-fixes.spec.ts.
 */
async function seedDrafts(page: Page, records: Record<string, unknown>[]): Promise<void> {
  await page.addInitScript((rows) => {
    const open = indexedDB.open('svrz-drafts', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('form-drafts')) {
        open.result.createObjectStore('form-drafts', { keyPath: 'id' });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('form-drafts', 'readwrite');
      for (const row of rows) tx.objectStore('form-drafts').put(row);
      // Closed once the write has committed, so this seed is never the open
      // connection that a later version bump would block on.
      tx.oncomplete = () => db.close();
    };
  }, records);
}

/** The one-draft case the first tests were written around. */
async function seedDraft(page: Page, ownerId: string): Promise<void> {
  await seedDrafts(page, [draftRecord({ ownerId })]);
}

/** A record as the store holds it — the fields these tests read back. */
type StoredDraft = {
  id: string;
  ownerId: string;
  gameId: string;
  role: string;
  status: string;
  observationTarget: string;
  updatedAt: number;
  meta: Record<string, string>;
  ratings: Record<string, string>;
  results: Record<string, string>;
  signature: string;
  rcSignature: string;
  tipsAndTricks: string;
};

/**
 * What is actually on disk, not what the screen claims.
 *
 * Every assertion about a guard that lives INSIDE the write — the one that
 * refuses to demote a role whose report has already gone — has to read the
 * store, because a screen that renders correctly is exactly what the bug looked
 * like from the outside.
 */
function storedDrafts(page: Page): Promise<StoredDraft[]> {
  return page.evaluate(() => new Promise<StoredDraft[]>((resolve, reject) => {
    const open = indexedDB.open('svrz-drafts', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('form-drafts')) {
        open.result.createObjectStore('form-drafts', { keyPath: 'id' });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('form-drafts', 'readonly').objectStore('form-drafts').getAll();
      req.onsuccess = () => { const rows = req.result as StoredDraft[]; db.close(); resolve(rows); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

/** One role's record, insisted upon: reading a field off `undefined` says
 *  nothing about which role the store is actually missing. */
async function storedRole(page: Page, role: string): Promise<StoredDraft> {
  const rows = await storedDrafts(page);
  const found = rows.find((d) => d.role === role);
  expect(found, `no stored draft for ${role} — the store holds ${rows.map((d) => `${d.role} (${d.status})`).join(', ') || 'nothing'}`).toBeTruthy();
  return found;
}

/**
 * Turn one stored role into the tombstone a confirmed send leaves behind —
 * status 'filed' with the payload blanked, exactly what `setDraftStatus` writes.
 *
 * Done from the page rather than through the UI because the state it recreates
 * is the one a PARTIAL dual-mode send leaves: one role filed on the server while
 * the other is still on screen, unsent, with both forms still in memory. That is
 * the only situation in which the autosave is offered a record for a role it
 * must not write, and it cannot be reached by typing.
 */
async function fileRoleInStore(page: Page, gameId: string, role: string): Promise<void> {
  await page.evaluate((key) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('svrz-drafts', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('form-drafts', 'readwrite');
      const store = tx.objectStore('form-drafts');
      const get = store.get(key);
      get.onsuccess = () => {
        const rec = get.result;
        // Aborting rather than resolving: a key nobody wrote means the test is
        // seeding one record and filing another, which would pass silently.
        if (!rec) { tx.abort(); return; }
        store.put({
          ...rec, status: 'filed', submissionKey: '',
          meta: {}, ratings: {}, results: {}, signature: '', rcSignature: '', tipsAndTricks: '',
        });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error(`no draft at ${key}`)); };
    };
  }), `${RC.id}|${gameId}|${role}`);
}

/** A draft file as another build would have written it. */
function draftFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'svrz-rc.draft',
    fileVersion: 1,
    minReader: 1,
    exportedAt: '2026-08-27T20:15:00.000Z',
    app: { version: '1.0.0', sha: 'deadbee' },
    author: { ownerId: RC.id, name: RC.name },
    game: {
      id: GAME.id, matchNo: GAME.matchNo, date: GAME.date, league: GAME.league,
      location: GAME.location, homeTeam: GAME.homeTeam, awayTeam: GAME.awayTeam,
      firstReferee: GAME.firstReferee, secondReferee: GAME.secondReferee,
    },
    drafts: [{
      role: '1. SR',
      lang: 'EN',
      observationTarget: '1SR',
      resultUnlocked: false,
      coacheeName: COACHEE.full_name,
      coacheeLevel: COACHEE.referee_level,
      meta: {},
      ratings: { [FIRST_CRITERION_ID]: 'A', '1sr-tech-1': 'E' },
      results: {},
      signature: '',
      rcSignature: '',
      tipsAndTricks: 'carried in from a file',
    }],
    ...over,
  };
}

async function pickDraftFile(page: Page, contents: Record<string, unknown>): Promise<void> {
  await page.getByLabel(/Load draft|Entwurf laden/).setInputFiles({
    name: 'SVRZ draft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(contents), 'utf8'),
  });
}

test.describe('The device keeps the work', () => {
  test('a reload gives the rating and the tips back', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);

    await (await ratingControl(page, 0, 'B')).click();
    await tipsBox(page).fill('Whistle position: hold it, do not chase the ball');
    // Not a fixed wait: the reload is only allowed to prove anything once the
    // app itself says the work is committed.
    await expect(savedStrip(page)).toBeVisible();

    await page.reload();

    // Back on the form, not merely back in the app: the resume hint survives the
    // reload in sessionStorage and the restore is silent, with no banner to tap.
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(tipsBox(page)).toHaveValue('Whistle position: hold it, do not chase the ball');
    await expect(await ratingControl(page, 0, 'B')).toHaveClass(RATING_CLASS.B);
    // The mark landed on the criterion it was made on, not one row over.
    await expect(await ratingControl(page, 1, 'B')).not.toHaveClass(RATING_CLASS.B);
  });

  test('a cold start offers the draft instead of jumping into it', async ({ page }) => {
    await stubSignedInApp(page);
    await seedDraft(page, RC.id);
    await page.goto('/');

    // A cold start has no resume hint, so the coach is OFFERED the work rather
    // than dropped into it — on a shared tablet the other behaviour would open
    // somebody else's evening.
    await expect(draftsBanner(page)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('p', { hasText: DRAFT_LABEL })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toHaveCount(0);

    await openHeldGames(page);
    await expect(draftPill(page)).toBeVisible();
    await expect(draftPill(page)).toHaveText(/^(Draft|Entwurf)$/);
  });

  test('another coach\'s draft on this device is not this coach\'s to see', async ({ page }) => {
    await stubSignedInApp(page);
    // The shared-tablet case: the same store, a different owner id.
    await seedDraft(page, 'rc-someone-else');
    await page.goto('/');

    await expect(draftsBanner(page)).toHaveCount(0);

    // Asserted against a games list that has actually rendered, so "no pill" is
    // a statement about the list and not about a screen that never loaded.
    await openHeldGames(page);
    await expect(draftPill(page)).toHaveCount(0);

    // And nothing of it reaches the form either.
    await page.getByText(GAME.homeTeam).first().click();
    await page.getByRole('button', { name: /Start observation|Beobachtung starten/ }).click();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(tipsBox(page)).toHaveValue('');
    await expect(await ratingControl(page, 0, 'D')).not.toHaveClass(RATING_CLASS.D);
  });
});

test.describe('The portable file', () => {
  test('the exported file is a v1 draft and its ratings travel by item id', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);

    await (await ratingControl(page, 0, 'C')).click();
    await tipsBox(page).fill('Take the whole net into the pre-match check');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Save draft|Entwurf sichern/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);

    const file = JSON.parse(await readFile(await download.path(), 'utf8'));
    // The identity gate: a coach who picks the wrong file out of Downloads is
    // told so by this field and nothing else.
    expect(file.kind).toBe('svrz-rc.draft');
    // The literal 1, not the file version — it says "any build that understands
    // v1 can read me", and a later additive version must keep writing it.
    expect(file.minReader).toBe(1);
    expect(file.game.id).toBe(GAME.id);
    expect(file.author.ownerId).toBe(RC.id);

    expect(file.drafts).toHaveLength(1);
    const part = file.drafts[0];
    expect(part.role).toBe('1. SR');
    // Keyed by criterion id, never by row: the whole reason a catalogue may be
    // edited without shifting somebody's stored marks by one.
    expect(part.ratings[FIRST_CRITERION_ID]).toBe('C');
    expect(Object.keys(part.ratings)).toEqual([FIRST_CRITERION_ID]);
    expect(part.tipsAndTricks).toBe('Take the whole net into the pre-match check');
  });

  test('an imported file lands on the form, criterion by criterion', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    // The import binds the work to a game on THIS device, so the list has to
    // have arrived before the file is picked.
    await openHeldGames(page);

    await pickDraftFile(page, draftFile());

    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(tipsBox(page)).toHaveValue('carried in from a file');
    await expect(await ratingControl(page, 0, 'A')).toHaveClass(RATING_CLASS.A);
    // The second mark is on the first criterion of the TECHNIQUE section, four
    // rows further down — proof the file was projected by id and not poured back
    // in row order.
    await expect(await ratingControl(page, 4, 'E')).toHaveClass(RATING_CLASS.E);
    await expect(await ratingControl(page, 1, 'A')).not.toHaveClass(RATING_CLASS.A);
  });

  test('a file from a newer build is refused out loud and changes nothing', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openHeldGames(page);

    // minReader 99: not "this file is damaged" but "this app is too old". The
    // difference is the only one the coach can act on — reloading gets the build
    // that can read it.
    await pickDraftFile(page, draftFile({ minReader: 99 }));

    await expect(errorToast(page)).toContainText(/newer version of the app|neueren Version der App/);

    // Refused means refused: no form, no stored draft, no row on the list.
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toHaveCount(0);
    await expect(draftsBanner(page)).toHaveCount(0);
    await expect(draftPill(page)).toHaveCount(0);
  });
});

/**
 * The nine ways the draft feature was wrong, and the five of them a browser can
 * still reach.
 *
 * Every one of these passed a hand-test at the time it shipped, because every
 * one of them looked right on screen: the discarded draft was gone from the
 * banner, the sent report opened without complaint, the two-referee visit filed
 * its report. What made them defects was what happened NEXT — the next tap, the
 * next keystroke, the next reload — so each test below drives the second step
 * and reads the store rather than the screen wherever the store is where the
 * damage was done.
 */

/** The lock the form wears when this role's report has already left it. */
const lockBanner = (page: Page) =>
  page.getByText(/Being sent — waiting in the queue|Wird gesendet — wartet in der Warteschlange|Already submitted|Bereits eingereicht/);

/** The greyed-out half of the form. Only the disabled wrapper holds the criteria. */
const inertFormBody = (page: Page) =>
  page.locator('div.pointer-events-none').filter({ has: page.locator('td.rating-cell') });

const restoredToast = (page: Page) =>
  page.getByText(/^(Draft restored|Entwurf wiederhergestellt)/);

/** The "Observation for" segmented control — 1SR / 2SR / Both.
 *  Anchored at the start only: a segment whose referee is a coachee carries a
 *  dot titled "Coachee", and the title lands in the accessible name. */
const targetButton = (page: Page, name: RegExp) =>
  page.getByRole('group', { name: /Observation for|Beobachtung f/ }).getByRole('button', { name });

/** The chosen segment. `bg-slate-900` is the only signal the three share. */
const TARGET_ACTIVE = /bg-slate-900/;

/** GAME with a second referee on it, so the visit can be a two-referee one.
 *  Only the 1. SR is a coachee, which makes '1SR' the target the app would
 *  PRE-select — so a control reading 'both' can only have come from the draft. */
const GAME_2SR = { ...GAME, secondReferee: 'Ref Two' };

/** Serve the two-referee fixture in place of the single-referee one. */
async function useTwoRefereeGame(page: Page): Promise<void> {
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_2SR] }));
}

/**
 * Games tab -> held games -> expand the fixture's ROW -> open its form.
 *
 * Not `openFeedbackForm`: the moment a draft is on the device the banner above
 * the list carries its label — `${homeTeam} vs ${awayTeam}` — so the helper's
 * `getByText(homeTeam).first()` lands on the banner and the row is never
 * expanded. The match number appears only on the row.
 */
async function openGameFromList(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  const start = page.getByRole('button', { name: /Start observation|Beobachtung starten/ });
  if (await start.count() === 0) await page.getByText(`#${GAME.matchNo}`).first().click();
  await start.click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
}

/** Draw a stroke on the open signature pad and keep it — as in e2e/feedback-email.spec.ts. */
async function signOpenPad(page: Page): Promise<void> {
  const pad = page.locator('canvas');
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 3, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Save signature|Unterschrift speichern/ }).click();
}

test.describe('Discard means gone', () => {
  test('the copy on screen goes with the copy on disk', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);

    await (await ratingControl(page, 0, 'B')).click();
    await tipsBox(page).fill('Ball handling: call it earlier, and mean it');
    await expect(savedStrip(page)).toBeVisible();

    await page.getByRole('button', { name: /^(Back|Zurück)$/ }).click();
    await expect(draftsBanner(page)).toBeVisible();

    await page.getByRole('button', { name: /^(Discard|Verwerfen)$/ }).first().click();
    await page.getByTestId('confirm-accept').click();

    // The banner is the easy half, and the half the original fix already had.
    await expect(draftsBanner(page)).toHaveCount(0);
    await expect(draftPill(page)).toHaveCount(0);

    // The hard half: the form for this game is still mounted, every flush path
    // rebuilds its record from that memory, and `handleSelectGame` flushes
    // BEFORE it does anything else — so one tap on the same game used to write
    // the discarded work straight back and hand it over with a "restored" toast.
    const start = page.getByRole('button', { name: /Start observation|Beobachtung starten/ });
    if (await start.count() === 0) await page.getByText(GAME.homeTeam).first().click();
    await start.click();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();

    await expect(tipsBox(page)).toHaveValue('');
    await expect(await ratingControl(page, 0, 'B')).not.toHaveClass(RATING_CLASS.B);
    await expect(restoredToast(page)).toHaveCount(0);
    await expect(draftsBanner(page)).toHaveCount(0);
    await expect(draftPill(page)).toHaveCount(0);

    // And nothing came back on disk either, which is what the next reload reads.
    expect(await storedDrafts(page)).toEqual([]);
  });

});

test.describe('Work that has already been sent', () => {
  // Offline send, then a reload: `feedbackLocked` died with the page and the
  // server never closed the role, so the games list handed back a blank,
  // editable form for a report the referee is already holding. Filing it again
  // sends a second report and a second PDF.
  for (const [status, banner] of [
    ['queued', /Being sent — waiting in the queue|Wird gesendet — wartet in der Warteschlange/],
    ['filed', /Already submitted|Bereits eingereicht/],
  ] as const) {
    test(`a ${status} role opens locked, not as a form to fill again`, async ({ page }) => {
      await stubSignedInApp(page);
      await seedDrafts(page, [draftRecord({
        status,
        submissionKey: status === 'queued' ? 'sub-1' : '',
        // What a confirmed send leaves behind: the memory that this game+role
        // went, with the assessment itself blanked.
        ...(status === 'filed'
          ? { ratings: {}, tipsAndTricks: '', signature: '', rcSignature: '' }
          : {}),
      })]);
      await page.goto('/');

      // Through the games LIST, not the banner: the banner already refused to
      // resume such a role, and this is the door that was left open.
      await openGameFromList(page);

      await expect(lockBanner(page)).toBeVisible();
      await expect(lockBanner(page)).toHaveText(banner);
      await expect(restoredToast(page)).toHaveCount(0);

      // Not merely labelled locked — inert. The criteria and the tips box sit
      // inside the wrapper that stops taking input.
      await expect(inertFormBody(page)).toHaveCount(1);
      const cell = await ratingControl(page, 0, 'B');
      // `force` gets past Playwright's own refusal to click something that
      // takes no pointer events; the browser still routes the click past it.
      await cell.click({ force: true, timeout: 2000 }).catch(() => { /* refused, which is the point */ });
      await expect(cell).not.toHaveClass(RATING_CLASS.B);
    });
  }
});

test.describe('A two-referee visit stays a two-referee visit', () => {
  test('a sibling that was never started does not collapse it', async ({ page }) => {
    await stubSignedInApp(page);
    await useTwoRefereeGame(page);
    // One role, mid-visit, on a game whose OTHER role has simply not been
    // opened yet. This record is the only thing left saying the coach chose to
    // observe both — collapsing here silently filed one report of two.
    await seedDrafts(page, [draftRecord({ role: '1. SR', observationTarget: 'both' })]);
    await page.goto('/');

    await openGameFromList(page);
    await expect(restoredToast(page)).toBeVisible();

    await expect(targetButton(page, /^(Both|Beide)$/)).toHaveClass(TARGET_ACTIVE);
    await expect(targetButton(page, /^1SR/)).not.toHaveClass(TARGET_ACTIVE);
    // The visit is dual again, so the other referee's form is one tap away.
    await expect(page.getByRole('button', { name: /^(Switch to|Wechseln zu) 2\. SR$/ })).toBeVisible();
  });

  test('a sibling already filed does collapse it', async ({ page }) => {
    await stubSignedInApp(page);
    await useTwoRefereeGame(page);
    await seedDrafts(page, [
      draftRecord({ role: '1. SR', observationTarget: 'both' }),
      // The other half of the visit is gone: sent, confirmed, blanked. Keeping
      // the visit dual here would make validateForm demand a form for a role
      // that can no longer be edited.
      draftRecord({
        role: '2. SR', status: 'filed',
        ratings: {}, tipsAndTricks: '', signature: '', rcSignature: '',
      }),
    ]);
    await page.goto('/');

    await openGameFromList(page);
    await expect(restoredToast(page)).toBeVisible();

    await expect(targetButton(page, /^1SR/)).toHaveClass(TARGET_ACTIVE);
    await expect(targetButton(page, /^(Both|Beide)$/)).not.toHaveClass(TARGET_ACTIVE);
    await expect(page.getByRole('button', { name: /^(Switch to|Wechseln zu) 2\. SR$/ })).toHaveCount(0);
  });
});

test.describe('The autosave and the report that already went', () => {
  test('a filed role is not resurrected by the next keystroke', async ({ page }) => {
    await stubSignedInApp(page);
    await useTwoRefereeGame(page);
    // A dual visit, both halves still unfinished. The 1. SR is the newer one,
    // so it is the form that opens and the 2. SR is the stash behind it.
    const now = Date.now();
    await seedDrafts(page, [
      draftRecord({ role: '1. SR', observationTarget: 'both', updatedAt: now }),
      draftRecord({
        role: '2. SR', observationTarget: 'both', updatedAt: now - 1000,
        ratings: {}, tipsAndTricks: 'the second referee, half observed',
      }),
    ]);
    await page.goto('/');

    await openGameFromList(page);
    await expect(restoredToast(page)).toBeVisible();
    await expect(savedStrip(page)).toBeVisible();

    // The send files 2. SR and then throws on 1. SR: one tombstone on disk, both
    // forms still in memory, the coach still typing into the role that failed.
    await fileRoleInStore(page, GAME_2SR.id, '2. SR');
    expect((await storedRole(page, '2. SR')).status).toBe('filed');

    await tipsBox(page).fill('Net play: step in, do not lean');
    // Polled through the raw list rather than `storedRole`: this is the one read
    // that is racing a write, so "not there yet" has to be a retry, not a throw.
    await expect
      .poll(async () => (await storedDrafts(page)).find((d) => d.role === '1. SR')?.tipsAndTricks)
      .toBe('Net play: step in, do not lean');

    // The write that just landed carried a record for BOTH roles — the 2. SR
    // form is still in memory and still counts as work — and the store refused
    // the one it must not take. A blind put would have turned the tombstone back
    // into a restorable, re-sendable copy of a report the referee already has.
    const filed = await storedRole(page, '2. SR');
    expect(filed.status).toBe('filed');
    expect(filed.tipsAndTricks).toBe('');
    expect(filed.ratings).toEqual({});
    expect(filed.signature).toBe('');
  });
});

test.describe('A signature is work that cannot be retyped', () => {
  test('the ink is on disk and on the server before the next keystroke', async ({ page }) => {
    await stubSignedInApp(page);
    // Every parked body, so the backup can be read rather than assumed. The
    // server copy is the half a 1200 ms autosave cannot quietly repair: the next
    // park after this one is 45 s away.
    const parked: string[] = [];
    await page.route(/\/api\/drafts\/parked\//, async (r) => {
      if (r.request().method() === 'PUT') parked.push(r.request().postData() || '');
      await r.fulfill({ json: { parked: 1 } });
    });
    await page.goto('/');
    await openFeedbackForm(page);

    await tipsBox(page).fill('Signals: hold them, the line judge is watching');
    await expect(savedStrip(page)).toBeVisible();
    expect((await storedRole(page, '1. SR')).signature).toBe('');

    const before = parked.length;
    await page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).first().click();
    await signOpenPad(page);
    await expect(page.getByAltText(/Referee signature|Unterschrift Schiedsrichter/)).toBeVisible();

    // The park is issued only AFTER its own write has committed, so the arrival
    // of this request is the moment the store is guaranteed to be settled — no
    // polling, and no window for the 1200 ms autosave to cover for a flush that
    // wrote the pre-signature snapshot.
    await expect.poll(() => parked.length).toBeGreaterThan(before);
    expect(parked[parked.length - 1]).toContain('data:image/png;base64,');

    const record = await storedRole(page, '1. SR');
    expect(record.signature).toMatch(/^data:image\/png;base64,/);
    // The rest of the form came with it, not instead of it.
    expect(record.tipsAndTricks).toBe('Signals: hold them, the line judge is watching');
  });
});
