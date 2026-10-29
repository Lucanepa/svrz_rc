// The coach's private notebook, on this device: pages kept in IndexedDB so a
// dead battery, a closed tab or a service-worker reload cannot destroy an
// evening's notes — and mirrored to the server (notebookSync.ts) so a phone
// that throws its site data away between two games cannot either.
//
// A page has two sides since 24.10.2026, each optional: what the coach typed
// (`text`) and what she wrote by hand (the strokes, in a store of their own,
// with `bg` under them and `points` counting them). One "Neue Seite" and a
// switch inside the page replaced the "+ Text" / "+ Stift" pair (Jennifer,
// 23.10.2026). The switch is a view (25.10.2026): `kind` keeps its two values
// and names the side last WRITTEN on the page — which is all the installed
// apps from before read, so they show the side with the latest writing on it
// and the server keeps the other (server/notebook.ts).
//
// Records the frontend before wrote are still on the coaches' devices, with
// one side each: '' for the text of a pen page, '' and 0 for the court and the
// stroke count of a typed one, whatever the server held. They carry no
// `sides` mark, and are never taken at their word for the side they could not
// show (sidesKnown, mergeFromServer, wireFrom).
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
import { richToPlain, sanitizeRich } from './richText';

// Still 1 with two sides: an older build skips a schema-newer page, and the
// installed apps would have lost every page written since. They read `kind`.
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
/** One line in the page strip: long enough for "Halbzeit Rämi", short
 *  enough that the strip stays a strip. */
export const NOTEBOOK_MAX_TITLE_LEN = 60;

export type NotebookPage = {
  id: string;
  schema: number;
  ownerId: string;        // outboxOwnerId; the only identity that reads it back
  pageId: string;         // crypto.randomUUID() at creation — the merge identity
  kind: PageKind;         // the side the page shows: the one last used on it
  title: string;          // the coach's own name for the page; '' = untitled
  text: string;           // the typed side; '' = nothing typed
  bg: PageBackground;     // a printed background under the handwriting
  points: number;         // the handwriting's sample count (cheap "is there ink"); 0 = none
  usedIn: PageUse[];      // ≤ 10
  createdAt: number;      // epoch ms, device clock — the page's EXPIRY clock
  updatedAt: number;      // epoch ms — the LWW version of THIS page; MONOTONIC on every write
  deleted: boolean;       // tombstone: kept (until the TTL) so a stale copy elsewhere cannot resurrect it
  dirty: boolean;         // LOCAL ONLY — not yet acknowledged by the server; stripped from the wire
  savedAt: string;        // LOCAL ONLY — server autodate of the last ack; '' = never reached the server
  rejectedReason: string; // LOCAL ONLY — a terminal server refusal; skipped until an edit clears it
  /** LOCAL ONLY — 2: this frontend wrote the record and knows both its sides.
   *  Absent on a record the frontend before 25.10.2026 wrote, whose other
   *  side may be on the server only. Never on the wire (`both` says it there). */
  sides?: 2;
  /** LOCAL ONLY — the server refused these strokes (its reason, or 'too-big'
   *  from this device's own check). The page syncs without them, and they are
   *  not sent again until they change. */
  inkRejected?: string;
  extra?: Record<string, unknown>;   // forward-compat bag, never for content
};

/** One stroke: colour index, width in page units, whether `d` carries real pen
 *  pressure, and the samples — first [x10, y10, p100, 0], then deltas
 *  [dx10, dy10, p100, dtMs]. Integers only: nothing in a page can be a URL. */
export type InkStroke = { c: 0 | 1; w: number; p: 0 | 1; d: number[] };
/** A logical A4-ratio page, DPR-independent. */
export type InkPage = { w: 1000; h: 1414; strokes: InkStroke[] };
/** `stale`: the server holds a newer version of these strokes than this
 *  device (a pull said so). Kept on the record, not only in memory, so a reload
 *  before they are fetched cannot push the old strokes over the newer ones. */
export type NotebookInk = { id: string; ownerId: string; page: InkPage; stale?: boolean };

/** What travels. NO id, ownerId, dirty, savedAt, rejectedReason, sides,
 *  inkRejected. `both` says this client vouches for both sides of the page —
 *  the server keeps the side an older app could not show only for pushes
 *  that do not (it is about the request, and never stored). */
export type PageWire = Omit<NotebookPage, 'id' | 'ownerId' | 'dirty' | 'savedAt' | 'rejectedReason' | 'sides' | 'inkRejected'> & { ink?: InkPage; both?: true };

/** What the server hands back for one page (the index carries no ink, for
 *  either side shown; `points` says whether there is some to fetch). */
export type ServerPage = {
  pageId: string; kind: string; createdAt: number; updatedAt: number; deleted: boolean; schema: number; savedAt: string;
  title?: string; text?: string; bg?: string; points?: number; usedIn?: PageUse[]; ink?: InkPage; extra?: Record<string, unknown>;
};

export type PageAck = {
  ownerId: string;
  /** `newRow`: the server had no live page under this id, so it holds no
   *  strokes of it but the ones this push carried (since 25.10.2026). */
  saved: { pageId: string; savedAt: string; updatedAt: number; createdAt: number; newRow?: boolean }[];
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
    title: '', text: '', bg, points: 0, usedIn: [],
    createdAt: now, updatedAt: now, deleted: false, dirty: true, savedAt: '', rejectedReason: '', sides: 2,
  };
}

/** Whether this device knows both sides of a page: the record is this
 *  frontend's, or the page never reached the server (so there is no other
 *  copy of either side to lose). A record the frontend before wrote, once on
 *  the server, may show '' for a side the server holds. */
export const sidesKnown = (p: NotebookPage): boolean => p.sides === 2 || !p.savedAt;

/** Whether the typed side holds anything: markup with no letters is nothing. */
export const hasTypedText = (p: { text: string }): boolean => richToPlain(p.text || '').trim() !== '';

/**
 * The side a write on `side` leaves the page on — its `kind`, which the
 * installed apps show. The side written on, as a rule; but a side written
 * empty (Rückgängig on the last stroke, every letter deleted) hands the page
 * to the other side when that one holds something, or an installed app shows
 * an empty page that the coach deletes, the other side and all.
 */
export function kindAfterWrite(p: { text: string; points: number }, side: PageKind): PageKind {
  const typed = hasTypedText(p);
  const inked = p.points > 0;
  if (side === 'ink') return inked || !typed ? 'ink' : 'text';
  return typed || !inked ? 'text' : 'ink';
}

/**
 * The record a commit stores, from the page the sheet hands in and the record
 * the cache holds now. The sheet's page is a snapshot of its last render, and
 * a pull or a strokes fetch may have marked the record in between, bringing in
 * the side the frontend before could not show. Taken as it was, the snapshot
 * dropped the mark and that side again: pushed without `both`, the server kept
 * its older text, and the next pull wrote it over what the coach had typed
 * (re-check, 25.10.2026). So the mark stays, and the snapshot speaks only for
 * the side the commit wrote — a stroke never touches the typed side, typing
 * never the pen side, and the typed side of an unmarked pen page was not
 * editable at all (it waits for the server's text), so a write there is a
 * title.
 */
export function committedRecord(page: NotebookPage, prev: NotebookPage | null | undefined, withInk: boolean): NotebookPage {
  const next: NotebookPage = { ...page };
  if (page.sides !== 2 && prev && prev.sides === 2) {
    if (withInk) next.text = prev.text;
    else {
      next.bg = prev.bg;
      next.points = prev.points;
      if (page.kind === 'ink') next.text = prev.text;
    }
    next.kind = kindAfterWrite(next, withInk ? 'ink' : page.kind);
    next.sides = 2;
    return next;
  }
  // A record known on both sides stays so, and one that never reached the
  // server is known now — there is no other copy. One the frontend before
  // wrote and the server holds stays unmarked until a pull brings in its
  // other side: marked by an edit, a rename before the first pull pushed its
  // blank side with `both` and wiped the server's (25.10.2026).
  if (page.sides === 2 || !page.savedAt) next.sides = 2; else delete next.sides;
  return next;
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
  return all
    .filter((p) => p && p.ownerId === ownerId && (p.schema ?? 1) <= NOTEBOOK_SCHEMA)
    // A row written before titles existed carries no `title` at all, and
    // `undefined` is not the empty title — it is the value that quietly turns
    // the header field into an uncontrolled input, which then keeps showing
    // the page before it. Every page that leaves this store has one.
    .map((p) => (typeof p.title === 'string' ? p : { ...p, title: '' }));
}

/** The pages a coach sees: this owner's, live, newest first. */
export function livePages(pages: NotebookPage[], now: number): NotebookPage[] {
  return pages.filter((p) => pageIsLive(p, now)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getStoredInk(ownerId: string, pageId: string): Promise<{ page: InkPage; stale: boolean } | null> {
  let found: NotebookInk | undefined;
  await runTx('readonly', [INK], (t) => {
    const req = t.objectStore(INK).get(pageKey(ownerId, pageId));
    req.onsuccess = () => { found = req.result as NotebookInk | undefined; };
  });
  return found && found.ownerId === ownerId ? { page: found.page, stale: found.stale === true } : null;
}

/** The store keys of this owner's pages that have strokes on this device. The
 *  keys only: the boot needs to know which pages could lose strokes to a
 *  push without them, not the strokes. */
export async function listStoredInkIds(ownerId: string): Promise<string[]> {
  let keys: IDBValidKey[] = [];
  await runTx('readonly', [INK], (t) => {
    const req = t.objectStore(INK).getAllKeys();
    req.onsuccess = () => { keys = req.result || []; };
  });
  const prefix = `${ownerId}|`;
  return keys.map(String).filter((k) => k.startsWith(prefix));
}

/** Write pages (and their strokes) in ONE transaction. A page whose `ink` is
 *  given gets its strokes written, and they are current again; `ink: null`
 *  drops them, and so does a tombstone — a deleted page's strokes must not
 *  stay on a shared tablet's disk until the week's purge. `inkStale` marks
 *  the strokes already stored as older than the server's (getStoredInk). */
export function putPages(records: { page: NotebookPage; ink?: InkPage | null; inkStale?: boolean }[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  return runTx('readwrite', [PAGES, INK], (t) => {
    for (const { page, ink, inkStale } of records) {
      t.objectStore(PAGES).put(page);
      const store = t.objectStore(INK);
      if (page.deleted || ink === null) store.delete(page.id);
      else if (ink) store.put({ id: page.id, ownerId: page.ownerId, page: ink } as NotebookInk);
      else if (inkStale) {
        const req = store.get(page.id);
        req.onsuccess = () => {
          const held = req.result as NotebookInk | undefined;
          if (held && !held.stale) store.put({ ...held, stale: true });
        };
      }
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

/** The court lies across the page (29.10.2026). Kept in the page's `extra`
 *  bag, which the server and every older build carry along untouched, so the
 *  background stays 'court' for them: an older app shows it upright. */
export const COURT_LANDSCAPE_KEY = 'court';
export const courtLandscape = (p: { extra?: Record<string, unknown> } | null | undefined): boolean => p?.extra?.[COURT_LANDSCAPE_KEY] === 'h';
export function withCourtLandscape<T extends { extra?: Record<string, unknown> }>(p: T, on: boolean): T {
  const extra: Record<string, unknown> = { ...(p.extra || {}) };
  if (on) extra[COURT_LANDSCAPE_KEY] = 'h'; else delete extra[COURT_LANDSCAPE_KEY];
  const next = { ...p, extra };
  if (!Object.keys(extra).length) delete next.extra;
  return next;
}
/** A title is a LABEL, not content: one line of plain text, capped, and never
 *  markup — it is drawn into the page strip, which has room for neither a
 *  second line nor a tag. */
export const safeTitle = (v: unknown): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, NOTEBOOK_MAX_TITLE_LEN);
const SAFE_USES = (v: unknown): PageUse[] => (Array.isArray(v) ? v.filter((u) => u && typeof u === 'object').slice(0, 10) as PageUse[] : []);

/** A server row as a stored page under the owner the SERVER named. Both sides,
 *  whichever one the page shows. */
export function pageFromServer(ownerId: string, s: ServerPage): NotebookPage | null {
  if (!s || typeof s.pageId !== 'string' || !s.pageId) return null;
  const kind: PageKind = s.kind === 'ink' ? 'ink' : 'text';
  const points = Number(s.points);
  return {
    id: pageKey(ownerId, s.pageId), schema: Number(s.schema) || 1, ownerId, pageId: s.pageId, kind,
    title: safeTitle(s.title),
    // A page is markup from the editor's subset; what the server hands back is
    // untrusted at this boundary and lands in a contenteditable, so it goes
    // through the sanitiser exactly like a parked draft's rich boxes.
    text: typeof s.text === 'string' ? sanitizeRich(s.text) : '',
    bg: SAFE_BG(s.bg),
    points: Number.isFinite(points) && points > 0 ? Math.floor(points) : (s.ink && Array.isArray(s.ink.strokes) ? inkPoints(s.ink) : 0),
    usedIn: SAFE_USES(s.usedIn),
    createdAt: Number(s.createdAt) || 0, updatedAt: Number(s.updatedAt) || 0,
    deleted: s.deleted === true, dirty: false, savedAt: typeof s.savedAt === 'string' ? s.savedAt : '', rejectedReason: '',
    // The server's copy has both sides, whichever one an installed app wrote last.
    sides: 2,
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
 *     dirty flag clears. A record the frontend before 25.10.2026 wrote takes
 *     the server's sides at the tie as well, and is marked: its '' for the
 *     side it could not show was a blank, not a deletion, and pushed with
 *     `both` it wiped the typed text (or the court) the server had kept
 *     (data-loss review, 25.10.2026). Its strokes are asked for when the
 *     server counts some it does not.
 *  Absence from the server is handled by the CALLER never calling this for a
 *  page the server did not mention: absence never deletes.
 *
 *  A record of the frontend before that is NEWER than the server's (edits it
 *  had not pushed) keeps its own side and takes the other from the server —
 *  a typed page the court and the count, a pen page the text — and is marked
 *  and still waiting. Left unmarked it went without `both`; drawn on, it went
 *  as a pen page, the server kept its older text (rule b), and the pull after
 *  that wrote the older text over the coach's (review of the fix round,
 *  25.10.2026, N1). At a tie, the strokes of an unmarked record are asked for
 *  whenever the server counts some: a count cannot tell older strokes from
 *  newer ones of the same size (N3).
 */
export function mergeFromServer(local: NotebookPage | null, server: NotebookPage, holdsInk = false): MergeDecision {
  // Strokes to fetch: the server counts some, or the page shows the
  // handwriting, as a pen page always did.
  const inkLive = !server.deleted && (server.points > 0 || server.kind === 'ink');
  if (!local) return { write: server, dropInk: false, fetchInk: inkLive };
  if (server.updatedAt > local.updatedAt) {
    // A newer copy that counts no strokes, while this device holds some: they
    // may have been cleared elsewhere, and are asked for before they are shown
    // or pushed again — never just dropped, they may be the only copy.
    return { write: server, dropInk: server.deleted, fetchInk: inkLive || (holdsInk && !server.deleted) };
  }
  const old = local.sides !== 2 && !server.deleted && !local.deleted;
  if (server.updatedAt < local.updatedAt) {
    if (!old) return { write: null, dropInk: false, fetchInk: false };
    const write: NotebookPage = local.kind === 'ink'
      ? { ...local, text: server.text, sides: 2 }
      : { ...local, bg: server.bg, points: server.points, sides: 2 };
    return { write, dropInk: false, fetchInk: local.kind !== 'ink' && server.points > 0 };
  }
  if (old) {
    const write: NotebookPage = { ...local, text: server.text, bg: server.bg, points: server.points, sides: 2, dirty: false, savedAt: server.savedAt || local.savedAt, rejectedReason: '' };
    return { write, dropInk: false, fetchInk: server.points > 0 };
  }
  // Tie: same version on both sides. Nothing to fetch — the strokes we hold ARE
  // this version — but a dirty flag or a missing savedAt is worth clearing.
  if (local.dirty || local.savedAt !== server.savedAt) {
    return { write: { ...local, dirty: false, savedAt: server.savedAt || local.savedAt, rejectedReason: '' }, dropInk: false, fetchInk: false };
  }
  return { write: null, dropInk: false, fetchInk: false };
}

/** The page as it travels. The server takes the owner from the session and the
 *  bookkeeping fields are one device's business. The strokes travel with any
 *  live page that has them, whichever side it shows; without them the push
 *  is metadata-only and the server keeps what it holds. `both` only for a
 *  record this frontend vouches for: one the frontend before wrote is pushed
 *  as the installed apps push, and the server keeps the side it could not
 *  show. */
export function wireFrom(page: NotebookPage, ink?: InkPage | null): PageWire {
  const { id: _id, ownerId: _o, dirty: _d, savedAt: _s, rejectedReason: _r, sides, inkRejected: _k, ...rest } = page;
  void _id; void _o; void _d; void _s; void _r; void _k;
  const wire: PageWire = sides === 2 ? { ...rest, both: true } : rest;
  return ink && !page.deleted ? { ...wire, ink } : wire;
}

/** Split dirty pages into requests: pages without strokes first, ≤ 50 and
 *  ≤ 1 MB per batch; every page that carries strokes in a request of its own.
 *  A page that alone exceeds the wire cap is reported, never sent. */
export function batchesFor(items: { page: NotebookPage; ink?: InkPage | null }[]): { batches: PageWire[][]; tooBig: string[] } {
  const batches: PageWire[][] = [];
  const tooBig: string[] = [];
  let current: PageWire[] = [];
  let bytes = 0;
  const flush = () => { if (current.length) { batches.push(current); current = []; bytes = 0; } };
  const text = items.filter((i) => !i.ink || i.page.deleted);
  const ink = items.filter((i) => i.ink && !i.page.deleted);
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
