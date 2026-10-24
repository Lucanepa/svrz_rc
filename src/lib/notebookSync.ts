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
  NOTEBOOK_SYNC_DELAY_MS, NOTEBOOK_TEXT_DEBOUNCE_MS, batchesFor, getStoredInk, listStoredInkIds, listStoredPages, livePages, mergeFromServer,
  nextVersion, notebookStoreAvailable, pageFromServer, pageIsLive, pruneNotebook, putPages, requestPersistentStorage, wireFrom,
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
/** Bumped whenever a page's strokes change under a read: a local commit, or a
 *  pull that marks them stale or drops them. A read that started before the
 *  bump holds an older truth than the cache. */
const inkGen = new Map<string, number>();
const bumpInk = (id: string) => { inkGen.set(id, (inkGen.get(id) || 0) + 1); };
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
  cache.clear(); inkCache.clear(); inkIds.clear(); inkStale.clear(); pending.clear();
  booted = o;
  setStatus({ loaded: false });
  storeOk = await notebookStoreAvailable();
  if (storeOk) {
    try { await pruneNotebook(now()); } catch { /* a purge that fails is retried at the next boot */ }
    try {
      for (const p of await listStoredPages(o)) cache.set(p.id, p);
      for (const id of await listStoredInkIds(o)) inkIds.add(id);
    } catch { storeOk = false; }
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
  cache.set(next.id, next);
  if (ink !== undefined) {
    if (ink) { inkCache.set(next.id, ink); inkIds.add(next.id); } else { inkCache.delete(next.id); inkIds.delete(next.id); }
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

/** Reads of a page's strokes that are still running, by store key, with the
 *  generation they started at. */
const inkInFlight = new Map<string, { gen: number; read: Promise<InkPage | null> }>();

/** The strokes of a page: local first, the server when ours are missing or
 *  older. Null when neither has them (a brand-new page, a page only typed on).
 *
 *  A second ask for the same page while the first is still out shares it.
 *  React's StrictMode runs the sheet's ink effect twice on mount, and in
 *  WebKit both runs reached the network before either had stored what it
 *  fetched: two GETs for one page (notebook-ink spec, mobile-safari). Only
 *  while nothing changed in between, though: the sheet asks again after every
 *  stroke, and a fetch of a stale page that started before the stroke would
 *  have answered with the server's strokes, the new one missing — on screen,
 *  in IndexedDB and in the next push. */
export function getInk(pageId: string): Promise<InkPage | null> {
  const id = `${owner()}|${pageId}`;
  const gen = inkGen.get(id) || 0;
  const running = inkInFlight.get(id);
  if (running && running.gen === gen) return running.read;
  const read = readInk(pageId, gen).finally(() => { if (inkInFlight.get(id)?.read === read) inkInFlight.delete(id); });
  inkInFlight.set(id, { gen, read });
  return read;
}

/** Whether the server may hold strokes of this page: it reached the server,
 *  and counts some or shows them. A page this device made and has not synced
 *  yet has nothing there to ask for — switching it to Handschrift is not a
 *  round trip. */
const inkOnServer = (page: NotebookPage): boolean => !!page.savedAt && (page.points > 0 || page.kind === 'ink');

async function readInk(pageId: string, gen: number): Promise<InkPage | null> {
  const o = owner();
  const id = `${o}|${pageId}`;
  const page = cache.get(id);
  if (!page || page.deleted) return null;
  // Overtaken: the strokes changed while this read waited. What the cache
  // holds now is newer than anything this read found, and is left alone.
  const overtaken = () => (inkGen.get(id) || 0) !== gen;
  const cached = inkCache.get(id);
  const stored = cached || !storeOk ? null : await getStoredInk(o, pageId).catch(() => null);
  const local = cached || (stored ? stored.page : null);
  if (overtaken()) return inkCache.get(id) || local;
  // Marked older than the server's by a pull before a reload.
  if (stored && stored.stale) inkStale.add(id);
  if (local && !inkStale.has(id)) { inkCache.set(id, local); return local; }
  if (!local && !inkStale.has(id) && !inkOnServer(page)) return null;
  try {
    const remote = await fetchNotebookInk(pageId);
    if (overtaken()) return inkCache.get(id) || local;
    if (remote && remote.ownerId === o) {
      // The server's strokes — or, where it has none at all, the ones this
      // device holds: the only copy, current again, and the next push may
      // carry them.
      const ink = remote.page.ink || local;
      inkStale.delete(id);
      if (!ink) return null;
      inkCache.set(id, ink);
      inkIds.add(id);
      if (storeOk) await putPages([{ page: cache.get(id) || page, ink }]).catch(() => {});
      return ink;
    }
  } catch { /* offline: whatever we hold is what the coach gets */ }
  return local;
}

/** The strokes a push carries for a page: the ones this device holds — unless
 *  the server has newer ones, and then none: the push is metadata-only and the
 *  server keeps its own (server/notebook.ts). Typing on a page whose
 *  handwriting changed on another device must not put the old strokes back. */
async function inkForPush(o: string, page: NotebookPage): Promise<InkPage | null> {
  if (page.deleted || inkStale.has(page.id)) return null;
  const cached = inkCache.get(page.id);
  if (cached) return cached;
  if (!storeOk) return null;
  const stored = await getStoredInk(o, page.pageId).catch(() => null);
  if (!stored) return null;
  if (stored.stale) { inkStale.add(page.id); return null; }
  return stored.page;
}

export function hasLocalInk(pageId: string): boolean {
  return inkCache.has(`${owner()}|${pageId}`);
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
        if (p) cache.set(p.id, { ...p, rejectedReason: 'too-big' });
      }
      const sent = new Map<string, number>();
      for (const item of items) sent.set(item.page.pageId, item.page.updatedAt);
      let needPull = false;
      for (const batch of batches) {
        if (owner() !== o) return;   // the coach handed the tablet over mid-push
        const ack = await pushNotebookPages(batch);
        if (ack.ownerId && ack.ownerId !== o) return;
        for (const s of ack.saved) {
          const p = cache.get(`${o}|${s.pageId}`);
          if (!p) continue;
          // Compare-and-clear: a keystroke that landed while the request was in
          // flight bumped the version, and that version is still dirty.
          if (p.updatedAt !== sent.get(s.pageId)) { cache.set(p.id, { ...p, createdAt: s.createdAt || p.createdAt, savedAt: s.savedAt || p.savedAt }); continue; }
          const next = { ...p, dirty: false, updatedAt: s.updatedAt || p.updatedAt, createdAt: s.createdAt || p.createdAt, savedAt: s.savedAt || p.savedAt, rejectedReason: '' };
          cache.set(p.id, next);
          if (storeOk) await putPages([{ page: next }]).catch(() => {});
        }
        if (ack.stale.length) needPull = true;
        for (const r of ack.rejected) {
          const p = cache.get(`${o}|${r.pageId}`);
          if (!p) continue;
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
        if (biggest) cache.set(biggest.id, { ...biggest, rejectedReason: 'too-big' });
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
  const o = owner();
  if (!o || isOffline()) return;
  if (!opts.force && now() - lastPullAt < PULL_MIN_INTERVAL_MS) return;
  lastPullAt = now();
  let result: { ownerId: string; pages: ServerPage[] };
  try { result = await listNotebook(); } catch { return; }
  if (owner() !== o) return;
  if (!result.ownerId || result.ownerId !== o) return;
  const writes: { page: NotebookPage; ink?: InkPage | null; inkStale?: boolean }[] = [];
  for (const row of result.pages) {
    const server = pageFromServer(o, row);
    if (!server) continue;
    const local = cache.get(server.id) || null;
    const d = mergeFromServer(local, server, inkCache.has(server.id) || inkIds.has(server.id));
    const stale = d.fetchInk && !!d.write;
    // The stale mark goes into the store with the page, in one transaction: a
    // reload before the strokes are fetched must still know they are old.
    if (d.write) { cache.set(d.write.id, d.write); writes.push({ page: d.write, ink: d.dropInk ? null : undefined, inkStale: stale }); }
    if (d.dropInk) { inkCache.delete(server.id); inkIds.delete(server.id); inkStale.delete(server.id); bumpInk(server.id); }
    if (stale) { inkStale.add(server.id); bumpInk(server.id); }
  }
  if (storeOk && writes.length) await putPages(writes).catch(() => {});
  emitPages();
  setStatus({});
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
  else if (!o || o === 'admin' || o === 'anon') { cache.clear(); inkCache.clear(); inkIds.clear(); inkStale.clear(); booted = ''; if (config) config.onPages([]); setStatus({ loaded: true }); }
}

export function stop(): void {
  void flushLocal();
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  config = null; booted = '';
  cache.clear(); inkCache.clear(); inkIds.clear(); inkStale.clear();
}

export function currentStatus(): PadSyncStatus { return status; }

export function pagesNow(): NotebookPage[] {
  const o = owner();
  return livePages([...cache.values()].filter((p) => p.ownerId === o), now());
}
