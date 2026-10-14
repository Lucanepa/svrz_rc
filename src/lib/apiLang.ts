// Tells the API which language to answer in (asked 2026-10-14: a refused take
// came back in German to a coach reading the app in English). Every call to
// the API carries the language on screen as Accept-Language, and the server
// picks the matching text of each message (server/say.ts).
//
// Accept-Language is a CORS-safelisted header for a value like "en" or "de",
// so the web app's cross-origin calls pay no preflight for it. A call that sets
// its own Accept-Language keeps it.

import { uiLang } from './prefs';

let installed = false;

/** Whether a URL is one of our API calls: the configured API origin, or
 *  same-origin `/api/` (the dev proxy and the e2e stubs). */
export function isApiUrl(url: string, apiBase: string, here: string): boolean {
  let u: URL;
  try { u = new URL(url, here); } catch { return false; }
  if (!u.pathname.startsWith('/api/')) return false;
  const base = apiBase.replace(/\/+$/, '');
  if (base) {
    try { if (u.origin === new URL(base, here).origin) return true; } catch { /* a malformed base matches nothing */ }
  }
  return u.origin === new URL(here).origin;
}

export function installApiLang(apiBase: string): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const raw = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isApiUrl(url, apiBase, window.location.href)) return raw(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has('Accept-Language')) return raw(input, init);
    headers.set('Accept-Language', uiLang() === 'EN' ? 'en' : 'de');
    const nextInit: RequestInit = { ...init, headers };
    return raw(input instanceof Request ? new Request(input, nextInit) : input, nextInit);
  }) as typeof fetch;
}
