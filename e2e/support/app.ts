import { expect, type Page } from '@playwright/test';

/**
 * A signed-in app with a little data behind it.
 *
 * Everything in the app now sits behind a login, and most of it behind three or
 * four data endpoints. Tests that drive the real API were at the mercy of
 * whether one was running — which is how this suite ended up asserting against
 * a login screen. Stubbing at the network boundary is what makes these tests
 * deterministic, and it belongs in one place rather than in each spec.
 */

export const RC = { id: 'rc1', name: 'Anna Muster' };

export const COACHEE = {
  id: 'c1',
  full_name: 'Ref One',
  email: 'ref.one@example.ch',
  referee_level: 'N3',
  stage: '2',
  observation_status: { needsObservation: true, count: 0 },
};

/** Held by the signed-in coach: only its holder may observe it. */
export const GAME = {
  id: 'g1',
  matchNo: '2345678',
  league: '3L',
  date: '2026-11-15T19:30:00Z',
  location: 'Sporthalle Utogrund',
  homeTeam: 'VBC Züri Unterland',
  awayTeam: 'Volley Näfels II',
  firstReferee: COACHEE.full_name,
  secondReferee: '',
  assignedRc: RC.name,
  feedbackClosedRoles: [] as string[],
};

const EMAIL_TEMPLATE = { subject: 's', heading: 'h', intro: 'i', outro: 'o' };

export type StubOptions = {
  /** Name on the session; defaults to the coach who holds GAME. */
  signedInAs?: string;
  /** Give the session admin rights (opens the admin console). */
  admin?: boolean;
  /** Let this session read the president-only surfaces. */
  surveyReader?: boolean;
};

/**
 * Route every API call the app makes on start-up. Register further routes after
 * calling this to override a specific one — in Playwright the last matching
 * handler wins.
 */
export async function stubSignedInApp(page: Page, opts: StubOptions = {}): Promise<void> {
  const name = opts.signedInAs ?? RC.name;
  // Catch-all first, so an endpoint nobody named still answers something valid.
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: {
      rc: { id: RC.id, name },
      admin: opts.admin ? { email: 'admin@example.ch' } : null,
      surveyReader: Boolean(opts.surveyReader),
    },
  }));
  await page.route('**/api/admin/auth/status', (r) => r.fulfill({
    json: { authenticated: Boolean(opts.admin), email: opts.admin ? 'admin@example.ch' : '' },
  }));
  await page.route('**/api/settings', (r) => r.fulfill({
    json: {
      default_season: 2026, test_mode: false, groups: [],
      // "All games" for this coachee, so the Niveau-target filter cannot hide
      // the fixture out from under a test.
      coachee_targets: { [COACHEE.id]: { mode: 'all' } },
      rc_mandates: {}, default_goal: 10,
    },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME] }));
  await page.route('**/api/games/*/assign-rc', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/admin/email-templates', (r) => r.fulfill({
    json: {
      feedback: EMAIL_TEMPLATE, reminder: EMAIL_TEMPLATE,
      defaults: { feedback: EMAIL_TEMPLATE, reminder: EMAIL_TEMPLATE },
      reminder_enabled: true, placeholders: [],
    },
  }));
  // The signature pad only renders once a signing session exists.
  await page.route('**/api/signature/start', (r) => r.fulfill({ json: { slug: 'sig-test' } }));
  await page.route('**/api/signature/sig-test', (r) => r.fulfill({
    json: { context: '', signer: '', signed: false, data: '' },
  }));
}

/** Games tab → reveal held games → expand the fixture → open its feedback form. */
export async function openFeedbackForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Coachee Games|Coachee-Spiele/ }).click();
  // Games already held by a coach live behind this filter.
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  await page.getByText(GAME.homeTeam).first().click();
  await page.getByRole('button', { name: /Start observation|Beobachtung starten/ }).click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
}
