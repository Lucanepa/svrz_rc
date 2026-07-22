import { test, expect } from '@playwright/test';

/**
 * The feedback form and the send path around it.
 *
 * These tests used to drive a live backend and a live database. That made them
 * dormant: the form sits behind a login, so without a server the helper bailed
 * out and every test skipped — and once the API grew an auth gate, the ones
 * that did run asserted a contract that no longer existed. The UI half is now
 * stubbed at the network boundary, which makes the path deterministic and, more
 * to the point, actually exercised. The auth half still needs a real API and
 * says so, skipping cleanly when there is none.
 */

const RC = { id: 'rc1', name: 'Anna Muster' };

const COACHEE = {
  id: 'c1',
  full_name: 'Ref One',
  email: 'ref.one@example.ch',
  referee_level: 'N3',
  stage: '2',
  observation_status: { needsObservation: true, count: 0 },
};

// Already claimed by the signed-in coach: only the coach holding a game may
// observe it, and the list shows taken games behind the "RC assigned" filter.
const GAME = {
  id: 'g1',
  matchNo: '2345678',
  league: '3L',
  date: '2026-11-15T19:30:00Z',
  location: 'Sporthalle Utogrund',
  homeTeam: 'VBC Züri Unterland',
  awayTeam: 'Volley Näfels II',
  firstReferee: 'Ref One',
  secondReferee: '',
  assignedRc: RC.name,
  feedbackClosedRoles: [],
};

async function stubApi(page: import('@playwright/test').Page) {
  // Catch-all first: later routes win, so anything not named here answers [].
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { rc: RC, admin: null, surveyReader: false } }));
  await page.route('**/api/settings', (r) => r.fulfill({
    json: {
      default_season: 2026, test_mode: false, groups: [],
      // "All games" for this coachee, so the Niveau-target filter cannot hide
      // the fixture out from under the test.
      coachee_targets: { c1: { mode: 'all' } },
      rc_mandates: {}, default_goal: 10,
    },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME] }));
  await page.route('**/api/games/*/assign-rc', (r) => r.fulfill({ json: { ok: true } }));
  // The pad only renders once a signing session exists; without a slug the
  // modal sits on its spinner.
  await page.route('**/api/signature/start', (r) => r.fulfill({ json: { slug: 'sig-test' } }));
  await page.route('**/api/signature/sig-test', (r) => r.fulfill({ json: { context: '', signer: '', signed: false, data: '' } }));
}

/** Games tab → reveal taken games → expand the fixture → open its feedback form. */
async function openFeedbackForm(page: import('@playwright/test').Page) {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Coachee Games|Coachee-Spiele/ }).click();
  // Games already held by a coach live behind this filter.
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  await page.getByText(GAME.homeTeam).first().click();
  await page.getByRole('button', { name: /Start observation|Beobachtung starten/ }).click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
}

const sendButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ });

/** The group of buttons under a given heading in the results strip. */
const resultGroup = (page: import('@playwright/test').Page, heading: RegExp) =>
  page.getByRole('heading', { name: heading }).locator('xpath=..');

/** Draw a stroke on the open signature pad and keep it. */
async function signOpenPad(page: import('@playwright/test').Page) {
  const pad = page.locator('canvas');
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 3, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Save signature|Unterschrift speichern/ }).click();
}

/**
 * Fill everything the send path insists on. The confirmation modal only opens
 * once the form validates, so these tests cannot reach it with an empty form —
 * which is why they never ran before.
 */
async function fillFeedbackForm(page: import('@playwright/test').Page) {
  // Every criterion gets a C. The desktop grid is five table cells per row in
  // A–E order; a phone gets the same choice as labelled buttons instead.
  // Both layouts are in the DOM at once — only one of them is on screen, so ask
  // whether the grid is visible rather than whether it exists. Work row by row
  // rather than striding a flat list of cells: a criterion marked N/A collapses
  // its five cells into one, which would shift every later row's C.
  const cells = page.locator('td.rating-cell');
  if (await cells.count() > 0 && await cells.first().isVisible()) {
    const rows = page.locator('tr', { has: page.locator('td.rating-cell') });
    for (let r = 0; r < await rows.count(); r++) {
      const row = rows.nth(r).locator('td.rating-cell');
      // A–E in order, so C is the third — skip a row that has collapsed.
      if (await row.count() === 5) await row.nth(2).click();
    }
  } else {
    // The phone lays each criterion out as its own card of A–E buttons.
    const cs = page.locator('button', { hasText: /^C$/ });
    for (let i = 0; i < await cs.count(); i++) await cs.nth(i).click();
  }

  await resultGroup(page, /Match Level|Spielniveau/).getByRole('button', { name: /^(Normal)$/ }).click();
  await resultGroup(page, /^(Motivation)$/).getByRole('button', { name: '✓' }).click();
  await resultGroup(page, /Outlook|Ausblick/).getByRole('button', { name: '✓' }).click();
  await resultGroup(page, /Further visit|Weiterer Besuch/).getByRole('button', { name: 'N', exact: true }).click();
  await resultGroup(page, /Referee Goal|SR-Ziel/).locator('input').fill('2L');

  // A 3:0 built from three legal sets — the match score is derived, not typed.
  for (const set of [1, 2, 3]) {
    await page.getByLabel(new RegExp(`(Set|Satz) ${set} (home|Heim)`)).fill('25');
    await page.getByLabel(new RegExp(`(Set|Satz) ${set} (away|Gast)`)).fill('20');
  }

  // Both parties sign; neither is optional any more.
  for (const index of [0, 1]) {
    await page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).nth(index).click();
    await signOpenPad(page);
  }
}

test.describe('Feedback form UI', () => {
  test.beforeEach(async ({ page }) => { await openFeedbackForm(page); });

  test.describe('Tips & Tricks section', () => {
    test('shows Tips & Tricks heading', async ({ page }) => {
      await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    });

    test('Tips & Tricks textarea is editable', async ({ page }) => {
      const tips = page.locator('textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]');
      await expect(tips).toBeVisible();
      await tips.fill('Keep whistle position consistent');
      await expect(tips).toHaveValue('Keep whistle position consistent');
    });

    test('shows email-only disclaimer', async ({ page }) => {
      await expect(
        page.locator('p').filter({
          hasText: /not be saved in the official feedback|nicht im offiziellen Feedback gespeichert/,
        }),
      ).toBeVisible();
    });
  });

  test.describe('Send button and confirmation modal', () => {
    test('send button is visible', async ({ page }) => {
      await expect(sendButton(page)).toBeVisible();
    });

    test('an incomplete form is refused instead of sending', async ({ page }) => {
      await sendButton(page).click();
      await expect(page.getByRole('heading', { name: /Save feedback|Feedback speichern/ })).toHaveCount(0);
      await expect(page.getByText(/fill in all ratings|alle Bewertungen ausfüllen/)).toBeVisible();
    });

    test('send button opens confirmation modal', async ({ page }) => {
      await fillFeedbackForm(page);
      await sendButton(page).click();
      await expect(page.getByRole('heading', { name: /Save feedback|Feedback speichern/ })).toBeVisible();
    });

    test('confirmation modal mentions email with PDF', async ({ page }) => {
      await fillFeedbackForm(page);
      await sendButton(page).click();
      await expect(
        page.locator('p').filter({ hasText: /email with the PDF|E-Mail mit dem PDF/ }),
      ).toBeVisible();
    });

    test('confirmation modal can be cancelled', async ({ page }) => {
      await fillFeedbackForm(page);
      await sendButton(page).click();
      const modal = page.getByRole('heading', { name: /Save feedback|Feedback speichern/ });
      await expect(modal).toBeVisible();
      await page.getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();
      await expect(modal).not.toBeVisible();
    });
  });

  test.describe('Form locking state', () => {
    test('form is not locked on initial game selection', async ({ page }) => {
      await expect(sendButton(page)).toBeVisible();
      await expect(page.getByText(/Feedback submitted|Feedback eingereicht/)).toHaveCount(0);
    });

    test('closed game banner is not shown for fresh game', async ({ page }) => {
      await expect(page.getByText(/already been observed|bereits beobachtet/)).toHaveCount(0);
    });
  });

  test.describe('Signatures', () => {
    test('the form offers both a referee and a coach signature', async ({ page }) => {
      await expect(page.getByText(/Referee signature|Unterschrift Schiedsrichter/)).toBeVisible();
      await expect(page.getByText(/Referee Coach signature|Unterschrift Referee Coach/)).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ })).toHaveCount(2);
    });

    // The coach's signature is the newer requirement, so guard it specifically:
    // a form complete in every other respect must still not go anywhere.
    test('refuses to send when only the referee has signed', async ({ page }) => {
      await fillFeedbackForm(page);
      await page.getByRole('button', { name: /^(Remove|Entfernen)$/ }).nth(1).click();

      await sendButton(page).click();
      await expect(page.getByRole('heading', { name: /Save feedback|Feedback speichern/ })).toHaveCount(0);
      await expect(page.getByText(/referee coach’s signature|Unterschrift des Referee Coach/)).toBeVisible();
    });
  });
});

// The auth gate in front of the write path. This one genuinely needs the API,
// so it probes first and skips rather than failing when nothing is listening.
test.describe('API auth', () => {
  const reachable = async (request: import('@playwright/test').APIRequestContext) => {
    try { return (await request.get('/api/health')).ok(); } catch { return false; }
  };

  test('feedback submit refuses an unauthenticated caller', async ({ request }) => {
    test.skip(!(await reachable(request)), 'No API reachable through the dev proxy');
    const response = await request.post('/api/feedback/submit', {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    // Authentication is checked before the payload, so an empty body is still
    // a 401 and never reaches validation.
    expect(response.status()).toBe(401);
  });

  test('eligible-games refuses an unauthenticated caller', async ({ request }) => {
    test.skip(!(await reachable(request)), 'No API reachable through the dev proxy');
    const response = await request.get('/api/eligible-games');
    expect(response.status()).toBe(401);
  });
});
