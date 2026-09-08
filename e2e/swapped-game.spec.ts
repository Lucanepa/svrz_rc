import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * Infoschreiben 4.1: "mit der Börse sind Spiele schnell getauscht", so the RC is
 * asked to check before setting off whether the game still has their referee on
 * it. The tool has always known — the summary marks such a game `noCoachee` —
 * and used to render it as an ordinary row, which is why the regulation had to
 * ask a human to do the checking.
 */

const base = {
  gameDate: '2026-11-20T19:30:00Z',
  league: '3L',
  matchNo: '2400123',
  location: 'Sporthalle Utogrund',
  teams: 'VBC Volketswil vs DTV Bülach',
  result: '',
};

const summary = (noCoachee: boolean) => [{
  coacheeName: noCoachee ? 'Fremd Eins / Fremd Zwei' : 'Ref One',
  coacheeId: noCoachee ? '' : 'c1',
  doneFeedbacks: [],
  outstandingGames: [],
  plannedGames: [{
    ...base,
    gameId: 'g-planned',
    refereeName: noCoachee ? 'Fremd Eins / Fremd Zwei' : 'Ref One',
    ...(noCoachee ? { noCoachee: true } : { refereeRole: '1. SR' }),
  }],
}];

const warning = /Kein Coachee mehr auf diesem Spiel|No coachee on this game any more/;

async function openHome(page: import('@playwright/test').Page, noCoachee: boolean) {
  await stubSignedInApp(page);
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: summary(noCoachee) }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  await page.goto('/');
  await expect(page.getByText(base.teams.split(' vs ')[0]).first()).toBeVisible();
}

test('a game that lost its coachee says so, and says what to do about it', async ({ page }) => {
  await openHome(page, true);
  await expect(page.getByText(warning)).toBeVisible();
  // The action the regulation asks for next — giving the game back — is named
  // on the row rather than left to be discovered.
  await expect(page.getByText(/du kannst es abgeben|you can give it back/)).toBeVisible();
});

test('an ordinary planned game carries no warning', async ({ page }) => {
  await openHome(page, false);
  await expect(page.getByText(warning)).toHaveCount(0);
});
