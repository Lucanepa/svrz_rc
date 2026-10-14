import { test, expect, type Page } from '@playwright/test';
import { computePlanning } from '../server/planning';
import { stubSignedInApp, COACHEE, GAME } from './support/app';

// Three things a phone made hard (Luca, 2026-10-14):
//  - every tab shares the window's one scroll, so a switch carried the old
//    tab's offset over and a shorter tab clamped it to its own bottom: each
//    switch landed at the foot of the next page. A tab now opens where it was
//    left, or at the top the first time — in the console and in the app;
//  - the console's game list scrolled inside a box under the search and the
//    toggles, a third of a phone's screen; there the page scrolls instead;
//  - a coachee row's three buttons stood beside the details and cut every
//    line short; on a phone they are a row of their own, under all of it.

const MANY = Array.from({ length: 60 }, (_, i) => ({
  ...COACHEE,
  id: `c${i}`,
  full_name: `Ref ${String(i).padStart(2, '0')}`,
  referee_id: String(91000 + i),
  season: 2026,
}));

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** Scrolls as a hand would leave it: no smooth animation still running when
 *  the next step reads the offset, and the scroll event delivered. */
async function scrollTo(page: Page, top: number) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
  await expect.poll(() => scrollY(page)).toBe(top);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('a console tab opens where it was left, or at the top the first time', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: MANY }));
  await page.goto('/admin/coachees');
  await expect(page.getByText('59, Ref')).toBeAttached();

  await scrollTo(page, 1500);
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect.poll(() => scrollY(page)).toBe(0);

  await scrollTo(page, 200);
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect.poll(() => scrollY(page)).toBe(1500);

  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect.poll(() => scrollY(page)).toBe(200);

  // Back steps between tabs too, and lands where each was left.
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/coachees$/);
  await expect.poll(() => scrollY(page)).toBe(1500);
});

test('a game opened from Planung opens Spiele at the top, on that game', async ({ page }) => {
  const games = Array.from({ length: 30 }, (_, i) => ({ ...GAME, id: `g${i}`, matchNo: String(406800 + i), assignedRc: '' }));
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: games }));
  await page.route('**/api/admin/planning*', (r) => r.fulfill({ json: computePlanning({
    season: 2026, now: '2026-10-15T10:00:00.000Z',
    coachees: [{ id: 'c1', name: 'Ref One', groups: 'Varia', level: 'N3', stage: '2', observed: 0, furtherWanted: false }],
    games: [{ id: 'g7', matchNo: '406807', date: '2026-11-01T19:00:00.000Z', label: 'Home – Away', rc: 'Anna Muster', closedRoles: [], feedbackRoles: [], isRcGame: false, offeredRoles: [],
      slots: [{ role: '1. SR', name: 'Ref One', coacheeId: 'c1' }, { role: '2. SR', name: '', coacheeId: '' }] }],
  }) }));
  await page.goto('/admin/games');
  await expect(page.getByText('#406829')).toBeAttached();
  await scrollTo(page, 400);

  await page.getByRole('button', { name: /^(Planung|Planning)$/ }).click();
  await page.getByTestId('planning-row').getByRole('button', { name: /406807/ }).click();
  await expect(page.getByPlaceholder(/Spiel, Team, Liga|Search game, team/)).toHaveValue('406807');
  // Not the offset the whole list was left at: the list is one game now.
  await expect.poll(() => scrollY(page)).toBe(0);
});

test('an app tab opens where it was left, or at the top the first time', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: MANY }));
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: /Hauptnavigation|Main navigation/ });

  await nav.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText('49, Ref').first()).toBeAttached();
  await scrollTo(page, 1200);

  await nav.getByRole('button', { name: /^(Start|Home)$/ }).click();
  await expect.poll(() => scrollY(page)).toBe(0);

  await nav.getByRole('button', { name: /^Coachees$/ }).click();
  await expect.poll(() => scrollY(page)).toBe(1200);
});

test('the console game list is the page on a phone, a box of its own beside the rail', async ({ page, isMobile }) => {
  await stubSignedInApp(page, { admin: true });
  await page.goto('/admin/games');
  const row = page.getByText(`#${GAME.matchNo}`);
  await expect(row).toBeVisible();
  // The nearest ancestor that scrolls on its own, if any short of the page.
  const box = await row.evaluate((el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const y = getComputedStyle(n).overflowY;
      if (y === 'auto' || y === 'scroll') return true;
    }
    return false;
  });
  expect(box).toBe(!isMobile);
});

test('a coachee row keeps its buttons under the details on a phone', async ({ page, isMobile }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [{ ...COACHEE, season: 2026 }] }));
  await page.goto('/admin/coachees');
  const row = page.locator(`[data-coachee-row="${COACHEE.id}"]`);
  await expect(row).toBeVisible();

  const details = await row.getByText(COACHEE.email).boundingBox();
  const target = await row.getByText(/^(Fokus-Spiele|Focused games):$/).boundingBox();
  const actions = await row.locator('[data-coachee-actions]').boundingBox();
  if (!details || !target || !actions) throw new Error('row not laid out');

  if (isMobile) {
    // Under everything, the target line included, and the details get the
    // row's whole width.
    expect(actions.y).toBeGreaterThanOrEqual(target.y + target.height);
  } else {
    // Beside the details, above the target line that runs under both.
    expect(actions.y + actions.height).toBeLessThanOrEqual(target.y + 1);
    expect(actions.x).toBeGreaterThan(details.x + details.width);
  }
});
