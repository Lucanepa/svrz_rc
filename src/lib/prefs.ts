// Per-device choices made at the login screen and honoured everywhere after.
//
// The team signs in on one shared credential, so the two things the session
// cookie cannot answer on its own — who is holding the device, and which
// language they read — are answered once at the gate and remembered here. The
// RC id is the *pre-selection* for the picker only: what the app acts on is
// always the identity the server put on the session, never this value.
//
// Every accessor swallows storage errors. Safari's private mode throws on
// localStorage access, and a preference is never worth breaking a login over.

export type Lang = 'DE' | 'EN';

const LANG_KEY = 'svrz_lang';
const RC_KEY = 'svrz_rc_identity';

export function getStoredLang(): Lang | null {
  try {
    const value = localStorage.getItem(LANG_KEY);
    return value === 'DE' || value === 'EN' ? value : null;
  } catch { return null; }
}

export function setStoredLang(lang: Lang): void {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode — this session only */ }
}

export function getStoredRcId(): string | null {
  try { return localStorage.getItem(RC_KEY) || null; } catch { return null; }
}

export function setStoredRcId(rcId: string | null): void {
  try {
    if (rcId) localStorage.setItem(RC_KEY, rcId);
    else localStorage.removeItem(RC_KEY);
  } catch { /* private mode — the picker just asks again next time */ }
}

// The language on screen right now. The RC app and the admin console each keep
// their own choice (svrz_lang / svrz_admin_lang) and say which one is showing;
// the pages that only read the stored choice need not. Read by what speaks
// outside any one screen: the API language header (apiLang.ts), and the toast
// and confirm chrome when their caller passed no language.
let showing: Lang | null = null;

export function setUiLang(lang: Lang | null): void {
  showing = lang;
}

export function uiLang(): Lang {
  if (showing) return showing;
  const stored = getStoredLang();
  if (stored) return stored;
  // Nothing chosen yet: the browser's guess, as the app's first screen makes it.
  const nav = typeof navigator === 'undefined' ? '' : navigator.language || '';
  return nav.toLowerCase().startsWith('en') ? 'EN' : 'DE';
}

/** The text for the language on screen — for a message composed away from any
 *  screen's dictionary (a fetch helper's fallback, a parser's refusal). */
export function inUiLang(de: string, en: string): string {
  return uiLang() === 'EN' ? en : de;
}
