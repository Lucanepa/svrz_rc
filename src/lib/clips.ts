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

/** The video of a clip: in IndexedDB (`blob`, the web app and a picked file),
 *  or in the installed app's folder (`path`, copied off a plugged-in card,
 *  with `proxyPath` the camera's small .LRF copy when it had one). */
export type ClipFile = { name: string; type: string; size: number; blob?: Blob; path?: string; proxyPath?: string };
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
  // The installed app's files go with their clips.
  const withFiles = await new Promise<Clip[]>((resolve) => {
    const req = d.transaction(CLIPS, 'readonly').objectStore(CLIPS).getAll();
    req.onsuccess = () => resolve((req.result as Clip[]).filter((c) => ids.includes(c.id) && c.file?.path));
    req.onerror = () => resolve([]);
  });
  if (withFiles.length) {
    void import('./clipFiles').then((m) => Promise.all(withFiles.map((c) => m.deleteClipFiles(c.clipId).catch(() => undefined)))).catch(() => undefined);
  }
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(CLIPS, 'readwrite');
    for (const id of ids) t.objectStore(CLIPS).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  changed();
}

/** Every clip id on this device, any coach's: what the installed app's folder may keep. */
export async function allClipIds(): Promise<string[]> {
  const d = await db();
  return new Promise<string[]>((resolve, reject) => {
    const req = d.transaction(CLIPS, 'readonly').objectStore(CLIPS).getAll();
    req.onsuccess = () => resolve((req.result as Clip[]).map((c) => c.clipId));
    req.onerror = () => reject(req.error);
  });
}

export function newClip(ownerId: string, pageId: string, n: number, at: number, seconds: number, camera: string): Clip {
  const clipId = crypto.randomUUID();
  return { id: `${ownerId}|${clipId}`, ownerId, clipId, pageId, n, at, seconds, stoppedAt: 0, camera, file: null, createdAt: at };
}

/** The next number: one count across the coach's pages, so "Clip 7" names
 *  one clip wherever its line is (a page can @-mention a clip of another). */
export const nextClipNumber = (clips: Clip[]): number => clips.reduce((m, c) => Math.max(m, c.n), 0) + 1;

/** The clip numbers a page's text mentions. */
export function clipNumbersIn(text: string): number[] {
  const re = new RegExp(CLIP_LINE_RE.source, 'g');
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]));
  return out;
}

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
const TOLERANCE_MS = 3_000;
/** Longer than any clip: a card time further from the name's start is a copy's. */
const MAX_CLIP_MS = 5 * 60_000;
/** A clip's length when nothing says it: ten buffered seconds and the stop. */
const USUAL_CLIP_MS = 11_500;

/**
 * When a file's recording ENDED, on the camera's clock as this device reads
 * it, and whether it is DJI's small proxy (.LRF) of a recording.
 *
 * The end, not the start: a clip's start depends on how much Pre-Rec had
 * buffered, which is less when the clip before ended only seconds earlier
 * (the third clip of the first evening, 29.10.2026, started 9 s after its
 * tap where the others started 4 s after), while its end is always the stop
 * a second after the tap. The card's file time is that end; DJI's name
 * carries the start, and stands in when the file time is a copy's.
 */
export function fileEnd(f: PickedFile): { at: number; base: string; proxy: boolean } {
  const m = DJI_NAME.exec(f.name);
  const proxy = /\.lrf$/i.test(f.name);
  const base = f.name.replace(/\.[^.]+$/, '').toUpperCase();
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const start = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    const ownTime = f.lastModified >= start && f.lastModified - start <= MAX_CLIP_MS;
    return { at: ownTime ? f.lastModified : start + USUAL_CLIP_MS, base, proxy };
  }
  return { at: f.lastModified, base, proxy };
}

/** When a clip ended on this device's clock: the stop it was sent, or a moment after the tap. */
const clipEnd = (c: { at: number; stoppedAt?: number }): number => (c.stoppedAt && c.stoppedAt > c.at ? c.stoppedAt : c.at + 1_500);

/**
 * Which picked file is which clip. The camera's clock may be off from this
 * device's by anything (never set, another time zone; 14 s on the first
 * evening), so the offset that lines up the most clips' ends is found first —
 * the one closest to zero among equals — and each clip then takes the
 * nearest file within a few seconds. Of a recording picked twice (the .MP4
 * and DJI's .LRF proxy) the MP4 is taken. Returns clipId → index into `files`.
 */
export function matchClipFiles(clips: { clipId: string; at: number; stoppedAt?: number }[], files: PickedFile[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!clips.length || !files.length) return out;
  const ends = files.map((f) => fileEnd(f));
  // One entry per recording: the MP4 over the proxy.
  const best = new Map<string, number>();
  ends.forEach((e, i) => {
    const prev = best.get(e.base);
    if (prev === undefined || (ends[prev].proxy && !e.proxy)) best.set(e.base, i);
  });
  const candidates = [...best.values()];

  const score = (offset: number) => clips.filter((c) => candidates.some((i) => Math.abs(ends[i].at - clipEnd(c) - offset) <= TOLERANCE_MS)).length;
  let offset = 0;
  let top = score(0);
  for (const c of clips) {
    for (const i of candidates) {
      const o = ends[i].at - clipEnd(c);
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
      const g = Math.abs(ends[i].at - clipEnd(c) - offset);
      if (g <= TOLERANCE_MS && g < gap) { gap = g; pick = i; }
    }
    if (pick >= 0) { taken.add(pick); out.set(c.clipId, pick); }
  }
  return out;
}

/** The type a picked file is played with: DJI's .LRF is an MP4 under another name. */
export const playableType = (f: { name: string; type: string }): string => (f.type && f.type.startsWith('video/') ? f.type : 'video/mp4');

// ── Too heavy to play ────────────────────────────────────────────────────
// The camera films what it is set to, and 4K at 120 fps (10-bit H.265, 311
// Mbit/s, 600 MB for 16 s) is more than the installed app plays in real time
// on a laptop: 1.5 s of video in 7 s (31.10.2026, Radeon 890M). The GPU decodes
// it at twice real time while the frames stay on it; what falls behind is
// copying every 4K frame back to memory, 120 times a second — GStreamer's
// download path (the webview's) took 35 s for 16 s, mpv's vaapi-copy fell
// short too. 2.7K at 60 fps (75 Mbit/s) played. Such a clip starts on the
// camera's 720p copy, and an original that falls behind switches to it.

/** Over this the original starts on the 720p copy, when there is one. */
export const HEAVY_MBIT = 150;

/** The original's data rate in Mbit/s: its size over the clip's length — the
 *  Pre-Rec seconds and the second the camera ran on after the tap. */
export function clipMbit(file: { size: number } | null | undefined, seconds: number): number {
  if (!file || !(file.size > 0)) return 0;
  return (file.size * 8) / (Math.max(1, seconds + 1) * 1e6);
}

/** How long a play is watched before it is judged, in seconds. */
export const BEHIND_AFTER_S = 4;

/**
 * Whether a video falls behind: under 60 % of real time over at least
 * BEHIND_AFTER_S seconds, at the speed it is set to — slow motion picked in
 * the player is not falling behind.
 */
export function fallsBehind(wallSeconds: number, mediaSeconds: number, playbackRate = 1): boolean {
  if (wallSeconds < BEHIND_AFTER_S) return false;
  const rate = playbackRate > 0 ? playbackRate : 1;
  return mediaSeconds / (wallSeconds * rate) < 0.6;
}
