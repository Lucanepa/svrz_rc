import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';
import { takenAfterReminder, reminderDeadlineOf } from '../src/lib/reminder';

// Taking a game never told its referees anything: the day-before reminder does
// that, at 10:00, and only for the games taken by then. A coach who took
// tomorrow's game at lunchtime — or tonight's on the way to the gym — had a
// referee who would be surprised in the hall. Now the take itself says so, asks,
// and mails on confirmation, through the same endpoint as Home's "Erinnerung".

/** Free to take; kicks off 15.11.2026 at 20:30 in the gym (19:30Z). Its own
 *  number: a clone that kept GAME's would be a second game under one match
 *  number, and the form URL is that number now. */
const FREE = { ...GAME, id: 'g-free', matchNo: '2400777', assignedRc: '' };

const LATE_NOW = new Date('2026-11-14T11:00:00Z');   // 12:00 Zürich on the eve — the 10:00 run is over
const EARLY_NOW = new Date('2026-11-14T08:00:00Z');  // 09:00 Zürich on the eve — the run is still to come

/** Record what reached the server, land on the Games tab with the clock set. */
async function openGames(page: Page, now: Date): Promise<{ assigned: string[]; reminded: string[] }> {
  const assigned: string[] = [];
  const reminded: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/games/*/reminder', async (r) => {
    reminded.push(r.request().url());
    await r.fulfill({ json: { sent: 1, suppressed: false, recipients: ['ref.one@example.ch'] } });
  });
  await page.clock.setFixedTime(now);
  await page.goto('/games');
  // The row folds its actions away; the take button is inside.
  await page.getByRole('button', { name: new RegExp(FREE.homeTeam) }).first().click();
  await expect(page.getByRole('button', { name: /Take game|Spiel übernehmen/ })).toBeVisible();
  return { assigned, reminded };
}

test('a take after the 10:00 run asks first, then takes AND mails', async ({ page }) => {
  const { assigned, reminded } = await openGames(page, LATE_NOW);

  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();

  // Nothing has happened yet: the mail cannot be unsent, so the coach is told
  // what the take will do — which game, and that the SR hear about it now.
  const notice = page.getByTestId('take-notice');
  await expect(notice).toBeVisible();
  await expect(page.getByTestId('take-notice-late')).toContainText(`${FREE.homeTeam} vs ${FREE.awayTeam}`);
  await expect(page.getByTestId('take-notice-late')).toContainText(/straight away|sofort/);
  expect(assigned).toHaveLength(0);
  expect(reminded).toHaveLength(0);

  await page.getByRole('button', { name: /Take & inform|Übernehmen & informieren/ }).click();

  // The take lands first, the reminder follows — one mail, for this game.
  await expect.poll(() => assigned.length).toBe(1);
  await expect.poll(() => reminded.length).toBe(1);
  expect(reminded[0]).toContain(`/api/games/${FREE.id}/reminder`);
  await expect(page.getByText(/informed by e-mail|per E-Mail informiert/)).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test('Cancel on that dialog takes nothing and mails nobody', async ({ page }) => {
  const { assigned, reminded } = await openGames(page, LATE_NOW);

  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();
  await expect(page.getByTestId('take-notice')).toBeVisible();
  await page.getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();

  await expect(page.getByTestId('take-notice')).toHaveCount(0);
  expect(assigned).toHaveLength(0);
  expect(reminded).toHaveLength(0);
  // Still free to take — the row did not change under the coach.
  await expect(page.getByRole('button', { name: /Take game|Spiel übernehmen/ })).toBeVisible();
});

test('a take before the 10:00 run goes straight through, and leaves the mail to the job', async ({ page }) => {
  const { assigned, reminded } = await openGames(page, EARLY_NOW);

  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();

  await expect.poll(() => assigned.length).toBe(1);
  await expect(page.getByTestId('take-notice')).toHaveCount(0);
  expect(reminded).toHaveLength(0);
});

test('a failed mail is reported as a failed mail — the take stands', async ({ page }) => {
  const { assigned } = await openGames(page, LATE_NOW);
  await page.route('**/api/games/*/reminder', (r) => r.fulfill({
    status: 422, json: { error: 'Keine Empfänger: die SR dieses Spiels sind keine Coachees dieser Saison (oder haben keine E-Mail).' },
  }));

  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();
  await page.getByRole('button', { name: /Take & inform|Übernehmen & informieren/ }).click();

  await expect.poll(() => assigned.length).toBe(1);
  await expect(page.getByText(/did not go out|ging aber nicht raus/)).toBeVisible();
  await expect(page.getByText(/Keine Empfänger/)).toBeVisible();
});

/**
 * The rule itself, in Zürich time whatever zone the process runs in. The
 * deadline is 10:00 on the day BEFORE the game; the window closes at kick-off.
 */
test.describe('takenAfterReminder', () => {
  const kickoff = '2026-11-15T19:30:00Z'; // 20:30 CET in the gym
  const at = (iso: string) => new Date(iso).getTime();

  test('the deadline is 10:00 Zürich on the eve', () => {
    expect(new Date(reminderDeadlineOf(kickoff)!).toISOString()).toBe('2026-11-14T09:00:00.000Z'); // CET
    expect(new Date(reminderDeadlineOf('2026-09-21 18:45:00.000Z')!).toISOString()).toBe('2026-09-20T08:00:00.000Z'); // CEST
  });

  test('before the run: not late; after it: late; after the whistle: not late', () => {
    expect(takenAfterReminder(kickoff, at('2026-11-14T08:59:00Z'))).toBe(false); // 09:59, the run is still to come
    expect(takenAfterReminder(kickoff, at('2026-11-14T09:00:00Z'))).toBe(true);  // 10:00 sharp — the run has fired
    expect(takenAfterReminder(kickoff, at('2026-11-15T18:00:00Z'))).toBe(true);  // an hour before the whistle
    expect(takenAfterReminder(kickoff, at('2026-11-15T19:30:00Z'))).toBe(false); // whistled — bookkeeping now
    expect(takenAfterReminder(kickoff, at('2026-11-10T12:00:00Z'))).toBe(false); // days ahead
  });

  test('a game with a date but no time counts as ahead for its whole day', () => {
    expect(takenAfterReminder('2026-11-15', at('2026-11-15T20:00:00Z'))).toBe(true);
    expect(takenAfterReminder('2026-11-15', at('2026-11-15T23:30:00Z'))).toBe(false); // 00:30 the 16th in Zürich
  });

  test('an unreadable date is never late', () => {
    expect(takenAfterReminder('', at('2026-11-14T12:00:00Z'))).toBe(false);
    expect(takenAfterReminder('not a date', at('2026-11-14T12:00:00Z'))).toBe(false);
  });
});
