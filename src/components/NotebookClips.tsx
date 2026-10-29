// The notebook's camera: a button in the typed side's toolbar that connects an
// Osmo Action over Bluetooth and then saves a clip of the seconds before the
// tap (the camera's Pre-Rec), and a strip under the
// toolbar with the page's clips — each one plays once its video has been
// matched from the camera's card ("Videos zuordnen").
//
// The sheet owns the text: the button asks it to write the clip's line at the
// caret (`insertLine`), which also makes the page when it is not written yet,
// and gets the page's id back. Everything about the camera is in
// lib/osmoCamera.ts, everything about the clips in lib/clips.ts.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import { CircleDot, Download, Film, LoaderCircle, Play, Trash2, Unplug, Upload, Video, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { clockLabel } from '../lib/appTime';
import { PAD_STRINGS as PAD_TEXT, fill, type PAD_STRINGS } from '../lib/notepadStrings';
import { IS_NATIVE } from '../lib/native';
import { OsmoError, bluetoothSupport, findNativeCamera, pickWebCamera, type OsmoErrorCode } from '../lib/osmoLink';
import { DEFAULT_PRE_SECONDS, cameraState, connectCamera, disconnectCamera, saveClip, subscribeCamera } from '../lib/osmoCamera';
import { isPreRecording, isRecording } from '../lib/osmoProtocol';
import {
  allClipIds, clipLine, clipNumbersIn, deleteClips, doomedClips, listClips, matchClipFiles, newClip, nextClipNumber, playableType, putClip, subscribeClips,
  type Clip,
} from '../lib/clips';
import { cameraMedia, clipFileUrl, importClipFile, pruneClipFiles, saveClipFile, type MediaFile } from '../lib/clipFiles';
import { confirmDialog, toast } from './ui';
import { clientLog } from '../lib/logger';

type Strings = Record<keyof (typeof PAD_STRINGS)['DE'], string>;
const LAST_CAMERA_KEY = 'svrz_osmo_last';

const ERROR_KEY: Record<OsmoErrorCode, keyof Strings | null> = {
  unsupported: 'camErrUnsupported',
  cancelled: null,
  'not-found': 'camErrNotFound',
  permission: 'camErrPermission',
  'bluetooth-off': 'camErrBluetoothOff',
  link: 'camErrLink',
  refused: 'camErrRefused',
  timeout: 'camErrTimeout',
  busy: 'camErrBusy',
  asleep: 'camErrAsleep',
  'too-hot': 'camErrTooHot',
  card: 'camErrCard',
  record: 'camErrRecord',
  'no-prerec': 'camErrNoPrerec',
};
function sayError(tp: Strings, e: unknown): void {
  const code: OsmoErrorCode = e instanceof OsmoError ? e.code : 'link';
  const key = ERROR_KEY[code];
  if (key) toast.error(tp[key]);
}

export const useCamera = () => useSyncExternalStore(subscribeCamera, cameraState, cameraState);
/** Whether this browser or app can drive a camera at all. */
export const cameraSupported = (): boolean => bluetoothSupport(IS_NATIVE) !== null;

// The camera is OFF until the coach turns it on in the options (Luca,
// 29.10.2026): one more button in the notebook is noise for everybody who has
// no camera. Per device, like Bluetooth itself.
const CAMERA_ON_KEY = 'svrz_camera_on';
const cameraListeners = new Set<() => void>();
function readCameraOn(): boolean {
  try { return localStorage.getItem(CAMERA_ON_KEY) === '1'; } catch { return false; }
}
export function setCameraOn(on: boolean): void {
  try { if (on) localStorage.setItem(CAMERA_ON_KEY, '1'); else localStorage.removeItem(CAMERA_ON_KEY); } catch { /* storage refused: this run only */ }
  if (!on) void disconnectCamera();
  for (const fn of cameraListeners) fn();
}
const subscribeCameraOn = (fn: () => void) => { cameraListeners.add(fn); return () => { cameraListeners.delete(fn); }; };
export const useCameraOn = (): boolean => useSyncExternalStore(subscribeCameraOn, readCameraOn, readCameraOn);

/** The row in the app's options: "Kamera im Notizblock", off by default. */
export function CameraOption({ lang }: { lang: 'DE' | 'EN' }) {
  const on = useCameraOn();
  const de = lang === 'DE';
  return (
    <button
      type="button"
      onClick={() => setCameraOn(!on)}
      aria-pressed={on}
      data-testid="option-camera"
      className="w-full min-h-12 inline-flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
      title={de
        ? 'Eine Osmo-Action-Kamera über Bluetooth: «Clip» im Notizblock speichert die Sekunden davor (Pre-Rec).'
        : 'An Osmo Action camera over Bluetooth: "Clip" in the notebook saves the seconds before (Pre-Rec).'}
    >
      <Video size={18} />
      <span className="flex-1 text-left">{de ? 'Kamera im Notizblock' : 'Camera in the notebook'}</span>
      <span className="text-xs font-semibold text-stone-500">{on ? (de ? 'An' : 'On') : (de ? 'Aus' : 'Off')}</span>
    </button>
  );
}

/** The installed app on a computer: it can read a plugged-in card itself. */
const DESKTOP_APP = IS_NATIVE && typeof navigator !== 'undefined' && !/Android/i.test(navigator.userAgent);

const baseOf = (name: string) => name.replace(/\.[^.]+$/, '').toUpperCase();
const AUTO_EVERY_MS = 4_000;

/**
 * The installed app on a computer, after the match: plug in the camera or its
 * SD card and the clips waiting for a video get theirs — matched by time,
 * copied into the app's folder, playable in the notebook at once. Polls only
 * while a clip is waiting, and matches again only when what is on the cards
 * changed. Renders nothing.
 */
export function ClipAutoImport({ ownerId, lang }: { ownerId: string; lang: 'DE' | 'EN' }) {
  // Not tied to the camera option: clips waiting for a video were filmed, so
  // the videos are wanted (the option off after a restart left three clips
  // unmatched with their card plugged in, 29.10.2026).
  useEffect(() => {
    if (!DESKTOP_APP || !ownerId) return;
    const tp = PAD_TEXT[lang] || PAD_TEXT.DE;
    let busy = false;
    let seen = '';
    // Files of clips that are gone (their page went on another run): once.
    void allClipIds().then((ids) => pruneClipFiles(ids)).catch(() => undefined);
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const waiting = (await listClips(ownerId)).filter((c) => !c.file);
        if (!waiting.length) { seen = ''; return; }
        const media = await cameraMedia();
        const key = media.map((m) => `${m.path}:${m.size}`).join('|');
        if (!media.length || key === seen) return;
        seen = key;
        const map = matchClipFiles(waiting, media.map((m) => ({ name: m.name, lastModified: m.modified, size: m.size })));
        clientLog.info('clips.auto', 'videos on a card', { files: media.length, waiting: waiting.length, matched: map.size });
        let k = 0;
        for (const c of waiting) {
          const i = map.get(c.clipId);
          if (i === undefined) continue;
          const f: MediaFile = media[i];
          try {
            const path = await importClipFile(f.path, c.clipId, false);
            const isProxy = /\.lrf$/i.test(f.name);
            const lrf = isProxy ? undefined : media.find((m) => m.path !== f.path && /\.lrf$/i.test(m.name) && baseOf(m.name) === baseOf(f.name));
            const proxyPath = lrf ? await importClipFile(lrf.path, c.clipId, true).catch(() => undefined) : undefined;
            await putClip({ ...c, file: { name: f.name, type: playableType({ name: f.name, type: '' }), size: f.size, path, ...(proxyPath ? { proxyPath } : {}) } });
            k += 1;
          } catch (e) {
            // The card went away mid-copy: it is tried again when it is back.
            clientLog.warn('clips.auto.fail', 'copy off the card failed', { error: String(e).slice(0, 200) });
            seen = '';
          }
        }
        if (k) toast.success(fill(tp.clipsAutoAttached, { k, m: waiting.length }));
      } catch {
        /* not this app's command, or no card: the next tick asks again */
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), AUTO_EVERY_MS);
    return () => clearInterval(t);
  }, [ownerId, lang]);
  return null;
}

/** A clip line in the page asks for its clip: the strip of the page on screen opens it. */
export const CLIP_OPEN_EVENT = 'svrz:clip-open';
export const openClipByNumber = (n: number) => window.dispatchEvent(new CustomEvent(CLIP_OPEN_EVENT, { detail: { n } }));

/** The owner's clips on this device, kept current. Pages that are gone take
 *  their clips with them, once the notebook's pages have loaded. */
export function useClips(ownerId: string, livePageIds: string[] | null): Clip[] {
  const [clips, setClips] = useState<Clip[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { listClips(ownerId).then((c) => { if (alive) setClips(c); }, () => undefined); };
    load();
    const off = subscribeClips(load);
    return () => { alive = false; off(); };
  }, [ownerId]);
  const liveKey = livePageIds ? livePageIds.join(',') : null;
  useEffect(() => {
    if (liveKey === null) return;
    const doomed = doomedClips(clips, new Set(liveKey ? liveKey.split(',') : []), Date.now());
    if (doomed.length) void deleteClips(doomed.map((c) => c.id)).catch(() => undefined);
  }, [clips, liveKey]);
  return clips;
}

function leftLabel(seconds: number): string {
  const min = Math.floor(seconds / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}

const BUTTON = 'h-8 px-2 inline-flex items-center gap-1 rounded-lg border text-xs font-medium transition-colors';

/** The toolbar button: Kamera → Verbinde … → Clip → Speichert …. */
export function CameraButton({ tp, ownerId, clips, insertLine }: {
  tp: Strings;
  ownerId: string;
  clips: Clip[];
  /** Writes the text `make` returns at the caret, making the page if need
   *  be, and returns the page's id, or null when nothing could be written. */
  insertLine: (make: (pageIdBefore: string | null) => string) => string | null;
}) {
  const cam = useCamera();
  const busy = cam.phase === 'connecting' || cam.phase === 'confirm' || cam.phase === 'reconnecting';

  const connect = async () => {
    try {
      // Web: the chooser, which Chrome only opens inside this tap. The app:
      // a scan, taking the camera used last when it is there.
      let last = '';
      try { last = localStorage.getItem(LAST_CAMERA_KEY) || ''; } catch { /* storage refused */ }
      const transport = IS_NATIVE ? await findNativeCamera(last) : await pickWebCamera();
      try { localStorage.setItem(LAST_CAMERA_KEY, transport.key); } catch { /* storage refused */ }
      await connectCamera(transport);
    } catch (e) {
      sayError(tp, e);
    }
  };

  const clip = async () => {
    let made: Clip | null = null;
    try {
      const done = await saveClip((tappedAt, preSeconds) => {
        const n = nextClipNumber(clips);
        const pageId = insertLine(() => `${clipLine(n, tappedAt)} `);
        if (!pageId) return;
        made = newClip(ownerId, pageId, n, tappedAt, preSeconds || DEFAULT_PRE_SECONDS, cameraState().name);
        void putClip(made).catch(() => undefined);
      });
      const kept = made as Clip | null;
      if (kept) void putClip({ ...kept, stoppedAt: done.stoppedAt }).catch(() => undefined);
    } catch (e) {
      sayError(tp, e);
    }
  };

  if (cam.phase === 'ready') {
    return (
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!cam.clip) void clip(); }}
        disabled={!!cam.clip}
        title={tp.camClipTitle}
        data-testid="cam-clip"
        className={cn(BUTTON, cam.clip ? 'border-red-300 bg-red-50 text-red-700' : 'border-red-200 text-red-700 hover:bg-red-50')}
      >
        <CircleDot size={12} className={cn('shrink-0', cam.clip && 'animate-pulse')} />
        {cam.clip ? tp.camSaving : tp.camClip}
      </button>
    );
  }
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { if (!busy) void connect(); }}
      disabled={busy}
      title={tp.camConnectTitle}
      data-testid="cam-connect"
      className={cn(BUTTON, 'border-stone-200 text-stone-700 hover:bg-stone-100')}
    >
      {busy ? <LoaderCircle size={12} className="shrink-0 animate-spin" /> : <Video size={12} className="shrink-0" />}
      {busy ? tp.camConnecting : tp.camConnect}
    </button>
  );
}

/** Under the toolbar: the camera's state, the page's clips, "Videos zuordnen". */
export function ClipStrip({ tp, lang, pageId, text, clips }: { tp: Strings; lang: 'DE' | 'EN'; pageId: string | null; text: string; clips: Clip[] }) {
  const cam = useCamera();
  const fileRef = useRef<HTMLInputElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // The clips filmed on this page and the ones its text mentions (@).
  const mentioned = useMemo(() => clipNumbersIn(text).join(','), [text]);
  const onPage = useMemo(() => {
    const ns = new Set(mentioned ? mentioned.split(',').map(Number) : []);
    return pageId ? clips.filter((c) => c.pageId === pageId || ns.has(c.n)) : clips.filter((c) => ns.has(c.n));
  }, [clips, pageId, mentioned]);
  const waiting = useMemo(() => clips.filter((c) => !c.file), [clips]);
  const open = openId ? clips.find((c) => c.id === openId) || null : null;
  // A tap on a clip line in the page.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const n = (e as CustomEvent<{ n: number }>).detail?.n;
      const c = onPage.find((x) => x.n === n) || clips.find((x) => x.n === n);
      if (c) setOpenId(c.id);
    };
    window.addEventListener(CLIP_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CLIP_OPEN_EVENT, onOpen);
  }, [onPage, clips]);
  const camLine = cam.phase === 'confirm' ? fill(tp.camConfirm, { code: cam.code })
    : cam.phase === 'reconnecting' ? tp.camReconnecting
    : cam.phase === 'ready' && cam.status && !isPreRecording(cam.status) && !isRecording(cam.status) ? tp.camNoPrerec
    : cam.phase === 'ready' ? (cam.status && cam.status.battery >= 0
      ? fill(tp.camReady, { name: cam.name, bat: cam.status.battery, left: leftLabel(cam.status.remainSeconds) })
      : fill(tp.camReadyShort, { name: cam.name }))
    : '';
  if (!camLine && !onPage.length) return null;

  const attach = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (!files.length || !waiting.length) return;
    const map = matchClipFiles(waiting, files.map((f) => ({ name: f.name, lastModified: f.lastModified, size: f.size })));
    let k = 0;
    for (const c of waiting) {
      const i = map.get(c.clipId);
      if (i === undefined) continue;
      const f = files[i];
      try {
        // A copy, not the File: the card is taken out after this.
        const type = playableType(f);
        const blob = new Blob([await f.arrayBuffer()], { type });
        await putClip({ ...c, file: { name: f.name, type, size: f.size, blob } });
        k += 1;
      } catch { /* this one stays waiting */ }
    }
    if (k) toast.success(fill(tp.clipsAttached, { k, m: waiting.length }));
    else toast.error(tp.clipsAttachedNone);
  };
  const pickFiles = () => fileRef.current?.click();

  return (
    <div className="px-3 py-1.5 border-b border-stone-100 flex flex-wrap items-center gap-1.5 text-xs" data-testid="clip-strip">
      {camLine && (
        <span className="inline-flex items-center gap-1 text-stone-600" data-testid="cam-state">
          {cam.phase === 'ready' ? <Video size={12} className="shrink-0 text-stone-500" /> : <LoaderCircle size={12} className="shrink-0 animate-spin" />}
          <span className={cn(cam.phase === 'confirm' && 'font-semibold text-stone-900', camLine === tp.camNoPrerec && 'font-medium text-amber-700')}>{camLine}</span>
          {cam.phase === 'ready' && cam.preSeconds > 0 && camLine !== tp.camNoPrerec && (
            <span className="text-stone-500" data-testid="cam-prerec">· {fill(tp.camPreRec, { s: cam.preSeconds })}</span>
          )}
          {cam.phase !== 'off' && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void disconnectCamera()}
              title={tp.camDisconnect}
              aria-label={tp.camDisconnect}
              className="ml-0.5 h-6 w-6 inline-flex items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
            >
              <Unplug size={12} />
            </button>
          )}
        </span>
      )}
      {onPage.map((c) => (
        <button
          key={c.id}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenId(c.id)}
          aria-label={c.file ? fill(tp.clipPlay, { n: c.n }) : `${clipLabel(tp, c)} · ${tp.clipNoFile}`}
          title={c.file ? undefined : tp.clipNoFile}
          data-testid="clip-chip"
          className={cn(
            'h-7 max-w-[16rem] px-2 inline-flex items-center gap-1 rounded-full border',
            c.file ? 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50' : 'border-dashed border-stone-300 text-stone-500 hover:bg-stone-50',
          )}
        >
          {c.file ? <Play size={11} className="shrink-0" /> : <Film size={11} className="shrink-0" />}
          <span className="truncate">{clipLabel(tp, c)}</span>
        </button>
      ))}
      {waiting.length > 0 && onPage.some((c) => !c.file) && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={pickFiles}
          title={DESKTOP_APP ? `${tp.clipsAttachTitle}. ${tp.clipsAutoHint}` : tp.clipsAttachTitle}
          data-testid="clips-attach"
          className="h-7 px-2 inline-flex items-center gap-1 rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-100"
        >
          <Upload size={11} className="shrink-0" />{tp.clipsAttach}
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="video/*,.mp4,.MP4,.lrf,.LRF,.mov,.MOV"
        className="hidden"
        data-testid="clips-file"
        onChange={(e) => { void attach(e.currentTarget.files); e.currentTarget.value = ''; }}
      />
      {open && <ClipDialog tp={tp} lang={lang} clip={open} onPickFiles={pickFiles} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** "Clip 3 · 22:05:49", or "Clip 3 · Pfiff zu spät" once it has a name. */
export const clipLabel = (tp: Strings, c: Clip): string =>
  fill(tp.clipChip, { n: c.n, time: c.title ? c.title : clockLabel(c.at, { seconds: true }) });

/** What a saved clip is called on the disk: the number, the day and time, the name. */
export function clipFileName(c: Clip): string {
  const d = new Date(c.at);
  const p = (x: number) => String(x).padStart(2, '0');
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${clockLabel(c.at, { seconds: true }).replace(/:/g, '.')}`;
  const name = (c.title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const ext = /\.mov$/i.test(c.file?.name || '') ? 'mov' : 'mp4';
  return `Clip ${c.n} ${when}${name ? ` - ${name}` : ''}.${ext}`;
}

function ClipDialog({ tp, lang, clip, onPickFiles, onClose }: { tp: Strings; lang: 'DE' | 'EN'; clip: Clip; onPickFiles: () => void; onClose: () => void }) {
  const blob = clip.file?.blob || null;
  const blobUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);
  // A file in the installed app's folder plays from there. The camera's
  // small copy (720p H.264) first when there is one: the original is 2.7K
  // 10-bit H.265 at 60 fps (the first card, 29.10.2026), a load on a laptop
  // decoding it in software, and more than a referee's position needs.
  // "Original" switches; a source that fails falls through to the other.
  const hasProxy = !!clip.file?.proxyPath;
  const [original, setOriginal] = useState(!hasProxy);
  // Last resort, when the webview will not stream from the folder at all:
  // the file read whole and played from memory.
  const [memoryUrl, setMemoryUrl] = useState('');
  useEffect(() => () => { if (memoryUrl) URL.revokeObjectURL(memoryUrl); }, [memoryUrl]);
  const [tried, setTried] = useState<string[]>([]);
  const path = clip.file?.path ? (original || !hasProxy ? clip.file.path : clip.file.proxyPath!) : '';
  const url = memoryUrl || (path ? clipFileUrl(path) : blobUrl);
  const onVideoError = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    // What the webview says, so a coach's "it does not play" is answerable.
    clientLog.warn('clips.play.fail', 'clip video does not play', {
      source: memoryUrl ? 'memory' : path ? (path === clip.file?.proxyPath ? 'proxy' : 'original') : 'blob',
      code: v.error?.code ?? null, message: (v.error?.message || '').slice(0, 200), network: v.networkState, ready: v.readyState,
      type: clip.file?.type || '', size: clip.file?.size || 0,
    });
    if (!clip.file?.path || memoryUrl) return;
    const next = [...tried, path];
    setTried(next);
    const other = path === clip.file.path ? clip.file.proxyPath : clip.file.path;
    if (other && !next.includes(other)) { setOriginal(other === clip.file.path); return; }
    void fetch(clipFileUrl(clip.file.proxyPath || clip.file.path))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => setMemoryUrl(URL.createObjectURL(new Blob([b], { type: 'video/mp4' }))))
      .catch((err) => clientLog.warn('clips.play.fail', 'clip video could not be read', { error: String(err).slice(0, 200) }));
  };
  // The first evening's clips showed their first frame and stopped, with no
  // error (30.10.2026). Two ways that happens, both handled here and both
  // logged: the webview refusing to start a video with sound by itself
  // (then it starts muted, the controls can turn the sound on), and the
  // stream from the folder stalling (then the file is read into memory,
  // which the small copy makes cheap, and played from there).
  const videoRef = useRef<HTMLVideoElement>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toMemory = (why: string) => {
    if (memoryUrl || !clip.file?.path) return;
    const from = path || clip.file.proxyPath || clip.file.path;
    clientLog.info('clips.play.memory', 'clip read into memory', { why, source: from === clip.file.proxyPath ? 'proxy' : 'original' });
    void fetch(clipFileUrl(from))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => setMemoryUrl(URL.createObjectURL(new Blob([b], { type: 'video/mp4' }))))
      .catch((err) => clientLog.warn('clips.play.fail', 'clip video could not be read', { error: String(err).slice(0, 200) }));
  };
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const say = (evt: string) => clientLog.info('clips.play', evt, {
      t: Math.round(v.currentTime * 100) / 100, d: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
      ready: v.readyState, network: v.networkState, paused: v.paused, muted: v.muted,
      source: memoryUrl ? 'memory' : path ? (path === clip.file?.proxyPath ? 'proxy' : 'original') : 'blob',
    });
    const clearStall = () => { if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null; } };
    const onStall = (evt: string) => () => {
      say(evt);
      if (v.ended || v.paused || stallTimer.current) return;
      stallTimer.current = setTimeout(() => { stallTimer.current = null; if (!v.ended && v.readyState < 3) toMemory(evt); }, 3_000);
    };
    const handlers: [string, () => void][] = [
      ['loadeddata', () => say('loadeddata')],
      ['playing', () => { clearStall(); say('playing'); }],
      ['pause', () => say('pause')],
      ['ended', () => { clearStall(); say('ended'); }],
      ['waiting', onStall('waiting')],
      ['stalled', onStall('stalled')],
    ];
    for (const [evt, fn] of handlers) v.addEventListener(evt, fn);
    // Started by hand of the code, so a refusal is seen and answered.
    v.play().catch((err: unknown) => {
      say(`play refused: ${(err as { name?: string })?.name || err}`);
      if ((err as { name?: string })?.name === 'NotAllowedError') { v.muted = true; void v.play().catch(() => undefined); }
    });
    return () => { clearStall(); for (const [evt, fn] of handlers) v.removeEventListener(evt, fn); };
    // The listeners belong to this source; `url` names it.
  }, [url]);
  const [title, setTitle] = useState(clip.title || '');
  // Escape closes the clip, not the whole notebook (App.tsx closes the sheet
  // on a window-level Escape; capture runs first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const saveTitle = () => {
    const next = title.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (next !== (clip.title || '')) void putClip({ ...clip, title: next }).catch(() => undefined);
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: fill(tp.clipDeleteTitle, { n: clip.n }), message: tp.clipDeleteMsg, tone: 'danger', confirmLabel: tp.clipDelete, lang }))) return;
    await deleteClips([clip.id]).catch(() => undefined);
    onClose();
  };
  const heading = fill(tp.clipChip, { n: clip.n, time: clockLabel(clip.at, { seconds: true }) });
  return (
    <div className="fixed inset-0 z-[80] bg-black/85 flex flex-col items-center justify-center p-3" role="dialog" aria-label={heading} data-testid="clip-player">
      <div className="w-full max-w-4xl flex items-center gap-2 text-white text-sm mb-2">
        <span className="shrink-0 font-medium">{heading}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          placeholder={tp.clipNamePlaceholder}
          aria-label={tp.clipName}
          maxLength={80}
          data-testid="clip-name"
          className="min-w-0 flex-1 h-9 rounded-lg bg-white/10 px-3 text-white placeholder:text-white/50 outline-none focus:bg-white/15"
        />
        <button type="button" onClick={() => { saveTitle(); onClose(); }} aria-label={tp.clipClose} className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg hover:bg-white/10">
          <X size={18} />
        </button>
      </div>
      {url ? (
        <video
          key={url}
          ref={videoRef}
          src={url}
          controls
          playsInline
          onError={onVideoError}
          className="w-full max-w-4xl max-h-[70vh] rounded-lg bg-black"
        />
      ) : (
        <div className="w-full max-w-4xl aspect-video max-h-[70vh] rounded-lg bg-white/5 flex flex-col items-center justify-center gap-3 text-white/80 text-sm">
          <Film size={28} className="opacity-60" />
          <span>{tp.clipNoFile}</span>
          <button type="button" onClick={onPickFiles} className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white">
            <Upload size={14} />{tp.clipsAttach}
          </button>
        </div>
      )}
      <div className="w-full max-w-4xl flex items-center justify-between gap-2 mt-2 text-sm">
        <span className="text-white/60 text-xs">{fill(tp.clipPre, { s: clip.seconds })}</span>
        <span className="flex items-center gap-2">
          {hasProxy && !memoryUrl && (
            <button
              type="button"
              onClick={() => { setTried([]); setOriginal((o) => !o); }}
              aria-pressed={original}
              title={tp.clipOriginalTitle}
              data-testid="clip-original"
              className={cn('h-9 px-3 inline-flex items-center rounded-lg text-white', original ? 'bg-white/30' : 'bg-white/10 hover:bg-white/20')}
            >
              {tp.clipOriginal}
            </button>
          )}
          {clip.file?.path ? (
            // The installed app: a copy in the Downloads folder (a webview's
            // download link goes nowhere there).
            <button
              type="button"
              onClick={() => {
                saveTitle();
                void saveClipFile(clip.clipId, clipFileName({ ...clip, title: title.trim() }))
                  .then((where) => toast.success(fill(tp.clipSavedTo, { path: where })), () => toast.error(tp.clipSaveFailed));
              }}
              data-testid="clip-download"
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white"
            >
              <Download size={14} />{tp.clipDownload}
            </button>
          ) : url && (
            <a
              href={url}
              download={clipFileName({ ...clip, title: title.trim() })}
              data-testid="clip-download"
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white"
            >
              <Download size={14} />{tp.clipDownload}
            </a>
          )}
          <button type="button" onClick={() => void remove()} data-testid="clip-delete" className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-red-500/40 text-white">
            <Trash2 size={14} />{tp.clipDelete}
          </button>
        </span>
      </div>
    </div>
  );
}
