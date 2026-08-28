// In-progress observations, held on this device so a dead battery, a closed tab
// or a service-worker reload cannot destroy twenty minutes of work. Same
// ownership rule as the outbox: the RC id that wrote a draft is the only
// identity that may ever see it back.
//
// Its OWN database, not a second store inside `svrz-offline`. Adding a store
// there means DB_VERSION 1 -> 2, and `offlineQueue.openDb()` has no `onblocked`
// handler: a blocked upgrade would surface as a rejected `enqueueFeedback`, the
// one write in this app whose failure loses a completed observation. A separate
// database also means a quota failure on a draft can never abort a transaction
// on the store holding finished, unsent submissions.

import { APP_VERSION } from './buildInfo';
import type { EligibleGame } from '../types';

export type DraftStatus = 'editing' | 'queued' | 'filed';

/**
 * One role's form, on one device, for one coach.
 *
 * `sections` are deliberately NOT stored. The criteria wording is a verbatim
 * copy of the SECTIONS_* catalogue (~20 label strings per form) and only the
 * rating is the coach's. Ratings travel keyed by AssessmentItem.id, never by
 * array position, so a catalogue that gains, loses or reorders an item cannot
 * shift a stored draft's marks by one — the failure `toggleLang` and
 * `normalizeLoadedFeedback` are both still exposed to. It also makes a draft
 * language-agnostic: the labels are rebuilt from `lang` on restore.
 */
export type DraftRecord = {
  id: string;                       // `${ownerId}|${gameId}|${role}` — put() is the upsert
  schema: number;                   // DRAFT_SCHEMA; a newer schema is ignored, never migrated blind
  ownerId: string;                  // the outbox owner id. Only this identity may read it back.
  gameId: string;
  role: '1. SR' | '2. SR';
  updatedAt: number;
  /**
   * 'editing' — restorable work.
   * 'queued'  — its submission is in the outbox; payload KEPT so
   *             discardFailedOutbox can hand the work back.
   * 'filed'   — the server confirmed it. Payload is BLANKED on this
   *             transition: what survives is only the memory that this
   *             game+role was already sent, which `feedbackLocked` (client
   *             only, dies with the page) cannot provide and which the server
   *             does not provide either for a `secondBesuch: 'Y'` report.
   */
  status: DraftStatus;
  submissionKey: string;            // '' unless status === 'queued'; matches OutboxItem.id
  label: string;                    // `${homeTeam} vs ${awayTeam}` — OutboxItem.label convention
  matchNo: string;                  // lets an imported file re-key onto the same match elsewhere

  // Context a restored form needs to be filed correctly. openFeedbackId,
  // feedbackLocked and openFeedbackMine are NOT here and never will be: a draft
  // is only ever written for a form that is neither filed nor locked, so a
  // restored draft is unconditionally a fresh unfiled form.
  observationTarget: '1SR' | '2SR' | 'both';
  resultUnlocked: boolean;          // without it the meta-fill effect reverts a hand-corrected score
  coacheeId: string;
  coacheeName: string;
  coacheeLevel: string;

  // The form.
  lang: 'DE' | 'EN';
  meta: Record<string, string>;     // MetaData, verbatim
  ratings: Record<string, string>;  // AssessmentItem.id -> rating
  results: Record<string, string>;  // Results, verbatim
  signature: string;                // '' when not captured
  rcSignature: string;
  tipsAndTricks: string;            // not part of FeedbackFormData, but it is mailed — losing it loses real work

  /** Top-level keys written by a NEWER build that this one does not understand.
   *  Carried through a restore and re-emitted on export so a round trip through
   *  an older device does not silently strip a newer field. */
  extra?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

export const DRAFT_KIND = 'svrz-rc.draft';
export const DRAFT_FILE_VERSION = 1;   // what THIS build writes
export const DRAFT_READER_VERSION = 1; // highest `minReader` this build accepts

export type DraftFilePart = {
  role: '1. SR' | '2. SR';
  lang: 'DE' | 'EN';
  observationTarget: '1SR' | '2SR' | 'both';
  resultUnlocked: boolean;
  coacheeName: string;
  coacheeLevel: string;
  meta: Record<string, string>;
  ratings: Record<string, string>;
  results: Record<string, string>;
  signature: string;
  rcSignature: string;
  tipsAndTricks: string;
  extra?: Record<string, unknown>;
};

export type DraftFile = {
  kind: string;          // must equal DRAFT_KIND
  fileVersion: number;   // what the writer wrote
  /** Lowest reader version that can still render this file correctly. A future
   *  v2 that only ADDS optional fields writes minReader 1, so today's build
   *  accepts it and preserves the unknown keys. A v3 that changes the rating
   *  encoding writes minReader 3, so today's build refuses it LOUDLY instead of
   *  half-restoring it. Two numbers, because one cannot express both. */
  minReader: number;
  exportedAt: string;    // ISO
  app: { version: string; sha: string };
  author: { ownerId: string; name: string };
  game: {
    id: string; matchNo: string; date: string; league: string; location: string;
    homeTeam: string; awayTeam: string; firstReferee: string; secondReferee: string;
  };
  drafts: DraftFilePart[];   // 1 or 2 parts, one per role, only status 'editing'
  extra?: Record<string, unknown>;
};

/** FLAT result — tsconfig has no `strict`, so a boolean-tagged union does not
 *  narrow in the negative branch and reading `.reason` there is a TS2339 that
 *  `npm run lint` (tsc --noEmit) fails on. */
export type DraftFileRead = {
  ok: boolean;
  reason: '' | 'too-big' | 'json' | 'kind' | 'too-new' | 'malformed' | 'empty';
  file: DraftFile | null;
};

/** Everything the file needs that a record does not carry: which game the work
 *  belongs to (a record only knows its id) and who is exporting.
 *
 *  `extra` is the other half of the forward-compatibility promise: unknown
 *  TOP-level keys survive a decode in `DraftFile.extra`, and a caller that
 *  round-trips a file can hand them back here so they are re-emitted where the
 *  newer build put them instead of being quietly dropped by this one. */
export type DraftFileCtx = {
  game: EligibleGame | null;
  author: { ownerId: string; name: string };
  extra?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DB_NAME = 'svrz-drafts';
const STORE = 'form-drafts';
const DB_VERSION = 1;
export const DRAFT_SCHEMA = 1;
/** sessionStorage, not localStorage: it survives a reload (the service-worker
 *  case, where the coach was on the form a second ago) and dies with the tab
 *  (the dead-battery case, where a silent jump into someone's previous screen
 *  would be wrong on a shared tablet). */
const RESUME_KEY = 'svrz_draft_resume_v1';
export const DRAFT_MAX_BYTES = 4 * 1024 * 1024;
export const DRAFT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
/** How long an 'editing' draft may sit untouched before the app calls it old.
 *  A WARNING threshold, not a deadline: nothing in this module deletes live work
 *  for crossing it. A coach who parks an observation over a holiday and comes
 *  back to an empty form has lost twenty minutes of his evening to a clock
 *  nobody ever showed him, so the clock is shown instead of enforced. */
export const DRAFT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_PER_OWNER = 12;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    // The outbox has neither of the next two handlers and cannot cheaply grow
    // them, because changing its failure mode puts completed submissions at
    // risk. This database is new, so it ships them from the first version.
    // Without `onblocked` a later DB_VERSION bump waits forever behind another
    // window that still holds the old connection: no error, no timeout, just a
    // draft that never saves. Rejecting turns that into `draftSaveFailed`, and
    // the coach is told to save the file instead.
    req.onblocked = () => reject(new Error('draft store blocked by another window'));
    req.onsuccess = () => {
      // The mirror image: without `onversionchange` THIS window is the one
      // doing the blocking. Every helper below opens its own connection and
      // closes it again, so standing aside costs nothing.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// Resolve on transaction COMMIT (t.oncomplete), not request success, so a
// commit/abort failure (e.g. QuotaExceeded) rejects rather than falsely
// reporting success. The connection is closed on every terminal path.
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    let result: T;
    let settled = false;
    const done = (err?: unknown) => { if (settled) return; settled = true; db.close(); err ? reject(err) : resolve(result); };
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => { result = req.result as T; };
    req.onerror = () => done(req.error);
    t.oncomplete = () => done();
    t.onerror = () => done(t.error);
    t.onabort = () => done(t.error || new Error('IndexedDB transaction aborted'));
  }));
}

// The multi-request sibling of `run`: one transaction, any number of requests,
// still resolved on COMMIT. Both roles of a dual-mode visit are written through
// this, so the cross-role mirrors (`rcSignature`, `meta.ergebnis`) commit
// together or not at all — two separate transactions could leave one role
// carrying a signature the other role's record has already lost.
function runTx(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  return openDb().then((db) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => { if (settled) return; settled = true; db.close(); err ? reject(err) : resolve(); };
    const t = db.transaction(STORE, mode);
    t.oncomplete = () => done();
    t.onerror = () => done(t.error);
    t.onabort = () => done(t.error || new Error('IndexedDB transaction aborted'));
    // `fn` fires the caller's own requests, and a throw out of one of them would
    // otherwise leave this connection open for the life of the page — an open
    // connection being exactly what makes a later upgrade hang on `onblocked`.
    try {
      fn(t.objectStore(STORE));
    } catch (e) {
      try { t.abort(); } catch { /* the transaction was already finished */ }
      done(e);
    }
  }));
}

export function draftKey(ownerId: string, gameId: string, role: string): string {
  return `${ownerId}|${gameId}|${role}`;
}

/** Every write of a visit goes through here in ONE transaction. See `runTx`. */
/**
 * Write a whole visit — both roles, one transaction.
 *
 * `onlyIfEditing` is what the AUTOSAVE passes. A role whose submission has
 * already left the form is not a draft any more, and a blind `put` would demote
 * it back to one: the dual-mode send can file '1. SR' and then throw on
 * '2. SR', which leaves the form editable with one role already filed and
 * e-mailed, and the next keystroke would turn that tombstone into a restorable
 * — and re-sendable — copy of a report the referee already has. The same guard
 * protects a 'queued' role, whose payload `discardFailedOutbox` has to be able
 * to hand back intact.
 *
 * It returns what was actually written, so a caller can park exactly what the
 * store accepted rather than what it offered.
 */
export async function putDrafts(records: DraftRecord[], onlyIfEditing = false): Promise<DraftRecord[]> {
  if (!records || records.length === 0) return [];
  const written: DraftRecord[] = [];
  // `runTx` resolves on the transaction's COMMIT, which is after every request's
  // onsuccess has run — so `written` is complete by the time this returns.
  await runTx('readwrite', (s) => {
    for (const record of records) {
      if (!onlyIfEditing) { s.put(record); written.push(record); continue; }
      const req = s.get(record.id);
      req.onsuccess = () => {
        const stored = req.result as DraftRecord | undefined;
        if (stored && stored.status !== 'editing') return;
        s.put(record);
        written.push(record);
      };
    }
  });
  return written;
}

// This owner's records, newest first. `getAll()` plus a filter in JS, the exact
// `listOutbox` pattern: an index would have to be created in an upgrade, and
// the number of drafts on one device is bounded at DRAFT_MAX_PER_OWNER anyway.
//
// A record written by a NEWER build is skipped rather than shown: this build
// cannot know what its fields mean, and half-restoring it is worse than not
// offering it. It stays on disk, so the build that wrote it still finds it.
export async function listDrafts(ownerId: string): Promise<DraftRecord[]> {
  const all = (await run<DraftRecord[]>('readonly', (s) => s.getAll())) || [];
  return all
    .filter((d) => d && d.ownerId === ownerId && (d.schema ?? 1) <= DRAFT_SCHEMA)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getGameDrafts(ownerId: string, gameId: string): Promise<DraftRecord[]> {
  return (await listDrafts(ownerId)).filter((d) => d.gameId === gameId);
}

/**
 * Move one role's draft along its lifecycle. Read and write happen in the SAME
 * transaction, so a flush that files a role cannot lose a keystroke the
 * autosave committed in between.
 *
 * A missing record is not an error and is never created: the coach may have
 * discarded the draft between the send and its confirmation, and resurrecting
 * it here would hand back work that was deliberately thrown away.
 */
export async function setDraftStatus(
  ownerId: string, gameId: string, role: string,
  status: DraftStatus, submissionKey?: string,
): Promise<void> {
  const key = draftKey(ownerId, gameId, role);
  await runTx('readwrite', (s) => {
    const req = s.get(key);
    req.onsuccess = () => {
      const record = req.result as DraftRecord;
      // The key already carries the owner, so the second check is belt and
      // braces — but it is the check that makes "never touch another owner's
      // record" true even if a future caller builds the key differently.
      if (!record || record.ownerId !== ownerId) return;
      const next: DraftRecord = {
        ...record,
        status,
        updatedAt: Date.now(),
        // The key is only meaningful while an outbox item is holding this work.
        // Clearing it on the way back to 'editing' is what stops a discarded
        // item's key from being matched against a later, unrelated submission.
        submissionKey: status === 'queued' ? (submissionKey || record.submissionKey || '') : '',
      };
      if (status === 'filed') {
        // A tombstone: it remembers that this game+role was sent — which
        // nothing else on the client survives a reload to tell us — without
        // keeping a signed assessment of a named referee on a shared tablet
        // for the next 45 days.
        next.meta = {};
        next.ratings = {};
        next.results = {};
        next.signature = '';
        next.rcSignature = '';
        next.tipsAndTricks = '';
      }
      s.put(next);
    };
  });
}

// Both roles unless one is named. The keys are derived from the owner, so this
// cannot reach another coach's record for the same game even by accident.
export async function deleteDraft(ownerId: string, gameId: string, role?: string): Promise<void> {
  const roles = role ? [role] : ['1. SR', '2. SR'];
  await runTx('readwrite', (s) => { for (const r of roles) s.delete(draftKey(ownerId, gameId, r)); });
}

/**
 * Age and count cap, this owner only.
 *
 * Drafts share the device's quota with the outbox, which holds completed
 * observations that exist nowhere else — so the drafts have to be bounded, or a
 * season of half-finished forms raises the eviction pressure on the one store
 * that must never be evicted.
 *
 * What bounding may NOT do is take unfinished work away on a timer. An 'editing'
 * record is the only copy of what the coach typed, and no amount of elapsed time
 * turns that into rubbish — so age retires only records whose work has already
 * left this store: a 'filed' tombstone, whose payload was blanked on the way in,
 * and a 'queued' leftover, whose whole submission (PDF included) is being held
 * by its outbox item and which after six weeks belongs to an item that is long
 * gone. Old live work is REPORTED, through `draftIsStale`, and never deleted.
 *
 * This is the only place that reads `getAll()` without an owner filter, and it
 * is deliberately not exported as a reader: it returns nothing to anybody, and
 * every id it deletes came from a record whose `ownerId` it just matched.
 */
export async function pruneDrafts(ownerId: string): Promise<void> {
  if (!ownerId) return;
  const all = (await run<DraftRecord[]>('readonly', (s) => s.getAll())) || [];
  const mine = all
    .filter((d) => d && d.ownerId === ownerId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));   // newest first
  const cutoff = Date.now() - DRAFT_TTL_MS;
  const doomed = new Set<string>();
  for (const d of mine) {
    if (d.status !== 'editing' && (d.updatedAt || 0) < cutoff) doomed.add(d.id);
  }
  // The cap is the backstop against unbounded growth, and it evicts by STATUS
  // before it evicts by age: a tombstone is a few hundred bytes remembering that
  // something was sent, an 'editing' record is somebody's unfinished evening.
  let over = mine.length - doomed.size - DRAFT_MAX_PER_OWNER;
  for (let i = mine.length - 1; i >= 0 && over > 0; i--) {
    const d = mine[i];                                          // oldest first
    if (d.status === 'editing' || doomed.has(d.id)) continue;
    doomed.add(d.id);
    over--;
  }
  // And if the cap can only be met by dropping live work, the list runs over
  // instead. Twelve is a number picked to bound a store, not a promise made to a
  // coach; silently deleting the thirteenth unfinished observation to honour it
  // would break the one promise this module does make. The store stays bounded
  // in practice because every draft ends as a tombstone that the age rule can
  // then retire.
  if (doomed.size === 0) return;
  await runTx('readwrite', (s) => { for (const id of doomed) s.delete(id); });
}

/**
 * "This one has been sitting here a long time" — a line for the banner, never a
 * reason to delete anything. Only an 'editing' record can be stale: a 'filed'
 * tombstone and a 'queued' leftover have no work left to warn about, and the age
 * rule in `pruneDrafts` is what ends their lives.
 *
 * `now` is a parameter so the caller can date a whole list against one clock
 * (and so a test does not have to travel in time to prove the rule).
 */
export function draftIsStale(record: DraftRecord, now: number = Date.now()): boolean {
  if (!record || record.status !== 'editing') return false;
  return now - (record.updatedAt || 0) > DRAFT_STALE_MS;
}

/** Whole days since the last keystroke, for the sentence the warning is made of.
 *  Floored, so "30 days" is never claimed a few minutes early. */
export function draftAgeDays(record: DraftRecord, now: number = Date.now()): number {
  if (!record || !record.updatedAt) return 0;
  return Math.max(0, Math.floor((now - record.updatedAt) / (24 * 60 * 60 * 1000)));
}

// Asked once on boot, so the form can say "this device cannot keep your draft"
// BEFORE the coach has typed anything, rather than failing on the first commit.
// Private browsing and a blocked IndexedDB both land here.
export async function draftStoreAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

let persistenceAsked = false;

/**
 * Ask the browser not to evict this origin under storage pressure. Once per
 * session, and the answer is ignored on purpose: on most browsers it is granted
 * silently for an installed PWA and refused silently otherwise, and there is
 * nothing useful to tell a coach either way.
 *
 * Nothing else in the app asks, so the real beneficiary is the OUTBOX, which
 * shares the origin and holds finished submissions.
 */
export async function requestPersistentStorage(): Promise<void> {
  if (persistenceAsked) return;
  // Set before the first await: the autosave commits in bursts, and a second
  // commit must not be able to slip in a second prompt.
  persistenceAsked = true;
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || !storage.persist) return;
    if (storage.persisted && await storage.persisted()) return;
    await storage.persist();
  } catch {
    /* Some browsers throw on the mere access in private mode — a draft is never
       worth an unhandled rejection. */
  }
}

export function resumeHint(): string {
  try { return sessionStorage.getItem(RESUME_KEY) || ''; } catch { return ''; }
}

export function setResumeHint(gameId: string): void {
  try {
    if (gameId) sessionStorage.setItem(RESUME_KEY, gameId);
    else sessionStorage.removeItem(RESUME_KEY);
  } catch { /* private mode — the coach reaches the draft through the banner instead */ }
}

export function clearResumeHint(): void {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* nothing to clear if it never stored */ }
}

// ---------------------------------------------------------------------------
// The portable file
// ---------------------------------------------------------------------------

const FILE_KEYS = new Set([
  'kind', 'fileVersion', 'minReader', 'exportedAt', 'app', 'author', 'game', 'drafts', 'extra',
]);
const PART_KEYS = new Set([
  'role', 'lang', 'observationTarget', 'resultUnlocked', 'coacheeName', 'coacheeLevel',
  'meta', 'ratings', 'results', 'signature', 'rcSignature', 'tipsAndTricks', 'extra',
]);

// A file picked off a disk is input from outside the app, so nothing it claims
// is a string is trusted to be one. Numbers and booleans are still converted
// rather than dropped: a writer that stored a score as a number meant the score.
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) out[key] = str(source[key]);
  return out;
}

/** Keys a newer build wrote that this one has no field for. They are kept so an
 *  export from this build gives them back unchanged — a draft that travels
 *  through an older device must not come home stripped. */
function collectExtra(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let found = false;
  for (const key of Object.keys(source)) {
    if (known.has(key)) continue;
    out[key] = source[key];
    found = true;
  }
  // A build that already did this collection nests them under `extra`; unpack
  // them so the next export puts them back at the level they were written at.
  const nested = source.extra;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const inner = nested as Record<string, unknown>;
    for (const key of Object.keys(inner)) {
      if (known.has(key)) continue;
      out[key] = inner[key];
      found = true;
    }
  }
  return found ? out : undefined;
}

/** Unknown keys go back exactly where the newer build put them, and the fields
 *  this build understands are applied LAST — a stale copy carried in `extra`
 *  can never win over the value actually being exported. */
function withExtra<T>(known: T, extra?: Record<string, unknown>): T {
  if (!extra) return known;
  return { ...extra, ...known } as T;
}

/**
 * The rescue file. Built from records, so the same function serves the export
 * button and anything that later wants to hand a draft to another device.
 *
 * Only work that is still the coach's own travels: a 'queued' or 'filed' part
 * is already on its way to the server, and importing it somewhere else would
 * manufacture a second copy of one observation.
 */
export function encodeDraftFile(records: DraftRecord[], ctx: DraftFileCtx): string {
  const source = records || [];
  const first = source[0];
  const game = ctx && ctx.game;
  // One part per role: two records for the same role share a store key, so only
  // one of them could ever be restored anyway.
  const byRole = new Map<DraftFilePart['role'], DraftRecord>();
  for (const record of source) {
    if (!record || record.status === 'queued' || record.status === 'filed') continue;
    byRole.set(record.role === '2. SR' ? '2. SR' : '1. SR', record);
  }
  const drafts: DraftFilePart[] = [];
  byRole.forEach((record, role) => {
    drafts.push(withExtra<DraftFilePart>({
      role,
      lang: record.lang === 'EN' ? 'EN' : 'DE',
      observationTarget: record.observationTarget === 'both' ? 'both'
        : record.observationTarget === '2SR' ? '2SR' : '1SR',
      resultUnlocked: !!record.resultUnlocked,
      coacheeName: str(record.coacheeName),
      coacheeLevel: str(record.coacheeLevel),
      meta: strMap(record.meta),
      ratings: strMap(record.ratings),
      results: strMap(record.results),
      signature: str(record.signature),
      rcSignature: str(record.rcSignature),
      tipsAndTricks: str(record.tipsAndTricks),
    }, record.extra));
  });
  const file: DraftFile = withExtra<DraftFile>({
    kind: DRAFT_KIND,
    fileVersion: DRAFT_FILE_VERSION,
    // The literal 1, not DRAFT_FILE_VERSION. This says "any build that
    // understands v1 can read me", which stays true for every later version
    // that only ADDS optional fields — and such a version must keep writing 1
    // here. Bumping it in lockstep with `fileVersion` would lock older devices
    // out of files they can read perfectly well, which is the whole reason
    // these are two numbers.
    minReader: 1,
    exportedAt: new Date().toISOString(),
    // The bare SHA, not BUILD_INFO: that one glues on a de-CH formatted
    // timestamp for a console footer, and a machine-read file wants neither the
    // formatting nor the locale.
    app: { version: APP_VERSION, sha: __BUILD_SHA__ },
    author: { ownerId: str(ctx && ctx.author && ctx.author.ownerId), name: str(ctx && ctx.author && ctx.author.name) },
    game: {
      // The record's own ids stand in when there is no game object: an export
      // made while the games list is still loading must still be re-bindable.
      id: str(game && game.id) || str(first && first.gameId),
      matchNo: str(game && game.matchNo) || str(first && first.matchNo),
      date: str(game && game.date),
      league: str(game && game.league),
      location: str(game && game.location),
      homeTeam: str(game && game.homeTeam),
      awayTeam: str(game && game.awayTeam),
      firstReferee: str(game && game.firstReferee),
      secondReferee: str(game && game.secondReferee),
    },
    drafts,
  }, ctx && ctx.extra);
  // Indented: this file is the fallback when storage is failing, and support
  // has to be able to ask a coach to open it and read the team names back.
  return JSON.stringify(file, null, 2);
}

/**
 * Never throws. Every way a file can be wrong is a `reason` the caller turns
 * into one sentence for the coach, because "the import did nothing" is the one
 * outcome that cannot be acted on.
 *
 * `knownRatingIds` is passed IN rather than imported. The section catalogues
 * live in `App.tsx`, which imports this module; reaching back for them would be
 * a circular import, and the module that loses that race is evaluated
 * half-initialised at run time. With no ids given, no catalogue check is made
 * at all — the right default for a caller that has no catalogue to check
 * against.
 */
export function decodeDraftFile(text: string, sizeBytes: number, knownRatingIds?: Iterable<string>): DraftFileRead {
  const fail = (reason: DraftFileRead['reason']): DraftFileRead => ({ ok: false, reason, file: null });
  if (sizeBytes > DRAFT_MAX_BYTES) return fail('too-big');

  let raw: any;
  try { raw = JSON.parse(text); } catch { return fail('json'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('kind');
  // The kind is the identity gate, and it is checked before anything else: a
  // coach who picks the wrong file out of a Downloads folder gets "that is not
  // an SVRZ draft", not "the file is damaged".
  if (raw.kind !== DRAFT_KIND) return fail('kind');

  // A file with no readable `minReader` is treated as v1. The kind has already
  // vouched for it, and refusing it over a missing number would reject a file
  // this build can in fact read.
  const minReader = typeof raw.minReader === 'number' && Number.isFinite(raw.minReader) ? raw.minReader : 1;
  if (minReader > DRAFT_READER_VERSION) return fail('too-new');

  // Without a game block there is nothing to bind the work to on this device,
  // and a form with no game silently becomes unfileable later on.
  if (!raw.game || typeof raw.game !== 'object' || Array.isArray(raw.game)) return fail('malformed');
  if (!Array.isArray(raw.drafts)) return fail('malformed');

  const known = knownRatingIds ? new Set(knownRatingIds) : null;
  let ratingTotal = 0;
  let ratingKnown = 0;
  const parts: DraftFilePart[] = [];

  for (const rawPart of raw.drafts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) continue;
    // A part whose role cannot be placed is dropped rather than defaulted: it
    // would come back as a 1. SR form carrying a 2. SR's marks.
    if (rawPart.role !== '1. SR' && rawPart.role !== '2. SR') continue;
    const role: DraftFilePart['role'] = rawPart.role;

    const ratings: Record<string, string> = {};
    const rawRatings = strMap(rawPart.ratings);
    for (const id of Object.keys(rawRatings)) {
      const rating = rawRatings[id];
      if (!rating) continue;
      ratingTotal++;
      // A criterion this catalogue no longer has is dropped silently — editing
      // the catalogue is a normal thing for the admin to do, and the coach
      // rates the replacement instead.
      if (known && !known.has(id)) continue;
      ratingKnown++;
      ratings[id] = rating;
    }

    parts.push({
      role,
      lang: rawPart.lang === 'EN' ? 'EN' : 'DE',
      // An unreadable target is derived from the role rather than defaulted to
      // '1SR': a 2. SR-only draft that comes back claiming '1SR' asks the coach
      // for a form no part of the file contains.
      observationTarget: rawPart.observationTarget === 'both' ? 'both'
        : rawPart.observationTarget === '2SR' ? '2SR'
        : rawPart.observationTarget === '1SR' ? '1SR'
        : (role === '2. SR' ? '2SR' : '1SR'),
      resultUnlocked: !!rawPart.resultUnlocked,
      coacheeName: str(rawPart.coacheeName),
      coacheeLevel: str(rawPart.coacheeLevel),
      meta: strMap(rawPart.meta),
      ratings,
      results: strMap(rawPart.results),
      signature: str(rawPart.signature),
      rcSignature: str(rawPart.rcSignature),
      tipsAndTricks: str(rawPart.tipsAndTricks),
      // Collected INTO the field on the way in, spread back out at the level
      // they were written at on the way out (see `withExtra` in the encoder).
      // The record that carries them between the two has one place to put them.
      extra: collectExtra(rawPart as Record<string, unknown>, PART_KEYS),
    });
  }

  // Dropping the odd renamed criterion is routine; dropping most of them means
  // this is not the catalogue the file was written against, and restoring it
  // would hand back a form that looks complete and is mostly unrated. Say so
  // instead of silently losing the marks.
  if (known && ratingTotal > 0 && ratingKnown * 2 < ratingTotal) return fail('malformed');
  if (parts.length === 0) return fail('empty');

  const g = raw.game;
  const file: DraftFile = {
    kind: DRAFT_KIND,
    fileVersion: typeof raw.fileVersion === 'number' && Number.isFinite(raw.fileVersion) ? raw.fileVersion : minReader,
    minReader,
    exportedAt: str(raw.exportedAt),
    app: {
      version: str(raw.app && raw.app.version),
      sha: str(raw.app && raw.app.sha),
    },
    author: {
      ownerId: str(raw.author && raw.author.ownerId),
      name: str(raw.author && raw.author.name),
    },
    game: {
      id: str(g.id),
      matchNo: str(g.matchNo),
      date: str(g.date),
      league: str(g.league),
      location: str(g.location),
      homeTeam: str(g.homeTeam),
      awayTeam: str(g.awayTeam),
      firstReferee: str(g.firstReferee),
      secondReferee: str(g.secondReferee),
    },
    drafts: parts,
    extra: collectExtra(raw as Record<string, unknown>, FILE_KEYS),
  };
  return { ok: true, reason: '', file };
}

/**
 * "SVRZ Naefels-Amriswil 2026-08-28 Entwurf.json"
 *
 * A coach has to recognise this in a Downloads folder a week later, so the name
 * carries the app, the teams and a date rather than just a match number. ASCII
 * only, because the file travels through share sheets and mail clients that
 * still mangle anything else.
 */
export function draftFileName(g: DraftFile['game'], lang: 'DE' | 'EN'): string {
  const slug = (s: string) => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9]+/g, '');
  const raw = (g && g.date) || '';
  // An already-ISO date is taken verbatim. Parsing it first would move a
  // midnight kickoff to the previous day for anyone reading the file west of
  // UTC, and the day a game was played is the one thing this name must get
  // right. Anything else is parsed and read in LOCAL time, which is the day the
  // rest of the app shows for the same game.
  let isoDate = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
  if (!isoDate) {
    const parsed = new Date(raw);
    const day = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    isoDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  }
  const teams = `${slug(g && g.homeTeam)}-${slug(g && g.awayTeam)}`;
  // A game block with no team names still has to produce something a human can
  // pick out of a list, so the match number stands in.
  const subject = teams === '-' ? (slug(g && g.matchNo) || 'Spiel') : teams;
  // One extension, never two: some share targets truncate a name at its first
  // dot, and "SVRZ … Entwurf" without the .json is a file nothing will open.
  return `SVRZ ${subject} ${isoDate} ${lang === 'DE' ? 'Entwurf' : 'Draft'}.json`;
}

// ---------------------------------------------------------------------------
// Two tabs on one observation
// ---------------------------------------------------------------------------

/**
 * Two tabs open on the same game autosave to the SAME store key, so the one that
 * commits second wins and the first one's keystrokes are gone with nothing on
 * screen to say it happened. What follows exists so the app can say it.
 *
 * It is an ADVISORY signal and deliberately not a lock. A lock that refuses the
 * second tab strands the work in whichever tab the coach can no longer reach — a
 * PWA window the OS reaped, a phone in a bag, a browser that will not come back
 * — and the only way out is to throw the evening away. Losing a race between two
 * of your own tabs costs a debounce window and self-heals on the next keystroke;
 * being locked out of your own unsent observation is exactly the class of loss
 * this module exists to prevent. So the claim is a sentence the UI renders, and
 * the coach overrides it by carrying on typing.
 */

const CLAIM_CHANNEL = 'svrz-draft-claim-v1';
/** A claim is only believed for this long after the last sign of life. A tab
 *  that is killed outright — crash, force-quit, iOS reaping a backgrounded PWA —
 *  never gets to post a release, and a warning that outlives the tab it is about
 *  is worse than no warning at all: the coach learns to ignore it. */
export const DRAFT_CLAIM_TTL_MS = 20 * 1000;
/** Comfortably inside the TTL, so one beat lost to a throttled background timer
 *  does not read as a dead tab. */
const CLAIM_BEAT_MS = 7 * 1000;

type ClaimMessage = {
  kind: 'claim' | 'beat' | 'release' | 'who';
  tabId: string;
  ownerId: string;
  gameId: string;
  role: string;
  at: number;
};

/** FLAT, for the same reason `DraftFileRead` is flat: with no `strict` a
 *  boolean-tagged union does not narrow, so `active` is a field to read and not
 *  a tag that conjures the rest of the object. `active: false` is the "the other
 *  tab is gone, take the warning down" edge, and it still carries the ids so the
 *  caller can tell WHICH warning it is being told to drop. */
export type DraftClaimNotice = {
  active: boolean;
  ownerId: string;
  gameId: string;
  role: string;      // the role the other tab is on; '' when it never said
  since: number;     // epoch ms of that tab's last sign of life; 0 when inactive
};

type ForeignClaim = { ownerId: string; gameId: string; role: string; at: number };

let channel: BroadcastChannel | null = null;
/** Set once when the capability is missing or the constructor threw. Retrying
 *  per keystroke on a browser that will never have it is how a missing feature
 *  turns into a stutter in the form. */
let channelUnavailable = false;
let tabId = '';
let myClaim: { ownerId: string; gameId: string; role: string } | null = null;
let beatTimer: ReturnType<typeof setInterval> | null = null;
const foreignClaims = new Map<string, ForeignClaim>();
const claimListeners = new Set<(notice: DraftClaimNotice) => void>();
let lastNotice: DraftClaimNotice | null = null;

// The outbox's id shape. It identifies a TAB and nothing else: it is never
// persisted and never leaves this origin, so a fresh one per page load is right
// — two windows of the same coach must look like two different tabs, which is
// the entire point.
function myTabId(): string {
  if (!tabId) tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return tabId;
}

/** Null on every browser that cannot do this — Safari private mode, old
 *  WebViews, anything running these functions outside a window. Every caller
 *  treats null as "there is no cross-tab signal here", which leaves the form
 *  behaving exactly as it did before the claim existed. */
function ensureChannel(): BroadcastChannel | null {
  if (channel || channelUnavailable) return channel;
  try {
    if (typeof BroadcastChannel === 'undefined') { channelUnavailable = true; return null; }
    const opened = new BroadcastChannel(CLAIM_CHANNEL);
    opened.onmessage = (event) => onClaimMessage(event ? (event.data as ClaimMessage) : null);
    channel = opened;
  } catch {
    // A browser that exposes the constructor and then refuses it (storage
    // partitioning, a hardened WebView) is the same case as not having it.
    channelUnavailable = true;
    channel = null;
  }
  return channel;
}

function post(message: ClaimMessage): void {
  const open = ensureChannel();
  if (!open) return;
  try { open.postMessage(message); } catch { /* a broken channel costs a warning, never a keystroke */ }
}

function announce(kind: ClaimMessage['kind']): void {
  if (!myClaim) return;
  post({ kind, tabId: myTabId(), ownerId: myClaim.ownerId, gameId: myClaim.gameId, role: myClaim.role, at: Date.now() });
}

function onClaimMessage(message: ClaimMessage | null): void {
  if (!message || typeof message !== 'object') return;
  if (!message.tabId || message.tabId === myTabId()) return;
  if (message.kind === 'release') {
    foreignClaims.delete(message.tabId);
  } else if (message.kind === 'who') {
    // A newcomer asking whether anybody already has this observation open. A
    // `who` is the ONLY message that is ever answered: answering a `claim` would
    // have two tabs announcing each other for as long as both stay open, every
    // reply provoking the next.
    if (myClaim && message.ownerId === myClaim.ownerId && message.gameId === myClaim.gameId) announce('claim');
    return;
  } else if (message.kind === 'claim' || message.kind === 'beat') {
    foreignClaims.set(message.tabId, {
      ownerId: message.ownerId || '',
      gameId: message.gameId || '',
      role: message.role || '',
      // OUR clock, never the sender's `at`. A tablet whose clock is a day out
      // would otherwise look either permanently dead or permanently alive, and
      // the shared tablets in this app are exactly the devices with bad clocks.
      at: Date.now(),
    });
  } else {
    // A kind a newer build invented. Ignored rather than guessed at — the worst
    // it costs is a warning this build does not know how to show.
    return;
  }
  evaluate();
}

function evaluate(): void {
  const now = Date.now();
  // Expiring here, on the heartbeat, is what stops a tab that died without
  // saying goodbye from warning about itself forever.
  for (const [id, claim] of foreignClaims) {
    if (now - claim.at > DRAFT_CLAIM_TTL_MS) foreignClaims.delete(id);
  }
  // A tab that is only listening has nothing to be told: it is not in the race,
  // and emitting an empty notice at it would put a subscriber through a state
  // change that says nothing. Taking a standing warning down belongs to
  // `releaseDraft`, which knows the claim it is dropping.
  if (!myClaim) return;
  let match: ForeignClaim | null = null;
  for (const claim of foreignClaims.values()) {
    // Owner and game, not role: the two roles of a dual-mode visit are one
    // observation, and a second tab editing the other half is the same clash.
    if (claim.ownerId !== myClaim.ownerId || claim.gameId !== myClaim.gameId) continue;
    if (!match || claim.at > match.at) match = claim;
  }
  const notice: DraftClaimNotice = match
    ? { active: true, ownerId: match.ownerId, gameId: match.gameId, role: match.role, since: match.at }
    : { active: false, ownerId: myClaim.ownerId, gameId: myClaim.gameId, role: '', since: 0 };
  // Emitted on a CHANGE only. The heartbeat runs every few seconds and the
  // notice drives something the coach can see; re-emitting an identical one
  // would repaint — or re-toast — for the length of the match. `since` moves on
  // every beat and is deliberately not part of the comparison.
  if (lastNotice
    && lastNotice.active === notice.active
    && lastNotice.ownerId === notice.ownerId
    && lastNotice.gameId === notice.gameId
    && lastNotice.role === notice.role) return;
  lastNotice = notice;
  emit(notice);
}

function emit(notice: DraftClaimNotice): void {
  for (const listener of claimListeners) {
    // One subscriber that throws must not cost the others their notice, and must
    // never surface as an unhandled error out of a heartbeat nobody awaited.
    try { listener(notice); } catch { /* the UI's problem, not the store's */ }
  }
}

// One timer does both jobs: it tells the other tabs this one is still alive, and
// it is the only thing that ever expires a claim left behind by a tab that is
// not. Started with the claim and stopped with it, so a page that never opens a
// form runs no timer at all.
function startBeat(): void {
  if (beatTimer || typeof setInterval !== 'function') return;
  beatTimer = setInterval(() => { announce('beat'); evaluate(); }, CLAIM_BEAT_MS);
}

function stopBeat(): void {
  if (!beatTimer) return;
  clearInterval(beatTimer);
  beatTimer = null;
}

/** Nothing left to hear and nothing left to say. A page that merely passed
 *  through a form should not hold a channel open for the rest of its life. */
function closeChannelIfIdle(): void {
  if (myClaim || claimListeners.size > 0 || !channel) return;
  try { channel.close(); } catch { /* already closed — the close is the point, not the call */ }
  channel = null;
}

/**
 * Say that THIS tab is now working on (ownerId, gameId, role).
 *
 * Returns whether the announcement could be made at all: false on a browser with
 * no BroadcastChannel, where there is nothing to render and the form behaves as
 * it always did. It is never a refusal — the claim cannot fail, because it does
 * not gate anything.
 *
 * Safe to call on every render. An unchanged claim re-announces nothing: the
 * autosave effect re-runs on every keystroke, and without that guard this would
 * be a keystroke firehose on a channel every tab of every window is listening to.
 */
export function claimDraft(ownerId: string, gameId: string, role: string): boolean {
  if (!ownerId || !gameId) { releaseDraft(); return false; }
  if (!ensureChannel()) return false;
  if (myClaim && myClaim.ownerId === ownerId && myClaim.gameId === gameId && myClaim.role === role) return true;
  // Moving to another observation releases the previous one. Without this, a tab
  // that only ever switched games goes on warning the other tabs about a game
  // nobody is in until the TTL runs out.
  if (myClaim) announce('release');
  myClaim = { ownerId, gameId, role: role || '' };
  // A notice about the observation just left must not dedupe away the first
  // notice about this one.
  lastNotice = null;
  announce('claim');
  // ...and ask whoever is already in here to say so. Without the probe the
  // newcomer learns nothing until the incumbent's next heartbeat, and the coach
  // spends those seconds typing into the tab that is going to lose the race.
  announce('who');
  startBeat();
  evaluate();
  return true;
}

/**
 * Stop claiming — on leaving the form, on `pagehide`, on unmount.
 *
 * Nothing depends on it being called. A tab that is killed cannot run code,
 * which is the whole reason a claim expires on its own after
 * DRAFT_CLAIM_TTL_MS; this just makes the common, orderly case immediate.
 */
export function releaseDraft(): void {
  const standing = lastNotice;
  if (myClaim) announce('release');
  myClaim = null;
  lastNotice = null;
  stopBeat();
  foreignClaims.clear();
  // A warning already on screen has to come down with the claim it belongs to.
  // The subscriber has no other way to learn that this tab stopped caring, and
  // an orphaned "open in another tab" line is the kind of thing a coach reads as
  // the app being broken.
  if (standing && standing.active) {
    emit({ active: false, ownerId: standing.ownerId, gameId: standing.gameId, role: '', since: 0 });
  }
  closeChannelIfIdle();
}

/**
 * Hear about another tab on the same (ownerId, gameId) — including the case
 * where the other tab got there first and THIS one is the newcomer, which the
 * probe in `claimDraft` is there to cover.
 *
 * Returns its own unsubscribe. A subscriber that arrives while a foreign claim
 * is already standing is told at once, so a banner mounted a render later does
 * not sit blank until the next heartbeat.
 */
export function subscribeDraftClaims(listener: (notice: DraftClaimNotice) => void): () => void {
  if (typeof listener !== 'function') return () => {};
  claimListeners.add(listener);
  ensureChannel();
  if (lastNotice && lastNotice.active) {
    try { listener(lastNotice); } catch { /* the UI's problem, not the store's */ }
  }
  return () => {
    claimListeners.delete(listener);
    closeChannelIfIdle();
  };
}
