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
