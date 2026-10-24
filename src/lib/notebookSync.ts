// The notebook's engine: the in-memory working set of the coach's pages, the
// debounced writes into IndexedDB, and the sync with the server.
//
// Three layers, in order of trust: this module's cache is what the sheet
// renders; IndexedDB is what survives a crash, a reload and a dead battery;
// the server is what survives a device that throws its site data away. Every
// change goes cache → IndexedDB (within half a second) → server (five seconds
// after the last change, or at once when the sheet closes or the page hides).
//
// A module-level object rather than React state, for the same reason the
// drafts autosave keeps refs: the flush that runs on `pagehide` must read the
// LIVE owner and the LIVE pages, not whatever a render captured.

import {
  NOTEBOOK_SYNC_DELAY_MS, NOTEBOOK_TEXT_DEBOUNCE_MS, batchesFor, getStoredInk, inkPoints, kindAfterWrite, listStoredInkIds, listStoredPages, livePages,
  mergeFromServer, nextVersion, notebookStoreAvailable, pageFromServer, pageIsLive, pruneNotebook, putPages, requestPersistentStorage, wireFrom,
  type InkPage, type NotebookPage, type PageUse, type ServerPage,
} from './notebook';
import { deleteNotebookPage, fetchNotebookInk, listNotebook, pushNotebookPages } from './pocketbase';

export type PadSyncStatus = {
  /** The device: what the last local write did. */
  local: 'idle' | 'saving' | 'saved' | 'failed';
  /** The server: where the dirty pages stand. */
  server: 'idle' | 'synced' | 'pending' | 'offline' | 'failed';
  at: number;               // when `local` last changed (epoch ms)
  message: string;          // the server's own sentence on a refusal, else ''
  serverOnly: boolean;      // no IndexedDB on this device — the server is the only copy
  dirty: number;            // pages not yet acknowledged
  /** The boot's first pull has answered (or could not be made). Until then an
   *  empty list is only the local cache — empty on a wiped device or a new
   *  sign-in — and not proof that the coach has no pages. */
  loaded: boolean;
};

type Config = {
  getOwner: () => string;
  onStatus: (s: PadSyncStatus) => void;
  onPages: (pages: NotebookPage[]) => void;
};

type Pending = { page: NotebookPage; ink: InkPage | null | undefined; timer: number };

const BACKOFF_START_MS = 10_000;
const BACKOFF_MAX_MS = 60_000;
const PULL_MIN_INTERVAL_MS = 60_000;
const KEEPALIVE_MAX_BYTES = 32_000;

let config: Config | null = null;
let storeOk = false;
let booted = '';                       // the owner the cache was loaded for
const cache = new Map<string, NotebookPage>();   // every stored page of the booted owner, tombstones included
const inkCache = new Map<string, InkPage>();     // strokes we hold locally (keyed like the store)
/** Pages whose strokes are in IndexedDB, read from the store's keys at boot and
 *  kept up to date after: the pagehide send has no time to ask the store which
 *  pages a push without strokes could cost theirs. */
const inkIds = new Set<string>();
const inkStale = new Set<string>();              // pages whose strokes the server has newer than ours
/** Pages whose strokes changed here since the server last acknowledged them:
 *  the only ones a push carries strokes for. Every other push of a page is
 *  metadata-only, and the server keeps the strokes it holds — a page of
 *  handwriting is not uploaded again with every pause in the typing on its
 *  other side, and a page typed on here does not send back strokes another
 *  device has added to since. At boot every page still waiting counts, since
 *  what it waits for may be its strokes. */
const inkDirty = new Set<string>();
/** Bumped whenever a page's strokes change under a read: a local commit, or a
 *  pull that marks them stale or drops them. A read that started before the
 *  bump holds an older truth than the cache. */
const inkGen = new Map<string, number>();
const bumpInk = (id: string) => { inkGen.set(id, (inkGen.get(id) || 0) + 1); };
/** How many samples the strokes this device holds for a page count, where
 *  that is known: set by every commit and every read of them, and at boot for
 *  the pages whose own count says none. A page whose count is 0 can still
 *  hold strokes here that the server never had — drawn offline while another
 *  device wrote the page — and they are not hidden: the strip and the switch
 *  show them, and the server is asked about them at once (settleHeldInk). */
const heldPoints = new Map<string, number>();
/** The boot's read of the store while it runs. A pull or a push that starts
 *  before it ends waits for it: a pull between the pages and the list of
 *  pages holding strokes merged as if no page held any, and a cleared-elsewhere
 *  set of strokes came back (review, 25.10.2026). */
let bootLoad: Promise<void> | null = null;
const clearInkState = () => { inkCache.clear(); inkIds.clear(); inkStale.clear(); inkDirty.clear(); heldPoints.clear(); };
const pending = new Map<string, Pending>();      // local commits not yet in IndexedDB
let pushTimer = 0;
let pushing: Promise<void> | null = null;
let pushBackoffMs = 0;
let nextPushAt = 0;
let lastPullAt = 0;
let status: PadSyncStatus = { local: 'idle', server: 'idle', at: 0, message: '', serverOnly: false, dirty: 0, loaded: false };

const now = () => Date.now();
const owner = () => (config ? config.getOwner() : '');

function emitPages(): void {
  if (!config) return;
  const o = owner();
  config.onPages(livePages([...cache.values()].filter((p) => p.ownerId === o), now()));
}

function setStatus(patch: Partial<PadSyncStatus>): void {
  const o = owner();
  const dirty = [...cache.values()].filter((p) => p.ownerId === o && p.dirty && !p.rejectedReason).length;
  status = { ...status, ...patch, dirty, serverOnly: !storeOk };
  if (config) config.onStatus(status);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(o: string): Promise<void> {
  cache.clear(); clearInkState(); pending.clear();
  booted = o;
  setStatus({ loaded: false });
  let loaded: () => void = () => {};
  bootLoad = new Promise<void>((resolve) => { loaded = resolve; });
  try {
    storeOk = await notebookStoreAvailable();
    if (storeOk) {
      try { await pruneNotebook(now()); } catch { /* a purge that fails is retried at the next boot */ }
      try {
        for (const p of await listStoredPages(o)) {
          cache.set(p.id, p);
          if (p.dirty && !p.deleted) inkDirty.add(p.id);
        }
      } catch { storeOk = false; }
      // Apart, and failing quietly: without the list a pagehide only leaves out
      // the pages that count strokes, and the store is no less usable.
      if (storeOk) {
        try { for (const id of await listStoredInkIds(o)) inkIds.add(id); } catch { /* the pages' counts still guard the keepalive */ }
        // The strokes of the pages that count none, read now: there are few
        // (a page cleared, a page whose newer copy came from a device that did
        // not draw on it), and what they hold decides whether the strip shows
        // a pen. Every other page's strokes wait until they are opened.
        const unsure = [...cache.values()].filter((p) => !p.deleted && !(p.points > 0) && inkIds.has(p.id));
        await Promise.all(unsure.map(async (p) => {
          const held = await getStoredInk(o, p.pageId).catch(() => null);
          if (held) heldPoints.set(p.id, inkPoints(held.page));
        }));
      }
    }
  } finally {
    loaded();
  }
  if (booted !== o) return;   // the owner changed under us
  emitPages();
  setStatus({ local: 'idle', server: 'idle' });
  // pullIndex returns quietly when offline, without an owner or on an error,
  // so this is reached on every outcome — never left waiting for good.
  try { await pullIndex({ force: true }); } finally { if (booted === o) setStatus({ loaded: true }); }
  await flushNow();
}

// ---------------------------------------------------------------------------
// Local commits
// ---------------------------------------------------------------------------

async function writeLocal(entries: Pending[]): Promise<void> {
  if (entries.length === 0) return;
  if (!storeOk) { setStatus({ local: 'saved', at: now() }); return; }
  setStatus({ local: 'saving' });
  try {
    await putPages(entries.map((e) => ({ page: e.page, ink: e.ink })));
    setStatus({ local: 'saved', at: now() });
    void requestPersistentStorage();
  } catch {
    // Surfaced, never thrown into anything: the cache still holds the page and
    // the server copy is the way out of a full disk.
    setStatus({ local: 'failed', at: now() });
  }
}

function armPush(): void {
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { pushTimer = 0; void push(); }, NOTEBOOK_SYNC_DELAY_MS);
}

/** Commit a page (and, when given, its strokes). Debounced per page; the cache
 *  and the sheet update at once, IndexedDB after `debounceMs`, the server 5 s
 *  later. */
export function commit(page: NotebookPage, ink?: InkPage | null, debounceMs = NOTEBOOK_TEXT_DEBOUNCE_MS): void {
  if (!config || page.ownerId !== owner()) return;
  const prev = cache.get(page.id);
  const next: NotebookPage = { ...page, dirty: true, rejectedReason: '', updatedAt: nextVersion(prev) };
  // A record known on both sides stays so, and one that never reached the
  // server is known now — there is no other copy. One the frontend before
  // wrote and the server holds stays unmarked until a pull brings in its
  // other side: marked by an edit, a rename before the first pull pushed its
  // blank side with `both` and wiped the server's (25.10.2026).
  if (page.sides === 2 || !page.savedAt) next.sides = 2; else delete next.sides;
  cache.set(next.id, next);
  if (ink !== undefined) {
    // New strokes may be taken where the ones before were refused.
    delete next.inkRejected;
    if (ink) { inkCache.set(next.id, ink); inkIds.add(next.id); inkDirty.add(next.id); heldPoints.set(next.id, inkPoints(ink)); } else { inkCache.delete(next.id); inkIds.delete(next.id); inkDirty.delete(next.id); heldPoints.delete(next.id); }
    inkStale.delete(next.id);
    bumpInk(next.id);
  }
  const existing = pending.get(next.id);
  if (existing) window.clearTimeout(existing.timer);
  const entry: Pending = { page: next, ink: ink !== undefined ? ink : existing?.ink, timer: 0 };
  entry.timer = window.setTimeout(() => {
    pending.delete(next.id);
    void writeLocal([entry]).then(armPush);
  }, Math.max(0, debounceMs));
  pending.set(next.id, entry);
  emitPages();
  setStatus({ local: 'saving' });
}

/** Everything pending goes into IndexedDB now. No network. */
export async function flushLocal(): Promise<void> {
  if (pending.size === 0) return;
  const entries = [...pending.values()];
  for (const e of entries) window.clearTimeout(e.timer);
  pending.clear();
  await writeLocal(entries);
}

/** Tombstone a page: kept locally (until its week is up) so a stale copy on
 *  another device cannot bring it back; its strokes are dropped at once. */
export function deletePage(pageId: string): void {
  const o = owner();
  const prev = cache.get(`${o}|${pageId}`);
  if (!prev || prev.deleted) return;
  commit({ ...prev, deleted: true, title: '', text: '', points: 0, usedIn: [] }, null, 0);
}

/** Record that pages were inserted into a form field. */
export function markUsed(pageIds: string[], use: PageUse): void {
  const o = owner();
  for (const pageId of pageIds) {
    const prev = cache.get(`${o}|${pageId}`);
    if (!prev || prev.deleted) continue;
    commit({ ...prev, usedIn: [...prev.usedIn, use].slice(-10) }, undefined, 0);
  }
}

/** What a read of a page's strokes found. `current`: they are known to be the
 *  page's latest — this device's own, or the server's just now. Not current:
 *  strokes known to be older than the server's whose fetch failed, or strokes
 *  the server should have and could not be asked for. The sheet shows those
 *  READ-ONLY and takes no stroke onto them: drawn on, they were pushed over
 *  the newer ones (review, 25.10.2026). */
export type InkRead = { page: InkPage | null; current: boolean };

/** Reads of a page's strokes that are still running, by store key, with the
 *  generation they started at. */
const inkInFlight = new Map<string, { gen: number; read: Promise<InkRead> }>();

/** The strokes of a page: local first, the server when ours are missing or
 *  older. `page` null when neither has any (a brand-new page, a page only
 *  typed on).
 *
 *  A second ask for the same page while the first is still out shares it.
 *  React's StrictMode runs the sheet's ink effect twice on mount, and in
 *  WebKit both runs reached the network before either had stored what it
 *  fetched: two GETs for one page (notebook-ink spec, mobile-safari). Only
 *  while nothing changed in between, though: a read that started before a
 *  stroke or a pull holds an older truth than the cache. */
export function getInk(pageId: string): Promise<InkRead> {
  const id = `${owner()}|${pageId}`;
  const gen = inkGen.get(id) || 0;
  const running = inkInFlight.get(id);
  if (running && running.gen === gen) return running.read;
  const read = readInk(pageId, gen).finally(() => { if (inkInFlight.get(id)?.read === read) inkInFlight.delete(id); });
  inkInFlight.set(id, { gen, read });
  return read;
}

/** Whether the server may hold strokes of this page: it reached the server,
 *  and counts some, or shows them, or is a record the frontend before wrote,
 *  whose count of a typed page said 0 whatever the server held. A page this
 *  device made and has not synced yet has nothing there to ask for, and a
 *  synced page that was only ever typed on has nothing either: Handschrift on
 *  it is not a round trip. */
const inkOnServer = (page: NotebookPage): boolean => !!page.savedAt && (page.points > 0 || page.kind === 'ink' || page.sides !== 2);

/** Whether reading this page's strokes may go to the network: the sheet shows
 *  "wird geladen" for that wait, rather than a page that takes strokes. */
export function inkMayFetch(pageId: string): boolean {
  const id = `${owner()}|${pageId}`;
  const page = cache.get(id);
  if (!page || page.deleted) return false;
  if (inkStale.has(id)) return true;
  if (inkCache.has(id)) return false;
  return page.points > 0 || inkOnServer(page);
}

/** The strokes this device holds for the page are known to be older than the
 *  server's: they are not written on until the server's are in. */
export function inkIsStale(pageId: string): boolean {
  return inkStale.has(`${owner()}|${pageId}`);
}

/** Changes whenever the page's strokes change under a read (a commit, a pull
 *  that marks them stale or drops them): the sheet reads them again. */
export function inkVersion(pageId: string): number {
  return inkGen.get(`${owner()}|${pageId}`) || 0;
}

/** This device holds strokes of the page, whatever its count says. */
export function holdsStrokes(pageId: string): boolean {
  const id = `${owner()}|${pageId}`;
  return (heldPoints.get(id) || 0) > 0 || (inkCache.get(id)?.strokes.length || 0) > 0;
}

/** Store a page's strokes as read, the page's count made to match them: the
 *  count is what the next read checks the strokes against (readInk). No new
 *  version: the page says what it said, and the count says what is held. */
async function keepRead(id: string, ink: InkPage): Promise<void> {
  inkCache.set(id, ink);
  inkIds.add(id);
  heldPoints.set(id, inkPoints(ink));
  const p = cache.get(id);
  if (!p) return;
  const page = p.points === inkPoints(ink) ? p : { ...p, points: inkPoints(ink) };
  if (page !== p) cache.set(id, page);
  if (storeOk) await putPages([{ page, ink }]).catch(() => {});
}

/** The server holds no strokes of this page at all, and this device does:
 *  they are the only copy. Current again, and on their way — as a new version
 *  when nothing else of the page waits, since the server takes no second push
 *  of a version it holds. This is how strokes drawn offline survive a newer
 *  copy of the page from a device that did not draw on it (25.10.2026). */
async function keepHeldInk(id: string, ink: InkPage): Promise<void> {
  const p = cache.get(id);
  if (!p || p.deleted) return;
  inkStale.delete(id);
  if (p.inkRejected || ink.strokes.length === 0) { await keepRead(id, ink); return; }
  if (p.dirty) { inkDirty.add(id); await keepRead(id, ink); return; }
  const points = inkPoints(ink);
  commit({ ...p, points, kind: kindAfterWrite({ ...p, points }, p.kind) }, ink, 0);
}

async function readInk(pageId: string, gen: number): Promise<InkRead> {
  const o = owner();
  const id = `${o}|${pageId}`;
  const page = cache.get(id);
  if (!page || page.deleted) return { page: null, current: true };
  // Overtaken: the strokes changed while this read waited. What the cache
  // holds now is newer than anything this read found; the sheet reads again.
  const overtaken = () => (inkGen.get(id) || 0) !== gen;
  const settled = (local: InkPage | null): InkRead => ({ page: inkCache.get(id) || local, current: inkCache.has(id) && !inkStale.has(id) });
  const cached = inkCache.get(id);
  const stored = cached || !storeOk ? null : await getStoredInk(o, pageId).catch(() => null);
  const local = cached || (stored ? stored.page : null);
  if (overtaken()) return settled(local);
  const now = cache.get(id) || page;
  // Marked older than the server's by a pull before a reload — or older than
  // the page's own count, which every commit keeps with its strokes: an ink
  // record the frontend before wrote never carried the mark (it lived in
  // memory), and was pushed, old strokes and new, over the newer ones.
  if (stored && (stored.stale || inkPoints(stored.page) !== now.points)) inkStale.add(id);
  if (local) heldPoints.set(id, inkPoints(local));
  if (local && !inkStale.has(id)) { inkCache.set(id, local); return { page: local, current: true }; }
  if (!local && !inkStale.has(id) && !inkOnServer(now)) return { page: null, current: true };
  let remote: Awaited<ReturnType<typeof fetchNotebookInk>>;
  try {
    remote = await fetchNotebookInk(pageId);
  } catch {
    // Offline, or the server down: what is shown is not known to be current.
    return { page: local, current: false };
  }
  if (overtaken()) return settled(local);
  if (remote && remote.ownerId !== o) return { page: local, current: false };
  const p = cache.get(id);
  if (!p || p.deleted) return { page: null, current: true };
  if (!remote) {
    // The server has no such page: what this device holds is all there is,
    // both sides of it.
    inkStale.delete(id);
    if (p.sides !== 2) { const known = { ...p, sides: 2 as const }; cache.set(id, known); if (storeOk) await putPages([{ page: known }]).catch(() => {}); }
    if (local) await keepRead(id, local);
    emitPages();
    return { page: local, current: true };
  }
  // A record the frontend before wrote, at the version the server has: its
  // other side comes in with the strokes, as a pull would bring it.
  if (p.sides !== 2) {
    const server = pageFromServer(o, remote.page);
    if (server && server.updatedAt === p.updatedAt) {
      const d = mergeFromServer(p, server);
      if (d.write) { cache.set(id, d.write); if (storeOk) await putPages([{ page: d.write }]).catch(() => {}); }
    }
  }
  const serverInk = remote.page.ink && Array.isArray(remote.page.ink.strokes) ? remote.page.ink : null;
  inkStale.delete(id);
  if (serverInk) {
    // The server's strokes win: a newer copy, or none here at all. What this
    // device had drawn on an older copy of the page is not pushed over them.
    inkDirty.delete(id);
    await keepRead(id, serverInk);
    emitPages();
    return { page: serverInk, current: true };
  }
  if (!local) { emitPages(); return { page: null, current: true }; }
  await keepHeldInk(id, local);
  emitPages();
  return { page: local, current: true };
}

/** The strokes a push carries for a page: the ones this device holds, when
 *  they changed here since the server last took them (inkDirty) — and never
 *  while the server has newer ones. Otherwise none: the push is
 *  metadata-only and the server keeps its own (server/notebook.ts). Typing on
 *  a page whose handwriting changed on another device must not put the old
 *  strokes back. */
async function inkForPush(o: string, page: NotebookPage): Promise<InkPage | null> {
  if (page.deleted || inkStale.has(page.id) || page.inkRejected) return null;
  // A page the server never confirmed goes with its strokes whatever this
  // device remembers of what changed: the server has no copy of them, and a
  // push without them made a row that counted strokes it did not have.
  if (!inkDirty.has(page.id) && page.savedAt) return null;
  const cached = inkCache.get(page.id);
  if (cached) return cached;
  if (!storeOk) return null;
  const stored = await getStoredInk(o, page.pageId).catch(() => null);
  if (!stored) return null;
  // Older than the server's — marked so, or older than the page's own count
  // (an ink record the frontend before wrote never carried the mark).
  if (stored.stale || inkPoints(stored.page) !== page.points) { inkStale.add(page.id); return null; }
  return stored.page;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function push(): Promise<void> {
  if (pushing) return pushing;
  pushing = (async () => {
    try {
      // Not before the boot has read the store: until then the cache does not
      // know which pages hold strokes here.
      if (bootLoad) await bootLoad;
      await flushLocal();
      const o = owner();
      if (!o) return;
      if (isOffline()) { setStatus({ server: 'offline' }); return; }
      if (now() < nextPushAt) { armPush(); return; }
      const t = now();
      const dirty = [...cache.values()].filter((p) => p.ownerId === o && p.dirty && !p.rejectedReason && (p.deleted || pageIsLive(p, t)));
      if (dirty.length === 0) { setStatus({ server: status.server === 'failed' ? 'failed' : 'synced' }); return; }
      const items = await Promise.all(dirty.map(async (page) => ({ page, ink: await inkForPush(o, page) })));
      const { batches, tooBig } = batchesFor(items);
      for (const pageId of tooBig) {
        const p = cache.get(`${o}|${pageId}`);
        if (!p) continue;
        if (items.some((i) => i.page.pageId === pageId && i.ink)) {
          // Its strokes are past what one request may carry. The page goes
          // without them — its text and its title are not held back — and
          // they stay on this device, the refusal said on the page.
          const next = { ...p, inkRejected: 'too-big' };
          cache.set(p.id, next);
          if (storeOk) await putPages([{ page: next }]).catch(() => {});
          batches.push([wireFrom(next)]);
        } else {
          cache.set(p.id, { ...p, rejectedReason: 'too-big' });
        }
      }
      const sent = new Map<string, number>();
      for (const item of items) sent.set(item.page.pageId, item.page.updatedAt);
      // The strokes' generation each push carried: acknowledged, they are the
      // server's — unless a stroke came in while they were on the way.
      const inkSent = new Map<string, number>();
      for (const item of items) if (item.ink && !item.page.deleted) inkSent.set(item.page.id, inkGen.get(item.page.id) || 0);
      let needPull = false;
      /** Pages whose strokes were refused and that went again without them —
       *  once per push, so a page refused whole is not sent forever. */
      const retried = new Set<string>();
      // By index: a page whose strokes are refused goes again at the end.
      for (let b = 0; b < batches.length; b += 1) {
        const batch = batches[b];
        if (owner() !== o) return;   // the coach handed the tablet over mid-push
        const ack = await pushNotebookPages(batch);
        if (ack.ownerId && ack.ownerId !== o) return;
        const carried = new Set(batch.filter((w) => w.ink).map((w) => w.pageId));
        for (const s of ack.saved) {
          let p = cache.get(`${o}|${s.pageId}`);
          if (!p) continue;
          if (carried.has(s.pageId) && inkSent.has(p.id) && (inkGen.get(p.id) || 0) === inkSent.get(p.id)) inkDirty.delete(p.id);
          let resend = false;
          if (s.newRow && !p.deleted) {
            // Nothing was stored under this id: the server has what this push
            // carried and nothing it could not show. Strokes held here that
            // stayed home are the only copy, and are sent.
            if (p.sides !== 2) p = { ...p, sides: 2 };
            if (!carried.has(s.pageId) && !p.inkRejected && (p.points > 0 || (heldPoints.get(p.id) || 0) > 0)) { inkDirty.add(p.id); resend = true; }
          } else if (p.sides !== 2) {
            // A record the frontend before wrote, pushed as the installed apps
            // push: the server kept the side it did not send. A pull brings
            // that side in now, rather than a minute from now.
            needPull = true;
          }
          // Compare-and-clear: a keystroke that landed while the request was in
          // flight bumped the version, and that version is still dirty.
          if (p.updatedAt !== sent.get(s.pageId)) { cache.set(p.id, { ...p, createdAt: s.createdAt || p.createdAt, savedAt: s.savedAt || p.savedAt }); continue; }
          const next = { ...p, dirty: false, updatedAt: s.updatedAt || p.updatedAt, createdAt: s.createdAt || p.createdAt, savedAt: s.savedAt || p.savedAt, rejectedReason: '' };
          cache.set(p.id, next);
          if (storeOk) await putPages([{ page: next }]).catch(() => {});
          // A new version carries them — the server takes no second push of
          // the version it has just stored — committed here and not after the
          // last request: one that fails throws past it, and the page, no
          // longer waiting, kept its strokes home for good (review, 25.10.2026).
          if (resend) commit(next, undefined, 0);
        }
        if (ack.stale.length) needPull = true;
        for (const r of ack.rejected) {
          const p = cache.get(`${o}|${r.pageId}`);
          if (!p) continue;
          if (carried.has(r.pageId) && /^ink-/.test(r.reason || '') && !retried.has(r.pageId)) {
            // The server will not take these strokes (their shape, their
            // size). The page goes again without them, so its text and title
            // sync; the strokes stay here, the refusal said on the page, and
            // are not sent again until they change (25.10.2026).
            retried.add(r.pageId);
            inkSent.delete(p.id);
            const next = { ...p, inkRejected: r.reason };
            cache.set(p.id, next);
            if (storeOk) await putPages([{ page: next }]).catch(() => {});
            batches.push([wireFrom(next)]);
            continue;
          }
          cache.set(p.id, { ...p, rejectedReason: r.reason || 'refused' });
          if (storeOk) await putPages([{ page: cache.get(p.id) as NotebookPage }]).catch(() => {});
          // A tombstone the server would not take through the push still has a
          // door: the DELETE route stamps its own tombstone above the row.
          if (p.deleted) await deleteNotebookPage(p.pageId).catch(() => {});
        }
      }
      pushBackoffMs = 0; nextPushAt = 0;
      emitPages();
      setStatus({ server: 'synced', message: '' });
      if (needPull) await pullIndex({ force: true });
    } catch (error) {
      const err = error as { reachedServer?: boolean; status?: number; retryAfterMs?: number; message?: string };
      // Only a server that ANSWERED is worth a word; the network failing is a
      // hall with no signal, and the strip already says the server will follow.
      if (err && err.reachedServer && err.status === 400) {
        setStatus({ server: 'failed', message: err.message || '' });
        return;
      }
      if (err && err.reachedServer && err.status === 413) {
        // Too big as a whole: mark the largest dirty page and let the rest go
        // next time.
        const o = owner();
        const dirty = [...cache.values()].filter((p) => p.ownerId === o && p.dirty && !p.rejectedReason);
        const biggest = dirty.sort((a, b) => (b.points || b.text.length) - (a.points || a.text.length))[0];
        // A page whose strokes were on the way loses its strokes' place in the
        // next push, not its own: the text still goes.
        if (biggest && biggest.points > 0 && !biggest.inkRejected && (inkDirty.has(biggest.id) || !biggest.savedAt)) cache.set(biggest.id, { ...biggest, inkRejected: 'too-big' });
        else if (biggest) cache.set(biggest.id, { ...biggest, rejectedReason: 'too-big' });
        armPush();
        setStatus({ server: 'pending' });
        return;
      }
      const wait = err && err.reachedServer && err.status === 429 && err.retryAfterMs
        ? err.retryAfterMs
        : (pushBackoffMs = pushBackoffMs ? Math.min(BACKOFF_MAX_MS, pushBackoffMs * 2) : BACKOFF_START_MS);
      nextPushAt = now() + wait;
      if (pushTimer) window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => { pushTimer = 0; void push(); }, wait);
      setStatus({ server: isOffline() ? 'offline' : 'pending' });
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

/** Drain pending local commits, then push dirty pages of the LIVE owner. */
export async function flushNow(): Promise<void> {
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  nextPushAt = 0;
  await push();
}

/** The page is going away: everything pending into IndexedDB first, then a
 *  best-effort keepalive POST for a small text-only body. Ink never rides it,
 *  and neither does a page that has strokes, whichever side it shows: sent
 *  without them and acknowledged, its strokes would never be pushed. Those go
 *  with the next regular push. */
export function flushOnHide(): void {
  void flushLocal();
  const o = owner();
  if (!o || isOffline()) return;
  const t = now();
  const noInk = (p: NotebookPage) => !(p.points > 0) && !inkCache.has(p.id) && !inkIds.has(p.id);
  const dirty = [...cache.values()].filter((p) => p.ownerId === o && p.dirty && !p.rejectedReason && (p.deleted || (pageIsLive(p, t) && noInk(p))));
  if (dirty.length === 0) return;
  const wire = dirty.map((p) => wireFrom(p));
  if (JSON.stringify({ pages: wire }).length > KEEPALIVE_MAX_BYTES) return;
  const sent = new Map(dirty.map((p) => [p.pageId, p.updatedAt]));
  void pushNotebookPages(wire, { keepalive: true }).then((ack) => {
    if (owner() !== o || (ack.ownerId && ack.ownerId !== o)) return;
    for (const s of ack.saved) {
      const p = cache.get(`${o}|${s.pageId}`);
      if (p && p.updatedAt === sent.get(s.pageId)) cache.set(p.id, { ...p, dirty: false, updatedAt: s.updatedAt || p.updatedAt, createdAt: s.createdAt || p.createdAt, savedAt: s.savedAt || p.savedAt });
    }
  }).catch(() => { /* the boot flush carries it */ });
}

/** Pull the index (no ink) and merge it, per page. Absence never deletes. */
export async function pullIndex(opts: { force?: boolean } = {}): Promise<void> {
  // Not before the boot has read the store (bootLoad says why).
  if (bootLoad) await bootLoad;
  const o = owner();
  if (!o || isOffline()) return;
  if (!opts.force && now() - lastPullAt < PULL_MIN_INTERVAL_MS) return;
  lastPullAt = now();
  let result: { ownerId: string; pages: ServerPage[] };
  try { result = await listNotebook(); } catch { return; }
  if (owner() !== o) return;
  if (!result.ownerId || result.ownerId !== o) return;
  const writes: { page: NotebookPage; ink?: InkPage | null; inkStale?: boolean }[] = [];
  const listed = new Set<string>();
  for (const row of result.pages) {
    const server = pageFromServer(o, row);
    if (!server) continue;
    listed.add(server.id);
    const local = cache.get(server.id) || null;
    const holds = inkCache.has(server.id) || inkIds.has(server.id);
    const d = mergeFromServer(local, server, holds);
    const stale = d.fetchInk && !!d.write;
    // The stale mark goes into the store with the page, in one transaction: a
    // reload before the strokes are fetched must still know they are old.
    if (d.write) { cache.set(d.write.id, d.write); writes.push({ page: d.write, ink: d.dropInk ? null : undefined, inkStale: stale }); }
    if (d.write === server) {
      // A newer copy from the server won: what this device had changed on the
      // page, its strokes included, is not pushed over it — unless the server
      // turns out to hold no strokes of it at all (settleHeldInk).
      inkDirty.delete(server.id);
      if (local && holds && !server.deleted && !(server.points > 0) && !heldPoints.has(server.id)) heldPoints.set(server.id, local.points);
    }
    if (d.dropInk) { inkCache.delete(server.id); inkIds.delete(server.id); inkStale.delete(server.id); heldPoints.delete(server.id); bumpInk(server.id); }
    if (stale) { inkStale.add(server.id); bumpInk(server.id); }
  }
  // A record the frontend before wrote that the server does not list has no
  // copy there to lose: both its sides are what this device holds.
  for (const p of cache.values()) {
    if (p.ownerId !== o || p.sides === 2 || listed.has(p.id)) continue;
    const known = { ...p, sides: 2 as const };
    cache.set(p.id, known);
    writes.push({ page: known });
  }
  if (storeOk && writes.length) await putPages(writes).catch(() => {});
  emitPages();
  setStatus({});
  settleHeldInk(o);
}

/** Strokes this device holds for a page whose copy counts none: drawn here
 *  and not yet pushed when a newer copy came from a device that did not draw
 *  on the page, or cleared elsewhere. The server is asked at once, not when
 *  the coach next opens the handwriting: readInk keeps them and sends them
 *  when it holds no strokes of the page, and takes its own when it does. */
function settleHeldInk(o: string): void {
  for (const p of cache.values()) {
    if (p.ownerId !== o || p.deleted || p.points > 0 || p.inkRejected || !((heldPoints.get(p.id) || 0) > 0)) continue;
    void getInk(p.pageId);
  }
}

/** The sheet opened or the app came back: refresh the list, then push. */
export async function refresh(): Promise<void> {
  emitPages();
  await pullIndex();
  await flushNow();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function configure(c: Config): void {
  config = c;
  const o = c.getOwner();
  if (o && o !== 'admin' && o !== 'anon') void boot(o);
  else setStatus({ loaded: true });   // no notebook to pull for this session
}

/** The owner changed (a coach hand-off): what was pending goes to the store
 *  under the OLD owner, then the cache is rebuilt for the new one. */
export function reset(): void {
  void flushLocal();
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  pushBackoffMs = 0; nextPushAt = 0; lastPullAt = 0;
  const o = owner();
  if (o && o !== 'admin' && o !== 'anon' && o !== booted) void boot(o);
  else if (!o || o === 'admin' || o === 'anon') { cache.clear(); clearInkState(); bootLoad = null; booted = ''; if (config) config.onPages([]); setStatus({ loaded: true }); }
}

export function stop(): void {
  void flushLocal();
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  config = null; booted = ''; bootLoad = null;
  cache.clear(); clearInkState();
}

export function currentStatus(): PadSyncStatus { return status; }

export function pagesNow(): NotebookPage[] {
  const o = owner();
  return livePages([...cache.values()].filter((p) => p.ownerId === o), now());
}
