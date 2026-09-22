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
  NOTEBOOK_SYNC_DELAY_MS, NOTEBOOK_TEXT_DEBOUNCE_MS, batchesFor, getStoredInk, listStoredPages, livePages, mergeFromServer,
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
const inkStale = new Set<string>();              // pages whose strokes the server has newer than ours
const pending = new Map<string, Pending>();      // local commits not yet in IndexedDB
let pushTimer = 0;
let pushing: Promise<void> | null = null;
let pushBackoffMs = 0;
let nextPushAt = 0;
let lastPullAt = 0;
let status: PadSyncStatus = { local: 'idle', server: 'idle', at: 0, message: '', serverOnly: false, dirty: 0 };

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
  cache.clear(); inkCache.clear(); inkStale.clear(); pending.clear();
  booted = o;
  storeOk = await notebookStoreAvailable();
  if (storeOk) {
    try { await pruneNotebook(now()); } catch { /* a purge that fails is retried at the next boot */ }
    try {
      for (const p of await listStoredPages(o)) cache.set(p.id, p);
    } catch { storeOk = false; }
  }
  if (booted !== o) return;   // the owner changed under us
  emitPages();
  setStatus({ local: 'idle', server: 'idle' });
  await pullIndex({ force: true });
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

/** Commit a page (and, for ink, its strokes). Debounced per page; the cache and
 *  the sheet update at once, IndexedDB after `debounceMs`, the server 5 s later. */
export function commit(page: NotebookPage, ink?: InkPage | null, debounceMs = NOTEBOOK_TEXT_DEBOUNCE_MS): void {
  if (!config || page.ownerId !== owner()) return;
  const prev = cache.get(page.id);
  const next: NotebookPage = { ...page, dirty: true, rejectedReason: '', updatedAt: nextVersion(prev) };
  cache.set(next.id, next);
  if (ink !== undefined) {
    if (ink) inkCache.set(next.id, ink); else inkCache.delete(next.id);
    inkStale.delete(next.id);
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

/** The strokes of a pen page: local first, the server when ours are missing or
 *  older. Null when neither has them (a brand-new page). */
export async function getInk(pageId: string): Promise<InkPage | null> {
  const o = owner();
  const id = `${o}|${pageId}`;
  const page = cache.get(id);
  if (!page || page.kind !== 'ink' || page.deleted) return null;
  const local = inkCache.get(id) || (storeOk ? await getStoredInk(o, pageId).catch(() => null) : null);
  if (local && !inkStale.has(id)) { inkCache.set(id, local); return local; }
  try {
    const remote = await fetchNotebookInk(pageId);
    if (remote && remote.ownerId === o && remote.page.ink) {
      const ink = remote.page.ink;
      inkCache.set(id, ink);
      inkStale.delete(id);
      if (storeOk) await putPages([{ page: cache.get(id) || page, ink }]).catch(() => {});
      return ink;
    }
  } catch { /* offline: whatever we hold is what the coach gets */ }
  return local;
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
      const items = await Promise.all(dirty.map(async (page) => ({
        page,
        ink: page.kind === 'ink' && !page.deleted
          ? (inkCache.get(page.id) || (storeOk ? await getStoredInk(o, page.pageId).catch(() => null) : null))
          : null,
      })));
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
 *  best-effort keepalive POST for a small text-only body. Ink never rides it. */
export function flushOnHide(): void {
  void flushLocal();
  const o = owner();
  if (!o || isOffline()) return;
  const t = now();
  const dirty = [...cache.values()].filter((p) => p.ownerId === o && p.dirty && !p.rejectedReason && p.kind === 'text' && (p.deleted || pageIsLive(p, t)));
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
  const writes: { page: NotebookPage; ink?: InkPage | null }[] = [];
  for (const row of result.pages) {
    const server = pageFromServer(o, row);
    if (!server) continue;
    const local = cache.get(server.id) || null;
    const d = mergeFromServer(local, server);
    if (d.write) { cache.set(d.write.id, d.write); writes.push({ page: d.write, ink: d.dropInk ? null : undefined }); }
    if (d.dropInk) { inkCache.delete(server.id); inkStale.delete(server.id); }
    if (d.fetchInk && d.write) inkStale.add(server.id);
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
}

/** The owner changed (a coach hand-off): what was pending goes to the store
 *  under the OLD owner, then the cache is rebuilt for the new one. */
export function reset(): void {
  void flushLocal();
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  pushBackoffMs = 0; nextPushAt = 0; lastPullAt = 0;
  const o = owner();
  if (o && o !== 'admin' && o !== 'anon' && o !== booted) void boot(o);
  else if (!o || o === 'admin' || o === 'anon') { cache.clear(); inkCache.clear(); inkStale.clear(); booted = ''; if (config) config.onPages([]); }
}

export function stop(): void {
  void flushLocal();
  if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = 0; }
  config = null; booted = '';
  cache.clear(); inkCache.clear(); inkStale.clear();
}

export function currentStatus(): PadSyncStatus { return status; }

export function pagesNow(): NotebookPage[] {
  const o = owner();
  return livePages([...cache.values()].filter((p) => p.ownerId === o), now());
}
