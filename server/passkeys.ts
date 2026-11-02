// Sign-in with a passkey (02.11.2026): the coach's own phone, tablet or laptop
// holds a key, and the device's fingerprint, face or PIN unlocks it. The app
// never sees the fingerprint or the face — the device checks it and signs a
// challenge; the server checks the signature against the public key it stored
// when the coach set the passkey up.
//
// Kept free of Express and the database, like rcSession.ts, so a spec can run
// the real ceremonies in a browser against an in-memory store
// (e2e/passkey-ceremony.spec.ts). index.ts keeps the I/O: the rows, the
// cookie, the log, the mail.
//
// Where a passkey stands in the trust model. Picking a name is a claim, not a
// proof (see /api/auth/rc/identify): anyone holding the team password can pick
// any name, and so could set up a passkey under it. A passkey therefore proves
// "this device, unlocked by its owner, belonged to someone who knew the team
// password when it was set up" — the same thing a session proves, for longer.
// So the team password's generation rule reaches passkeys too: rotating the
// password ends every passkey set up before the rotation (passkeyOutlived),
// exactly as it ends every session. Otherwise a leaked password, used once to
// set up a passkey, would outlive the rotation that was meant to shut it out.
// The coach is mailed whenever one is set up under their name, which is what
// turns a passkey somebody else made into something they hear about.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { randomBytes } from 'node:crypto';

/** How long the device sheet may stay open. The browser's own default is a
 *  minute; a coach looking for the fingerprint sensor of a borrowed tablet
 *  gets two. */
export const PASSKEY_CEREMONY_MS = 2 * 60 * 1000;
/** A challenge waits a little longer than the sheet, for a slow network. */
export const PASSKEY_CHALLENGE_TTL_MS = PASSKEY_CEREMONY_MS + 60 * 1000;
/** Outstanding challenges this process holds at most. The login options are
 *  reachable without a session, so the map needs a ceiling that does not
 *  depend on the rate limiter being right. The oldest go first. */
export const PASSKEY_CHALLENGES_MAX = 2000;
/** Passkeys one coach may have. A phone, a tablet, a laptop and their
 *  replacements fit easily; a script making thousands does not. */
export const PASSKEYS_PER_RC_MAX = 10;
/** A passkey nobody has signed in with for this long is dead. A key somebody
 *  else set up under a coach's name, and never needed again, does not stay a
 *  way in for good; a coach who uses the app sees the clock reset each time.
 *  Half a year spans the summer break with room to spare. */
export const PASSKEY_IDLE_MS = 1000 * 60 * 60 * 24 * 180;
/** What a device may call its transports (WebAuthn's enum). Anything else in
 *  the answer is dropped, not stored and served back. */
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
/** A credential id as the browser sends it: base64url, and not a novel. */
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/;

export type PasskeyConfig = {
  /** The WebAuthn relying party: the web app's host name. */
  rpId: string;
  rpName: string;
  /** The page origins a ceremony may come from. */
  origins: string[];
};

/**
 * Where passkeys belong. The ceremony runs on the PAGE (svrz-rc.openvolley.app),
 * not on the API host, so the relying party is the app's host — narrow on
 * purpose: a passkey for this app is offered on this app and nowhere else on
 * openvolley.app. Origins default to the CORS list, minus the installed app's
 * own schemes (a tauri:// page cannot hold a passkey for a web host).
 */
export function passkeyConfig(env: Record<string, string | undefined>, corsOrigins: string[]): PasskeyConfig {
  const appUrl = env.APP_PUBLIC_URL || 'https://svrz-rc.openvolley.app/';
  let rpId = (env.WEBAUTHN_RP_ID || '').trim();
  if (!rpId) {
    try { rpId = new URL(appUrl).hostname; } catch { rpId = 'svrz-rc.openvolley.app'; }
  }
  const explicit = (env.WEBAUTHN_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  // The installed app's schemes never, whatever the RP: with WEBAUTHN_RP_ID=
  // localhost (development) https://tauri.localhost would otherwise match.
  const origins = (explicit.length ? explicit : corsOrigins)
    .filter((o) => !/^(tauri:|https?:\/\/tauri\.localhost(:\d+)?$)/i.test(o))
    .filter((o) => originMatchesRp(o, rpId));
  return { rpId, rpName: 'SVRZ Referee Coaching', origins: [...new Set(origins)] };
}

/** An origin whose host is the RP ID or one of its subdomains, over https —
 *  or plain http on localhost, which is what browsers allow for development. */
export function originMatchesRp(origin: string, rpId: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname;
  const hostOk = host === rpId || host.endsWith(`.${rpId}`);
  if (!hostOk) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && host === 'localhost');
}

/**
 * Whether a passkey is dead. Two rules:
 *  - the team password's generation: one set up before the password last
 *    changed is dead. `credentialSince` 0 means "never changed in the console
 *    / not known", which skips this check — the same choice judgeRcSession
 *    makes, for the same reason (a hiccup at startup must not sign everyone
 *    out). So a rotation has to go through the console to reach passkeys.
 *  - idle: one not used for PASSKEY_IDLE_MS (counted from the set-up when it
 *    was never used) is dead.
 * A creation time that cannot be read counts as dead: the rules exist to fail
 * closed on exactly the rows nobody can vouch for.
 */
export function passkeyOutlived(createdMs: number, credentialSince: number, lastUsedMs = 0, now = Date.now()): boolean {
  if (!Number.isFinite(createdMs) || createdMs <= 0) return true;
  if (credentialSince > 0 && createdMs < credentialSince) return true;
  const lastSign = Number.isFinite(lastUsedMs) && lastUsedMs > createdMs ? lastUsedMs : createdMs;
  return now - lastSign > PASSKEY_IDLE_MS;
}

/** The device's transports, cut to the ones WebAuthn defines. */
export function cleanTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((t) => TRANSPORTS.has(t)))];
}

/** "iPhone · Safari", "Android · Chrome", "Mac · Firefox" — so the list under
 *  Optionen reads as the coach's own devices. Never more than that: it is
 *  shown to the coach and mailed to them, and the full user agent string
 *  would only be noise. */
export function passkeyDeviceLabel(userAgent: string): string {
  const ua = userAgent || '';
  const device =
    /iPad/.test(ua) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone'
        : /Android/.test(ua) ? 'Android'
          : /Macintosh|Mac OS X/.test(ua) ? (/Mobile/.test(ua) ? 'iPad' : 'Mac')
            : /Windows/.test(ua) ? 'Windows'
              : /CrOS/.test(ua) ? 'Chromebook'
                : /Linux/.test(ua) ? 'Linux'
                  : '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
          : /OPR\//.test(ua) ? 'Opera'
            : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) ? 'Safari'
                : '';
  return [device, browser].filter(Boolean).join(' · ') || 'Unbekanntes Gerät';
}

/** A stored passkey, as the ceremonies need it. */
export type StoredPasskey = {
  /** The row id. */
  id: string;
  rcId: string;
  /** base64url, as the browser reports it. */
  credentialId: string;
  /** base64url of the COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  createdMs: number;
  /** When it last signed in, ms; 0 = never. */
  lastUsedMs: number;
};

export type NewPasskey = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  backedUp: boolean;
};

/** Why a ceremony was refused, as a code the route turns into words. */
export type PasskeyRefusal =
  | 'challenge'        // unknown, used or expired: start again
  | 'unknown'          // no such passkey here (removed, or another app's)
  | 'mismatch'         // the challenge was issued to somebody else
  | 'invalid';         // the signature, origin, RP or user verification failed

export class PasskeyError extends Error {
  constructor(readonly code: PasskeyRefusal, message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

type Challenge = { challenge: string; purpose: 'register' | 'login'; rcId: string; expiresAt: number };

/**
 * The two ceremonies with their challenges. Challenges live in this process
 * only: a restart costs whoever had the sheet open one more tap, and nothing
 * else. Each is single-use — taken out of the map before it is checked, so a
 * replayed response finds nothing to match.
 */
export function createPasskeyCeremonies(config: PasskeyConfig, now: () => number = Date.now) {
  const challenges = new Map<string, Challenge>();

  const issue = (entry: Omit<Challenge, 'expiresAt'>): string => {
    sweep();
    while (challenges.size >= PASSKEY_CHALLENGES_MAX) {
      const oldest = challenges.keys().next().value;
      if (oldest === undefined) break;
      challenges.delete(oldest);
    }
    const id = randomBytes(18).toString('base64url');
    challenges.set(id, { ...entry, expiresAt: now() + PASSKEY_CHALLENGE_TTL_MS });
    return id;
  };

  const take = (id: string, purpose: Challenge['purpose']): Challenge => {
    const entry = typeof id === 'string' ? challenges.get(id) : undefined;
    if (entry) challenges.delete(id);
    if (!entry || entry.purpose !== purpose || entry.expiresAt < now()) {
      throw new PasskeyError('challenge', 'challenge unknown, used or expired');
    }
    return entry;
  };

  function sweep(): void {
    const t = now();
    for (const [id, entry] of challenges) if (entry.expiresAt < t) challenges.delete(id);
  }

  return {
    config,
    sweep,
    /** Outstanding challenges, for the spec. */
    get pending(): number { return challenges.size; },

    /**
     * Options for setting up a passkey for `rcId`. The user handle is the RC's
     * id — a random record id, nothing personal — so a device that already
     * holds a passkey for this coach replaces it instead of keeping two.
     * Discoverable and user-verified, both required: sign-in starts with no
     * name typed, and "fingerprint or face" is the whole point.
     */
    async registrationOptions(opts: {
      rcId: string;
      name: string;
      existing: Array<{ credentialId: string; transports: string[] }>;
    }): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpId,
        userID: isoUint8Array.fromUTF8String(opts.rcId),
        userName: opts.name,
        userDisplayName: opts.name,
        timeout: PASSKEY_CEREMONY_MS,
        attestationType: 'none',
        excludeCredentials: opts.existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        preferredAuthenticatorType: 'localDevice',
      });
      const challengeId = issue({ challenge: options.challenge, purpose: 'register', rcId: opts.rcId });
      return { challengeId, options };
    },

    async finishRegistration(opts: {
      challengeId: string;
      rcId: string;
      response: RegistrationResponseJSON;
    }): Promise<NewPasskey> {
      const entry = take(opts.challengeId, 'register');
      // Set up under the name the challenge was issued for, or not at all: a
      // session that switched coach between the two calls does not get to
      // file the key under the new name.
      if (entry.rcId !== opts.rcId) throw new PasskeyError('mismatch', 'challenge issued for another coach');
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: opts.response,
          expectedChallenge: entry.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          requireUserVerification: true,
        });
      } catch (error) {
        throw new PasskeyError('invalid', error instanceof Error ? error.message : String(error));
      }
      if (!verification.verified || !verification.registrationInfo) throw new PasskeyError('invalid', 'registration not verified');
      const info = verification.registrationInfo;
      return {
        credentialId: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: cleanTransports(info.credential.transports ?? opts.response.response?.transports),
        backedUp: info.credentialBackedUp,
      };
    },

    /** Options for signing in. No list of allowed keys: the device offers the
     *  passkeys it has for this site, and the answer says whose it was. */
    async authenticationOptions(): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        timeout: PASSKEY_CEREMONY_MS,
        userVerification: 'required',
      });
      const challengeId = issue({ challenge: options.challenge, purpose: 'login', rcId: '' });
      return { challengeId, options };
    },

    async finishAuthentication(opts: {
      challengeId: string;
      response: AuthenticationResponseJSON;
      lookup: (credentialId: string) => Promise<StoredPasskey | null>;
    }): Promise<{ passkey: StoredPasskey; newCounter: number }> {
      const entry = take(opts.challengeId, 'login');
      const credentialId = typeof opts.response?.id === 'string' ? opts.response.id : '';
      // Checked before it goes anywhere near a filter string.
      if (!CREDENTIAL_ID_RE.test(credentialId)) throw new PasskeyError('invalid', 'response carries no usable credential id');
      const passkey = await opts.lookup(credentialId);
      if (!passkey) throw new PasskeyError('unknown', 'no such passkey');
      // The user handle, when the device sends one, must be the coach the key
      // is filed under. A row's rc_id is the authority either way; this only
      // catches a key that was copied onto the wrong row.
      const handle = opts.response.response?.userHandle;
      if (handle) {
        let claimed = '';
        try { claimed = isoUint8Array.toUTF8String(isoBase64URL.toBuffer(handle)); } catch { claimed = ''; }
        if (claimed !== passkey.rcId) throw new PasskeyError('invalid', 'user handle does not match the passkey');
      }
      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response: opts.response,
          expectedChallenge: entry.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: isoBase64URL.toBuffer(passkey.publicKey),
            counter: passkey.counter,
            transports: passkey.transports as never,
          },
          requireUserVerification: true,
        });
      } catch (error) {
        throw new PasskeyError('invalid', error instanceof Error ? error.message : String(error));
      }
      if (!verification.verified) throw new PasskeyError('invalid', 'authentication not verified');
      return { passkey, newCounter: verification.authenticationInfo.newCounter };
    },
  };
}

export type PasskeyCeremonies = ReturnType<typeof createPasskeyCeremonies>;
