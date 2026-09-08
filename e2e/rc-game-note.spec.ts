import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * 4.4.10 SR-Spiel. A coach who whistled next to a coachee writes a short
 * Rückmeldung instead of a Feedbackformular, and that note is addressed to the
 * RC-Präsidium alone. Both halves of that promise are asserted here: what the
 * coach is told before they write, and the fact that no other coach's screen
 * ever asks for it.
 */

const SR_GAME = {
  gameId: 'g-sr',
  matchNo: '2400777',
  league: '3L',
  gameDate: '2026-10-11T18:00:00Z',
  location: 'Sporthalle Buchlern',
  mapsUrl: '',
  teams: 'VBC Uni Bern vs Volley Top Luzern',
  result: '3:1',
  rcRole: '2. SR',
  coacheeName: 'Ref One',
  coacheeId: 'c1',
  coacheeRole: '1. SR',
  note: null,
};

/** Filed by somebody else about the same referee — the row a colleague must not see. */
const OTHER_NOTE = {
  id: 'n-other',
  gameId: 'g-sr-earlier',
  rcId: 'rc9',
  rcName: 'Bea Beispiel',
  rcRole: '1. SR',
  coacheeId: 'c1',
  coacheeName: 'Ref One',
  coacheeRole: '2. SR',
  note: 'Am zweiten Pfiff aufmerksam, beim Aufstellungswechsel zu schnell.',
  submittedAt: '2026-09-15T20:00:00Z',
  matchNo: '2400111',
  league: '3L',
  gameDate: '2026-09-14T18:00:00Z',
  teams: 'TSV Jona vs VBC Einsiedeln',
};

const openSrGame = (page: Page) => page.getByRole('button', { name: /VBC Uni Bern/ }).first();

test('the coach is told the Rückmeldung goes to the chair alone, and it is sent', async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/rc-games*', (r) => r.fulfill({ json: [SR_GAME] }));
  await page.route('**/api/rc-game-notes', async (r) => {
    posted.push(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({
      json: {
        ...OTHER_NOTE, id: 'n-mine', gameId: SR_GAME.gameId,
        rcId: RC.id, rcName: RC.name, note: 'Sicher geleitet, klare Zeichen.',
      },
    });
  });

  await page.goto('/');
  await openSrGame(page).click();

  // The one thing the coach must know before typing: who reads this.
  await expect(page.getByText(/nur an das RC-Präsidium|to the RC chair alone/)).toBeVisible();
  await expect(page.getByText(/weder der Schiedsrichter noch die anderen Referee Coaches|neither the referee nor the other referee coaches/)).toBeVisible();

  await page.getByLabel(/Deine Rückmeldung|Your note/).fill('Sicher geleitet, klare Zeichen.');
  await page.getByRole('button', { name: /^(Senden|Send)$/ }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].gameId).toBe(SR_GAME.gameId);
  expect(posted[0].note).toBe('Sicher geleitet, klare Zeichen.');
  expect(posted[0].rolesSwapped).toBe(false);
  // Filed, so the game stops asking. It leaves the open list entirely and
  // waits behind "show past games" — the section exists to ask for the notes
  // that have NOT been written, and a filed one staying in it is a row to
  // scroll past for the rest of the season.
  await expect(page.getByText(/Keine offene Rückmeldung|No note outstanding/)).toBeVisible();
  const past = page.getByRole('button', { name: /Erledigte anzeigen \(1\)|Show past games \(1\)/ });
  await expect(past).toBeVisible();

  // And it is still reachable there, marked as filed.
  await past.click();
  await expect(page.getByText(/Erfasst|Filed/)).toBeVisible();
});

test("a colleague's Rückmeldung is never fetched for the coachee's page", async ({ page }) => {
  const asked: string[] = [];
  await stubSignedInApp(page);
  // Answered generously on purpose: if the page still asks, it gets a note back
  // and the assertion below fails on the text rather than on an empty stub.
  await page.route('**/api/rc-game-notes*', async (r) => {
    asked.push(r.request().url());
    await r.fulfill({ json: [OTHER_NOTE] });
  });
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({ json: [] }));

  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByRole('heading', { name: /Ref One/ })).toBeVisible();
  await expect(page.getByText(OTHER_NOTE.note)).toHaveCount(0);
  await expect(page.getByText(/Rückmeldungen aus SR-Spielen|Notes from games they refereed/)).toHaveCount(0);
  expect(asked).toEqual([]);
});

test('a 7.3 swap corrects the roles on the note and is reported with it', async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/rc-games*', (r) => r.fulfill({ json: [SR_GAME] }));
  await page.route('**/api/rc-game-notes', async (r) => {
    posted.push(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({ json: { ...OTHER_NOTE, id: 'n-mine', gameId: SR_GAME.gameId, rcId: RC.id, rcName: RC.name } });
  });

  await page.goto('/');
  await openSrGame(page).click();

  // The fixture says the coach was 2. SR and the coachee 1. SR.
  await expect(page.getByText(`${RC.name} (2. SR)`)).toBeVisible();
  await expect(page.getByText(`${SR_GAME.coacheeName} (1. SR)`)).toBeVisible();

  await page.getByRole('checkbox').check();

  // Ticking the box swaps what the dialog shows, so the coach can see it is now
  // describing the evening they actually had.
  await expect(page.getByText(`${RC.name} (1. SR)`)).toBeVisible();
  await expect(page.getByText(`${SR_GAME.coacheeName} (2. SR)`)).toBeVisible();

  await page.getByLabel(/Deine Rückmeldung|Your note/).fill('Tausch abgesprochen, lief gut.');
  await page.getByRole('button', { name: /^(Senden|Send)$/ }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].rolesSwapped).toBe(true);
});
