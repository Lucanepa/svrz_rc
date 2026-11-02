import { test, expect, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { stubSignedInApp, openOptions, RC } from './support/app';
import { createPasskeyCeremonies, type StoredPasskey } from '../server/passkeys';

/**
 * Sign-in with a passkey, in the app (AuthGate, PasskeyOption).
 *
 * The API is stubbed at the network boundary like everywhere else, but the
 * passkey stubs run the REAL server module: the options the page gets and the
 * checks its answers meet are server/passkeys.ts's own. The device is
 * Chromium's virtual authenticator — a fingerprint sensor that always
 * recognises its owner. What these pin down is the app's part: when it offers
 * the set-up, that one tap signs in as the coach the key belongs to, what a
 * refusal says, and that none of it shows where it cannot work.
 */

type Phase = 'anon' | 'signed-in' | 'identified';

/** The team login, the picker, and the passkey calls in front of a store. */
async function stubPasskeyFlow(page: Page, opts: { loginRefusal?: { code: string; error: string } } = {}) {
  let phase: Phase = 'anon';
  const store: StoredPasskey[] = [];
  const calls = { passkeyLogins: 0 };
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const ceremonies = createPasskeyCeremonies({ rpId: 'localhost', rpName: 'SVRZ Referee Coaching', origins: [origin] });

  await stubSignedInApp(page);
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: phase === 'anon' ? { rc: null, admin: null, shared: false, needsIdentity: false }
      : phase === 'signed-in' ? { rc: null, admin: null, shared: true, needsIdentity: true }
      : { rc: { id: RC.id, name: RC.name }, admin: null, shared: true, needsIdentity: false },
  }));
  await page.route('**/api/auth/shared/login', (r) => { phase = 'signed-in'; return r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/auth/rc/roster', (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name }] }));
  await page.route('**/api/auth/rc/identify', (r) => { phase = 'identified'; return r.fulfill({ json: { ok: true, rc: { id: RC.id, name: RC.name } } }); });
  await page.route('**/api/auth/rc/logout', (r) => { phase = 'anon'; return r.fulfill({ json: { ok: true } }); });

  await page.route('**/api/auth/passkey/register/options', async (r) => r.fulfill({
    json: await ceremonies.registrationOptions({ rcId: RC.id, name: RC.name, existing: store.filter((p) => p.rcId === RC.id) }),
  }));
  await page.route('**/api/auth/passkey/register', async (r) => {
    const body = r.request().postDataJSON();
    const added = await ceremonies.finishRegistration({ challengeId: body.challengeId, rcId: RC.id, response: body.response });
    store.push({ id: `pk${store.length + 1}`, rcId: RC.id, createdMs: Date.now(), lastUsedMs: 0, ...added });
    return r.fulfill({ json: { ok: true, passkey: { id: `pk${store.length}`, label: 'Linux · Chrome', created: new Date().toISOString(), lastUsed: '', credentialId: added.credentialId, outdated: false } } });
  });
  await page.route('**/api/auth/passkey/login/options', async (r) => r.fulfill({ json: await ceremonies.authenticationOptions() }));
  await page.route('**/api/auth/passkey/login', async (r) => {
    calls.passkeyLogins++;
    if (opts.loginRefusal) return r.fulfill({ status: 401, json: opts.loginRefusal });
    const body = r.request().postDataJSON();
    const { passkey } = await ceremonies.finishAuthentication({
      challengeId: body.challengeId, response: body.response,
      lookup: async (id) => store.find((p) => p.credentialId === id) ?? null,
    });
    phase = 'identified';
    return r.fulfill({ json: { ok: true, rc: { id: passkey.rcId, name: RC.name } } });
  });
  return { store, calls, setPhase: (p: Phase) => { phase = p; } };
}

/** A device with a fingerprint sensor that always recognises its owner. */
async function addFingerprintDevice(page: Page): Promise<{ addKeyFor: (rcId: string) => Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    // A passkey the device holds that the server knows nothing of.
    addKeyFor: async (rcId: string) => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId,
        credential: {
          credentialId: Buffer.from(`key-of-${rcId}`).toString('base64'),
          isResidentCredential: true,
          rpId: 'localhost',
          privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
          userHandle: Buffer.from(rcId).toString('base64'),
          signCount: 0,
        },
      });
    },
  };
}

const FAKE_TEAM_PW = 'not-a-real-password';

async function signInWithTeamCredential(page: Page): Promise<void> {
  await page.getByPlaceholder(/Benutzername|Username/).fill('Referee-Coaching');
  await page.getByPlaceholder(/^(Passwort|Password)$/).fill(FAKE_TEAM_PW);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/ }).click();
  await expect(page.getByRole('heading', { name: /Wer bist du\?|Who are you\?/ })).toBeVisible();
  await page.getByRole('button', { name: RC.name }).click();
  await page.getByRole('button', { name: /Weiter|Continue/ }).click();
}

async function expectAppAsRc(page: Page): Promise<void> {
  await expect(page.locator('h1')).toContainText('Coaching Feedback');
  await openOptions(page);
  await expect(page.getByTitle(new RegExp(`${RC.name} — (wechseln|switch)`))).toBeVisible();
}

test.describe('Fingerprint sign-in', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('svrz_lang', 'DE'));
  });

  test.describe('with a fingerprint device', () => {
    // The virtual authenticator is a Chromium DevTools feature.
    test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium DevTools only');

    test('offered after picking a name; once set up, one tap signs in as that coach', async ({ page }) => {
      const flow = await stubPasskeyFlow(page);
      await page.goto('/');
      await addFingerprintDevice(page);
      // Nobody set one up here yet: the team form leads, the passkey follows.
      await expect(page.getByTestId('passkey-login')).toBeVisible();
      await signInWithTeamCredential(page);

      const offer = page.getByTestId('passkey-offer');
      await expect(offer).toBeVisible();
      await expect(offer).toContainText('Nächstes Mal mit Fingerabdruck?');
      await expect(offer).toContainText('nur auf deinem eigenen Gerät');
      await offer.getByRole('button', { name: 'Einrichten' }).click();
      await expect(page.getByText('Eingerichtet. Beim nächsten Mal genügt')).toBeVisible();
      expect(flow.store).toHaveLength(1);
      await expectAppAsRc(page);

      // Out, and back in with one tap: no password, no picker.
      await page.getByRole('button', { name: 'Abmelden' }).click();
      await expect(page.getByPlaceholder('Benutzername')).toBeVisible();
      // This device has one now, so the button leads and the field is not focused.
      const button = page.getByTestId('passkey-login');
      await expect(page.getByPlaceholder('Benutzername')).not.toBeFocused();
      const [buttonBox, fieldBox] = [await button.boundingBox(), await page.getByPlaceholder('Benutzername').boundingBox()];
      expect(buttonBox!.y).toBeLessThan(fieldBox!.y);
      await button.click();
      await expectAppAsRc(page);
      expect(flow.calls.passkeyLogins).toBe(1);
      await expect(page.getByRole('heading', { name: 'Wer bist du?' })).toHaveCount(0);
    });

    test('"Nicht jetzt" goes straight in, and the offer is not repeated', async ({ page }) => {
      const flow = await stubPasskeyFlow(page);
      await page.goto('/');
      await addFingerprintDevice(page);
      await signInWithTeamCredential(page);
      await page.getByTestId('passkey-offer').getByRole('button', { name: 'Nicht jetzt' }).click();
      await expectAppAsRc(page);
      expect(flow.store).toHaveLength(0);

      await page.getByRole('button', { name: 'Abmelden' }).click();
      await signInWithTeamCredential(page);
      await expect(page.locator('h1')).toContainText('Coaching Feedback');
      await expect(page.getByTestId('passkey-offer')).toHaveCount(0);
    });

    test('a refused passkey says why, and the team password still works', async ({ page }) => {
      const words = 'Das Team-Passwort wurde geändert. Melde dich einmal mit dem neuen Passwort an und richte die Anmeldung per Fingerabdruck danach neu ein.';
      await stubPasskeyFlow(page, { loginRefusal: { code: 'outdated', error: words } });
      await page.goto('/');
      const device = await addFingerprintDevice(page);
      await device.addKeyFor(RC.id);
      await page.getByTestId('passkey-login').click();
      await expect(page.getByTestId('login-error')).toHaveText(words);
      await expect(page.getByPlaceholder('Benutzername')).toBeVisible();
      // The device is not the problem: the offer comes again after the
      // password, and that is how a coach gets a working passkey back.
      await signInWithTeamCredential(page);
      await expect(page.getByTestId('passkey-offer')).toBeVisible();
    });
  });

  test('no fingerprint sign-in where the browser cannot do it', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    });
    await stubPasskeyFlow(page);
    await page.goto('/');
    await expect(page.getByPlaceholder('Benutzername')).toBeVisible();
    await expect(page.getByTestId('passkey-login')).toHaveCount(0);
    await signInWithTeamCredential(page);
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    await expect(page.getByTestId('passkey-offer')).toHaveCount(0);
    await openOptions(page);
    await expect(page.getByTestId('passkey-option')).toHaveCount(0);
  });

  test('Optionen lists the coach\'s passkeys, and one can be removed', async ({ page }) => {
    const flow = await stubPasskeyFlow(page);
    flow.setPhase('identified');
    let listed = [
      { id: 'pk1', label: 'iPhone · Safari', created: '2026-10-30 08:00:00.000Z', lastUsed: '2026-11-01T18:00:00.000Z', credentialId: 'aaa', outdated: false },
      { id: 'pk2', label: 'Windows · Edge', created: '2026-09-01 08:00:00.000Z', lastUsed: '', credentialId: 'bbb', outdated: true },
    ];
    const removed: string[] = [];
    await page.route('**/api/auth/passkeys', (r) => r.fulfill({ json: listed }));
    await page.route('**/api/auth/passkeys/*', (r) => {
      const id = r.request().url().split('/').pop()!;
      removed.push(`${r.request().method()} ${id}`);
      listed = listed.filter((p) => p.id !== id);
      return r.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await openOptions(page);
    const option = page.getByTestId('passkey-option');
    await option.getByRole('button', { name: /Anmeldung per Fingerabdruck/ }).click();
    const list = option.getByTestId('passkey-list');
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('iPhone · Safari');
    await expect(list).toContainText('Eingerichtet 30.10.2026 · zuletzt 01.11.2026');
    // The one the last password change ended says so.
    await expect(list).toContainText('Abgelaufen: das Team-Passwort wurde danach geändert');

    await list.getByRole('button', { name: 'Windows · Edge entfernen' }).click();
    await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
    await expect(page.getByText('Passkey entfernt.')).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    expect(removed).toEqual(['DELETE pk2']);
  });
});
