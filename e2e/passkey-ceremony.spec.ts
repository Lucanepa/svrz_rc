import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import {
  ANDROID_APP_ORIGINS, apkKeyHashOrigin, RELEASE_CERT_SHA256, cleanTransports, createPasskeyCeremonies, originMatchesRp, passkeyConfig, passkeyDeviceLabel, passkeyOutlived,
  PasskeyError, PASSKEY_CHALLENGE_TTL_MS, PASSKEY_CHALLENGES_MAX, PASSKEY_IDLE_MS, type PasskeyConfig, type StoredPasskey,
} from '../server/passkeys';

/**
 * Passkey sign-in, server side (server/passkeys.ts).
 *
 * The real ceremonies, not stubs: a throwaway HTTP server runs the module's
 * options and checks against an in-memory store, and Chromium's virtual
 * authenticator — a fingerprint sensor that always says yes — answers in the
 * page. So the signature, origin, RP ID and user-verification checks the live
 * API makes are the ones exercised here. The rest is pure: the generation rule
 * that ties a passkey to the team password, the device label, the config.
 */

type Store = StoredPasskey[];

/** A page on http://localhost:<port> with the four passkey calls behind it. */
async function passkeyServer(config: (port: number) => PasskeyConfig, store: Store) {
  let ceremonies: ReturnType<typeof createPasskeyCeremonies>;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>passkeys</title>');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (req.url === '/reg/options') {
        const existing = store.filter((p) => p.rcId === body.rcId);
        send(200, await ceremonies.registrationOptions({ rcId: body.rcId, name: body.name ?? 'Anna Muster', existing }));
      } else if (req.url === '/reg/finish') {
        const added = await ceremonies.finishRegistration({ challengeId: body.challengeId, rcId: body.rcId, response: body.response });
        store.push({ id: `row${store.length + 1}`, rcId: body.rcId, createdMs: Date.now(), lastUsedMs: 0, ...added });
        send(200, { ok: true, credentialId: added.credentialId });
      } else if (req.url === '/login/options') {
        send(200, await ceremonies.authenticationOptions());
      } else if (req.url === '/login/finish') {
        const { passkey, newCounter } = await ceremonies.finishAuthentication({
          challengeId: body.challengeId,
          response: body.response,
          lookup: async (id) => store.find((p) => p.credentialId === id) ?? null,
        });
        passkey.counter = newCounter;
        send(200, { ok: true, rcId: passkey.rcId, counter: newCounter });
      } else {
        send(404, {});
      }
    } catch (error) {
      send(400, { code: error instanceof PasskeyError ? error.code : 'crash', message: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  ceremonies = createPasskeyCeremonies(config(port));
  return { url: `http://localhost:${port}/`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A fingerprint sensor built into the device, that always recognises its owner. */
async function addFingerprintDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

type Answer = { status: number; ok?: boolean; code?: string; rcId?: string; counter?: number; credentialId?: string; error?: string };

/** Sets up a passkey for `rcId` the way the app does: options, the device, the check. */
function register(page: Page, rcId: string, finishAs = rcId): Promise<Answer> {
  return page.evaluate(async ({ rcId, finishAs }) => {
    const post = async (path: string, body: unknown) => {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, ...(await r.json()) };
    };
    const start = await post('/reg/options', { rcId });
    const PKC = PublicKeyCredential as unknown as { parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions };
    try {
      const cred = await navigator.credentials.create({ publicKey: PKC.parseCreationOptionsFromJSON(start.options) }) as PublicKeyCredential & { toJSON(): unknown };
      return post('/reg/finish', { challengeId: start.challengeId, rcId: finishAs, response: cred.toJSON() });
    } catch (error) {
      return { status: 0, error: (error as Error).name };
    }
  }, { rcId, finishAs });
}

/** Signs in with whatever passkey the device offers. `replay` sends the same
 *  answer a second time and returns that second verdict. */
function signIn(page: Page, opts: { replay?: boolean } = {}): Promise<Answer> {
  return page.evaluate(async ({ replay }) => {
    const post = async (path: string, body: unknown) => {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, ...(await r.json()) };
    };
    const start = await post('/login/options', {});
    const PKC = PublicKeyCredential as unknown as { parseRequestOptionsFromJSON(o: unknown): PublicKeyCredentialRequestOptions };
    const cred = await navigator.credentials.get({ publicKey: PKC.parseRequestOptionsFromJSON(start.options) }) as PublicKeyCredential & { toJSON(): unknown };
    const body = { challengeId: start.challengeId, response: cred.toJSON() };
    const first = await post('/login/finish', body);
    return replay ? post('/login/finish', body) : first;
  }, { replay: Boolean(opts.replay) });
}

const LOCAL = (port: number): PasskeyConfig => ({ rpId: 'localhost', rpName: 'SVRZ Referee Coaching', origins: [`http://localhost:${port}`] });

test.describe('Passkey ceremonies, with a virtual fingerprint device', () => {
  // The virtual authenticator is a Chromium DevTools feature; once is enough.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Chromium DevTools only');

  test('a coach sets up a passkey and signs in with it, as that coach', async ({ page }) => {
    const store: Store = [];
    const srv = await passkeyServer(LOCAL, store);
    try {
      await page.goto(srv.url);
      await addFingerprintDevice(page);
      const added = await register(page, 'rc1');
      expect(added).toMatchObject({ status: 200, ok: true });
      expect(store).toHaveLength(1);
      // Only the public key is kept, and it is the coach's.
      expect(store[0]).toMatchObject({ rcId: 'rc1', credentialId: added.credentialId });
      expect(store[0].publicKey.length).toBeGreaterThan(40);

      const first = await signIn(page);
      expect(first).toMatchObject({ status: 200, ok: true, rcId: 'rc1' });
      // The device's signature count moves on, and the next sign-in still
      // passes the "never goes backwards" check.
      const second = await signIn(page);
      expect(second).toMatchObject({ status: 200, rcId: 'rc1' });
      expect(second.counter!).toBeGreaterThan(first.counter!);
    } finally { await srv.close(); }
  });

  test('an answer sent twice is refused the second time', async ({ page }) => {
    const store: Store = [];
    const srv = await passkeyServer(LOCAL, store);
    try {
      await page.goto(srv.url);
      await addFingerprintDevice(page);
      await register(page, 'rc1');
      expect(await signIn(page, { replay: true })).toMatchObject({ status: 400, code: 'challenge' });
    } finally { await srv.close(); }
  });

  test('the same device does not get a second passkey for the same coach', async ({ page }) => {
    const store: Store = [];
    const srv = await passkeyServer(LOCAL, store);
    try {
      await page.goto(srv.url);
      await addFingerprintDevice(page);
      await register(page, 'rc1');
      // excludeCredentials: the device itself refuses, and the app reads that
      // refusal as "already set up here".
      expect(await register(page, 'rc1')).toMatchObject({ status: 0, error: 'InvalidStateError' });
      expect(store).toHaveLength(1);
    } finally { await srv.close(); }
  });

  test('a set-up is filed under the coach it was started for, or not at all', async ({ page }) => {
    const store: Store = [];
    const srv = await passkeyServer(LOCAL, store);
    try {
      await page.goto(srv.url);
      await addFingerprintDevice(page);
      // Started as rc1, finished by a session that has since switched to rc2.
      expect(await register(page, 'rc1', 'rc2')).toMatchObject({ status: 400, code: 'mismatch' });
      expect(store).toHaveLength(0);
    } finally { await srv.close(); }
  });

  test('a passkey made on a page the server does not expect is refused', async ({ page }) => {
    const store: Store = [];
    // Same RP, but the only page origin the server accepts is the live app.
    const srv = await passkeyServer(() => ({ rpId: 'localhost', rpName: 'x', origins: ['https://svrz-rc.openvolley.app'] }), store);
    try {
      await page.goto(srv.url);
      await addFingerprintDevice(page);
      expect(await register(page, 'rc1')).toMatchObject({ status: 400, code: 'invalid' });
      expect(store).toHaveLength(0);
    } finally { await srv.close(); }
  });
});

test.describe('Passkey rules', () => {
  test('a passkey set up before the team password last changed is dead', () => {
    const rotated = Date.parse('2026-11-01T12:00:00Z');
    const now = rotated + 1000;
    expect(passkeyOutlived(rotated - 1, rotated, 0, now)).toBe(true);
    expect(passkeyOutlived(rotated + 1, rotated, 0, now)).toBe(false);
    // Never changed / not known: no generation check, like the sessions.
    expect(passkeyOutlived(rotated - 1, 0, 0, now)).toBe(false);
    // A row nobody can date is dead.
    expect(passkeyOutlived(Number.NaN, rotated, 0, now)).toBe(true);
    expect(passkeyOutlived(0, 0, 0, now)).toBe(true);
  });

  test('a passkey nobody signs in with for half a year is dead; each use resets the clock', () => {
    const created = Date.parse('2026-03-01T12:00:00Z');
    expect(passkeyOutlived(created, 0, 0, created + PASSKEY_IDLE_MS - 1)).toBe(false);
    expect(passkeyOutlived(created, 0, 0, created + PASSKEY_IDLE_MS + 1)).toBe(true);
    const used = created + 100 * 24 * 3600 * 1000;
    expect(passkeyOutlived(created, 0, used, created + PASSKEY_IDLE_MS + 1)).toBe(false);
    expect(passkeyOutlived(created, 0, used, used + PASSKEY_IDLE_MS + 1)).toBe(true);
  });

  test('what a device says about itself is cut to what WebAuthn defines', async () => {
    expect(cleanTransports(['internal', 'hybrid', 'x'.repeat(5000), 'internal', 7])).toEqual(['internal', 'hybrid']);
    expect(cleanTransports('usb')).toEqual([]);
    // A credential id that is not base64url never reaches a lookup.
    const c = createPasskeyCeremonies({ rpId: 'localhost', rpName: 'x', origins: ['http://localhost'] });
    let looked = 0;
    for (const id of ['x\\', 'a" || rc_id != "', '']) {
      const { challengeId } = await c.authenticationOptions();
      await expect(c.finishAuthentication({ challengeId, response: { id } as never, lookup: async () => { looked++; return null; } }))
        .rejects.toMatchObject({ code: 'invalid' });
    }
    expect(looked).toBe(0);
  });

  test('a challenge expires, and a used one is gone', async () => {
    let now = 1_000_000;
    const c = createPasskeyCeremonies({ rpId: 'localhost', rpName: 'x', origins: ['http://localhost'] }, () => now);
    const { challengeId } = await c.authenticationOptions();
    now += PASSKEY_CHALLENGE_TTL_MS + 1;
    const late = c.finishAuthentication({ challengeId, response: { id: 'x' } as never, lookup: async () => null });
    await expect(late).rejects.toMatchObject({ code: 'challenge' });
    // Taken out on the first try, even a failed one.
    await expect(c.finishAuthentication({ challengeId, response: { id: 'x' } as never, lookup: async () => null }))
      .rejects.toMatchObject({ code: 'challenge' });
  });

  test('a sign-in challenge cannot finish a set-up', async () => {
    const c = createPasskeyCeremonies({ rpId: 'localhost', rpName: 'x', origins: ['http://localhost'] });
    const { challengeId } = await c.authenticationOptions();
    await expect(c.finishRegistration({ challengeId, rcId: 'rc1', response: {} as never })).rejects.toMatchObject({ code: 'challenge' });
  });

  test('the challenges reachable without a session have a ceiling', async () => {
    const c = createPasskeyCeremonies({ rpId: 'localhost', rpName: 'x', origins: ['http://localhost'] });
    for (let i = 0; i < PASSKEY_CHALLENGES_MAX + 25; i++) await c.authenticationOptions();
    expect(c.pending).toBe(PASSKEY_CHALLENGES_MAX);
  });

  test('the relying party is the web app, and only its pages may ask', () => {
    const cors = ['https://svrz-rc.openvolley.app', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'https://rc.lucanepa.com'];
    expect(passkeyConfig({}, cors)).toEqual({ rpId: 'svrz-rc.openvolley.app', rpName: 'SVRZ Referee Coaching', origins: ['https://svrz-rc.openvolley.app', ...ANDROID_APP_ORIGINS] });
    expect(passkeyConfig({ APP_PUBLIC_URL: 'https://staging.example.org/app/' }, ['https://staging.example.org']).rpId).toBe('staging.example.org');
    expect(passkeyConfig({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGINS: 'http://localhost:3000, https://evil.example', WEBAUTHN_ANDROID_ORIGINS: '' }, cors))
      .toMatchObject({ rpId: 'localhost', origins: ['http://localhost:3000'] });
    expect(originMatchesRp('http://svrz-rc.openvolley.app', 'svrz-rc.openvolley.app')).toBe(false);
    expect(originMatchesRp('https://svrz-rc.openvolley.app.evil.example', 'svrz-rc.openvolley.app')).toBe(false);
    expect(originMatchesRp('not a url', 'localhost')).toBe(false);
    // The installed app's own origins never run a ceremony, not even on a
    // development RP where https://tauri.localhost would match the host rule.
    expect(passkeyConfig({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ANDROID_ORIGINS: '' }, ['http://localhost:3000', ...cors]).origins).toEqual(['http://localhost:3000']);
  });

  test('the installed Android app signs in by its signing key, and only that key', () => {
    // The release key: the same certificate public/.well-known/assetlinks.json gives Google.
    const assetlinks = JSON.parse(readFileSync('public/.well-known/assetlinks.json', 'utf8'));
    expect(assetlinks[0].target.sha256_cert_fingerprints).toEqual([RELEASE_CERT_SHA256]);
    expect(ANDROID_APP_ORIGINS).toEqual([apkKeyHashOrigin(RELEASE_CERT_SHA256)]);
    expect(ANDROID_APP_ORIGINS[0]).toMatch(/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/);
    expect(assetlinks[0].target.package_name).toBe('app.openvolley.svrzrc');
    expect(assetlinks[0].relation).toContain('delegate_permission/common.get_login_creds');
    // A debug build signs with another key: the env replaces the list, and
    // anything that is not an apk-key-hash is dropped.
    const debug = apkKeyHashOrigin(Array(32).fill('AB').join(':'));
    expect(passkeyConfig({ WEBAUTHN_ANDROID_ORIGINS: `${debug}, https://evil.example, android:apk-key-hash:short` }, []).origins).toEqual([debug]);
  });

  test('the device label names the device and the browser, nothing more', () => {
    expect(passkeyDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    // iPadOS asks for the desktop site by default and says "Macintosh".
    expect(passkeyDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1')).toBe('iPad · Safari');
    expect(passkeyDeviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(passkeyDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Windows · Edge');
    expect(passkeyDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:144.0) Gecko/20100101 Firefox/144.0')).toBe('Mac · Firefox');
    expect(passkeyDeviceLabel('')).toBe('Unbekanntes Gerät');
    // The installed Android app's web view.
    expect(passkeyDeviceLabel('Mozilla/5.0 (Linux; Android 16; Pixel 7 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36')).toBe('Android · App');
  });
});
