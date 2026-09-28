// The lifetime rules of an app session (`svrz_rc_session`), kept free of
// Express and PocketBase so the spec can pin them without a server.
//
// Two clocks:
//  - `exp`, the sliding one: 30 days from the last time the token was minted.
//  - `iat`, the login: when the team password was typed. Picking a name
//    (/api/auth/rc/identify) re-mints the token but CARRIES `iat` over, so the
//    session can never outlive RC_MAX_SESSION_MS from the moment somebody
//    actually knew the password. Before this, every identify minted a fresh
//    30 days, and a holder who called it once a month kept a session forever.
//
// And one generation: a session whose login predates the team password's last
// change is dead. Rotating a leaked password has to take the people who got in
// with it back out; otherwise the rotation locks out only the honest coaches,
// who are the ones who would have typed it again anyway.

export const RC_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, sliding
// Generous on purpose: phones already lose their site data every few days and
// re-login is the most common complaint. Ninety days is a season's stretch, and
// its only job is to put an END on a session, not to shorten normal use.
export const RC_MAX_SESSION_MS = 1000 * 60 * 60 * 24 * 90;

export type RcSessionClaims = { ok: boolean; rcId: string; loginAt: number };
export const NO_RC_CLAIMS: RcSessionClaims = { ok: false, rcId: '', loginAt: 0 };

/**
 * Judge a parsed, signature-checked token body.
 *
 * `credentialSince` is when the team password last changed (ms), or 0 when
 * unknown / never changed in the console — 0 skips the generation check rather
 * than failing closed, because a PocketBase hiccup at startup must not sign
 * every coach out.
 *
 * Tokens minted before `iat` existed carry only `exp`. Their login time is
 * taken as `exp - RC_TTL_MS` — the moment that token was minted, the latest
 * the login can have been — so a deploy logs nobody out: they run to their own
 * `exp`, and die early only if the password is rotated after they were minted.
 */
export function judgeRcSession(
  parsed: { purpose?: unknown; rcId?: unknown; exp?: unknown; iat?: unknown },
  now: number,
  credentialSince: number,
): RcSessionClaims {
  if (parsed.purpose !== 'rc') return NO_RC_CLAIMS;
  const exp = Number(parsed.exp);
  if (!Number.isFinite(exp) || exp < now) return NO_RC_CLAIMS;
  const iat = Number(parsed.iat);
  const hasIat = parsed.iat !== undefined && parsed.iat !== null && Number.isFinite(iat) && iat > 0;
  const loginAt = hasIat ? iat : exp - RC_TTL_MS;
  if (hasIat && now > iat + RC_MAX_SESSION_MS) return NO_RC_CLAIMS;
  if (credentialSince > 0 && loginAt < credentialSince) return NO_RC_CLAIMS;
  const rcId = parsed.rcId === null || parsed.rcId === undefined ? '' : String(parsed.rcId).trim();
  return { ok: true, rcId, loginAt };
}

/** The `iat`/`exp` pair for a token minted now. `loginAt` is the original
 *  login when re-minting (identify), omitted for a fresh login. The sliding
 *  30 days never reaches past the absolute cap. */
export function rcSessionTimes(now: number, loginAt?: number): { iat: number; exp: number } {
  const iat = loginAt && loginAt > 0 && loginAt <= now ? loginAt : now;
  return { iat, exp: Math.min(now + RC_TTL_MS, iat + RC_MAX_SESSION_MS) };
}
