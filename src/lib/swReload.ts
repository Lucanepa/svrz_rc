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
  | 'looping';

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

export function decideSwReload(input: { uptimeMs: number; reloadsSoFar: number }): SwReloadDecision {
  if (input.reloadsSoFar >= SW_RELOAD_MAX_IN_A_ROW) return 'looping';
  if (input.uptimeMs < SW_RELOAD_MIN_UPTIME_MS) return 'too-soon';
  return 'reload';
}

/** How long to wait before asking again, for a page that was merely too young. */
export function retryDelayMs(uptimeMs: number): number {
  return Math.max(1_000, SW_RELOAD_MIN_UPTIME_MS - uptimeMs + 1_000);
}
