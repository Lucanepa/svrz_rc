import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC, GAME, COACHEE } from './support/app';

// Every season-scoped read names its season — and shows only that season.
//
// The admin console's Übersicht asked for the overview without one, and the
// server read a missing season as "every season ever synced": a U18 final from
// the previous March was counted, and listed, as this season's unfinished
// observation (2026-09-13). The server now falls back to the default season on
// its own, but the clients must not lean on that: these tests pin what each
// screen sends, and that a last-season game stays out of this season's lists.
//
// The season is 2031 on purpose — nothing the app could guess from today's
// date, so a request carrying it can only have read it from the settings.

const SEASON = 2031;
const SETTINGS = { default_season: SEASON, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 };

/** Which season each season-scoped request asked for. */
function trackSeasons(page: Page) {
  const seen: { path: string; season: string | null }[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!/\/api\/(rc-overview|rc-games|games\/calendar-status)/.test(u.pathname)) return;
    seen.push({ path: u.pathname, season: u.searchParams.get('season') });
  });
  return seen;
}

/** A route held shut until the test opens it — so the screen can be caught
 *  before it knows the season. Same idiom as admin-loading-states.spec.ts. */
async function gated(page: Page, url: string | RegExp, json: unknown) {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => { open = resolve; });
  await page.route(url, async (route) => { await held; await route.fulfill({ json }); });
  return { open: () => open() };
}

/** Everything the coach app fetches once the season is known. */
const SEASON_GATED = ['/api/rc-overview', `/api/rc-overview/${encodeURIComponent(RC.name)}/coachees`, '/api/rc-games', '/api/games/calendar-status'];

const sse = (frames: string[]) => ({
  status: 200,
  headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  body: `retry: 5000\n\n${frames.map((f) => `data: ${f}\n\n`).join('')}`,
});

test.describe('admin console', () => {
  test('Übersicht asks for the settings season, counters and detail alike', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    await page.route('**/api/settings', (r) => r.fulfill({ json: SETTINGS }));
    await page.route(/\/api\/rc-overview(\?|$)/, (r) => r.fulfill({
      json: [{ id: 'rc2', fullName: 'Thanh Ut Nguyen', done: 0, outstanding: 1, planned: 0 }],
    }));
    await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
    const seen = trackSeasons(page);

    await page.goto('/admin/overview');
    const toggle = page.getByRole('button', { name: 'Thanh Ut Nguyen' });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect.poll(() => seen.some((s) => s.path.endsWith('/coachees'))).toBe(true);
    const wrong = seen.filter((s) => s.season !== String(SEASON));
    expect(wrong, `asked for a season other than the settings': ${JSON.stringify(wrong)}`).toEqual([]);
    expect(seen.some((s) => s.path === '/api/rc-overview')).toBe(true);
  });

  test('Spiele shows the settings season on the tab, test games exempt — and nothing before it knows the season', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    const settings = await gated(page, '**/api/settings', SETTINGS);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [
      // Three games, three match numbers: a clone that kept GAME's number
      // would be a second game under one number, which the form URL (the
      // number) then cannot name.
      { ...GAME, id: 'g-now', matchNo: '3100010', homeTeam: 'VBC Jetzt', date: `${SEASON}-10-10T18:00:00Z`, assignedRc: '' },
      // The season before's final — the row from the screenshot, moved along.
      { ...GAME, id: 'g-last', matchNo: '3000021', homeTeam: 'VBC Damals', date: `${SEASON}-03-21T13:30:00Z`, assignedRc: '' },
      // Made in the summer, in no season at all: shown, as everywhere else.
      { ...GAME, id: 'g-test', matchNo: 'TEST-20310701-k9q2', homeTeam: 'VBC Probe', date: `${SEASON}-07-01T18:00:00Z`, assignedRc: '', isManual: true },
    ] }));

    await page.goto('/admin/games');
    // The games are here, the season is not: no list yet, so the calendar's
    // guess (2026 today) never cuts it and the rows never jump.
    await expect(page.getByText('VBC Probe')).toHaveCount(0);
    await expect(page.getByText(/(Spiele|games) · (Saison|season)/)).toHaveCount(0);

    settings.open();
    await expect(page.getByText('VBC Jetzt')).toBeVisible();
    await expect(page.getByText('VBC Probe')).toBeVisible();
    await expect(page.getByText('VBC Damals')).toHaveCount(0);
    await expect(page.getByText(/2 (Spiele|games) · (Saison|season) 2031\/32/)).toBeVisible();
  });
});

test.describe('coach app', () => {
  test('Home, the SR-Spiele and the calendar all ask for the settings season', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/settings', (r) => r.fulfill({ json: SETTINGS }));
    await page.route(/\/api\/rc-overview(\?|$)/, (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 }] }));
    await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
    const seen = trackSeasons(page);

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    // Every season-gated request has fired — so anything sent off the guess
    // would have been dispatched earlier and is already in the list.
    for (const path of SEASON_GATED) await expect.poll(() => seen.some((s) => s.path === path), path).toBe(true);

    const wrong = seen.filter((s) => s.season !== String(SEASON));
    expect(wrong, `asked for a season other than the settings': ${JSON.stringify(wrong)}`).toEqual([]);
  });

  test('a default season moved while the app is open is fetched for, once', async ({ page }) => {
    await stubSignedInApp(page);
    // The settings answer changes underneath the app: 2031 on boot, 2032 after
    // the admin moved it — which the stream announces.
    let season = SEASON;
    await page.route('**/api/settings', (r) => r.fulfill({ json: { ...SETTINGS, default_season: season } }));
    await page.route(/\/api\/rc-overview(\?|$)/, (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 }] }));
    await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
    await page.route('**/api/events', async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      season = SEASON + 1;
      await r.fulfill(sse([JSON.stringify({ type: 'settings.changed', keys: ['default_season'] })]));
    });
    const seen = trackSeasons(page);

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    // The label follows the new season — and so do the numbers under it: the
    // season-scoped reads are asked again, for the new season, each once.
    await expect(page.getByText(`${SEASON + 1}/${String((SEASON + 2) % 100).padStart(2, '0')}`).first()).toBeVisible({ timeout: 10_000 });
    for (const path of SEASON_GATED) {
      await expect.poll(() => seen.filter((s) => s.path === path && s.season === String(SEASON + 1)).length, path).toBe(1);
    }
    expect(seen.filter((s) => s.season !== String(SEASON) && s.season !== String(SEASON + 1))).toEqual([]);
  });

  /** GAME's list with last season's final beside it — the row from the
   *  screenshot, under its own number. */
  const LAST_SEASONS = { ...GAME, id: 'g-last', matchNo: '2500321', homeTeam: 'VBC Damals', date: '2026-03-21T13:30:00Z' };

  test('a link to last season\'s game is "not found", not a blank form', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, LAST_SEASONS] }));
    await page.goto(`/form/${LAST_SEASONS.id}/1sr`);
    await expect(page.getByText(/Game not found|Spiel nicht gefunden/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toHaveCount(0);
  });

  test('last season\'s match number is "not found" the same way', async ({ page }) => {
    // The form's address is the match number now, so a link from a mail sent
    // in March carries one; it resolves to last season's game and is refused
    // by the same season guard as the record id — not opened as a blank form
    // on the wrong season.
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, LAST_SEASONS] }));
    await page.goto(`/form/${LAST_SEASONS.matchNo}/1sr`);
    await expect(page.getByText(/Game not found|Spiel nicht gefunden/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toHaveCount(0);
  });

  test('a match number two seasons\' games share opens this season\'s', async ({ page }) => {
    // VolleyManager may reuse a number across seasons. Of the games carrying
    // it, the one inside the season on screen is the one the link means; last
    // season's is listed FIRST so "this season's" cannot be "the first hit".
    // Its URL then reads the record id — a shared number names neither.
    await stubSignedInApp(page);
    const REUSED = { ...LAST_SEASONS, matchNo: GAME.matchNo };
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [REUSED, GAME] }));
    await page.goto(`/form/${GAME.matchNo}/1sr`);
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(page.getByText(/Game not found|Spiel nicht gefunden/)).toHaveCount(0);
    // This season's teams in the header, not last season's.
    await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
    await expect(page.getByText(REUSED.homeTeam)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/form/${GAME.id}/1sr$`));
  });

  // The coachee routes carry the SV number of a linked row (`/games/90003`)
  // or a record id, and the season decides which row that names. Last
  // season's person is a different answer from nobody: "nicht gefunden"
  // sends the coach looking for a typo that is not there, so the roll-over
  // gets its own notice — and still never opens the row, whose Niveau and
  // group are last season's.
  test('a link to last season\'s coachee row says it is another season\'s, and does not open it', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
      COACHEE,
      { ...COACHEE, id: 'c-last', full_name: 'Letizia Altsaison', season: 2025 },
    ] }));
    await page.goto('/games/c-last');
    await expect(page.getByText(/belongs to another season|gehört zu einer anderen Saison/)).toBeVisible();
    await expect(page.getByText(/Coachee not found|Coachee nicht gefunden/)).toHaveCount(0);
    await expect(page.getByText('Letizia Altsaison')).toHaveCount(0);
  });

  test('an SV number that only last season\'s row carries gets the same notice', async ({ page }) => {
    // The link a coach mailed in April, opened after the roll-over, for a
    // referee who is not a coachee this season.
    await stubSignedInApp(page);
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
      COACHEE,
      { ...COACHEE, id: 'c-last', full_name: 'Letizia Altsaison', season: 2025, referee_id: '90009' },
    ] }));
    await page.goto('/games/90009');
    await expect(page.getByText(/belongs to another season|gehört zu einer anderen Saison/)).toBeVisible();
    await expect(page.getByText('Letizia Altsaison')).toHaveCount(0);
  });

  test('an SV number with a row in both seasons opens this season\'s', async ({ page }) => {
    // The same person, one row per season, one licence number: the number
    // survives the roll-over, and it is this season's row — this season's
    // Niveau in the header — that the link opens, whichever season it was
    // mailed in. The rows are listed last season first, so "this season's"
    // cannot be "the first one".
    await stubSignedInApp(page);
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
      { ...COACHEE, id: 'c-last', full_name: 'Ref One', referee_level: 'N2', season: 2025 },
      { ...COACHEE, referee_level: 'N3', season: 2026 },
    ] }));
    await page.route('**/api/coachees/*/games', (r) => r.fulfill({ json: [{ ...GAME, assignedRoles: ['1. SR'] }] }));
    const asked: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (/\/api\/coachees\/[^/]+\/games$/.test(u.pathname)) asked.push(u.pathname); });
    await page.goto(`/games/${COACHEE.referee_id}`);
    await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
    await expect(page.getByText(/belongs to another season|gehört zu einer anderen Saison/)).toHaveCount(0);
    // This season's row was the one fetched — by its record id, as the API
    // is still addressed.
    await expect.poll(() => asked).toEqual([`/api/coachees/${COACHEE.id}/games`]);
  });

  test('a coachee link waits for the settings season rather than resolving on the calendar guess', async ({ page }) => {
    // July: the calendar guess is LAST season (September starts one), the
    // admin has already moved the default to this one, and /api/coachees
    // lands before /api/settings — nothing orders the two, and the roster
    // is the heavier request. Resolved the moment the roster arrived, the
    // number would have opened last season's row on the guess — silently,
    // last season's Niveau in the header, and it stayed there once the
    // settings corrected the season. The link waits for the season instead.
    await page.clock.setFixedTime(new Date('2026-07-15T10:00:00Z'));
    await stubSignedInApp(page);
    const settings = await gated(page, '**/api/settings', { ...SETTINGS, default_season: 2026 });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
      { ...COACHEE, id: 'c-last', full_name: 'Ref One', referee_level: 'N2', season: 2025 },
      { ...COACHEE, referee_level: 'N3', season: 2026 },
    ] }));
    await page.route('**/api/coachees/*/games', (r) => r.fulfill({ json: [{ ...GAME, assignedRoles: ['1. SR'] }] }));
    const asked: string[] = [];
    let rosterAsked = false;
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (/\/api\/coachees\/[^/]+\/games$/.test(u.pathname)) asked.push(u.pathname);
      if (/\/api\/coachees$/.test(u.pathname)) rosterAsked = true;
    });
    await page.goto(`/games/${COACHEE.referee_id}`);
    await expect.poll(() => rosterAsked).toBe(true);
    // A beat with the roster in hand and the season still unknown: the time
    // in which the guess used to answer the link. Nothing may be fetched.
    await page.waitForTimeout(400);
    expect(asked).toEqual([]);

    settings.open();
    await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
    await expect(page.getByText(/belongs to another season|gehört zu einer anderen Saison/)).toHaveCount(0);
    await expect.poll(() => asked).toEqual([`/api/coachees/${COACHEE.id}/games`]);
  });
});
