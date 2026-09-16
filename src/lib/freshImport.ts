// A dynamic import that survives a deploy.
//
// Every build names its chunks by content hash, and Pages serves only the
// current build: once a new one is out, a page still running the old one asks
// for `PdfReader-Clh0hgE_.js` and gets a 404. The service-worker reload in
// main.tsx normally takes the page to the new build first — but it defers
// while the form is dirty, and it stands down after two reloads in ten
// minutes, which four deploys in an afternoon (16.09.2026) turned into a tab
// that opened a document and crashed to "Da ist etwas schiefgelaufen".
//
// A missing chunk is the surest sign of a stale page, so it is answered the
// same way and with the same care: reload once, never mid-form, never twice
// in a row — and when a reload is not on, say what happened instead of
// crashing. The judgement is pure so it can be tested without a browser.

export const STALE_CHUNK_STATE_KEY = 'svrz_stale_chunk_reload';
/** One automatic reload per stale build; a second miss inside this window
 *  means the NEW build is what is missing chunks (a deploy still settling at
 *  the edge), and reloading again would only loop. */
export const STALE_CHUNK_FORGET_MS = 2 * 60 * 1000;

/** Whether an import failure is the chunk being gone, in the words the
 *  engines use for it. Anything else — a syntax error in the module, a
 *  network that is down altogether — is not a deploy and is not retried. */
export function isStaleChunkError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed/i.test(text);
}

export type StaleChunkDecision = 'reload' | 'form-dirty' | 'already-reloaded';

export function decideStaleChunkReload(input: { lastReloadAt: number | null; now: number; formDirty: boolean }): StaleChunkDecision {
  if (input.lastReloadAt != null && input.now - input.lastReloadAt < STALE_CHUNK_FORGET_MS) return 'already-reloaded';
  if (input.formDirty) return 'form-dirty';
  return 'reload';
}

export function readLastReload(raw: string | null): number | null {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : null;
}

/** Thrown to the caller when the page cannot be reloaded for it — the message
 *  a toast can show as it is. */
export class StaleBuildError extends Error {
  readonly decision: Exclude<StaleChunkDecision, 'reload'>;
  constructor(decision: Exclude<StaleChunkDecision, 'reload'>, cause: unknown) {
    super(decision === 'form-dirty'
      ? 'App-Update nötig. Bitte die Seite neu laden — deine Eingaben bleiben erhalten.'
      : 'App-Update nötig. Bitte die Seite neu laden.');
    this.name = 'StaleBuildError';
    this.decision = decision;
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Run a dynamic import; when its chunk is gone, reload the page once (safely)
 *  or reject with a StaleBuildError the caller can show. A reload never
 *  resolves — the page is on its way out. */
export async function importFresh<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isStaleChunkError(error)) throw error;
    let lastReloadAt: number | null = null;
    try { lastReloadAt = readLastReload(sessionStorage.getItem(STALE_CHUNK_STATE_KEY)); } catch { /* private mode */ }
    const decision = decideStaleChunkReload({ lastReloadAt, now: Date.now(), formDirty: Boolean(window.__svrzFormDirty) });
    if (decision !== 'reload') throw new StaleBuildError(decision, error);
    try { sessionStorage.setItem(STALE_CHUNK_STATE_KEY, String(Date.now())); } catch { /* private mode */ }
    // Whatever is parked in memory goes to disk first, raced so a wedged
    // IndexedDB cannot pin the page to a dead build — the same two rules
    // main.tsx applies before its own reload.
    try {
      const flush = window.__svrzFlushDraft;
      if (flush) await Promise.race([flush(), new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* reload anyway */ }
    window.location.reload();
    return new Promise<T>(() => {});
  }
}
