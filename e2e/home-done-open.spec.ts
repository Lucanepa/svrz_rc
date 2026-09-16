import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE, COACHEE_UNLINKED } from './support/app';

/**
 * Home's "Erledigte Beobachtungen" rows open the record they stand for.
 *
 * A row used to carry no record id, so the tap fetched the coachee's records
 * and took the first one from that day. Two observations of one coachee on
 * one day — a tournament afternoon, the same role in two halls — were two rows
 * that both opened the first record, and the second observation could not be
 * reached from Home at all. The summary now sends `feedbackId` beside each
 * row, and that id is what opens; the day match stays for a row an older
 * server sends without one.
 */

/** A filed observation, with the match number as the one field the reopened
 *  form shows that tells two same-day records apart. */
function record(id: string, matchNo: string, teams: [string, string], time: string) {
  return {
    id,
    role_assessed: '1. SR',
    rc_name: RC.name,
    rc_id: RC.id,
    submitted_at: `2026-03-14T${time}:00Z`,
    feedback_json: {
      role: '1. SR', lang: 'EN',
      meta: {
        spielNr: matchNo, liga: '3L', datum: '14.03.2026', ort: 'Halle',
        mannschaften: teams.join(' vs '), ergebnis: '3:0', srName: COACHEE.full_name,
        srNiveau: 'N3', rc: RC.name, gruppe: 'B',
      },
      sections: [],
      results: { motivation: 'up', einstufung: 'check', bemerkungen: `Spiel ${matchNo}`, srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
      signature: '', rcSignature: '',
    },
    expand: {
      game: {
        id: `g-${matchNo}`, match_no: matchNo, league: '3L', match_date: `2026-03-14 ${time}:00.000Z`,
        location: 'Halle', home_team: teams[0], away_team: teams[1],
        first_referee: COACHEE.full_name, second_referee: '',
      },
    },
  };
}

const MORNING = record('fb-morning', '2345678', ['VBC Morgen', 'TV Früh'], '09:00');
const AFTERNOON = record('fb-afternoon', '2345679', ['VBC Nachmittag', 'TV Spät'], '14:00');

/** One Home row per filed record, as /api/rc-overview/:rc/coachees sends it. */
function doneRow(r: typeof MORNING, withId: boolean) {
  const g = r.expand.game;
  return {
    gameDate: g.match_date, league: g.league, teams: `${g.home_team} vs ${g.away_team}`,
    role: r.role_assessed, submittedAt: r.submitted_at, result: '3:0',
    ...(withId ? { feedbackId: r.id, gameId: g.id, matchNo: g.match_no } : {}),
  };
}

async function stubHome(page: Page, withIds: boolean) {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [MORNING, AFTERNOON] }));
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 2, outstanding: 0, planned: 0 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: COACHEE.id, coacheeName: COACHEE.full_name,
      doneFeedbacks: [doneRow(MORNING, withIds), doneRow(AFTERNOON, withIds)],
      outstandingGames: [], plannedGames: [],
    }],
  }));
  await page.goto('/home');
}

/** The reopened form's match-number field: which record is on screen. */
const openedMatchNo = (page: Page, matchNo: string) => page.locator(`input[value="${matchNo}"]`).first();

test('two observations of one coachee on one day each open their own record', async ({ page }) => {
  await stubHome(page, true);

  // The rows name the game by its number, the way the coach does.
  await expect(page.getByText(`#${MORNING.expand.game.match_no}`)).toBeVisible();
  await expect(page.getByText(`#${AFTERNOON.expand.game.match_no}`)).toBeVisible();

  // The second one first — the one the day match could never reach.
  await page.getByRole('button', { name: /VBC Nachmittag/ }).click();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(openedMatchNo(page, AFTERNOON.expand.game.match_no)).toBeVisible();
  await expect(openedMatchNo(page, MORNING.expand.game.match_no)).toHaveCount(0);

  await page.getByRole('button', { name: /^(Back|Zurück)$/ }).click();
  await page.getByRole('button', { name: /^(Home|Start)$/ }).click();
  await page.getByRole('button', { name: /VBC Morgen/ }).click();
  await expect(openedMatchNo(page, MORNING.expand.game.match_no)).toBeVisible();
  await expect(openedMatchNo(page, AFTERNOON.expand.game.match_no)).toHaveCount(0);
});

test('the opened record is addressed under ITS coachee, and the address reopens it', async ({ page }) => {
  // The record's address is written from the selected coachee. Opened from
  // Home, nothing had selected the record's coachee — so the bar named
  // whoever was looked at last (here: the unlinked colleague whose games
  // were open before), or nobody at all (a bare `/form`), and a reload or a
  // shared link of that address found no such record under that person.
  await stubHome(page, true);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_UNLINKED] }));
  await page.goto(`/games/${COACHEE_UNLINKED.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(COACHEE_UNLINKED.full_name) })).toBeVisible();
  await page.getByRole('button', { name: /^(Back|Zurück)$/ }).click();
  await page.getByRole('button', { name: /^(Home|Start)$/ }).click();

  await page.getByRole('button', { name: /VBC Nachmittag/ }).click();
  await expect(openedMatchNo(page, AFTERNOON.expand.game.match_no)).toBeVisible();
  // COACHEE's SV number, the shape a linked coachee is addressed by — not
  // the colleague's record id, not `/form`.
  await expect(page).toHaveURL(new RegExp(`/feedbacks/${COACHEE.referee_id}/${AFTERNOON.id}$`));

  await page.reload();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(openedMatchNo(page, AFTERNOON.expand.game.match_no)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feedbacks/${COACHEE.referee_id}/${AFTERNOON.id}$`));
});

test('a row carrying an id the coachee no longer has says so instead of opening a neighbour', async ({ page }) => {
  await stubHome(page, true);
  // The record went (deleted in the console) between the summary and the tap.
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [MORNING] }));

  await page.getByRole('button', { name: /VBC Nachmittag/ }).click();
  await expect(page.getByText(/Observation not found|Beobachtung nicht gefunden/)).toBeVisible();
  await expect(openedMatchNo(page, MORNING.expand.game.match_no)).toHaveCount(0);
});

test('a row from an older server, without an id, still opens by its day', async ({ page }) => {
  await stubHome(page, false);

  // No number on the row — the older server sent none — and the day match
  // finds the first record of that day, as it always did.
  await expect(page.getByText(`#${MORNING.expand.game.match_no}`)).toHaveCount(0);
  await page.getByRole('button', { name: /VBC Morgen/ }).click();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(openedMatchNo(page, MORNING.expand.game.match_no)).toBeVisible();
});
