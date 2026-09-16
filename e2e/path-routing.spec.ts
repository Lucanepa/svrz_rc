import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, COACHEE, COACHEE_LISTED, GAME } from './support/app';

/**
 * Routes live in the path, and the URL says exactly what is on screen.
 *
 * Three things the hash never carried, and one thing it must not start doing
 * now that it is a path:
 *
 *   /form/<game>/<half>     which observation is open — a reload, or the other
 *                           coach on the game, lands on the same form. The
 *                           CONTENT stays in IndexedDB; the URL only names it.
 *   /games?view=calendar    the Games tab as a month grid, which always came
 *                           back as the list after a reload.
 *   /admin/logs/history     the console's Protokoll on Verlauf, so "the error
 *                           is under Verlauf" is a linkable sentence.
 *
 * And: swapping the referee inside one form, or paging the calendar, must NOT
 * become a Back step. A Back that re-entered the other half's form would
 * re-initialise it — and with IndexedDB blocked, the in-memory stash is all
 * there is. So those two replace the history entry instead of pushing one.
 */

/** GAME with a second referee who is ALSO a coachee, so the app pre-selects
 *  "both" and offers the swap between halves. */
const COACHEE_2 = { ...COACHEE, id: 'c2', full_name: 'Ref Two', email: 'ref.two@example.ch', referee_id: '90004' };
const GAME_2SR = { ...GAME, secondReferee: COACHEE_2.full_name, secondRefereeId: COACHEE_2.referee_id, secondCoacheeId: COACHEE_2.id };
async function useDualGame(page: Page): Promise<void> {
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_2] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_2SR] }));
}

/** Path + query, polled: pushState reaches Playwright's page.url() a beat
 *  after the DOM it belongs to, so a plain read right after an assertion on
 *  the screen can still see the previous entry. */
const atPath = (page: Page, p: string) =>
  expect(page).toHaveURL(new RegExp(`^[a-z]+://[^/]+${p.replace(/[.?+*$()[\]]/g, '\\$&')}$`));
const atPathMatching = (page: Page, re: RegExp) => expect(page).toHaveURL(re);

const formHeading = (page: Page) => page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ });
const switchTo = (page: Page, half: '1. SR' | '2. SR') =>
  page.getByRole('button', { name: new RegExp(`^(Switch to|Wechseln zu) ${half.replace('.', '\\.')}$`) });

test.describe('the form names its game and half', () => {
  test.beforeEach(async ({ page }) => { await stubSignedInApp(page); });

  test('opening an observation puts the game and the half in the URL', async ({ page }) => {
    await page.goto('/');
    await openFeedbackForm(page);

    await atPath(page, `/form/${GAME.id}/1sr`);
  });

  test('that URL opens the same form cold, with nothing carried over', async ({ page }) => {
    await page.goto(`/form/${GAME.id}/1sr`);

    await expect(formHeading(page)).toBeVisible();
    await expect(page.locator(`input[value="${GAME.matchNo}"]`).first()).toBeVisible();
    // Honoured as written — no rewrite to a different half or a list — and
    // the ONLY entry: the state was empty for the beat the roster took, and
    // writing "/form" then pushing the real route would have left a junk Back
    // step underneath.
    await atPath(page, `/form/${GAME.id}/1sr`);
    expect(await page.goBack()).toBeNull();
  });

  test('the half in the URL is the half that opens', async ({ page }) => {
    await useDualGame(page);
    await page.goto(`/form/${GAME.id}/2sr`);

    await expect(formHeading(page)).toBeVisible();
    // On the 2. SR: the swap offers the 1. SR. The app's own guess for a dual
    // visit is to start on the 1. SR, so a form on the 2. SR can only have
    // come from the URL.
    await expect(switchTo(page, '1. SR')).toBeVisible();
    await atPath(page, `/form/${GAME.id}/2sr`);
  });

  test('swapping the half rewrites the URL without adding a Back step', async ({ page }) => {
    await useDualGame(page);
    await page.goto('/');
    await openFeedbackForm(page);
    await atPath(page, `/form/${GAME.id}/1sr`);

    await switchTo(page, '2. SR').click();
    await expect(switchTo(page, '1. SR')).toBeVisible();
    await atPath(page, `/form/${GAME.id}/2sr`);

    // Back leaves the form for the screen before it — not the 1. SR half.
    await page.goBack();
    await expect(formHeading(page)).toHaveCount(0);
    await atPath(page, '/games');
  });

  test('a game that is not on the list says so and lands on the games tab', async ({ page }) => {
    await page.goto('/form/g-nobody/1sr');

    await expect(page.getByText(/Game not found|Spiel nicht gefunden/)).toBeVisible();
    await expect(formHeading(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toHaveClass(/bg-slate-900/);
  });

  test('a filed observation keeps its record address, not a form one', async ({ page }) => {
    // The record's own route is covered in deep-links.spec.ts; this pins the
    // precedence: with a record open, the URL must not read /form/<game>.
    const RECORD = {
      id: 'fb1', role_assessed: '1. SR', rc_name: 'Anna Muster', submitted_at: '2026-03-15T10:00:00Z',
      feedback_json: { role: '1. SR', lang: 'EN', meta: { spielNr: GAME.matchNo }, sections: [], results: {}, signature: '', rcSignature: '' },
      expand: { game: { id: GAME.id, match_no: GAME.matchNo, league: GAME.league, match_date: '2026-11-15', location: GAME.location, home_team: GAME.homeTeam, away_team: GAME.awayTeam, first_referee: GAME.firstReferee, second_referee: '' } },
    };
    await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [RECORD] }));
    await page.goto('/feedbacks/c1/fb1');

    await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
    await atPath(page, '/feedbacks/c1/fb1');
    // And nothing was written underneath it while the record was loading.
    expect(await page.goBack()).toBeNull();
  });
});

test.describe('tabs are Back steps; views inside a tab are not', () => {
  test.beforeEach(async ({ page }) => { await stubSignedInApp(page); });

  test('Back and Forward walk the tabs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
    await atPath(page, '/games');
    await page.getByRole('button', { name: /^Coachees$/ }).click();
    await atPath(page, '/coachees');
    await expect(page.getByText(COACHEE_LISTED)).toBeVisible();

    await page.goBack();
    await expect(page.getByRole('button', { name: /^(Games|Spiele)$/ })).toHaveClass(/bg-slate-900/);
    await atPath(page, '/games');

    await page.goForward();
    await expect(page.getByRole('button', { name: /^Coachees$/ })).toHaveClass(/bg-slate-900/);
    await atPath(page, '/coachees');
  });

  test('the calendar view is in the URL and survives a reload', async ({ page }) => {
    await page.goto('/games');
    await page.getByTitle(/^(Calendar|Kalender)$/).click();
    await atPath(page, '/games?view=calendar');

    await page.reload();
    await expect(page.getByTitle(/^(Calendar|Kalender)$/)).toHaveClass(/bg-slate-900/);
    await atPath(page, '/games?view=calendar');
  });

  test('the calendar view is a Back step; paging its month is not', async ({ page }) => {
    await page.goto('/games');
    await page.getByTitle(/^(Calendar|Kalender)$/).click();
    await atPath(page, '/games?view=calendar');

    // Next month: the URL now names it, but Back must return to the LIST,
    // not to this month.
    await page.getByRole('button', { name: /^(Next month|Nächster Monat)$/ }).click();
    await atPathMatching(page, /\/games\?view=calendar&month=\d{4}-\d{2}$/);

    await page.goBack();
    await atPath(page, '/games');
    await expect(page.getByTitle(/^(Calendar|Kalender)$/)).not.toHaveClass(/bg-slate-900/);
  });
});

test.describe('the other roots', () => {
  test('the console opens on the tab the URL names, Verlauf included', async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    // The Protokoll tab reads five endpoints the catch-all answers with `[]`,
    // which is not their shape; give it empty logs rather than a crash.
    await page.route('**/api/admin/logs?*', (r) => r.fulfill({
      json: { entries: [], total: 0, lastSeq: 0, stats: { size: 0, max: 20000, fileSink: false, dir: '' } },
    }));
    await page.route('**/api/admin/logs/sessions', (r) => r.fulfill({ json: { sessions: [] } }));
    await page.route('**/api/admin/error-logs/dates', (r) => r.fulfill({ json: { today: '2026-09-13', dates: [] } }));
    await page.route('**/api/admin/error-logs/mute-rules', (r) => r.fulfill({ json: { rules: [] } }));
    await page.route('**/api/admin/error-logs?*', (r) => r.fulfill({
      json: { date: '2026-09-13', groups: [], scanned: 0, matched: 0, hidden: { solved: 0, muted: 0 }, source: 'file' },
    }));
    await page.goto('/admin/logs/history');

    const history = page.getByRole('button', { name: /^(History & errors|Verlauf & Fehler)$/ });
    await expect(history).toHaveClass(/bg-stone-800/);

    // Live/Verlauf is a toggle inside one tab: it rewrites the URL and is not
    // a Back step of its own.
    await page.getByRole('button', { name: /^Live$/ }).click();
    await atPath(page, '/admin/logs');
    await page.getByRole('button', { name: /^(Settings|Einstellungen)$/ }).click();
    await atPath(page, '/admin/settings');
    await page.goBack();
    await atPath(page, '/admin/logs');
    await page.goBack();
    // Past the console's first entry: nothing of the toggle is left to land on.
    await expect(page).not.toHaveURL(/\/admin\/logs\/history$/);
  });

  test('the guide pins its language in the path, replacing rather than pushing', async ({ page }) => {
    await page.goto('/guide/en');
    await expect(page.getByRole('heading', { name: /Video guide/ })).toBeVisible();

    await page.getByRole('button', { name: /^Deutsche Version$/ }).click();
    await expect(page.getByRole('heading', { name: /Video-Anleitung/ })).toBeVisible();
    await atPath(page, '/guide/de');

    const previous = await page.goBack();
    expect(previous).toBeNull();
  });
});
