import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubSignedInApp, openFeedbackForm, signOpenPad, fillWholeForm, GAME } from './support/app';

const SERVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.ts'), 'utf8');

/**
 * A game taken for two referees is TWO observations of two people.
 *
 * What went wrong on 22.09.2026, on one evening's game: the coach filed the
 * 2. SR's report, went back into the same game for the 1. SR, and found the
 * 2. SR's signature — and everything else written about them — sitting on the
 * other referee's form. The form was carried across wholesale because the GAME
 * had not changed. And with one send button for the pair, "I am finished with
 * this one" had no way to say so.
 */

const GAME_2SR = { ...GAME, secondReferee: 'Ref Two' };

const rcSig = (page: Page) => page.getByAltText(/^(Referee Coach signature|Unterschrift Referee Coach)$/);
const refereeSig = (page: Page) => page.getByAltText(/^(Referee signature|Unterschrift Schiedsrichter)$/);
const targetButton = (page: Page, name: RegExp) =>
  page.getByRole('group', { name: /Observation for|Beobachtung f/ }).getByRole('button', { name });
const signAs = async (page: Page, who: 'referee' | 'rc') => {
  await page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).nth(who === 'referee' ? 0 : 1).click();
  await signOpenPad(page);
};
const confirmSend = (page: Page) => page.getByRole('button', { name: /^(Speichern|Save)$/ }).last();

async function open2SrGame(page: Page) {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_2SR] }));
  await page.goto('/');
  await openFeedbackForm(page);
}

test('the other referee of the same game starts on an empty form', async ({ page }) => {
  await open2SrGame(page);
  // Write and sign the 2. SR's report, as a coach does at the hall.
  await targetButton(page, /^2SR/).click();
  await signAs(page, 'referee');
  await signAs(page, 'rc');
  await expect(refereeSig(page)).toBeVisible();

  // Back into the SAME game from the list: the app opens the coachee's half.
  // Not openFeedbackForm — the held-games filter is already on from the first
  // time, and pressing it again would put the row back out of reach.
  await page.getByRole('button', { name: /^(Back|Zurück)$/ }).click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByText(GAME.homeTeam).first().click();
  await page.getByRole('button', { name: /Start observation|Beobachtung starten/ }).click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();

  // Nothing of the other referee may be here. Their ink above all: it would
  // satisfy the mandatory-signature gate and go out under this name.
  await expect(refereeSig(page)).toHaveCount(0);
  // The coach, though, signed the visit and does not sign twice.
  await expect(rcSig(page)).toBeVisible();
});

test.slow();
test('each referee has a send of their own, and one going does not take the other', async ({ page }) => {
  await open2SrGame(page);
  await targetButton(page, /^(Both|Beide)$/).click();

  const send1 = page.getByTestId('send-1sr');
  const send2 = page.getByTestId('send-2sr');
  await expect(send1).toBeVisible();
  await expect(send2).toBeVisible();
  // The other half has not been written yet, so it cannot be sent by mistake.
  await expect(send2).toBeDisabled();

  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/feedback/submit', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: 'fb-1sr', emailSent: true } });
  });
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));

  await fillWholeForm(page);
  await send1.click();
  await confirmSend(page).click();

  // Exactly one report went, and it is the one whose button was pressed.
  await expect.poll(() => posted.length, { timeout: 15000 }).toBe(1);
  expect(posted[0].role).toBe('1. SR');
});

test('a goal that says nothing is not a goal', async ({ page }) => {
  await open2SrGame(page);
  await fillWholeForm(page);
  // A dash is what gets typed to get past a required field; the goal is handed
  // to the next coach and has to say something.
  await page.getByRole('heading', { name: /Referee Goal|SR-Ziel/ }).locator('xpath=..').locator('input').fill('-');
  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await expect(page.getByText(/Bitte alle Felder im unteren Bereich|Please fill in all bottom fields/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Save feedback|Feedback speichern/ })).toHaveCount(0);

  // Say something and it goes.
  await page.getByRole('heading', { name: /Referee Goal|SR-Ziel/ }).locator('xpath=..').locator('input').fill('N3 halten');
  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await expect(page.getByRole('heading', { name: /Save feedback|Feedback speichern/ })).toBeVisible();
});

test.slow();
test('filing one referee\'s report leaves the other referee\'s form open', async ({ page }) => {
  await open2SrGame(page);
  await targetButton(page, /^(Both|Beide)$/).click();
  await page.route('**/api/feedback/submit', (r) => r.fulfill({ status: 201, json: { id: 'fb-1sr', emailSent: true } }));
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));

  await fillWholeForm(page);
  await page.getByTestId('send-1sr').click();
  await confirmSend(page).click();

  // The other half is a report nobody has written yet. It used to inherit the
  // first one's ending — one lock for the whole visit, and the filed record
  // left on screen — so a coach who had filed one referee could neither edit
  // nor send the other, on a form that read as submitted.
  await page.getByRole('button', { name: /^(Switch to|Wechseln zu) 2\. SR$/ }).click();
  await expect(page.getByText(/Feedback eingereicht|Feedback submitted/)).toHaveCount(0);
  await expect(page.getByTestId('send-2sr')).toBeVisible();
  // And it is a form again: its pads take ink.
  await expect(page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).first()).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Who is a coachee is decided by the season's imported list and by the admin
// console — never by a report happening to name somebody. Pinned from the
// server's source: the route needs PocketBase, and there is none here.
// ---------------------------------------------------------------------------

test.describe('A report never makes anybody a coachee (source)', () => {
  const start = SERVER.indexOf("app.post('/api/feedback/submit'");
  const submit = SERVER.slice(start, SERVER.indexOf('\n});\n', start));

  test('a real fixture resolves the referee in THIS season only', () => {
    expect(submit).toContain('{ strictSeason: !onManualGame }');
    // A Testspiel is the documented exception: it is on every season's list.
    expect(submit).toContain('const onManualGame = manualGameIds.has(String(game.id));');
  });

  test('and a referee who is not on it is filed against no coachee at all', () => {
    // The register fallback — the branch a not-found lookup lands in — writes
    // an empty relation, so nothing is counted on anybody.
    expect(submit).toContain("coachee: coachee ? coachee.id : ''");
  });

  test('the lookup itself has both doors closed under strictSeason', () => {
    const fn = SERVER.slice(SERVER.indexOf('async function findCoacheeRecord'), SERVER.indexOf('\n}\n', SERVER.indexOf('async function findCoacheeRecord')));
    expect(fn).toContain('opts.strictSeason ? coachees.find(season, query) : coachees.findOrNewest(season, query)');
    // The by-name fallback under it is the second door onto another season.
    expect(fn).toContain("opts.strictSeason && season != null");
  });
});
