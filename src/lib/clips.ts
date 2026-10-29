// Clips: the short videos a coach saves from the notebook with an Osmo Action
// camera (osmoCamera.ts) — what happened in the seconds BEFORE the tap, from
// the camera's Pre-Rec (Luca, 29.10.2026: "the last 10 secs"). The camera
// writes the clip onto its own card; the page gets a line
// "[Clip 3 · 19:42:10]" with the time of the tap, and the file is matched to
// that line after the match, when the coach picks the card's files
// ("Videos zuordnen").
//
// Kept on THIS device only (Luca, 29.10.2026): IndexedDB `svrz-clips`, never
// sent to the server, never into the form, the PDF or the mail. A clip goes
// with its page — when the page is deleted or its week is up — and in any
// case a week after it was recorded.

import { clockLabel } from './appTime';
import { NOTEBOOK_TTL_MS } from './notebook';

export type ClipFile = { name: string; type: string; size: number; blob: Blob };
export type Clip = {
  /** `${ownerId}|${clipId}`. */
  id: string;
  ownerId: string;
  clipId: string;
  pageId: string;
  /** "Clip n" on its page. */
  n: number;
  /** This device's clock at the tap: the clip is what came before it. */
  at: number;
  /** The seconds before the tap the camera kept (its Pre-Rec setting). */
  seconds: number;
  /** 0 while recording, or when the stop was not confirmed. */
  stoppedAt: number;
  /** The camera's Bluetooth name. */
  camera: string;
  /** The coach's own name for it, '' or absent when none. */
  title?: string;
  file: ClipFile | null;
  createdAt: number;
};

const DB_NAME = 'svrz-clips';
const DB_VERSION = 1;
const CLIPS = 'clips';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(CLIPS)) req.result.createObjectStore(CLIPS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('clips store blocked'));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

const listeners = new Set<() => void>();
export function subscribeClips(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const changed = () => { for (const fn of listeners) fn(); };

export async function listClips(ownerId: string): Promise<Clip[]> {
  const d = await db();
  const all = await new Promise<Clip[]>((resolve, reject) => {
    const req = d.transaction(CLIPS, 'readonly').objectStore(CLIPS).getAll();
    req.onsuccess = () => resolve(req.result as Clip[]);
    req.onerror = () => reject(req.error);
  });
  return all.filter((c) => c.ownerId === ownerId).sort((a, b) => a.at - b.at);
}

export async function putClip(clip: Clip): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(CLIPS, 'readwrite');
    t.objectStore(CLIPS).put(clip);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  changed();
}

export async function deleteClips(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(CLIPS, 'readwrite');
    for (const id of ids) t.objectStore(CLIPS).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  changed();
}

export function newClip(ownerId: string, pageId: string, n: number, at: number, seconds: number, camera: string): Clip {
  const clipId = crypto.randomUUID();
  return { id: `${ownerId}|${clipId}`, ownerId, clipId, pageId, n, at, seconds, stoppedAt: 0, camera, file: null, createdAt: at };
}

/** The next number on a page. */
export const nextClipNumber = (clips: Clip[], pageId: string): number =>
  clips.filter((c) => c.pageId === pageId).reduce((m, c) => Math.max(m, c.n), 0) + 1;

/** The line written into the page: plain text, so it reads the same on
 *  another device (which has no video) and in the form if it is imported. */
export const clipLine = (n: number, at: number): string => `[Clip ${n} · ${clockLabel(at, { seconds: true })}]`;
/** A clip line in a page's text: one piece in the editor (RichSurface atoms). */
export const CLIP_LINE_RE = /\[Clip (\d+) · \d{2}:\d{2}(?::\d{2})?\]/;

/** The clips whose page is gone or whose week is up. `livePageIds` is the
 *  owner's live pages; only clips older than `graceMs` go for a missing page,
 *  so a clip recorded on a page this very second is not taken. */
export function doomedClips(clips: Clip[], livePageIds: Set<string>, now: number, graceMs = 60_000): Clip[] {
  return clips.filter((c) => c.createdAt + NOTEBOOK_TTL_MS <= now || (!livePageIds.has(c.pageId) && now - c.createdAt > graceMs));
}

// ── matching the card's files to the lines ───────────────────────────────

export type PickedFile = { name: string; lastModified: number; size: number };

const DJI_NAME = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d{4})_D\.(mp4|lrf)$/i;
const TOLERANCE_MS = 4_000;

/** When a file's recording started, on the camera's clock as this device reads
 *  it, and whether it is DJI's small proxy (.LRF) of a recording. Whether the
 *  name carries the tap or the start of the buffered seconds does not matter:
 *  it is the same for every clip of an evening, and the matching below finds
 *  a shift all clips share. */
export function fileStart(f: PickedFile, seconds: number): { at: number; base: string; proxy: boolean } {
  const m = DJI_NAME.exec(f.name);
  const proxy = /\.lrf$/i.test(f.name);
  const base = f.name.replace(/\.[^.]+$/, '').toUpperCase();
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return { at: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), base, proxy };
  }
  // No time in the name (GoPro, a renamed file): the card's file time is the
  // END of the recording, a moment after the tap.
  return { at: f.lastModified - seconds * 1000, base, proxy };
}

/**
 * Which picked file is which clip. The camera's clock may be off from this
 * device's by anything (never set, another time zone), so the offset that
 * lines up the most clips is found first — the one closest to zero among
 * equals — and each clip then takes the nearest file within a few seconds.
 * Of a recording picked twice (the .MP4 and DJI's .LRF proxy) the MP4 is
 * taken. Returns clipId → index into `files`.
 */
export function matchClipFiles(clips: { clipId: string; at: number; seconds: number }[], files: PickedFile[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!clips.length || !files.length) return out;
  const seconds = clips[0].seconds;
  const starts = files.map((f) => fileStart(f, seconds));
  // One entry per recording: the MP4 over the proxy.
  const best = new Map<string, number>();
  starts.forEach((s, i) => {
    const prev = best.get(s.base);
    if (prev === undefined || (starts[prev].proxy && !s.proxy)) best.set(s.base, i);
  });
  const candidates = [...best.values()];

  const score = (offset: number) => clips.filter((c) => candidates.some((i) => Math.abs(starts[i].at - c.at - offset) <= TOLERANCE_MS)).length;
  let offset = 0;
  let top = score(0);
  for (const c of clips) {
    for (const i of candidates) {
      const o = starts[i].at - c.at;
      const s = score(o);
      if (s > top || (s === top && Math.abs(o) < Math.abs(offset))) { top = s; offset = o; }
    }
  }
  if (!top) return out;

  const taken = new Set<number>();
  for (const c of [...clips].sort((a, b) => a.at - b.at)) {
    let pick = -1;
    let gap = Infinity;
    for (const i of candidates) {
      if (taken.has(i)) continue;
      const g = Math.abs(starts[i].at - c.at - offset);
      if (g <= TOLERANCE_MS && g < gap) { gap = g; pick = i; }
    }
    if (pick >= 0) { taken.add(pick); out.set(c.clipId, pick); }
  }
  return out;
}

/** The type a picked file is played with: DJI's .LRF is an MP4 under another name. */
export const playableType = (f: { name: string; type: string }): string => (f.type && f.type.startsWith('video/') ? f.type : 'video/mp4');
