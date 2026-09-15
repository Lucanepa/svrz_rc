import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFeedbackForm, stubSignedInApp } from './support/app';

/**
 * The feedback form and the send path around it.
 *
 * These tests used to drive a live backend and a live database. That made them
 * dormant: the form sits behind a login, so without a server the helper bailed
 * out and every test skipped — and once the API grew an auth gate, the ones
 * that did run asserted a contract that no longer existed. The UI half is now
 * stubbed at the network boundary, which makes the path deterministic and, more
 * to the point, actually exercised. The auth half still needs a real API and
 * says so, skipping cleanly when there is none. The server's send path is
 * pinned from its source at the end, the way the mail specs do it: composing
 * the mail needs PocketBase and an SMTP transport, and neither exists here.
 */

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
  test.beforeEach(async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
  });

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

/**
 * The send path inside POST /api/feedback/submit, read from the source.
 *
 * Two messages leave: the referee's, with the survey token, and the copy for
 * the RC and the commission without it. They used to go one after the other,
 * and each carries the whole PDF — two sequential uploads of it were most of
 * a six-second "Abschliessen" with the coach in front of a spinner. Now they
 * leave together, and only the referee's decides whether the mail counts as
 * sent. What the source can prove is that shape, and that a request leaves a
 * trace either way: until now only a failure was logged, so "did the report
 * go out?" could only be answered by the absence of an error.
 */
test.describe('Send path (source)', () => {
  // The specs run as ES modules, so `__dirname` is not defined — and a path
  // relative to cwd would depend on where playwright was invoked from.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');
  const start = SRC.indexOf("app.post('/api/feedback/submit'");
  const submit = SRC.slice(start, SRC.indexOf('\n});\n', start));

  test('the referee’s mail and the copy leave side by side', () => {
    expect(start, 'the submit handler still exists').toBeGreaterThan(-1);
    const from = submit.indexOf('await Promise.allSettled([');
    expect(from).toBeGreaterThan(-1);
    const batch = submit.slice(from, submit.indexOf(']);', from));
    // Both sends in the one batch. A submit with nobody to copy — the coach is
    // the referee on their own test game — settles a placeholder in its place,
    // so the two outcomes keep their positions.
    expect(batch.match(/sendMailResilient\(/g)).toHaveLength(2);
    expect(batch).toContain('copyRecipients.length > 0');
    expect(batch).toContain('Promise.resolve(null)');
    // No send awaited on its own anywhere in the handler: that is the
    // sequential version coming back.
    expect(submit).not.toMatch(/await sendMailResilient\(/);
  });

  test('a rejected referee send still throws, before emailSent is set', () => {
    // The order is the point: `allSettled` never rejects, so without the
    // rethrow a bounced referee address would come back as `emailSent: true`.
    const branch = submit.indexOf("if (mainOutcome.status === 'rejected') {");
    const rethrow = submit.indexOf('throw mainOutcome.reason;');
    const sent = submit.indexOf('emailSent = true;');
    expect(branch).toBeGreaterThan(-1);
    expect(rethrow).toBeGreaterThan(branch);
    expect(sent).toBeGreaterThan(rethrow);
  });

  test('a copy that went out while the referee’s send failed is recorded, in both languages', () => {
    // The two leave together, so the RC and the commission can be holding
    // the report when the referee's address bounces. Rethrown without a word,
    // that left the Protokoll with only a failure line and the coach
    // forwarding a PDF by hand to people who already had it.
    const from = submit.indexOf("if (mainOutcome.status === 'rejected') {");
    const block = submit.slice(from, submit.indexOf('throw mainOutcome.reason;', from));
    expect(block).toContain("copyOutcome.status === 'fulfilled' && copyRecipients.length > 0");
    expect(block).toContain("log.warn('feedback.mail', 'referee send failed — the copy to the RC / commission did go out'");
    expect(block).toContain('Kopie an RC und Kommission wurde gesendet / copy to RC and commission was sent');
    expect(block).toContain('emailWarning =');
  });

  test('a rejected copy is logged and warned about, never thrown', () => {
    const from = submit.indexOf("if (copyOutcome.status === 'rejected') {");
    expect(from).toBeGreaterThan(-1);
    // After `emailSent = true`: the referee has the report whatever the copy did.
    expect(from).toBeGreaterThan(submit.indexOf('emailSent = true;'));
    const block = submit.slice(from, submit.indexOf('} catch (emailErr)', from));
    expect(block).toContain("log.error('feedback.mail', 'copy to the RC / commission failed'");
    // Verbatim inside the client's localised notice, so it carries both
    // languages itself — the submit never learns which one the coach used.
    expect(block).toContain('Kopie an RC und Kommission nicht gesendet / copy to RC and commission not sent');
    expect(block).not.toMatch(/\bthrow\b/);
  });

  test('a success writes one mail line, and the response one with the phases', () => {
    // ONE positive line, with what a delivery query needs: the provider's
    // message id and how many addresses it accepted. Counts, never addresses.
    expect(submit.match(/log\.info\('feedback\.mail'/g)).toHaveLength(1);
    const mailLine = submit.slice(
      submit.indexOf("log.info('feedback.mail'"),
      submit.indexOf("if (copyOutcome.status === 'rejected')"),
    );
    expect(mailLine).toMatch(/log\.info\('feedback\.mail', `report mailed to the referee/);
    for (const key of ['feedbackId:', 'ms:', 'messageId:', 'accepted:', 'copies:', 'copyOk:']) {
      expect(mailLine, key).toContain(key);
    }
    // And the phases on the way out, so "Abschliessen took six seconds" is
    // answerable with which part took them.
    expect(submit).toMatch(/log\.info\('feedback\.submit', `filed /);
    expect(submit).toContain('ms: { write: writeMs, mail: emailMs, close: Date.now() - closeStarted, total: Date.now() - writeStarted }');
  });
});
