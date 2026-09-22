import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE } from './support/app';

/**
 * Sent is not finished, and Home says so in its layout, not only in its words.
 *
 * A report is filed the moment it is mailed, but it is only complete once the
 * coach's private note to the RC president is on it too. Such a row used to sit
 * under "Erledigte Beobachtungen" — a green heading a coach reads as nothing to
 * do here — wearing an amber line nobody scrolls to. It now has a section of
 * its own, above the rest, and the completed list counts only what is actually
 * completed.
 */

/** One Home done row, as /api/rc-overview/:rc/coachees sends it. `noted`
 *  undefined stands for an older server, which sent no such field at all. */
function doneRow(matchNo: string, teams: string, noted?: boolean) {
  return {
    feedbackId: `fb-${matchNo}`,
    gameId: `g-${matchNo}`,
    matchNo,
    gameDate: '2026-03-14 20:00:00.000Z',
    league: '3L',
    teams,
    location: 'Halle',
    role: '1. SR',
    submittedAt: '2026-03-14T21:00:00Z',
    result: '3:0',
    ...(noted === undefined ? {} : { hasPresidentNote: noted }),
  };
}

const AWAITING = doneRow('2345678', 'VBC Offen vs TV Offen', false);
const COMPLETED = doneRow('2345679', 'VBC Fertig vs TV Fertig', true);
const OLD_SERVER = doneRow('2345680', 'VBC Alt vs TV Alt');

const awaitingHead = (page: Page) => page.getByRole('heading', { name: /Abschluss ausstehend|Awaiting completion/ });
const completedHead = (page: Page) => page.getByRole('heading', { name: /Erledigte Beobachtungen|Completed observations/ });

/** The rows under a heading: h3 → the SectionHead div → the section itself. */
const rowsUnder = (head: ReturnType<typeof awaitingHead>) =>
  head.locator('xpath=ancestor::div[2]').getByTestId('game-row');

async function stubHome(page: Page, done: ReturnType<typeof doneRow>[]) {
  await stubSignedInApp(page);
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: done.length, outstanding: 0, planned: 0 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: COACHEE.id, coacheeName: COACHEE.full_name,
      doneFeedbacks: done, outstandingGames: [], plannedGames: [],
    }],
  }));
  await page.goto('/home');
}

test('a sent report without the president\'s note is listed apart, above the completed ones', async ({ page }) => {
  await stubHome(page, [AWAITING, COMPLETED]);

  await expect(rowsUnder(awaitingHead(page))).toHaveCount(1);
  await expect(rowsUnder(awaitingHead(page))).toContainText('VBC Offen');
  await expect(rowsUnder(completedHead(page))).toHaveCount(1);
  await expect(rowsUnder(completedHead(page))).toContainText('VBC Fertig');

  // Above, not merely elsewhere: the point of the section is that it is read
  // first.
  const awaitingY = await awaitingHead(page).boundingBox();
  const completedY = await completedHead(page).boundingBox();
  expect(awaitingY!.y).toBeLessThan(completedY!.y);
});

test('with nothing completed yet, the completed list says so rather than claiming nothing was filed', async ({ page }) => {
  await stubHome(page, [AWAITING]);

  await expect(rowsUnder(awaitingHead(page))).toHaveCount(1);
  await expect(page.getByText(/Noch nichts abgeschlossen\.|Nothing completed yet\./)).toBeVisible();
  await expect(page.getByText(/Noch keine Beobachtung erfasst\.|No observations filed yet\./)).toHaveCount(0);
});

test('a row from an older server, which knows no notes, still reads as completed', async ({ page }) => {
  await stubHome(page, [OLD_SERVER]);

  await expect(awaitingHead(page)).toHaveCount(0);
  await expect(rowsUnder(completedHead(page))).toHaveCount(1);
  await expect(rowsUnder(completedHead(page))).toContainText('VBC Alt');
});
