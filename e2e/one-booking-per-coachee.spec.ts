import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// One open booking per coachee (asked 2026-09-30): a coach had planned a
// coachee for the 16th and a second coach still took the same coachee's game
// on the 26th — the take warned, but went through. Now the take button of a
// game whose every coachee is booked elsewhere is greyed, explains itself, and
// never reaches the server; the server refuses it too (source pin below).

/** The coachee's booking: GAME, held by another coach, report not sent. */
const BOOKED = { ...GAME, assignedRc: 'Carlos Castro', assignedRcId: 'rc-other' };
/** The same coachee on a later game nobody holds. */
const FREE = { ...GAME, id: 'g-free', matchNo: '2400777', date: '2026-11-26T19:30:00.000Z', assignedRc: '', assignedRcId: '' };
/** A game nobody holds whose 1. SR is nobody's coachee. */
const STRANGER = { ...FREE, id: 'g-stranger', matchNo: '2400778', homeTeam: 'VBC Fremd', firstReferee: 'Stranger, Sam', firstRefereeId: '999999', firstCoacheeId: '' };

async function openGames(page: Page, games: unknown[]): Promise<string[]> {
  const assigned: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: games }));
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/games');
  // By default the list hides the games of coachees already planned; the
  // coachee view shows them, so show them here too.
  await page.getByRole('button', { name: /Hide planned|Ohne Geplante/ }).click();
  return assigned;
}

test('a coachee booked on another game cannot be taken a second time', async ({ page }) => {
  const assigned = await openGames(page, [BOOKED, FREE]);
  await page.getByRole('button', { name: new RegExp(FREE.matchNo) }).first().click();

  const take = page.getByTestId('take-booked');
  await expect(take).toBeVisible();
  await expect(take).toHaveAttribute('aria-disabled', 'true');
  await take.dispatchEvent('click');
  await expect(page.getByText(/already has an observation booked|hat schon eine geplante Beobachtung/).first()).toBeVisible();
  await expect(page.getByText(/Carlos Castro/).first()).toBeVisible();
  expect(assigned).toHaveLength(0);
});

test('a game with no booked coachee is still taken as before', async ({ page }) => {
  const assigned = await openGames(page, [BOOKED, STRANGER]);
  await page.getByRole('button', { name: new RegExp(STRANGER.matchNo) }).first().click();
  await expect(page.getByTestId('take-booked')).toHaveCount(0);
  await page.getByRole('button', { name: /^(Take game|Spiel übernehmen)$/ }).click();
  await expect.poll(() => assigned.length).toBe(1);
});

// The server half: the tap from a stale screen. Composing it needs PocketBase,
// so it is pinned from the source, the way the other assign-rc specs do it.
test('the take endpoint refuses a coach whose coachee is booked elsewhere', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const start = server.indexOf("app.put('/api/games/:id/assign-rc'");
  const body = server.slice(start, server.indexOf('\napp.', start + 10));
  // Inside the coach's own take (rcAuth), before the write — not the admin path.
  const rcBranch = body.slice(body.indexOf('if (rcAuth) {'), body.indexOf('} else if (!givingBack) {'));
  expect(rcBranch).toContain('await openBookingBlocking(current)');
  expect(rcBranch).toMatch(/if \(blocking\) \{[\s\S]*?status: 409/);
});
