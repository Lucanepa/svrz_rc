// When a new service worker takes control, may this page reload?
//
// The decision lives here, away from the wiring in main.tsx, because it is the
// one piece that can strand every user at once: it reloaded an iPhone eight
// times a minute on 09.09.2026 (111 times in one session) and the app could not
// be worked at all. A rule that dangerous should be testable without a browser,
// a service worker and a deploy.
//
// The wiring — the listener, the draft flush, the actual location.reload() —
// stays in main.tsx. Only the judgement is here.

export type SwReloadDecision =
  /** Take the new build now. */
  | 'reload'
  /** Too young to be stale: try again once the page has been up a minute. */
  | 'too-soon'
  /** This looks like a loop. Keep the build we have and say so. */
  | 'looping'
  /** The app is on screen: take the new build the moment it is not — when
   *  the coach switches app or locks the phone — never in front of them. */
  | 'when-hidden';

export const SW_RELOAD_STATE_KEY = 'svrz_sw_reloads';
/** A page that has just started has nothing stale to escape. */
export const SW_RELOAD_MIN_UPTIME_MS = 60 * 1000;
/** Two is a deploy landing awkwardly; three in a row is a worker in a loop. */
export const SW_RELOAD_MAX_IN_A_ROW = 2;
/** What separates a loop from normal life is spacing: a deploy is days apart. */
export const SW_RELOAD_FORGET_MS = 10 * 60 * 1000;

/** Consecutive recent reloads, ignoring any that have gone quiet. */
export function recentSwReloads(raw: string | null, now: number): number {
  try {
    const { n, at } = JSON.parse(raw || '{}') as { n?: number; at?: number };
    if (!n || !at || now - at > SW_RELOAD_FORGET_MS) return 0;
    return n;
  } catch {
    return 0;
  }
}

/** The state to store after a reload is taken. */
export function noteSwReload(raw: string | null, now: number): string {
  return JSON.stringify({ n: recentSwReloads(raw, now) + 1, at: now });
}

/**
 * A reload in front of the coach reads as a crash: the list they were
 * scrolling, the game they were opening, gone and redrawn — and with several
 * deploys in a day it happened several times a day (25.09.2026, "the app
 * crashes so many times"). So a visible page never reloads for a new build;
 * it waits until it is hidden and reloads there, unseen, and the coach comes
 * back to the new build. Meanwhile the old build keeps working, and a chunk it
 * can no longer fetch is StaleBuildNotice's to explain, not a crash.
 */
export function decideSwReload(input: { uptimeMs: number; reloadsSoFar: number; visible?: boolean }): SwReloadDecision {
  if (input.reloadsSoFar >= SW_RELOAD_MAX_IN_A_ROW) return 'looping';
  if (input.visible) return 'when-hidden';
  if (input.uptimeMs < SW_RELOAD_MIN_UPTIME_MS) return 'too-soon';
  return 'reload';
}

/** How long to wait before asking again, for a page that was merely too young. */
export function retryDelayMs(uptimeMs: number): number {
  return Math.max(1_000, SW_RELOAD_MIN_UPTIME_MS - uptimeMs + 1_000);
}

// ── A registration that failed ───────────────────────────────────────

/** Network-shaped registration failures in a row on this device (localStorage). */
export const SW_REGISTER_FAILS_KEY = 'svrz_sw_register_fails';

/** What kind of failure a registration error is.
 *  • broken: the worker file came back wrong — a bad HTTP status, an HTML
 *    page instead of JavaScript (the Pages cache trap of 12.08.2026, which
 *    blanked the app), or a SecurityError. Ours to fix, every time.
 *  • network: the file never arrived — the browser's own words for a fetch
 *    with no answer, or a module import that died the same way.
 *  • other: anything else, including the "Rejected" of Google's renderer
 *    (the logger knows that visitor by itself). */
export function classifySwRegisterError(error: unknown): 'broken' | 'network' | 'other' {
  const name = error instanceof Error ? error.name
    : error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
  let message = '';
  try { message = error instanceof Error ? error.message : String(error ?? ''); } catch { /* unprintable */ }
  if (name === 'SecurityError' || /bad HTTP response|MIME type|Content-Type|with status \d{3}/i.test(message)) return 'broken';
  if (/unknown error occurred when fetching the script|load failed|failed to fetch|networkerror|network connection was lost|internet connection appears to be offline|timed out|dynamically imported module|importing a module script failed/i.test(message)) return 'network';
  return 'other';
}

/**
 * How loud a failed registration is. The iPhone's hidden link previews
 * (02.10, 19.10, 21.10.2026: "Script …/sw.js load failed") and a scanner's
 * page torn down mid-boot (12.10.2026) were each mailed as an error. A worker
 * that cannot be fetched once, or while nobody is looking or the network is
 * gone, is not news; the same device failing again on its next visit is.
 *
 * Never by the message alone: a worker served wrong is always an error,
 * whatever else is true, because that is how the app blanked in August.
 * `failuresInARow` counts this failure too (1 = the first).
 */
export function swRegisterErrorLevel(
  kind: 'broken' | 'network' | 'other',
  input: { excused: boolean; failuresInARow: number },
): 'warn' | 'error' {
  if (kind !== 'network') return 'error';
  if (input.excused) return 'warn';
  return input.failuresInARow <= 1 ? 'warn' : 'error';
}
