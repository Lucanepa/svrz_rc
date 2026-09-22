// The installed app's session — pure enough to test without a PocketBase
// (see e2e/native-client.spec.ts); index.ts only mounts it.
//
// A native build (src/lib/native.ts) runs on an origin that is a different site
// from this API, so its session cookies would be third-party — dropped by
// WebKit, never sent under SameSite=Lax. It carries them itself instead: the
// same signed tokens, sent back in `X-Svrz-Jar` as a Cookie line, and handed
// out in `X-Svrz-Set-Session` wherever a response sets one. Every auth check in
// index.ts reads req.headers.cookie and every sign-in calls res.cookie, so
// translating at this one door leaves all of them unchanged.
//
// It grants nothing a cookie would not: the tokens are the same, signed and
// expiring the same way, and a request with the header but no valid token is
// the same 401. Only our two session cookies cross; the jar cannot smuggle in
// anything else. A browser never adds a custom header by itself, so a forged
// cross-site request has no session to ride on.
//
// `minVersion` (NATIVE_MIN_VERSION in svrz-api.env) turns away an installed app
// older than an API change it cannot follow, with 426 — the app shows "update
// required" instead of failing request after request. /api/health and the log
// intake stay open, so an outdated app can still say what happened to it.

import type { Request, Response } from 'express';

export const NATIVE_JAR_COOKIES = new Set(['svrz_rc_session', 'svrz_admin_session']);

/** Whether dotted `version` is older than `minimum`. An empty minimum lets
 *  everything through; a leading `v` or `native-v` is ignored on both. */
export function versionBelow(version: string, minimum: string): boolean {
  if (!minimum) return false;
  const parts = (v: string) => v.replace(/^[^\d]*/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** The jar header as the Cookie line the auth code reads: our two sessions
 *  only, everything else dropped. */
export function jarToCookieLine(jar: string): string {
  return jar
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('=') && NATIVE_JAR_COOKIES.has(part.slice(0, part.indexOf('=')).trim()))
    .join('; ');
}

const OPEN_TO_OUTDATED = new Set(['/api/health', '/api/client-logs']);

export function nativeClient(opts: { minVersion: string }) {
  return (req: Request, res: Response, next: () => void) => {
    const client = String(req.headers['x-svrz-client'] ?? '').trim();
    if (!client.startsWith('native/')) { next(); return; }
    const version = client.slice('native/'.length);
    if (opts.minVersion && versionBelow(version, opts.minVersion) && !OPEN_TO_OUTDATED.has(req.path)) {
      res.status(426).json({ error: 'This version of the app is no longer supported. Please update it.', minVersion: opts.minVersion });
      return;
    }
    // The jar replaces the Cookie line outright: the installed app has no
    // cookies of its own for this site.
    req.headers.cookie = jarToCookieLine(String(req.headers['x-svrz-jar'] ?? ''));
    const setSession: { name: string; value: string; maxAge: number | null }[] = [];
    const setCookie = res.cookie.bind(res);
    res.cookie = ((name: string, value: unknown, options?: { maxAge?: number }) => {
      if (NATIVE_JAR_COOKIES.has(name)) {
        setSession.push({ name, value: String(value ?? ''), maxAge: typeof options?.maxAge === 'number' ? options.maxAge : null });
        res.setHeader('X-Svrz-Set-Session', JSON.stringify(setSession));
      }
      return setCookie(name, value as string, options ?? {});
    }) as Response['cookie'];
    next();
  };
}
