// The rules that keep the activity log bounded and free of capability tokens —
// pure, so they can be tested without a running server (e2e/log-guard.spec.ts).
// logstore.ts, erroralerts.ts and index.ts keep the I/O.
//
// Two unauthenticated doors feed the log: /api/client-logs (on purpose — a
// beacon fires after logout) and the request logger, which records every
// request before any route decides who is asking. Whatever reaches the ring or
// the daily JSONL through either of them is bounded here by BYTES, not only by
// count: the ring is 20,000 entries, and 20,000 entries of a quarter megabyte
// each is an out-of-memory crash, while the JSONL sits on the disk pb_data
// shares.

// ── Capability tokens ────────────────────────────────────────────────
// Three URLs carry the only credential their resource has: the iCal feed, a
// referee's survey, and a signature slug. The log is read by every admin (and
// by LOG_READ_TOKEN holders), none of whom that token was handed to. The
// request logger strips them from the lines it writes, and the browser scrubs
// the lines it ships — but a call site that forgets (a 429 logging req.path, a
// click on an anchor logging its href) wrote the token verbatim. record() runs
// every string through this, so forgetting stops mattering.
//
// The named exceptions are routes, not tokens: `ical/me` is the app asking for
// its own link, `survey/responses` the chair's reader, `signature/start` the
// coach opening a session.
const API_TOKEN_RE = /(\/api\/(?:ical|survey|signature)\/)(?!(?:me|responses|start)(?:[/?#\s"'.]|$))[^/?#\s"'<>]+/gi;
// The app's own pages for the same tokens stay in the fragment (#/sign/<slug>,
// #/survey/<token>), so they reach the log as part of a copied href or path.
const HASH_TOKEN_RE = /(#\/(?:survey|sign)\/)[^/?#\s"'<>]+/gi;

export function redactCapabilityTokens(value: string): string {
  if (!value || value.indexOf('/') === -1) return value;
  // `<` is outside the token class, so an already-redacted `<token>` does not
  // match again: redacting twice reads the same as redacting once.
  return value.replace(API_TOKEN_RE, '$1<token>').replace(HASH_TOKEN_RE, '$1<token>');
}

// ── Entry fields that are not message or data ────────────────────────
// msg and data are capped by redact(); these rode along whole. `t` came
// straight from the browser's batch, and `sid`/`did` from a header or a body
// field the caller writes — each one a way to store a quarter megabyte per
// entry past every other bound.
export const ENTRY_FIELD_MAX = {
  evt: 60,
  sid: 64,
  did: 64,
  reqId: 32,
  ip: 64,
  user: 140,
} as const;

export function capField(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * A client-supplied timestamp, or undefined for "use the arrival time".
 * Only a short string that parses as a date is kept: the browser's own clock
 * is what keeps a batched, offline-buffered session in order, but anything else
 * in that field is not a timestamp and has no reason to be stored.
 */
export function clientTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > 40) return undefined;
  return Number.isNaN(Date.parse(t)) ? undefined : t;
}

// ── Body shapes ──────────────────────────────────────────────────────
// A body too large to log inline is logged as its shape: size and key names.
// The key names are the caller's, so an unauthenticated POST of sixty
// 2,000-character keys was 120 kB per line. A real body has a handful of short
// keys; the first twenty, each clipped, still answers "what did it send".
export const SHAPE_MAX_KEYS = 20;
export const SHAPE_MAX_KEY_CHARS = 60;

export function boundedKeys(keys: string[]): { keys: string[]; more?: number } {
  const shown = keys.slice(0, SHAPE_MAX_KEYS).map((k) => (k.length > SHAPE_MAX_KEY_CHARS ? `${k.slice(0, SHAPE_MAX_KEY_CHARS)}…` : k));
  return keys.length > SHAPE_MAX_KEYS ? { keys: shown, more: keys.length - SHAPE_MAX_KEYS } : { keys: shown };
}

// ── Who a client batch belongs to ────────────────────────────────────
export const UNVERIFIED_PREFIX = 'unverified:';

/**
 * The name a client log batch is filed under. Verified only when the session
 * behind the request names that very person: an active RC whose full name is
 * the claim, or a console session whose login is. A valid cookie was not
 * enough — any coach's cookie filed lines under any other coach's name, and a
 * deactivated coach's cookie (it verifies until its 30-day expiry) still
 * counted.
 */
export function clientLogUser(
  claimed: string,
  session: { rcName?: string | null; consoleEmail?: string | null },
): string | undefined {
  if (!claimed) return undefined;
  const verified = (session.rcName && session.rcName === claimed)
    || (session.consoleEmail && session.consoleEmail === claimed);
  return verified ? claimed : `${UNVERIFIED_PREFIX}${claimed}`;
}

/** A client line nobody vouches for: no name, or one the ingest marked. */
export function isUnverifiedEntry(entry: { src?: string; user?: string }): boolean {
  if (entry.src !== 'client') return false;
  return !entry.user || entry.user.startsWith(UNVERIFIED_PREFIX);
}

// ── Error-alert digest admission ─────────────────────────────────────
/**
 * Whether a new failure class gets a slot in the pending digest, and which
 * unverified one it pushes out to get it.
 *
 * Anyone can post error-level client lines, and each distinct `evt` is its own
 * class, so without a separate budget a stream of random ones filled all the
 * slots and every real server error after it was dropped — then held back an
 * hour by the cooldown on top. Unverified classes get a small share of their
 * own; a server or verified error always gets in, evicting an unverified class
 * if that is what it takes.
 */
export function digestAdmission(
  pending: Map<string, { unverified: boolean }>,
  unverified: boolean,
  limits: { maxGroups: number; maxUnverifiedGroups: number },
): { admit: boolean; evict?: string } {
  let unverifiedCount = 0;
  let firstUnverified: string | undefined;
  for (const [key, g] of pending) {
    if (!g.unverified) continue;
    unverifiedCount++;
    if (firstUnverified === undefined) firstUnverified = key;
  }
  if (unverified) {
    if (unverifiedCount >= limits.maxUnverifiedGroups) return { admit: false };
    return { admit: pending.size < limits.maxGroups };
  }
  if (pending.size < limits.maxGroups) return { admit: true };
  return firstUnverified !== undefined ? { admit: true, evict: firstUnverified } : { admit: false };
}
