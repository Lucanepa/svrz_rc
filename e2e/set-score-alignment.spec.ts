import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * The set scores of a played game, drawn one row per team.
 *
 * `tabular-nums` was doing half the job: it makes every DIGIT the same width,
 * but a single-digit set is still one character where a two-digit set is two.
 * So "10 | 8 | 15" above "25 | 25 | 25" put the two rows' separators in
 * different places, and the column of numbers read as ragged rather than as a
 * scoreboard. Each score now sits in a cell as wide as the widest score in the
 * match, so the pipes meet whatever the digits do.
 *
 * Measured rather than asserted on classes: a width that is right in the
 * stylesheet and wrong on screen is exactly the bug, and only geometry catches
 * a cell the font quietly overflows.
 */

// 0:3, and every kind of digit count in one match: one-digit, two-digit, and a
// three-digit score that no real set reaches but the layout must still survive.
const RESULT = '0:3 (10:25 / 8:25 / 15:25)';

const listGame = (over: Record<string, unknown> = {}) => ({
  id: 'g1', matchNo: '418351', league: 'Züri Cup',
  date: '2026-09-10T18:00:00Z', location: 'Gesamtschule In der Höh, Volketswil',
  homeTeam: 'Volleyball-Club Volketswil', awayTeam: 'VBC Wetzikon D3',
  firstReferee: 'Kevin León Peña de los Santos', secondReferee: '',
  assignedRc: '', feedbackClosedRoles: [], starred: false, vmFlagged: false,
  game_result: RESULT,
  ...over,
});

async function gamesTab(page: Page, over: Record<string, unknown> = {}) {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [listGame(over)] }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).first().click();
}

/**
 * Every separator's box, in document order.
 *
 * There is exactly one copy of each: TeamPair reflows with grid `order` rather
 * than rendering both layouts and hiding one, so nothing here is
 * `display: none` and no box comes back null. The guard stays anyway — it costs
 * a line and it is the difference between this failing and it silently
 * measuring a hidden node if that ever changes.
 */
async function pipeBoxes(page: Page) {
  const pipes = page.locator('span[aria-hidden]', { hasText: /^\|$/ });
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < await pipes.count(); i += 1) {
    const box = await pipes.nth(i).boundingBox();
    if (box) out.push({ x: Math.round(box.x), y: Math.round(box.y) });
  }
  return out;
}

/** Left edge of every visible separator, in document order. */
async function pipeXs(page: Page): Promise<number[]> {
  return (await pipeBoxes(page)).map((b) => b.x);
}

test('the separators line up between the two rows, whatever the digits do', async ({ page }) => {
  await gamesTab(page);
  const xs = await pipeXs(page);
  // Two sets of separators — two per row, three sets.
  expect(xs).toHaveLength(4);
  const [home1, home2, away1, away2] = xs;
  // The home row has a one-digit set in it (8) and the away row has none; this
  // is the exact pairing that used to drift.
  expect(Math.abs(home1 - away1)).toBeLessThanOrEqual(1);
  expect(Math.abs(home2 - away2)).toBeLessThanOrEqual(1);
});

test('a three-digit score widens every cell rather than breaking the column', async ({ page }) => {
  await gamesTab(page, { game_result: '0:3 (10:25 / 8:25 / 100:25)' });
  const xs = await pipeXs(page);
  expect(xs).toHaveLength(4);
  expect(Math.abs(xs[0] - xs[2])).toBeLessThanOrEqual(1);
  expect(Math.abs(xs[1] - xs[3])).toBeLessThanOrEqual(1);
});

test('a game with no result draws no scoreboard at all', async ({ page }) => {
  await gamesTab(page, { game_result: '' });
  expect(await pipeXs(page)).toHaveLength(0);
});

/**
 * On a phone the numbers move off the team lines entirely.
 *
 * A club name wraps to three lines in a ~120px column and the score was
 * squeezed into what was left. Below `sm` the two rows of numbers sit in a row
 * of their own under the names — same order, home above away, so which line
 * belongs to which team still reads off the block above it.
 */
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the scores sit below the team names, not beside them', async ({ page }) => {
    await gamesTab(page);
    const awayBox = await page.getByText('VBC Wetzikon D3').first().boundingBox();
    const boxes = await pipeBoxes(page);
    expect(boxes).toHaveLength(4);
    // Below the LAST team name — i.e. past both of them, not level with either.
    expect(boxes[0].y).toBeGreaterThan(awayBox!.y);
  });

  test('and they are still aligned down there', async ({ page }) => {
    await gamesTab(page);
    const xs = await pipeXs(page);
    expect(Math.abs(xs[0] - xs[2])).toBeLessThanOrEqual(1);
    expect(Math.abs(xs[1] - xs[3])).toBeLessThanOrEqual(1);
  });
});
