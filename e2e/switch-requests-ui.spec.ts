import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME, RC, COACHEE } from './support/app';

// Switch requests in the app (asked 2026-10-10): on a game whose coachee is
// already booked by another coach on a LATER game, "Spiel übernehmen" becomes
// "Tausch anfragen"; once asked it says so; and the holder answers on Home.

/** The coachee's booking: GAME (15.11.), held by another coach. */
const BOOKED = { ...GAME, assignedRc: 'Carlos Castro', assignedRcId: 'rc-other' };
/** The same coachee on an EARLIER game nobody holds. */
const EARLIER = { ...GAME, id: 'g-early', matchNo: '2400555', date: '2026-11-08T19:30:00.000Z', homeTeam: 'VBC Früh', assignedRc: '', assignedRcId: '' };

const brief = (g: typeof GAME) => ({ id: g.id, matchNo: g.matchNo, date: g.date, teams: `${g.homeTeam} – ${g.awayTeam}`, league: g.league, location: g.location });
const request = (over: Record<string, unknown> = {}) => ({
  id: 'sw1', status: 'pending', coacheeId: COACHEE.id, coacheeName: COACHEE.full_name,
  toGame: brief(EARLIER), fromGame: brief(BOOKED),
  requester: RC.name, requesterId: RC.id, holder: 'Carlos Castro', holderId: 'rc-other',
  expiresAt: '2026-11-03T10:00:00.000Z', createdAt: '2026-11-01T10:00:00.000Z', decidedAt: '', outcome: '',
  ...over,
});

async function openGames(page: Page, lists: { incoming: unknown[]; outgoing: unknown[] }) {
  const posted: Array<{ url: string; body: string }> = [];
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [BOOKED, EARLIER] }));
  await page.route('**/api/switch-requests**', async (r) => {
    if (r.request().method() === 'POST') {
      posted.push({ url: r.request().url(), body: r.request().postData() ?? '' });
      lists.outgoing = [request()];
      await r.fulfill({ status: 201, json: request() });
      return;
    }
    await r.fulfill({ json: lists });
  });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  return posted;
}

test('an earlier game of a coachee booked by another coach offers a switch, and says once it is asked', async ({ page }) => {
  const lists = { incoming: [] as unknown[], outgoing: [] as unknown[] };
  const posted = await openGames(page, lists);
  await page.goto('/games');
  await page.getByRole('button', { name: /Hide planned|Ohne Geplante/ }).click();
  await page.getByRole('button', { name: new RegExp(EARLIER.matchNo) }).first().click();

  const ask = page.getByTestId('take-switch');
  await expect(ask).toBeVisible();
  await expect(page.getByTestId('take-booked')).toHaveCount(0);
  await ask.click();
  await expect(page.getByText(/Carlos Castro has to agree|Carlos Castro muss zustimmen/)).toBeVisible();
  await page.getByRole('button', { name: /^(Send request|Anfrage senden)$/ }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(JSON.parse(posted[0].body)).toEqual({ gameId: EARLIER.id });
  await expect(page.getByTestId('take-switch-pending')).toBeVisible();
  // Never a take: nothing moves until the holder agrees.
  await expect(page.getByRole('button', { name: /^(Take game|Spiel übernehmen)$/ })).toHaveCount(0);
});

test('the LATER game of a booked coachee stays greyed: a switch only brings an observation forward', async ({ page }) => {
  const LATER = { ...EARLIER, id: 'g-late', matchNo: '2400556', date: '2026-11-29T19:30:00.000Z' };
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [BOOKED, LATER] }));
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/games');
  await page.getByRole('button', { name: /Hide planned|Ohne Geplante/ }).click();
  await page.getByRole('button', { name: new RegExp(LATER.matchNo) }).first().click();
  await expect(page.getByTestId('take-booked')).toBeVisible();
  await expect(page.getByTestId('take-switch')).toHaveCount(0);
});

test('the holder answers on Home', async ({ page }) => {
  const answered: string[] = [];
  const lists = { incoming: [request({ requester: 'Carlos Castro', requesterId: 'rc-other', holder: RC.name, holderId: RC.id })], outgoing: [] as unknown[] };
  await stubSignedInApp(page);
  await page.route('**/api/switch-requests**', async (r) => {
    if (r.request().method() === 'POST') {
      answered.push(new URL(r.request().url()).pathname);
      lists.incoming = [];
      await r.fulfill({ json: request({ status: 'accepted' }) });
      return;
    }
    await r.fulfill({ json: lists });
  });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/home');

  const card = page.getByTestId('switch-incoming');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Carlos Castro');
  await expect(card).toContainText(COACHEE.full_name);
  await expect(card).toContainText('VBC Früh');
  await card.getByRole('button', { name: /^(Accept|Annehmen)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Accept|Annehmen)$/ }).click();
  await expect.poll(() => answered).toEqual(['/api/switch-requests/sw1/accept']);
  await expect(page.getByTestId('switch-incoming')).toHaveCount(0);
});

test('what became of an own request shows on Home', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/switch-requests**', (r) => r.fulfill({ json: { incoming: [], outgoing: [request({ status: 'declined', decidedAt: '2026-11-01T09:00:00.000Z' })] } }));
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/home');
  const row = page.getByTestId('switch-outgoing');
  await expect(row).toHaveAttribute('data-status', 'declined');
  await expect(row).toContainText(/Carlos Castro (declined|hat abgelehnt)/);
});
