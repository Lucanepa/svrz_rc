// Sign-in with a passkey: the device's fingerprint, face or PIN unlocks a key
// the device keeps; the app never sees the fingerprint or the face. The server
// side, and where a passkey stands next to the team password, is in
// server/passkeys.ts.
//
// Web only. The installed app's pages live on tauri:// (or tauri.localhost),
// and a passkey belongs to the web app's host — the device would refuse the
// ceremony, and on Linux the app's web view has no passkey support at all. So
// the installed app keeps the team password, and nothing here is offered there.

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  sendSignal,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { IS_NATIVE } from './native';
import {
  passkeyLogin, passkeyLoginOptions, passkeyRegister, passkeyRegisterOptions,
  type PasskeyEntry,
} from './pocketbase';

/** This page can run a passkey ceremony at all. */
export function passkeysPossible(): boolean {
  if (IS_NATIVE) return false;
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

/** This device can hold a passkey itself, unlocked by its own fingerprint,
 *  face or PIN — what the offer after sign-in asks about. A laptop without a
 *  sensor can still sign in with a phone's passkey; it just is not offered to
 *  keep one. */
export async function deviceCanHoldPasskey(): Promise<boolean> {
  if (!passkeysPossible()) return false;
  try { return await platformAuthenticatorIsAvailable(); } catch { return false; }
}

/** The person closed the device's sheet, or let it time out: not an error
 *  worth words, only a reason to stop. */
export function isPasskeyCancel(error: unknown): boolean {
  const e = error as { name?: string; code?: string; cause?: { name?: string } } | null;
  if (!e) return false;
  return e.name === 'NotAllowedError' || e.name === 'AbortError'
    || e.code === 'ERROR_CEREMONY_ABORTED'
    || e.cause?.name === 'NotAllowedError' || e.cause?.name === 'AbortError';
}

/** The device already holds a passkey for this coach (it refused to make a
 *  second): as good as a success for the person tapping. */
export function isPasskeyAlreadyHere(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null;
  return e?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || e?.name === 'InvalidStateError';
}

/** The full sign-in: options, the device's sheet, the check. Throws the API's
 *  error (with `.code`) or the device's (see isPasskeyCancel). `onThisDevice`
 *  is false when the key came from elsewhere — a phone held up to a laptop's
 *  QR code, a security key — so the laptop is not taken for its home. */
export async function signInWithPasskey(): Promise<{ rc: { id: string; name: string; firstName?: string }; credentialId: string; onThisDevice: boolean }> {
  const { challengeId, options } = await passkeyLoginOptions();
  const optionsJSON = options as PublicKeyCredentialRequestOptionsJSON;
  const response = await startAuthentication({ optionsJSON });
  try {
    const rc = await passkeyLogin(challengeId, response);
    return { rc, credentialId: response.id, onThisDevice: response.authenticatorAttachment !== 'cross-platform' };
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A key the server no longer knows (removed under Optionen, or set up on
    // a test server): ask the device to stop offering it. Best effort — most
    // browsers ignore it so far, and it changes nothing here either way.
    if (code === 'unknown' && optionsJSON.rpId) {
      void sendSignal({ signalName: 'unknownCredential', rpID: optionsJSON.rpId, credentialID: response.id }).catch(() => {});
    }
    // Dead or gone: this device no longer has a working passkey, so the next
    // sign-in with the password offers the set-up again — which is exactly
    // what the refusal tells the coach to do.
    if (code === 'unknown' || code === 'outdated') dropHintFor(response.id);
    throw error;
  }
}

/** Sets up a passkey for the coach the session names — normally on this
 *  device; `onThisDevice` is false when the person chose a phone or a key. */
export async function setUpPasskey(): Promise<PasskeyEntry & { onThisDevice: boolean }> {
  const { challengeId, options } = await passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
  const entry = await passkeyRegister(challengeId, response);
  return { ...entry, onThisDevice: response.authenticatorAttachment !== 'cross-platform' };
}

/** Asks the device to forget a passkey the server just removed. Best effort,
 *  like every signal; the relying party is the page's own host. */
export function forgetPasskeyOnDevice(credentialId: string): void {
  if (!credentialId) return;
  void sendSignal({ signalName: 'unknownCredential', rpID: window.location.hostname, credentialID: credentialId }).catch(() => {});
}

// What this device remembers about passkeys, per coach. Hints only — site data
// on a phone comes and goes, and the server is the authority on what signs in.
// `on`: a passkey was set up here, so the login screen leads with it and the
// offer is not repeated; `credentialId` is which one, so the list under
// Optionen can say "this device". `dismissed`: the coach said "not now".
const HINT_KEY = 'svrz_passkey_hints';
type Hint = { on?: boolean; dismissed?: boolean; credentialId?: string };
type Hints = Record<string, Hint>;

function readHints(): Hints {
  try {
    const parsed = JSON.parse(localStorage.getItem(HINT_KEY) || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Hints : {};
  } catch { return {}; }
}

function writeHint(rcId: string, patch: Hint): void {
  try {
    const hints = readHints();
    hints[rcId] = { ...hints[rcId], ...patch };
    localStorage.setItem(HINT_KEY, JSON.stringify(hints));
  } catch { /* private mode — the offer may come again, nothing worse */ }
}

/** Some coach set up a passkey on this device. */
export function anyPasskeyOnDevice(): boolean {
  return Object.values(readHints()).some((h) => h.on);
}

export function passkeyOnDevice(rcId: string): boolean {
  return Boolean(readHints()[rcId]?.on);
}

export function markPasskeyOnDevice(rcId: string, on: boolean, credentialId?: string): void {
  writeHint(rcId, on ? { on, ...(credentialId ? { credentialId } : {}) } : { on: false, credentialId: '' });
}

/** Forgets that this device holds `credentialId`, for whichever coach. */
export function dropHintFor(credentialId: string): void {
  if (!credentialId) return;
  for (const [rcId, hint] of Object.entries(readHints())) {
    if (hint.credentialId === credentialId) writeHint(rcId, { on: false, credentialId: '' });
  }
}

/** Which of the coach's passkeys is this device's, when it is known. */
export function passkeyIdOnDevice(rcId: string): string {
  return readHints()[rcId]?.credentialId || '';
}

export function passkeyOfferDismissed(rcId: string): boolean {
  return Boolean(readHints()[rcId]?.dismissed);
}

export function dismissPasskeyOffer(rcId: string): void {
  writeHint(rcId, { dismissed: true });
}
