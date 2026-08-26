import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * The team login and the picker behind it.
 *
 * The credential is shared, so the identity is a claim the app collects rather
 * than something the password proves — which makes "did the picker actually
 * run, and did the app come up as the name it chose" the thing worth pinning
 * down. Stubbed at the network boundary like the rest of the suite, with one
 * addition: /api/auth/me has to answer differently as the session advances,
 * because the three states it distinguishes are the whole feature.
 */

const OTHER_RC = { id: 'rc2', fullName: 'Beat Beispiel' };

type Phase = 'anon' | 'signed-in' | 'identified';

/** Stubs the app plus an auth/me that tracks how far the session has got. */
async function stubLoginFlow(page: Page): Promise<{ setPhase: (p: Phase) => void }> {
  let phase: Phase = 'anon';
  // Everything the app needs once it is up; registered first so the auth routes
  // below override its auth/me (in Playwright the last matching handler wins).
  await stubSignedInApp(page);
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: phase === 'anon' ? { rc: null, admin: null, shared: false, needsIdentity: false }
      : phase === 'signed-in' ? { rc: null, admin: null, shared: true, needsIdentity: true }
      : { rc: { id: RC.id, name: RC.name }, admin: null, shared: true, needsIdentity: false },
  }));
  await page.route('**/api/auth/shared/login', (r) => {
    phase = 'signed-in';
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/auth/rc/roster', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name }, OTHER_RC],
  }));
  await page.route('**/api/auth/rc/identify', (r) => {
    phase = 'identified';
    return r.fulfill({ json: { ok: true, rc: { id: RC.id, name: RC.name } } });
  });
  return { setPhase: (p: Phase) => { phase = p; } };
}

async function signInWithTeamCredential(page: Page): Promise<void> {
  await page.getByPlaceholder(/Benutzername|Username/).fill('Referee-Coaching');
  await page.getByPlaceholder(/^(Passwort|Password)$/).fill('Saison26-27');
  await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();
}

test.describe('Team login', () => {
  test('signs in, asks which RC, then opens the app as that RC', async ({ page }) => {
    await stubLoginFlow(page);
    await page.goto('/');

    // The everyday screen is username + password, not e-mail — and neither
    // field is pre-filled: the credential is typed, not handed out by the page.
    await expect(page.getByPlaceholder(/Benutzername|Username/)).toHaveValue('');
    await expect(page.getByPlaceholder(/^(Passwort|Password)$/)).toHaveValue('');
    // There is no second form to reach from here any more: the per-person
    // e-mail login is gone, and #/admin is a separate page with its own password.
    await expect(page.getByRole('button', { name: /Persönlicher Zugang|Personal access/ })).toHaveCount(0);
    await expect(page.getByPlaceholder(/E-Mail|^Email$/)).toHaveCount(0);
    await signInWithTeamCredential(page);

    // The password alone gets nobody in — the picker stands between.
    await expect(page.getByRole('heading', { name: /Wer bist du\?|Who are you\?/ })).toBeVisible();
    await page.getByRole('button', { name: RC.name }).click();
    await page.getByRole('button', { name: /Weiter|Continue/ }).click();

    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    // The app came up as the name that was picked, not merely as "signed in".
    await expect(page.getByTitle(new RegExp(`${RC.name} — (wechseln|switch)`))).toBeVisible();
  });

  test('a session that signed in but never picked lands on the picker, not the login', async ({ page }) => {
    const { setPhase } = await stubLoginFlow(page);
    setPhase('signed-in');
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /Wer bist du\?|Who are you\?/ })).toBeVisible();
    await expect(page.getByPlaceholder(/Benutzername|Username/)).toHaveCount(0);
  });

  test('the language chosen at the gate carries into the app', async ({ page }) => {
    await stubLoginFlow(page);
    // Start from a known language: the browser's own locale decides otherwise,
    // and this test is about the toggle, not about the fallback.
    await page.addInitScript(() => localStorage.setItem('svrz_lang', 'DE'));
    await page.goto('/');
    await expect(page.getByPlaceholder('Benutzername')).toBeVisible();

    // The toggle is on the login card itself, so the picker is already in the
    // language the coach reads by the time it asks them anything.
    await page.getByTitle(/Sprache wechseln|Switch language/).click();
    await expect(page.getByPlaceholder('Username')).toBeVisible();
    await signInWithTeamCredential(page);

    await expect(page.getByRole('heading', { name: 'Who are you?' })).toBeVisible();
    await page.getByRole('button', { name: RC.name }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('button', { name: /^Coachee Games$/ })).toBeVisible();
  });

  test('#/admin asks for its OWN password, not the team one', async ({ page }) => {
    await stubLoginFlow(page);
    await page.goto('/#/admin');

    // The console no longer sits behind the app's gate (main.tsx): it renders
    // its own username + password form, and the copy says as much so nobody
    // stands there typing the team credential.
    await expect(page.getByText(/Eigener Zugang für diese Seite|This page has its own login/)).toBeVisible();
    await expect(page.getByPlaceholder(/Benutzername|Username/)).toBeVisible();
    // And there is no e-mail field anywhere — that login does not exist now.
    await expect(page.getByPlaceholder(/E-Mail|^Email$/)).toHaveCount(0);
  });

  test('the name in the header reopens the picker without asking for the password', async ({ page }) => {
    const { setPhase } = await stubLoginFlow(page);
    setPhase('identified');
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Coaching Feedback');

    await page.getByTitle(new RegExp(`${RC.name} — (wechseln|switch)`)).click();

    await expect(page.getByRole('heading', { name: /Wer bist du\?|Who are you\?/ })).toBeVisible();
    await expect(page.getByRole('button', { name: OTHER_RC.fullName })).toBeVisible();
  });
});
