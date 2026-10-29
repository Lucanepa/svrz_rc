// The notebook's camera: a button in the typed side's toolbar that connects an
// Osmo Action over Bluetooth and then records a clip, and a strip under the
// toolbar with the page's clips — each one plays once its video has been
// matched from the camera's card ("Videos zuordnen").
//
// The sheet owns the text: the button asks it to write the clip's line at the
// caret (`insertLine`), which also makes the page when it is not written yet,
// and gets the page's id back. Everything about the camera is in
// lib/osmoCamera.ts, everything about the clips in lib/clips.ts.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CircleDot, Film, LoaderCircle, Play, Unplug, Upload, Video, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { clockLabel } from '../lib/appTime';
import { fill, type PAD_STRINGS } from '../lib/notepadStrings';
import { IS_NATIVE } from '../lib/native';
import { OsmoError, bluetoothSupport, findNativeCamera, pickWebCamera, type OsmoErrorCode } from '../lib/osmoLink';
import { cameraState, connectCamera, disconnectCamera, recordClip, subscribeCamera } from '../lib/osmoCamera';
import {
  CLIP_SECONDS, clipLine, deleteClips, doomedClips, listClips, matchClipFiles, newClip, nextClipNumber, playableType, putClip, subscribeClips,
  type Clip,
} from '../lib/clips';
import { toast } from './ui';

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
};
function sayError(tp: Strings, e: unknown): void {
  const code: OsmoErrorCode = e instanceof OsmoError ? e.code : 'link';
  const key = ERROR_KEY[code];
  if (key) toast.error(tp[key]);
}

export const useCamera = () => useSyncExternalStore(subscribeCamera, cameraState, cameraState);
/** Whether this browser or app can drive a camera at all. */
export const cameraSupported = (): boolean => bluetoothSupport(IS_NATIVE) !== null;

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

/** Re-renders every quarter second while `on`: the countdown of a clip. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const BUTTON = 'h-8 px-2 inline-flex items-center gap-1 rounded-lg border text-xs font-medium transition-colors';

/** The toolbar button: Kamera → Verbinde … → Clip 10 s → Aufnahme · 7 s. */
export function CameraButton({ tp, ownerId, clips, insertLine }: {
  tp: Strings;
  ownerId: string;
  clips: Clip[];
  /** Writes the text `make` returns for the page on screen (null: a page not
   *  written yet) at the caret, making the page if need be, and returns the
   *  page's id, or null when nothing could be written. */
  insertLine: (make: (pageIdBefore: string | null) => string) => string | null;
}) {
  const cam = useCamera();
  const now = useTick(!!cam.clip);
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
      const done = await recordClip(CLIP_SECONDS, (startedAt) => {
        let n = 1;
        const pageId = insertLine((before) => {
          n = before ? nextClipNumber(clips, before) : 1;
          return `${clipLine(n, startedAt)} `;
        });
        if (!pageId) return;
        made = newClip(ownerId, pageId, n, startedAt, CLIP_SECONDS, cameraState().name);
        void putClip(made).catch(() => undefined);
      });
      const kept = made as Clip | null;
      if (kept) void putClip({ ...kept, stoppedAt: done.stoppedAt }).catch(() => undefined);
    } catch (e) {
      sayError(tp, e);
    }
  };

  if (cam.phase === 'ready') {
    const left = cam.clip ? Math.max(0, Math.ceil((cam.clip.startedAt + cam.clip.seconds * 1000 - now) / 1000)) : 0;
    return (
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!cam.clip) void clip(); }}
        disabled={!!cam.clip}
        title={fill(tp.camClipTitle, { s: CLIP_SECONDS })}
        data-testid="cam-clip"
        className={cn(BUTTON, cam.clip ? 'border-red-300 bg-red-50 text-red-700' : 'border-red-200 text-red-700 hover:bg-red-50')}
      >
        <CircleDot size={12} className={cn('shrink-0', cam.clip && 'animate-pulse')} />
        {cam.clip ? fill(tp.camRecording, { s: left }) : fill(tp.camClip, { s: CLIP_SECONDS })}
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
export function ClipStrip({ tp, pageId, clips }: { tp: Strings; pageId: string | null; clips: Clip[] }) {
  const cam = useCamera();
  const fileRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState<Clip | null>(null);
  const onPage = useMemo(() => (pageId ? clips.filter((c) => c.pageId === pageId) : []), [clips, pageId]);
  const waiting = useMemo(() => clips.filter((c) => !c.file), [clips]);
  const camLine = cam.phase === 'confirm' ? fill(tp.camConfirm, { code: cam.code })
    : cam.phase === 'reconnecting' ? tp.camReconnecting
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

  return (
    <div className="px-3 py-1.5 border-b border-stone-100 flex flex-wrap items-center gap-1.5 text-xs" data-testid="clip-strip">
      {camLine && (
        <span className="inline-flex items-center gap-1 text-stone-600" data-testid="cam-state">
          {cam.phase === 'ready' ? <Video size={12} className="shrink-0 text-stone-500" /> : <LoaderCircle size={12} className="shrink-0 animate-spin" />}
          <span className={cn(cam.phase === 'confirm' && 'font-semibold text-stone-900')}>{camLine}</span>
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
      {onPage.map((c) => {
        const label = fill(tp.clipChip, { n: c.n, time: clockLabel(c.startedAt, { seconds: true }) });
        return c.file ? (
          <button
            key={c.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPlaying(c)}
            aria-label={fill(tp.clipPlay, { n: c.n })}
            data-testid="clip-chip"
            className="h-7 px-2 inline-flex items-center gap-1 rounded-full border border-stone-300 bg-white text-stone-800 hover:bg-stone-50"
          >
            <Play size={11} className="shrink-0" />{label}
          </button>
        ) : (
          <span key={c.id} data-testid="clip-chip" title={tp.clipNoFile} className="h-7 px-2 inline-flex items-center gap-1 rounded-full border border-dashed border-stone-300 text-stone-500">
            <Film size={11} className="shrink-0" />{label}<span className="sr-only"> · {tp.clipNoFile}</span>
          </span>
        );
      })}
      {waiting.length > 0 && onPage.some((c) => !c.file) && (
        <>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            title={tp.clipsAttachTitle}
            data-testid="clips-attach"
            className="h-7 px-2 inline-flex items-center gap-1 rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-100"
          >
            <Upload size={11} className="shrink-0" />{tp.clipsAttach}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="video/*,.mp4,.MP4,.lrf,.LRF,.mov,.MOV"
            className="hidden"
            data-testid="clips-file"
            onChange={(e) => { void attach(e.currentTarget.files); e.currentTarget.value = ''; }}
          />
        </>
      )}
      {onPage.length > 0 && <span className="basis-full text-[11px] text-stone-400">{tp.clipsDeviceOnly}</span>}
      {playing && <ClipPlayer tp={tp} clip={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function ClipPlayer({ tp, clip, onClose }: { tp: Strings; clip: Clip; onClose: () => void }) {
  const url = useMemo(() => (clip.file ? URL.createObjectURL(clip.file.blob) : ''), [clip]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  // Escape closes the video, not the whole notebook (App.tsx closes the sheet
  // on a window-level Escape; capture runs first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] bg-black/85 flex flex-col items-center justify-center p-3" role="dialog" aria-label={fill(tp.clipChip, { n: clip.n, time: clockLabel(clip.startedAt, { seconds: true }) })} data-testid="clip-player">
      <div className="w-full max-w-4xl flex items-center justify-between text-white text-sm mb-2">
        <span>{fill(tp.clipChip, { n: clip.n, time: clockLabel(clip.startedAt, { seconds: true }) })}</span>
        <button type="button" onClick={onClose} aria-label={tp.clipClose} className="h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-white/10">
          <X size={18} />
        </button>
      </div>
      <video src={url} controls autoPlay playsInline className="w-full max-w-4xl max-h-[80vh] rounded-lg bg-black" />
    </div>
  );
}
