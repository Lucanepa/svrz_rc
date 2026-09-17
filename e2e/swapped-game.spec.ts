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

const summary = (noCoachee: boolean, extra: Record<string, unknown> = {}) => [{
  coacheeName: noCoachee ? 'Fremd Eins / Fremd Zwei' : 'Ref One',
  coacheeId: noCoachee ? '' : 'c1',
  doneFeedbacks: [],
  outstandingGames: [],
  plannedGames: [{
    ...base,
    gameId: 'g-planned',
    refereeName: noCoachee ? 'Fremd Eins / Fremd Zwei' : 'Ref One',
    ...(noCoachee ? { noCoachee: true } : { refereeRole: '1. SR' }),
    ...extra,
  }],
}];

// The note that a taken game no longer needs the coach's evening — a hard
// reason (no coachee, RC-Spiel); focus is only ever a hint, never this.
const warning = /Beobachtung nicht mehr nötig|Observation no longer needed/;

async function openHome(page: import('@playwright/test').Page, noCoachee: boolean, extra: Record<string, unknown> = {}) {
  await stubSignedInApp(page);
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: summary(noCoachee, extra) }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  await page.goto('/');
  await expect(page.getByText(base.teams.split(' vs ')[0]).first()).toBeVisible();
}

test('a game that lost its coachee says so, and says what to do about it', async ({ page }) => {
  await openHome(page, true);
  await expect(page.getByText(warning)).toBeVisible();
  await expect(page.getByText(/Kein Coachee mehr auf dem Spiel|No coachee on the game any more/)).toBeVisible();
  // "Abgeben" leads once the observation has lost its point; "Beobachten"
  // is still there, but no longer the dark button a thumb lands on first.
  await expect(page.getByRole('button', { name: /Spiel abgeben|Give game back/ })).toHaveClass(/bg-slate-900/);
  await expect(page.getByRole('button', { name: /Spiel öffnen|Open game/ })).not.toHaveClass(/bg-slate-900/);
  // The action the regulation asks for next — giving the game back — is named
  // on the row rather than left to be discovered.
  await expect(page.getByText(/Du kannst das Spiel abgeben|You can give the game back/)).toBeVisible();
});

test('an ordinary planned game carries no warning', async ({ page }) => {
  await openHome(page, false);
  await expect(page.getByText(warning)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Spiel öffnen|Open game/ })).toHaveClass(/bg-slate-900/);
  // The card itself is not a button any more: the row carries its own three,
  // and a thumb scrolling a phone opened forms it never meant to.
  await expect(page.getByRole('button', { name: new RegExp(base.teams.split(' vs ')[0]) })).toHaveCount(0);
  await page.getByText(base.teams.split(' vs ')[0]).first().click();
  await expect(page.getByRole('heading', { name: /SR-Coaching Feedback/ })).toHaveCount(0);
});

// Focus is an indication, never a hard stop (Luca, 17.09.2026): the row says
// it in grey and keeps "Beobachten" as the dark button.
test('a game outside the coachee\'s focus gets a hint, not the warning', async ({ page }) => {
  await stubSignedInApp(page);
  // No per-coachee override: the level decides. An N2-2 promotion candidate's
  // focus is 2. Liga as 1. SR / 1. Liga as 2. SR — a 3. Liga evening is not
  // his (the case e2e/promotion-focus.spec.ts pins on the Games tab).
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [{
    id: 'c1', full_name: 'Ref One', email: 'ref.one@example.ch', referee_level: 'N2', stage: '2', groups: 'Beförderung?',
    observation_status: { needsObservation: true, count: 0 },
  }] }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: summary(false, {
    league: '3L ♂',
    crew: [{ name: 'Ref One', role: '1. SR', coachee: true, coacheeId: 'c1' }],
  }) }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  await page.goto('/');
  await expect(page.getByText(base.teams.split(' vs ')[0]).first()).toBeVisible();
  await expect(page.getByTestId('scope-hint')).toContainText(/Ausserhalb des Fokus|Outside the coachee's focus/);
  await expect(page.getByText(warning)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Spiel öffnen|Open game/ })).toHaveClass(/bg-slate-900/);
});

// Luca's own 401912 (17.09.2026): Alexander Rupp, a coachee, next to Manuel
// Prencipe, a referee coach. The API flagged it, the row drew nothing — and
// with the coaching happening on the court (4.4.10) the evening is not needed.
test('a taken game that became an RC-Spiel says so and offers the way out', async ({ page }) => {
  await openHome(page, false, {
    isRcGame: true,
    crew: [
      { name: 'Ref One', role: '1. SR', coachee: true, coacheeId: 'c1' },
      { name: 'Coach Two', role: '2. SR', coachee: false, coacheeId: '' },
    ],
  });
  await expect(page.getByText(/^(RC Game|RC-Spiel)$/)).toBeVisible();
  await expect(page.getByText(warning)).toBeVisible();
  await expect(page.getByText(/Jetzt ein RC-Spiel|Now an RC game/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Spiel abgeben|Give game back/ })).toHaveClass(/bg-slate-900/);
});
