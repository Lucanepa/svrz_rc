// The coach's private notebook, on this device: pages of text or ink, kept in
// IndexedDB so a dead battery, a closed tab or a service-worker reload cannot
// destroy an evening's notes — and mirrored to the server (notebookSync.ts) so
// a phone that throws its site data away between two games cannot either.
//
// A page is NOT a record. It is deleted one week after it was written, on this
// device and on the server, and nothing extends that: what must outlive the
// week is lifted into the report through the form, where it belongs. It is
// also not per game — "literally like a noteblock" (Luca, 2026-09-15): the
// coach writes, and decides later what a page was for.
//
// Its OWN database, for the reason formDraft.ts gives for its own: a version
// bump here must never block `svrz-drafts` or the outbox, and a quota failure
// on a page of ink must never abort a transaction on finished submissions.
// Same ownership rule as both: the RC id that wrote a page is the only
// identity that may ever read it back on a shared tablet.

import { requestPersistentStorage } from './formDraft';
import { sanitizeRich } from './richText';

export const NOTEBOOK_SCHEMA = 1;              // "newer is skipped, never migrated blind" — the drafts policy
/** "Deleted at most one week after" — from the page's creation, both sides. */
export const NOTEBOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTEBOOK_MAX_PAGES = 40;          // live pages per coach; the server enforces the same
export const NOTEBOOK_MAX_TEXT = 20_000;
/** Serialised size of one ink page — the SAME predicate the server enforces,
 *  checked at stroke end so a stroke that would not sync is refused at once. */
export const NOTEBOOK_INK_MAX_CHARS = 800_000;
export const NOTEBOOK_INK_MAX_STROKES = 4_000;
export const NOTEBOOK_SYNC_DELAY_MS = 5_000;
export const NOTEBOOK_BATCH_MAX_BYTES = 1_000_000;   // strictly below the server's wire cap
export const NOTEBOOK_TEXT_DEBOUNCE_MS = 500;
export const NOTEBOOK_INK_DEBOUNCE_MS = 2_000;

export type PageKind = 'text' | 'ink';
export type PageBackground = '' | 'court';
export type PadField = 'bemerkungen' | 'highlights' | 'improvements' | 'goals' | 'tips';
/** What "übernommen" prints: the field, the half, and the game the text went into. */
export type PageUse = { f: PadField; r: '1. SR' | '2. SR'; g: string; label: string; t: number };

/**
 * One page. `id` is DERIVED (`${ownerId}|${pageId}`), never passed — the e2e
 * seed derives it the same way. Flat on purpose: tsconfig has no `strict`, so
 * a union tagged by a boolean would not narrow.
 */
export type NotebookPage = {
  id: string;
  schema: number;
  ownerId: string;        // outboxOwnerId; the only identity that reads it back
  pageId: string;         // crypto.randomUUID() at creation — the merge identity
  kind: PageKind;
  text: string;           // kind 'text'; '' on ink
  bg: PageBackground;     // kind 'ink': a printed background under the strokes
  points: number;         // kind 'ink': sample count (cheap "is there ink"); 0 for text
  usedIn: PageUse[];      // ≤ 10
  createdAt: number;      // epoch ms, device clock — the page's EXPIRY clock
  updatedAt: number;      // epoch ms — the LWW version of THIS page; MONOTONIC on every write
  deleted: boolean;       // tombstone: kept (until the TTL) so a stale copy elsewhere cannot resurrect it
  dirty: boolean;         // LOCAL ONLY — not yet acknowledged by the server; stripped from the wire
  savedAt: string;        // LOCAL ONLY — server autodate of the last ack; '' = never reached the server
  rejectedReason: string; // LOCAL ONLY — a terminal server refusal; skipped until an edit clears it
  extra?: Record<string, unknown>;   // forward-compat bag, never for content
};

/** One stroke: colour index, width in page units, whether `d` carries real pen
 *  pressure, and the samples — first [x10, y10, p100, 0], then deltas
 *  [dx10, dy10, p100, dtMs]. Integers only: nothing in a page can be a URL. */
export type InkStroke = { c: 0 | 1; w: number; p: 0 | 1; d: number[] };
/** A logical A4-ratio page, DPR-independent. */
export type InkPage = { w: 1000; h: 1414; strokes: InkStroke[] };
export type NotebookInk = { id: string; ownerId: string; page: InkPage };

/** What travels. NO id, ownerId, dirty, savedAt, rejectedReason. */
export type PageWire = Omit<NotebookPage, 'id' | 'ownerId' | 'dirty' | 'savedAt' | 'rejectedReason'> & { ink?: InkPage };

/** What the server hands back for one page (the index carries no ink). */
export type ServerPage = {
  pageId: string; kind: string; createdAt: number; updatedAt: number; deleted: boolean; schema: number; savedAt: string;
  text?: string; bg?: string; points?: number; usedIn?: PageUse[]; ink?: InkPage; extra?: Record<string, unknown>;
};

export type PageAck = {
  ownerId: string;
  saved: { pageId: string; savedAt: string; updatedAt: number; createdAt: number }[];
  stale: { pageId: string; updatedAt: number }[];
  rejected: { pageId: string; reason: string }[];
};

const DB_NAME = 'svrz-notebook';
const DB_VERSION = 1;
const PAGES = 'pages';
const INK = 'ink';

export const pageKey = (ownerId: string, pageId: string): string => `${ownerId}|${pageId}`;
export const pageExpiresAt = (p: { createdAt: number }): number => (p.createdAt || 0) + NOTEBOOK_TTL_MS;
export const pageIsLive = (p: NotebookPage, now: number): boolean => !p.deleted && pageExpiresAt(p) > now;

/** A fresh page id. `crypto.randomUUID` is what every modern browser has; the
 *  fallback only exists so a very old WebView still gets a unique id. */
export function newPageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The next version of a page: strictly greater than the previous one even
 *  when the clock went backwards, so a tombstone always outranks the live copy
 *  it replaces and an edit always outranks the version the server holds. */
export function nextVersion(prev?: { updatedAt: number } | null): number {
  const now = Date.now();
  return prev && prev.updatedAt >= now ? prev.updatedAt + 1 : now;
}

export function makePage(ownerId: string, kind: PageKind, bg: PageBackground = ''): NotebookPage {
  const pageId = newPageId();
  const now = Date.now();
  return {
    id: pageKey(ownerId, pageId), schema: NOTEBOOK_SCHEMA, ownerId, pageId, kind,
    text: '', bg: kind === 'ink' ? bg : '', points: 0, usedIn: [],
    createdAt: now, updatedAt: now, deleted: false, dirty: true, savedAt: '', rejectedReason: '',
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PAGES)) req.result.createObjectStore(PAGES, { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains(INK)) req.result.createObjectStore(INK, { keyPath: 'id' });
    };
    // Same two handlers as the draft store, for the same reasons: without
    // `onblocked` a later version bump waits forever behind another window;
    // without `onversionchange` THIS window is the one blocking.
    req.onblocked = () => reject(new Error('notebook store blocked by another window'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      // A database created at v1 with one store (a seed, an older build) never
      // runs onupgradeneeded again at the same version, and every transaction
      // on the missing store would throw NotFoundError forever. Say so once,
      // here, and the caller falls back to server-only mode.
      if (!db.objectStoreNames.contains(PAGES) || !db.objectStoreNames.contains(INK)) {
        db.close();
        reject(new Error('notebook store is missing an object store'));
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

// Resolve on transaction COMMIT, not request success, so a commit/abort failure
// (QuotaExceeded above all) rejects rather than falsely reporting success. The
// connection is closed on every terminal path.
function runTx(mode: IDBTransactionMode, stores: string[], fn: (t: IDBTransaction) => void): Promise<void> {
  return openDb().then((db) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => { if (settled) return; settled = true; db.close(); err ? reject(err) : resolve(); };
    const t = db.transaction(stores, mode);
    t.oncomplete = () => done();
    t.onerror = () => done(t.error);
    t.onabort = () => done(t.error || new Error('IndexedDB transaction aborted'));
    try {
      fn(t);
    } catch (e) {
      try { t.abort(); } catch { /* already finished */ }
      done(e);
    }
  }));
}

function getAll<T>(store: string): Promise<T[]> {
  let result: T[] = [];
  return runTx('readonly', [store], (t) => {
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => { result = (req.result as T[]) || []; };
  }).then(() => result);
}

/** Every stored page of this owner — tombstones and expired ones included.
 *  The sync engine's view; the UI reads through `livePages`. */
export async function listStoredPages(ownerId: string): Promise<NotebookPage[]> {
  const all = await getAll<NotebookPage>(PAGES);
  return all.filter((p) => p && p.ownerId === ownerId && (p.schema ?? 1) <= NOTEBOOK_SCHEMA);
}

/** The pages a coach sees: this owner's, live, newest first. */
export function livePages(pages: NotebookPage[], now: number): NotebookPage[] {
  return pages.filter((p) => pageIsLive(p, now)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getStoredInk(ownerId: string, pageId: string): Promise<InkPage | null> {
  let found: NotebookInk | undefined;
  await runTx('readonly', [INK], (t) => {
    const req = t.objectStore(INK).get(pageKey(ownerId, pageId));
    req.onsuccess = () => { found = req.result as NotebookInk | undefined; };
  });
  return found && found.ownerId === ownerId ? found.page : null;
}

/** Write pages (and, for ink pages, their strokes) in ONE transaction. A page
 *  whose `ink` is given gets its strokes written; a tombstone loses them —
 *  a deleted pen page's strokes must not stay on a shared tablet's disk until
 *  the week's purge. */
export function putPages(records: { page: NotebookPage; ink?: InkPage | null }[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  return runTx('readwrite', [PAGES, INK], (t) => {
    for (const { page, ink } of records) {
      t.objectStore(PAGES).put(page);
      if (page.deleted) t.objectStore(INK).delete(page.id);
      else if (ink) t.objectStore(INK).put({ id: page.id, ownerId: page.ownerId, page: ink } as NotebookInk);
    }
  });
}

export function deleteStoredPage(id: string): Promise<void> {
  return runTx('readwrite', [PAGES, INK], (t) => {
    t.objectStore(PAGES).delete(id);
    t.objectStore(INK).delete(id);
  });
}

/**
 * Delete what is past its week — every owner's rows, because an expired page is
 * nobody's to keep. Not exported as a reader: it is the one path that walks
 * the store without an owner filter, and nothing but the boot prune may.
 * A page that never reached the server is purged too: "at most one week" is
 * the promise, and the server would refuse the row by its own clock anyway.
 */
export async function pruneNotebook(now: number): Promise<number> {
  const all = await getAll<NotebookPage>(PAGES);
  const doomed = all.filter((p) => p && pageExpiresAt(p) <= now);
  if (doomed.length === 0) return 0;
  await runTx('readwrite', [PAGES, INK], (t) => {
    for (const p of doomed) { t.objectStore(PAGES).delete(p.id); t.objectStore(INK).delete(p.id); }
  });
  return doomed.length;
}

/** Asked once on boot, so the sheet can say "this device cannot keep pages"
 *  before the coach has written anything. Private browsing, a blocked
 *  IndexedDB and a half-built database all land here. */
export async function notebookStoreAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

export { requestPersistentStorage };

// ---------------------------------------------------------------------------
// Pure rules — the merge, the wire, the batches. Tested without a browser.
// ---------------------------------------------------------------------------

export type MergeDecision = { write: NotebookPage | null; dropInk: boolean; fetchInk: boolean };

const SAFE_BG = (v: unknown): PageBackground => (v === 'court' ? 'court' : '');
const SAFE_USES = (v: unknown): PageUse[] => (Array.isArray(v) ? v.filter((u) => u && typeof u === 'object').slice(0, 10) as PageUse[] : []);

/** A server row as a stored page under the owner the SERVER named. */
export function pageFromServer(ownerId: string, s: ServerPage): NotebookPage | null {
  if (!s || typeof s.pageId !== 'string' || !s.pageId) return null;
  const kind: PageKind = s.kind === 'ink' ? 'ink' : 'text';
  return {
    id: pageKey(ownerId, s.pageId), schema: Number(s.schema) || 1, ownerId, pageId: s.pageId, kind,
    // A page is markup from the editor's subset; what the server hands back is
    // untrusted at this boundary and lands in a contenteditable, so it goes
    // through the sanitiser exactly like a parked draft's rich boxes.
    text: kind === 'text' && typeof s.text === 'string' ? sanitizeRich(s.text) : '',
    bg: kind === 'ink' ? SAFE_BG(s.bg) : '',
    points: kind === 'ink' ? Number(s.points) || (s.ink ? s.ink.strokes.reduce((n, st) => n + st.d.length / 4, 0) : 0) : 0,
    usedIn: SAFE_USES(s.usedIn),
    createdAt: Number(s.createdAt) || 0, updatedAt: Number(s.updatedAt) || 0,
    deleted: s.deleted === true, dirty: false, savedAt: typeof s.savedAt === 'string' ? s.savedAt : '', rejectedReason: '',
    ...(s.extra && typeof s.extra === 'object' ? { extra: s.extra } : {}),
  };
}

/**
 * THE MERGE RULE, client side, per page. Identity = pageId, version = updatedAt.
 *  1. no local → adopt.
 *  2. server newer → adopt, even over a dirty local (the coach's later edit
 *     elsewhere wins; the loss is bounded to one page).
 *  3. local newer → keep (the next push carries it).
 *  4. tie → the server's copy: this is our own push acknowledged late, so the
 *     dirty flag clears.
 *  Absence from the server is handled by the CALLER never calling this for a
 *  page the server did not mention: absence never deletes.
 */
export function mergeFromServer(local: NotebookPage | null, server: NotebookPage): MergeDecision {
  const inkLive = server.kind === 'ink' && !server.deleted;
  if (!local) return { write: server, dropInk: false, fetchInk: inkLive };
  if (server.updatedAt > local.updatedAt) {
    return { write: server, dropInk: server.deleted, fetchInk: inkLive };
  }
  if (server.updatedAt < local.updatedAt) return { write: null, dropInk: false, fetchInk: false };
  // Tie: same version on both sides. Nothing to fetch — the strokes we hold ARE
  // this version — but a dirty flag or a missing savedAt is worth clearing.
  if (local.dirty || local.savedAt !== server.savedAt) {
    return { write: { ...local, dirty: false, savedAt: server.savedAt || local.savedAt, rejectedReason: '' }, dropInk: false, fetchInk: false };
  }
  return { write: null, dropInk: false, fetchInk: false };
}

/** The page as it travels. The server takes the owner from the session and the
 *  bookkeeping fields are one device's business. */
export function wireFrom(page: NotebookPage, ink?: InkPage | null): PageWire {
  const { id: _id, ownerId: _o, dirty: _d, savedAt: _s, rejectedReason: _r, ...rest } = page;
  void _id; void _o; void _d; void _s; void _r;
  return ink && page.kind === 'ink' && !page.deleted ? { ...rest, ink } : rest;
}

/** Split dirty pages into requests: text pages first, ≤ 50 and ≤ 1 MB per
 *  batch; every ink page in a request of its own. A page that alone exceeds
 *  the wire cap is reported, never sent. */
export function batchesFor(items: { page: NotebookPage; ink?: InkPage | null }[]): { batches: PageWire[][]; tooBig: string[] } {
  const batches: PageWire[][] = [];
  const tooBig: string[] = [];
  let current: PageWire[] = [];
  let bytes = 0;
  const flush = () => { if (current.length) { batches.push(current); current = []; bytes = 0; } };
  const text = items.filter((i) => i.page.kind !== 'ink' || i.page.deleted);
  const ink = items.filter((i) => i.page.kind === 'ink' && !i.page.deleted);
  for (const item of text) {
    const w = wireFrom(item.page);
    const size = JSON.stringify(w).length;
    if (size > NOTEBOOK_BATCH_MAX_BYTES) { tooBig.push(item.page.pageId); continue; }
    if (current.length >= 50 || bytes + size > NOTEBOOK_BATCH_MAX_BYTES) flush();
    current.push(w); bytes += size;
  }
  flush();
  for (const item of ink) {
    const w = wireFrom(item.page, item.ink);
    if (JSON.stringify(w).length > NOTEBOOK_BATCH_MAX_BYTES) { tooBig.push(item.page.pageId); continue; }
    batches.push([w]);
  }
  return { batches, tooBig };
}

/** The serialised size the server will measure — the one predicate both sides share. */
export function inkSize(page: InkPage): number {
  return JSON.stringify(page).length;
}

export function inkPoints(page: InkPage): number {
  return page.strokes.reduce((n, s) => n + s.d.length / 4, 0);
}
