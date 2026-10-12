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

// 12.10.2026: "this also please in its own nav tab" — "in home only pending".
// Home keeps what is still open; the Tausch tab lists every request, decided
// ones on both sides included, and the nav counts what waits for an answer.
test('Home shows only the open requests; the Tausch tab shows what became of every one', async ({ page }) => {
  const asked = request({ id: 'sw-in', requester: 'Carlos Castro', requesterId: 'rc-other', holder: RC.name, holderId: RC.id });
  const lists = {
    incoming: [asked, request({ id: 'sw-in-old', status: 'accepted', requester: 'Bea Beispiel', requesterId: 'rc-bea', holder: RC.name, holderId: RC.id, decidedAt: '2026-10-30T09:00:00.000Z' })],
    outgoing: [request({ id: 'sw-out' }), request({ id: 'sw-out-old', status: 'declined', decidedAt: '2026-11-01T09:00:00.000Z' })],
  };
  const urls: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/switch-requests**', (r) => { urls.push(r.request().url()); return r.fulfill({ json: lists }); });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/home');

  const home = page.getByTestId('switch-requests-home');
  await expect(home.getByTestId('switch-incoming')).toHaveCount(1);
  await expect(home.getByTestId('switch-outgoing')).toHaveCount(1);
  await expect(home.getByTestId('switch-outgoing')).toHaveAttribute('data-status', 'pending');
  // The whole history is asked for; Home picks the open ones out of it.
  expect(urls.some((u) => u.includes('all=1'))).toBe(true);
  // One request waits for this coach's answer.
  await expect(page.getByTestId('nav-switches-badge')).toHaveText('1');

  await home.getByRole('button', { name: /^(Alle|All)/ }).click();
  await expect(page).toHaveURL(/\/switches$/);
  const tab = page.getByTestId('switch-requests-tab');
  await expect(tab.getByTestId('switch-incoming')).toHaveCount(1);
  await expect(tab.getByTestId('switch-outgoing')).toHaveCount(2);
  await expect(tab.locator('[data-testid="switch-outgoing"][data-status="declined"]')).toContainText(/Carlos Castro (declined|hat abgelehnt)/);
  // Asked of this coach and answered: who asked, and what became of it.
  await expect(tab.getByTestId('switch-answered')).toContainText(/Bea Beispiel/);
  await expect(tab.getByTestId('switch-answered')).toContainText(/Angenommen|Accepted/);
  // Nothing decided is on Home.
  await page.goto('/home');
  await expect(page.locator('[data-testid="switch-outgoing"][data-status="declined"]')).toHaveCount(0);
});

test('/switches opens the tab, and says so when there is nothing yet', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/switch-requests**', (r) => r.fulfill({ json: { incoming: [], outgoing: [] } }));
  await page.goto('/switches');
  await expect(page.getByTestId('switch-requests-tab')).toBeVisible();
  await expect(page.getByTestId('switch-requests-empty')).toBeVisible();
  await expect(page.getByTestId('nav-switches-badge')).toHaveCount(0);
  // Nothing open: Home has no switch section at all.
  await page.getByRole('button', { name: /^(Start|Home)$/ }).click();
  await expect(page.getByTestId('switch-requests-home')).toHaveCount(0);
});

// 12.10.2026: "let me take back the request". "Tausch angefragt" takes it back,
// asked first because the holder is told by mail; the button is "Tausch
// anfragen" again once the request is gone.
test('"Tausch angefragt" withdraws the request, after asking', async ({ page }) => {
  const posted: string[] = [];
  const lists = { incoming: [] as unknown[], outgoing: [request()] as unknown[] };
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [BOOKED, EARLIER] }));
  await page.route('**/api/switch-requests**', async (r) => {
    if (r.request().method() === 'POST') {
      posted.push(new URL(r.request().url()).pathname);
      lists.outgoing = [request({ status: 'cancelled', decidedAt: '2026-11-01T10:00:00.000Z' })];
      await r.fulfill({ json: lists.outgoing[0] });
      return;
    }
    await r.fulfill({ json: lists });
  });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/games');
  await page.getByRole('button', { name: /Hide planned|Ohne Geplante/ }).click();
  await page.getByRole('button', { name: new RegExp(EARLIER.matchNo) }).first().click();

  const pending = page.getByTestId('take-switch-pending');
  await pending.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Carlos Castro .*(e-mail|E-Mail)/);
  // Kept: nothing is sent.
  await dialog.getByRole('button', { name: /^(Keep it|Behalten)$/ }).click();
  expect(posted).toEqual([]);

  await pending.click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Withdraw|Zurückziehen)$/ }).click();
  await expect.poll(() => posted).toEqual(['/api/switch-requests/sw1/cancel']);
  await expect(page.getByTestId('take-switch')).toBeVisible();
  await expect(page.getByTestId('take-switch-pending')).toHaveCount(0);
});

test('"Zurückziehen" on Home asks first, then withdraws', async ({ page }) => {
  const posted: string[] = [];
  const lists = { incoming: [] as unknown[], outgoing: [request()] as unknown[] };
  await stubSignedInApp(page);
  await page.route('**/api/switch-requests**', async (r) => {
    if (r.request().method() === 'POST') {
      posted.push(new URL(r.request().url()).pathname);
      lists.outgoing = [request({ status: 'cancelled', decidedAt: '2026-11-01T10:00:00.000Z' })];
      await r.fulfill({ json: lists.outgoing[0] });
      return;
    }
    await r.fulfill({ json: lists });
  });
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/home');

  const row = page.getByTestId('switch-outgoing');
  await row.getByRole('button', { name: /^(Withdraw|Zurückziehen)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Withdraw|Zurückziehen)$/ }).click();
  await expect.poll(() => posted).toEqual(['/api/switch-requests/sw1/cancel']);
  // Withdrawn is decided, and Home keeps only the open ones: it moves to the tab.
  await expect(row).toHaveCount(0);
});
