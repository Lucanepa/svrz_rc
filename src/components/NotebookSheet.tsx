// The Notizblock sheet: the coach's pages, newest on top, one on screen at a
// time. A page has two sides, and a switch at the top of it says which one is
// on screen: Tippen (the rich editor, so iPadOS Scribble, Samsung's S Pen and
// Gboard write into it natively) or Handschrift (InkPad). One "Neue Seite"
// opens a page on the side last used on this device; the "+ Text" / "+ Stift"
// pair it replaced made a coach choose a kind of page before writing anything
// (Jennifer, 23.10.2026). On the observation form the footer also offers
// "Übernehmen…", the only way a page ever reaches the report — its typed side,
// never the handwriting.
//
// The switch is a VIEW (25.10.2026): it changes what the sheet shows and
// nothing else — no new version, no "Bearbeitet", no fetch of its own. The
// side on screen is kept per page while the sheet is open (`sideView`); the
// page's `kind` is the side last WRITTEN, set by the write itself (the first
// stroke, the first letter), and is the side a page opens on — here, on
// another device, and in the installed apps, which show that side only.
//
// Rendering and state come from notebookSync: this component never touches
// IndexedDB or the network itself. A page that does not exist yet (the empty
// notebook, or "Neue Seite") is VIRTUAL until its first keystroke or stroke,
// so opening and closing the sheet never syncs an empty row.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { BrushCleaning, ChevronLeft, ChevronRight, Clock, Eraser, FileIcon, Hand, Keyboard, LayoutTemplate, Maximize2, Minimize2, MoveHorizontal, NotebookPen, PenLine, Plus, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '../lib/utils';
import { clockLabel, dayLabel, dayTimeLabel } from '../lib/appTime';
import { PAD_STRINGS, fill, type PadLang } from '../lib/notepadStrings';
import {
  NOTEBOOK_MAX_PAGES, NOTEBOOK_MAX_TITLE_LEN, NOTEBOOK_INK_DEBOUNCE_MS, NOTEBOOK_TTL_MS, inkPoints, kindAfterWrite, makePage, pageExpiresAt, sidesKnown,
  type InkPage, type InkStroke, type NotebookPage, type PadField, type PageBackground, type PageKind,
} from '../lib/notebook';
import * as notebookSync from '../lib/notebookSync';
import type { PadSyncStatus } from '../lib/notebookSync';
import { importBlock, pageBlock } from '../lib/notebookImport';
import { richToPlain } from '../lib/richText';
import { lineTimes, withLineTimes } from '../lib/notebookTimes';
import { RichSurface, RichToolbar, appendBullet, appendCheck, appendNumbered, caretOffsets } from './RichText';
import { confirmDialog, toast } from './ui';
import AppSpinner from './AppSpinner';
import StaleBuildNotice from './StaleBuildNotice';
import NoteTimes from './NoteTimes';
import { CameraButton, ClipStrip, cameraSupported, clipLabel, openClipByNumber, useCameraOn, useClips } from './NotebookClips';
import { CLIP_LINE_RE, clipLine, type Clip } from '../lib/clips';
import { importFresh } from '../lib/freshImport';
import { PEN_TRAILING_MS } from '../lib/inkInput';
import { WHOLE_PAGE_SNAP } from '../lib/inkView';
import type { InkPadControl, InkTool, InkViewState, InkZoom } from './InkPad';

// perfect-freehand and the canvas code load the first time a coach opens a
// pen page, never for one who only types.
const InkPad = lazy(() => importFresh(() => import('./InkPad')).catch((error: unknown) => ({
  // A stale build cannot draw the pad; the notice takes its place in the sheet.
  default: () => <StaleBuildNotice inline message={error instanceof Error ? error.message : String(error)} />,
})));

export type InsertContext = {
  role: '1. SR' | '2. SR';
  gameId: string;
  label: string;
  name: string;
  onInsert: (field: PadField, pages: NotebookPage[]) => void;
};

export type NotebookSheetProps = {
  lang: PadLang;
  ownerId: string;
  pages: NotebookPage[];
  status: PadSyncStatus;
  insert: InsertContext | null;
  /** A filed observation is on screen: say why nothing can be inserted. */
  reviewOnly: boolean;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
};

const FINGER_KEY = 'svrz_ink_finger';
/** The page the sheet was last closed on, per owner: a shared laptop must not
 *  reopen one coach's notebook on another's page. */
const LAST_PAGE_KEY = 'svrz_pad_last_page';
const PEN_SEEN_KEY = 'svrz_ink_pen_seen';
/** The side the last page was switched to on this device, which a new page
 *  opens on: a coach who writes with the Pencil should not switch every page. */
const SIDE_KEY = 'svrz_pad_side';
/** The time column beside a text page: on unless this device turned it off. */
const TIMES_KEY = 'svrz_pad_times';
/** The pen page's zoom level on this device (relative to fit-width), like
 *  svrz_pad_full: a coach who writes zoomed in should not pinch on every new
 *  page. The level, never the position — each page opens at its top. */
const ZOOM_KEY = 'svrz_ink_zoom';
/** A click this soon after a touch went down or up on its button is that
 *  touch's click (iOS sends it within a few hundred ms of the lift). */
const TAP_CLICK_MS = 1000;

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode — this session only */ }
}

const FIELD_KEYS: PadField[] = ['bemerkungen', 'highlights', 'improvements', 'goals', 'tips'];

/** The side a new page opens on: the one last switched to here, else the
 *  handwriting where a pen has been seen, else typing. */
function initialSide(): PageKind {
  const pref = readPref(SIDE_KEY);
  if (pref === 'text' || pref === 'ink') return pref;
  return readPref(PEN_SEEN_KEY) === '1' ? 'ink' : 'text';
}

/** Whether a page's handwritten side carries strokes: the page counts some,
 *  or this device holds some the page's copy does not count yet — strokes
 *  drawn here offline under a newer copy from elsewhere are not hidden
 *  (review, 25.10.2026). The typed side is asked of `typedIds` in the sheet,
 *  worked out once per change of the pages. */
const hasInk = (p: NotebookPage): boolean => p.points > 0 || notebookSync.holdsStrokes(p.pageId);

/** A pen page with no strokes yet. One object, not one per render: the pad
 *  redraws when its page prop changes identity, and every commit makes a new
 *  page anyway ({ ...inkPage, strokes }), so this one is never written to. */
const EMPTY_INK: InkPage = { w: 1000, h: 1414, strokes: [] };

export default function NotebookSheet({ lang, ownerId, pages, status, insert, reviewOnly, full, onToggleFull, onClose }: NotebookSheetProps) {
  const tp = PAD_STRINGS[lang] || PAD_STRINGS.DE;
  const de = lang === 'DE';
  const [mode, setMode] = useState<'pages' | 'import'>('pages');
  // Closing the sheet is not leaving the page: a coach who looks something up
  // mid-observation comes back to the page they were writing on, not to the
  // newest one. Only if it is still there — a week passes, and pages go.
  const lastPageKey = `${LAST_PAGE_KEY}:${ownerId}`;
  const rememberedPage = (list: NotebookPage[]): string => {
    const id = readPref(lastPageKey) || '';
    return id && list.some((p) => p.pageId === id) ? id : '';
  };
  const [currentId, setCurrentId] = useState<string>(() => rememberedPage(pages) || (pages[0] ? pages[0].pageId : ''));
  useEffect(() => { if (currentId) writePref(lastPageKey, currentId); }, [currentId, lastPageKey]);
  const [sectionMenu, setSectionMenu] = useState(false);
  /** "@" typed on the typed side: the coach's clips to mention, newest first. */
  const [mentionMenu, setMentionMenu] = useState(false);
  const [virtual, setVirtual] = useState<{ kind: PageKind; bg: PageBackground } | null>(null);
  const [sideDefault, setSideDefault] = useState<PageKind>(initialSide);
  /** The side on screen, per page, while the sheet is open: a view, never
   *  written. A page not in it shows its kind — the side last written. */
  const [sideView, setSideView] = useState<Record<string, PageKind>>({});
  /** The strokes on screen, with the page they belong to: a page turned to
   *  never shows (or takes strokes onto) the page before's. `current`: known
   *  to be the page's latest (notebookSync.InkRead). */
  const [inkState, setInkState] = useState<{ pageId: string; page: InkPage; current: boolean } | null>(null);
  /** Bumped by "Erneut versuchen": the strokes are asked for again. */
  const [inkRetry, setInkRetry] = useState(0);
  const [tool, setTool] = useState<InkTool>({ kind: 'pen', colour: 0 });
  const [fingerDraws, setFingerDraws] = useState<boolean>(() => {
    const pref = readPref(FINGER_KEY);
    if (pref === '1') return true;
    if (pref === '0') return false;
    return readPref(PEN_SEEN_KEY) !== '1';
  });
  const [cancelled, setCancelled] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [field, setField] = useState<PadField>('bemerkungen');
  const [showUsed, setShowUsed] = useState(false);
  const [showTimes, setShowTimes] = useState<boolean>(() => readPref(TIMES_KEY) !== '0');
  const toggleTimes = () => { setShowTimes((v) => { writePref(TIMES_KEY, v ? '0' : '1'); return !v; }); };
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inkControl = useRef<InkPadControl | null>(null);
  /** The grey box the pen page fills: touches in it are the pad's. */
  const inkBoxRef = useRef<HTMLDivElement>(null);
  // A fresh pad, and with it a fresh view at the top of the page, for every
  // page the coach turns to. Not for the first stroke on a page not yet
  // written: that stroke MAKES the page, and the view she is writing in stays.
  const [viewKey, setViewKey] = useState(0);
  /** The pen's last contact as the palm guard below reads it. Kept here, not
   *  only in the pad: a page turn makes a new pad whose clock starts at 0, and
   *  a palm resting on Rückgängig while the other hand turned the page then
   *  undid a stroke on the page it landed on (final check, 24.10.2026). */
  const penClock = useRef(0);
  const lastPenAt = () => {
    penClock.current = Math.max(penClock.current, inkControl.current?.lastPenAt() ?? 0);
    return penClock.current;
  };
  /** Where each side was left, per page, when the other one took its place:
   *  the caret and the scroll of the typed side, the zoom and the place of
   *  the handwriting. A round trip between the sides of one page comes back
   *  to them; a page turn does not (a page opens at its top). The typed side
   *  went back to its first line, and what was typed next landed in front of
   *  the page ("XHallo Welt", UI review 25.10.2026). */
  const textViews = useRef(new Map<string, { scrollTop: number; caret: [number, number] | null }>());
  const inkViews = useRef(new Map<string, InkViewState>());
  /** The caret's last place in the typed side, kept as the selection moves: a
   *  tap on the switch may take the selection with it before the click. */
  const lastCaret = useRef<Range | null>(null);
  const turnPage = () => { lastPenAt(); textViews.current.clear(); inkViews.current.clear(); lastCaret.current = null; setViewKey((k) => k + 1); };
  /** A stroke still on the page goes onto it before anything turns the page
   *  or the side: a pen or a mouse on a button ends it on the way down, a key
   *  does not, and the stroke was lost (UI review, 25.10.2026). */
  const endStroke = () => { inkControl.current?.endStroke(); };
  const [inkZoom, setInkZoom] = useState<InkZoom | null>(null);
  const zoomLevel = useRef<number | null>(null);
  if (zoomLevel.current === null) {
    const stored = parseFloat(readPref(ZOOM_KEY) || '');
    zoomLevel.current = Number.isFinite(stored) && stored > 0 ? stored : 1;
  }
  /** The two-finger hint shows until this device has zoomed once, and only on
   *  a device with a touch screen: on a desktop it said nothing true, and it
   *  took the place of the line saying pen pages are not inserted. */
  const [zoomedOnce, setZoomedOnce] = useState(() => readPref(ZOOM_KEY) !== null);
  const [touchScreen] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches);

  const current = pages.find((p) => p.pageId === currentId) || null;
  /** The pages with typed text that would be inserted: one pass over the
   *  pages per change, not one per pill, switch and list row per render. */
  const typedIds = useMemo(() => new Set(pages.filter((p) => pageBlock(p)).map((p) => p.pageId)), [pages]);
  const hasTyped = (p: NotebookPage): boolean => typedIds.has(p.pageId);
  // Before the boot's first pull has answered, an empty list is only the
  // local cache — empty on a wiped device or a new sign-in. A blank writable
  // "Seite 1 von 1" in that window committed a new page next to the real
  // ones, so the page area waits. A page the coach asked for still shows.
  const pagesPending = !status.loaded && pages.length === 0 && !virtual;
  const showVirtual = !!virtual || (pages.length === 0 && !current && !pagesPending);
  const virtualKind: PageKind = virtual ? virtual.kind : sideDefault;
  const virtualBg: PageBackground = virtual ? virtual.bg : '';
  /** The side on screen: the one switched to on this page while the sheet is
   *  open, else the page's kind. A page not yet written follows the switch. */
  const side: PageKind = current ? (sideView[current.pageId] || current.kind) : virtualKind;
  const activeBg: PageBackground = current ? current.bg : virtualBg;
  /** The typed side of a record the frontend before wrote, while the server's
   *  copy of it has not come in: it kept '' for the text of a pen page,
   *  whatever the server held, and an empty page offered to type on would put
   *  the coach's next words over the ones she cannot see. */
  const typedUnknown = !!current && current.kind === 'ink' && !sidesKnown(current);

  // The strokes on screen, and whether they may be written on. Only the
  // current page's: a state left by the page before is not this page's.
  const inkFor = current && inkState && inkState.pageId === current.pageId ? inkState : null;
  const inkStaleNow = !!current && notebookSync.inkIsStale(current.pageId);
  /** Not read yet, and the read may go to the network: "wird geladen". A read
   *  from this device only is quick and shows a page that takes no stroke yet. */
  const inkWaiting = !!current && !inkFor && notebookSync.inkMayFetch(current.pageId);
  /** The strokes on screen are known to be the page's latest. Anything else
   *  is shown read-only: a stroke on strokes older than the server's pushed
   *  them over the newer ones (review, 25.10.2026). A page not yet written
   *  has nothing to be older than. */
  const inkWritable = !current || (!!inkFor && inkFor.current && !inkStaleNow);
  const inkFailed = !!inkFor && !inkFor.current;

  // The side a page comes on screen with is pinned there while the sheet is
  // open: its kind may change under it — a side written empty hands the page
  // to the other side, a pull brings another device's writing — and the side
  // on screen is the coach's choice, not the page's. The editor was swapped
  // for the pen page under her fingers when she deleted the last letter
  // (review, 25.10.2026).
  useEffect(() => {
    if (!current) return;
    const { pageId, kind } = current;
    setSideView((v) => (v[pageId] ? v : { ...v, [pageId]: kind }));
  }, [current?.pageId]);

  // A page that expired or was deleted while on screen: move to the newest.
  useEffect(() => {
    if (currentId && !pages.some((p) => p.pageId === currentId)) { setCurrentId(pages[0] ? pages[0].pageId : ''); turnPage(); }
    // Pages arrive after the first render (IndexedDB, then the server), so the
    // remembered one is looked for again here and not only in the initial state.
    if (!currentId && !virtual && pages[0]) { setCurrentId(rememberedPage(pages) || pages[0].pageId); turnPage(); }
  }, [pages, currentId, virtual]);

  // The writing hand rests on the sheet: on the toolbar right under the page,
  // on the page strip, by the header's buttons. iOS turns a short palm contact
  // into a click, and a click on Rückgängig took the last stroke away, one on
  // Finger turned finger drawing on. A touch's click is swallowed here, in the
  // capture phase, before any button sees it — the signature dialog's
  // failure, on the notebook (Jennifer, 23.10.2026) — when the pen was on the
  // glass at any time from PEN_TRAILING_MS before that touch went down until
  // the click. That one window holds the palm whose heel lands just before
  // the Pencil's tip (the usual order, InkPad's PALM_LEAD_MS is there for
  // it), the palm that lands mid-letter and lifts long after the pen did
  // (its click undid the letter, final review), and the hand right after the
  // pen; a flag taken at the touch's pointerdown missed the first (final
  // check, 24.10.2026). Only contact counts, never hover: a coach holding the
  // Pencil over the page still taps the toolbar with the other hand.
  //
  // Which pointer made a click is read from the touches themselves, by the
  // element they landed on. The click's own pointerType cannot be trusted:
  // iPadOS Safari 18.2 and later call a tap's click 'mouse' (WebKit bug
  // 282988), and before that it was a plain MouseEvent. Nor can "the last
  // pointerdown in the panel": the pen's next letter lands between the palm's
  // pointerdown and its click.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    /** The last few touches on the panel's controls, by pointer, in the order
     *  they were last seen: what they landed on, when they went down, and
     *  when they were last seen. */
    type Touch = { target: Node; downAt: number; at: number };
    const touched = new Map<number, Touch>();
    const seen = (id: number, t: Touch) => {
      touched.delete(id);
      touched.set(id, t);
      if (touched.size > 8) touched.delete(touched.keys().next().value as number);
    };
    // A touch on the pen page itself is the pad's, never a button's click:
    // kept here, the rest of a resting hand pushed the palm on Rückgängig out
    // of the list before it lifted (final check, 24.10.2026).
    const onControls = (e: PointerEvent): e is PointerEvent & { target: Node } =>
      e.pointerType === 'touch' && e.target instanceof Node && !inkBoxRef.current?.contains(e.target);
    const onTouchDown = (e: PointerEvent) => {
      // Any press may be the one that turns the page: read the pad's clock
      // while it is still this page's.
      lastPenAt();
      if (!onControls(e)) return;
      const now = performance.now();
      seen(e.pointerId, { target: e.target, downAt: now, at: now });
    };
    const onTouchUp = (e: PointerEvent) => {
      if (!onControls(e)) return;
      const now = performance.now();
      const down = touched.get(e.pointerId);
      seen(e.pointerId, down ? { ...down, at: now } : { target: e.target, downAt: now, at: now });
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      const now = performance.now();
      // The touch this click is from: the last one seen on the element the
      // click went to, or on one inside it.
      let tap: Touch | null = null;
      if (target) for (const t of touched.values()) if (now - t.at < TAP_CLICK_MS && target.contains(t.target)) tap = t;
      // None on that element: the touch may have landed in the gap beside the
      // button and had its click moved onto it, or been pushed out of the
      // list. The latest touch on the controls stands in for it.
      if (!tap) for (const t of touched.values()) if (now - t.at < TAP_CLICK_MS) tap = t;
      if (!tap && (e as PointerEvent).pointerType !== 'touch') return;
      const penAt = lastPenAt();
      if (!penAt || penAt < (tap ? tap.downAt : now) - PEN_TRAILING_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };
    panel.addEventListener('pointerdown', onTouchDown, true);
    panel.addEventListener('pointerup', onTouchUp, true);
    panel.addEventListener('click', onClick, true);
    return () => {
      panel.removeEventListener('pointerdown', onTouchDown, true);
      panel.removeEventListener('pointerup', onTouchUp, true);
      panel.removeEventListener('click', onClick, true);
    };
  }, []);

  // Escape peels this menu first. App.tsx keeps a window-level Escape handler
  // that closes the whole sheet, and losing the page you are writing on is a
  // lot to pay for a menu opened by mistake. Capture, so it runs before that
  // one — the ConfirmDialog does the same.
  useEffect(() => {
    if (!sectionMenu && !mentionMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSectionMenu(false);
      setMentionMenu(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sectionMenu, mentionMenu]);

  // Body scroll lock and focus restore, the ConfirmDialog way.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, []);

  // Warm the pen chunk while the coach is still typing.
  useEffect(() => { void import('./InkPad').catch(() => { /* warmed on the next open */ }); }, []);

  // The strokes of the page on screen, while its handwriting is: local first,
  // the server if newer. Until they are in, the page shows "wird geladen"
  // where the read may go to the network (inkWaiting) and a page that takes
  // no stroke where it does not — never the strokes of the page before, which
  // the next stroke then wrote onto this one (review, 25.10.2026).
  const inkVersion = current ? notebookSync.inkVersion(current.pageId) : 0;
  useEffect(() => {
    let alive = true;
    if (!current || side !== 'ink') return;
    const pageId = current.pageId;
    void notebookSync.getInk(pageId).then((read) => {
      if (!alive) return;
      setInkState({ pageId, page: read.page || EMPTY_INK, current: read.current });
    });
    return () => { alive = false; };
    // Keyed on the page id, its version and its strokes' generation: a pull
    // that brought newer strokes, or marked these older, reads them again.
  }, [current?.pageId, current?.updatedAt, side, inkVersion, inkRetry]);

  // The caret of the typed side, as it moves: where typing goes on after a
  // round trip to the handwriting.
  useEffect(() => {
    const onSelection = () => {
      const surface = surfaceRef.current?.querySelector('.rich-surface');
      const sel = window.getSelection();
      if (!surface || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (surface.contains(range.startContainer)) lastCaret.current = range.cloneRange();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  // Back on the typed side of the page it was left on: its scroll as it was.
  // The caret the surface puts back itself (initialCaret). The entry stays
  // until the side is left again or the page turns.
  useEffect(() => {
    if (side !== 'text' || typedUnknown) return;
    const saved = textViews.current.get(current ? current.pageId : '');
    if (saved && scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop;
  }, [side, current?.pageId, typedUnknown]);

  // ── text ────────────────────────────────────────────────────────────
  // The page the first keystroke on a fresh page just made, until it is on
  // screen. A multi-line insert fires one input event per line, all before the
  // next render, and each of them still saw `current` empty — a heading as the
  // first thing written made three pages, two of them blank (2026-10-13).
  const madePage = useRef<NotebookPage | null>(null);
  useEffect(() => { if (current || virtual) madePage.current = null; }, [current, virtual]);
  const handleText = (value: string) => {
    // Typing on after an "@" is an "@", not a mention.
    if (mentionMenu) setMentionMenu(false);
    const open = current || madePage.current;
    // Every change stamps the lines it made: kept whether or not the column is
    // on, so turning it back on shows the evening as it was written.
    if (open) {
      // Nothing changed: the surface reports its text on blur too, and a tap
      // on the switch is a blur. Committed, that was a new version, a
      // "Bearbeitet" and a push for a page only looked at.
      if (value === open.text) return;
      const extra = withLineTimes(open.text, open.extra, value, Date.now());
      // Written on the typed side: the page is a typed page now, unless that
      // side was just emptied while the handwriting holds something.
      const next = { ...open, text: value, kind: kindAfterWrite({ text: value, points: open.points }, 'text'), ...(extra ? { extra } : {}) };
      if (!extra) delete next.extra;
      if (open === madePage.current) madePage.current = next;
      notebookSync.commit(next);
      return;
    }
    if (!value) return;
    const page = makePage(ownerId, 'text', virtualBg);
    page.text = value;
    const extra = withLineTimes('', undefined, value, page.createdAt);
    if (extra) page.extra = extra;
    notebookSync.commit(page, undefined, 0);
    madePage.current = page;
    setVirtual(null);
    setCurrentId(page.pageId);
  };

  const handleTitle = (value: string) => {
    // One line: the strip draws this, and a pasted paragraph would break it.
    const title = value.replace(/[\r\n]+/g, ' ').slice(0, NOTEBOOK_MAX_TITLE_LEN);
    // The page the first letter just made, as for the text: a second event
    // before the next render must name that page, not make another.
    const open = current || madePage.current;
    if (open) {
      const next = { ...open, title };
      if (open === madePage.current) madePage.current = next;
      notebookSync.commit(next);
      return;
    }
    if (!title.trim()) return;
    const page = makePage(ownerId, virtualKind, virtualBg);
    page.title = title;
    notebookSync.commit(page, undefined, 0);
    madePage.current = page;
    setVirtual(null);
    setCurrentId(page.pageId);
  };

  const currentText = current ? current.text : '';
  const currentExtra = current ? current.extra : undefined;
  // The camera's clips, on this device only. Once the pages are known, a clip
  // whose page is gone goes too.
  const clips = useClips(ownerId, status.loaded ? pages.map((p) => p.pageId) : null);
  const [canBluetooth] = useState(cameraSupported);
  const canFilm = useCameraOn() && canBluetooth;
  const times = useMemo(() => lineTimes(currentText, currentExtra), [currentText, currentExtra]);
  /** The evening in the order it happens. A coach taking notes through a match
   *  writes the same handful of headings every time and writes them badly with
   *  a thumb; these are the headings, spelled the same way on every page, so a
   *  page read back a week later has a shape. */
  const sectionLabels = (): string[] => [
    tp.padSectionPre,
    tp.padSectionProtocol,
    ...[1, 2, 3, 4, 5].map((n) => fill(tp.padSectionSet, { n })),
    tp.padSectionBreak,
    tp.padSectionPost,
  ];
  /** A heading on its own line. Plain text, like the time stamp: it is carried
   *  into the form verbatim and has to read as a line there too. */
  const insertSection = (label: string) => {
    const line = `— ${label} —`;
    const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (surface && document.activeElement === surface) {
      document.execCommand('insertText', false, `\n${line}\n`);
      return;
    }
    const plain = richToPlain(currentText);
    handleText(currentText ? `${currentText.replace(/\s+$/, '')}${plain ? '\n' : ''}${line}\n` : `${line}\n`);
  };
  const insertTime = () => {
    const stamp = `${clockLabel(Date.now())} `;
    const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (surface && document.activeElement === surface) {
      // At the caret: execCommand keeps the selection and fires the surface's
      // own input event, which is what commits the page.
      document.execCommand('insertText', false, stamp);
      return;
    }
    const plain = richToPlain(currentText);
    handleText(currentText ? `${currentText.replace(/\s+$/, '')}${plain ? '\n' : ''}${stamp}` : stamp);
  };
  /** A clip's line, where the coach is writing — like the time stamp. `make`
   *  is given the page on screen (null: not written yet) so the clip can be
   *  numbered on it; the id returned is the page the line went onto, which
   *  the line itself made when there was none. */
  const insertLine = (make: (pageIdBefore: string | null) => string): string | null => {
    const before = (current || madePage.current)?.pageId ?? null;
    const text = make(before);
    const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (surface && document.activeElement === surface) {
      document.execCommand('insertText', false, text);
    } else {
      const plain = richToPlain(currentText);
      handleText(currentText ? `${currentText.replace(/\s+$/, '')}${plain ? '\n' : ''}${text}` : text);
    }
    return (current || madePage.current)?.pageId ?? null;
  };
  /** A clip line's colour in the page: blue once its video is on this device,
   *  grey while it waits (or when the clip is another device's). */
  const clipTone = useMemo(() => {
    const withVideo = new Set(clips.filter((c) => c.file).map((c) => c.n));
    return (text: string): string => {
      const m = CLIP_LINE_RE.exec(text);
      return m && withVideo.has(Number(m[1])) ? 'bg-sky-100 text-sky-800' : 'bg-stone-100 text-stone-600';
    };
  }, [clips]);
  /** A clip picked after "@": its line replaces the "@" at the caret. */
  const mentionClip = (c: Clip) => {
    setMentionMenu(false);
    const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (!surface || document.activeElement !== surface) return;
    document.execCommand('delete');
    document.execCommand('insertText', false, `${clipLine(c.n, c.at)} `);
  };
  const format = (command: string, value?: string) => {
    const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (surface && document.activeElement !== surface) surface.focus();
    // styleWithCSS off: the browser emits <b>/<i>/<font color> rather than
    // inline styles, which is closer to the stored subset — domToRich
    // normalises either way.
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, value);
  };

  // ── ink ─────────────────────────────────────────────────────────────
  const commitInk = (next: InkPage) => {
    const open = current || madePage.current;
    if (open) {
      // Never onto strokes not known to be current — asked of the engine as
      // well as of this render, since a pull may have marked them since.
      if ((current && !inkWritable) || notebookSync.inkIsStale(open.pageId)) return;
      const points = inkPoints(next);
      // Written on the handwriting: a pen page now, unless the strokes were
      // just all taken away while the typed side holds something.
      const page = { ...open, points, kind: kindAfterWrite({ text: open.text, points }, 'ink') };
      if (open === madePage.current) madePage.current = page;
      notebookSync.commit(page, next, NOTEBOOK_INK_DEBOUNCE_MS);
      setInkState({ pageId: open.pageId, page: next, current: true });
      return;
    }
    const page = makePage(ownerId, 'ink', virtualBg);
    page.points = inkPoints(next);
    notebookSync.commit(page, next, 0);
    madePage.current = page;
    setVirtual(null);
    setCurrentId(page.pageId);
    setInkState({ pageId: page.pageId, page: next, current: true });
  };
  const inkPage: InkPage = current && inkFor ? inkFor.page : EMPTY_INK;
  const zoomPct = `${Math.round((inkZoom ? inkZoom.z : 1) * 100)} %`;
  // The level button switches between the page width (100 %) and the whole
  // page: to the whole page from any other view, back to the width from
  // there. It showed '100 %' and made the page smaller, and a second tap did
  // nothing (final review, 24.10.2026). Where the whole page fits at its
  // width (a phone held upright, in fullscreen), or is within
  // WHOLE_PAGE_SNAP of it, the two are one view: the view snaps the width
  // down to the whole page there, and the button was on but did nothing
  // (390 × 810 in fullscreen, final check). The test is the snap's own, 1
  // against the whole page (lib/inkView.ts clampZoom). On that one view the
  // button is off. Zoomed in, it brings the page back to it in one tap, as
  // it did before it switched between two views: it had stayed off there,
  // still naming the whole page (final check).
  const zoomOneView = !!inkZoom && 1 - inkZoom.min <= WHOLE_PAGE_SNAP;
  const zoomAtWhole = !!inkZoom && inkZoom.z <= inkZoom.min + 0.001;
  const zoomToWidth = zoomAtWhole || zoomOneView;
  const zoomLevelOff = !inkZoom || (zoomOneView && inkZoom.z <= 1 + 0.001);
  const zoomAction = zoomToWidth ? tp.padZoomWidth : tp.padZoomFit;
  const onStrokeEnd = (stroke: InkStroke) => commitInk({ ...inkPage, strokes: [...inkPage.strokes, stroke] });
  const onErase = (strokes: InkStroke[]) => {
    const gone = new Set(strokes);
    const kept = inkPage.strokes.filter((s) => !gone.has(s));
    if (kept.length !== inkPage.strokes.length) commitInk({ ...inkPage, strokes: kept });
  };
  const undo = () => { if (inkPage.strokes.length) commitInk({ ...inkPage, strokes: inkPage.strokes.slice(0, -1) }); };
  // The strokes only: what was typed on the page stays — and the question
  // says so only where something was typed.
  const clearInk = async () => {
    if (inkPage.strokes.length === 0 || !inkWritable) return;
    const message = current && hasTyped(current) ? tp.padClearInkMsg : tp.padClearInkMsgNoText;
    if (inkPage.strokes.length > 3 && !(await confirmDialog({ title: tp.padClearInkTitle, message, tone: 'danger', lang }))) return;
    commitInk({ ...inkPage, strokes: [] });
  };
  const onPenSeen = () => {
    if (readPref(PEN_SEEN_KEY) === '1') return;
    writePref(PEN_SEEN_KEY, '1');
    if (readPref(FINGER_KEY) === null) { setFingerDraws(false); toast.info(tp.padPenSeen, { lang }); }
  };
  const toggleFinger = () => { setFingerDraws((v) => { writePref(FINGER_KEY, v ? '0' : '1'); return !v; }); };
  const onZoomChange = (zoom: InkZoom, byUser: boolean) => {
    setInkZoom(zoom);
    if (!byUser) return;
    zoomLevel.current = zoom.z;
    // Four places, not two: the whole page rounded up to 0.68 reopened a page
    // 2.6 px too tall to fit (lib/inkView.ts snaps what is left).
    writePref(ZOOM_KEY, zoom.z.toFixed(4));
    setZoomedOnce(true);
  };

  // ── pages ───────────────────────────────────────────────────────────
  const newPage = () => {
    if (pages.length >= NOTEBOOK_MAX_PAGES) { toast.error(tp.padPagesFull, { lang }); return; }
    endStroke();
    setVirtual({ kind: sideDefault, bg: '' });
    setCurrentId('');
    turnPage();
  };
  // A VIEW: the side on screen changes, and nothing is written — no version,
  // no "Bearbeitet", no push, no fetch of its own (25.10.2026; for a day it
  // was an edit of the page's kind). The page's kind follows the writing.
  // Either side keeps what is on it, and where it was left on this page.
  const switchSide = (kind: PageKind) => {
    if (kind === side) return;
    // A stroke still on the page goes onto it first; on a page not yet
    // written, that stroke makes the page.
    endStroke();
    lastPenAt();
    writePref(SIDE_KEY, kind);
    setSideDefault(kind);
    setSectionMenu(false);
    const open = current || madePage.current;
    const key = open ? open.pageId : '';
    if (side === 'ink') {
      const view = inkControl.current?.viewState();
      if (view) inkViews.current.set(key, view);
    } else {
      const surface = surfaceRef.current?.querySelector('.rich-surface') as HTMLElement | null;
      const range = lastCaret.current;
      textViews.current.set(key, {
        scrollTop: scrollRef.current ? scrollRef.current.scrollTop : 0,
        caret: surface && range ? caretOffsets(surface, range) : null,
      });
    }
    if (open) setSideView((v) => ({ ...v, [open.pageId]: kind }));
    else setVirtual({ kind, bg: virtualBg });
  };
  // The court outline under a pen page: a toggle, so a coach who started
  // sketching can still put the lines under what is already there. It is
  // the handwriting's: the page becomes a pen page where nothing typed says
  // otherwise.
  const toggleCourt = () => {
    const next: PageBackground = activeBg === 'court' ? '' : 'court';
    if (current) {
      if (!inkWritable) return;
      notebookSync.commit({ ...current, bg: next, kind: kindAfterWrite(current, 'ink') }, undefined, 0);
    } else if (virtual) setVirtual({ ...virtual, bg: next });
  };
  const deletePage = async () => {
    if (!current) { setVirtual(null); turnPage(); return; }
    if (!(await confirmDialog({ title: tp.padDeleteTitle, message: tp.padDeleteMsg, tone: 'danger', lang }))) return;
    const idx = pages.findIndex((p) => p.pageId === current.pageId);
    const next = pages[idx + 1] || pages[idx - 1] || null;
    notebookSync.deletePage(current.pageId);
    setCurrentId(next ? next.pageId : '');
    turnPage();
  };

  // ── import ──────────────────────────────────────────────────────────
  // A page is offered by its typed side, whichever side it shows; a page with
  // handwriting only is listed greyed, to say why it cannot go in.
  const textPages = pages.filter(hasTyped);
  const usedHere = (p: NotebookPage) => !!insert && p.usedIn.some((u) => u.f === field && u.r === insert.role && u.g === insert.gameId);
  const importList = pages.filter((p) => (hasTyped(p) ? showUsed || !usedHere(p) : hasInk(p)));
  const openImport = () => {
    if (!insert) return;
    // The page on screen is pre-ticked — unless it already went into this
    // field, in which case it is hidden and the newest unused one is offered.
    const candidates = textPages.filter((p) => !usedHere(p));
    const first = current && hasTyped(current) && !usedHere(current) ? current.pageId : (candidates[0] ? candidates[0].pageId : '');
    setSelected(new Set(first ? [first] : []));
    setShowUsed(false);
    setMode('import');
  };
  // Only what is on the list can be chosen: a hidden (used) page stays out of
  // the preview and the count until the coach asks to see it.
  const chosen = textPages.filter((p) => selected.has(p.pageId) && (showUsed || !usedHere(p)));
  const fieldLabel = (f: PadField) => ({
    bemerkungen: tp.padInsertRemarks, highlights: tp.padInsertHighlights, improvements: tp.padInsertImprovements, goals: tp.padInsertGoals, tips: tp.padInsertTips,
  })[f];
  const doInsert = async () => {
    if (!insert || chosen.length === 0) return;
    const again = chosen.filter(usedHere);
    if (again.length && !(await confirmDialog({ title: tp.padInsertAgainTitle, message: fill(tp.padInsertAgainMsg, { field: fieldLabel(field) }), lang }))) return;
    insert.onInsert(field, chosen);
    setMode('pages');
  };

  // ── status line ─────────────────────────────────────────────────────
  const statusText = (() => {
    const parts: string[] = [];
    if (status.local === 'saving') parts.push(tp.padSaving);
    else if (status.local === 'failed') parts.push(tp.padSaveFailed);
    else if (status.local === 'saved' && status.at) parts.push(`${tp.padSaved} · ${clockLabel(status.at)}`);
    if (status.serverOnly) parts.push(tp.padServerOnly);
    else if (status.server === 'synced' && status.dirty === 0) parts.push(tp.padSynced);
    else if (status.server === 'pending' || status.server === 'offline') parts.push(tp.padSyncPending);
    else if (status.server === 'failed') parts.push(status.message ? `${tp.padSyncFailed}: ${status.message}` : tp.padSyncFailed);
    return parts.join(' · ');
  })();
  const statusTone = status.local === 'failed' || status.server === 'failed' ? 'text-red-700' : status.serverOnly || status.server === 'pending' || status.server === 'offline' ? 'text-amber-700' : 'text-stone-500';

  const expiryLine = (p: NotebookPage) => {
    const at = pageExpiresAt(p);
    const soon = at - Date.now() < NOTEBOOK_TTL_MS / 7;
    return { text: soon ? tp.padExpiresSoon : fill(tp.padExpires, { date: dayLabel(at) }), soon };
  };

  /** What a pill shows of a page: an icon per side that carries something,
   *  or the side it shows while neither does. */
  const sideIcons = (p: NotebookPage) => {
    const typed = hasTyped(p);
    const inked = hasInk(p);
    return (
      <>
        {(typed || (!inked && p.kind === 'text')) && <Keyboard size={12} className="shrink-0" data-side="text" />}
        {(inked || (!typed && p.kind === 'ink')) && <PenLine size={12} className="shrink-0" data-side="ink" />}
      </>
    );
  };

  const pill = (p: NotebookPage) => (
    <button
      key={p.pageId}
      type="button"
      onClick={() => { endStroke(); setVirtual(null); setCurrentId(p.pageId); setMode('pages'); turnPage(); }}
      aria-current={current && current.pageId === p.pageId ? 'page' : undefined}
      title={p.updatedAt - p.createdAt > 60_000
        ? `${fill(tp.padCreated, { date: dayTimeLabel(p.createdAt) })} · ${fill(tp.padEdited, { time: clockLabel(p.updatedAt) })}`
        : fill(tp.padCreated, { date: dayTimeLabel(p.createdAt) })}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border text-[11px] font-medium transition-colors',
        current && current.pageId === p.pageId && !virtual ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-600 border-stone-300 hover:bg-stone-50',
      )}
    >
      {sideIcons(p)}
      {/* A named page is found by its name; the time stays beside it, quieter,
          because two pages from one evening are still told apart by it. */}
      {p.title && <span className="max-w-[7rem] truncate">{p.title}</span>}
      <span className={cn(
        'tabular-nums',
        p.title && (current && current.pageId === p.pageId && !virtual ? 'text-white/60' : 'text-stone-400'),
      )}>{clockLabel(p.createdAt)}</span>
      {p.usedIn.length > 0 && <span className="text-emerald-500">✓</span>}
    </button>
  );

  // Pages run newest first, like the strip: ‹ is the newer page, › the older.
  // The page not yet written sits in front of the others and counts as one.
  const currentIndex = current ? pages.findIndex((p) => p.pageId === current.pageId) : -1;
  const onVirtual = !current && showVirtual;
  const total = pages.length + (onVirtual ? 1 : 0);
  const position = onVirtual ? 1 : currentIndex + 1;
  const goTo = (index: number) => {
    const target = pages[index];
    if (!target) return;
    endStroke();
    setVirtual(null);
    setCurrentId(target.pageId);
    turnPage();
  };
  const pageNav = total > 0 && (
    <div className="flex items-center gap-1 shrink-0" role="group">
      <button type="button" onClick={() => goTo(currentIndex - 1)} disabled={onVirtual || currentIndex <= 0} aria-label={tp.padPrevPage} title={tp.padPrevPage} className="h-7 w-7 inline-flex items-center justify-center rounded border border-stone-300 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40">
        <ChevronLeft size={14} />
      </button>
      <span className="text-[11px] text-stone-600 tabular-nums min-w-[5.5rem] text-center">{fill(tp.padPageOf, { n: position, m: total })}</span>
      <button type="button" onClick={() => goTo(onVirtual ? 0 : currentIndex + 1)} disabled={position >= total} aria-label={tp.padNextPage} title={tp.padNextPage} className="h-7 w-7 inline-flex items-center justify-center rounded border border-stone-300 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40">
        <ChevronRight size={14} />
      </button>
    </div>
  );

  // Tippen | Handschrift, at the start of the page's own line in either mode,
  // so the way back is where the way there was. A dot on the side NOT shown
  // says something is written there — said in words too, for whoever does
  // not see the dot (its title was the only word for it). A neutral dot: red
  // read as an error. 36 px tall, and 40 under a finger where the screen is
  // tall enough to spare it (a tablet): at 28 the segments were the smallest
  // target on the sheet (UI review, 25.10.2026). On a phone the 40 cost the
  // page its one view in fullscreen, the whole page at its width. The ring
  // is drawn inside the segment, where the group's rounded clip cannot cut it.
  const sideButton = (which: PageKind) => {
    const on = side === which;
    const filled = !on && !!current && (which === 'text' ? hasTyped(current) : hasInk(current));
    const label = which === 'text' ? tp.padSideText : tp.padSideInk;
    return (
      <button
        type="button"
        onClick={() => switchSide(which)}
        aria-pressed={on}
        title={filled ? (which === 'text' ? tp.padSideHasText : tp.padSideHasInk) : label}
        data-testid={which === 'text' ? 'pad-side-text' : 'pad-side-ink'}
        className={cn(
          'relative h-9 [@media(pointer:coarse)_and_(min-height:56rem)]:h-10 px-2 inline-flex items-center gap-1 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400',
          on ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-50',
        )}
      >
        {which === 'text' ? <Keyboard size={13} className="shrink-0" aria-hidden="true" /> : <PenLine size={13} className="shrink-0" aria-hidden="true" />}
        <span>{label}</span>
        {filled && (
          <>
            <span className="sr-only"> — {tp.padSideFilled}</span>
            <span data-testid="pad-side-dot" aria-hidden="true" className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-stone-500" />
          </>
        )}
      </button>
    );
  };
  const sideSwitch = (
    <div role="group" aria-label={tp.padSide} className="shrink-0 inline-flex rounded-lg border border-stone-300 bg-white overflow-hidden">
      {sideButton('text')}
      {sideButton('ink')}
    </div>
  );

  const wrapper = full
    ? 'no-print fixed inset-0 z-50 bg-white flex'
    : 'no-print fixed inset-0 z-50 bg-stone-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4';
  // 3xl, not 2xl: wide enough for the whole toolbar, Zeit included, on one row.
  const panel = full
    ? 'bg-white w-full h-full max-w-none rounded-none shadow-none flex flex-col'
    : 'bg-white w-full sm:max-w-3xl h-[92dvh] sm:h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col';

  return (
    <div
      className={wrapper}
      // Only a real mouse press closes the sheet from out here. iOS makes a
      // click of a palm or a stray finger beside the panel too, and in
      // landscape the hand rests on 200 px of backdrop either side of it.
      onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget && e.pointerType === 'mouse'; }}
      onClick={(e) => { if (!full && e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={tp.padTitle} data-full={full ? 'true' : 'false'} className={panel}>
        {/* header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200">
          <NotebookPen size={18} className="shrink-0 text-stone-700" />
          {/* The page's own name, where the panel's name used to be: the icon
              and the dialog's own label already say what this is, and a row of
              its own is height a phone cannot spare (it pushes the page turner
              out from under the thumb). Nothing to name before there is a page,
              and never in the import view, which is not about one page. */}
          {mode !== 'import' && (current || showVirtual) ? (
            <input
              type="text"
              // `|| ''`, never `current.title`: one undefined — a page stored
              // before this field existed — makes React let go of the input,
              // and it goes on showing the title of the page before it. Not
              // keyed by the page: the first letter on a new page MAKES the
              // page, the key changed under the caret, and the field was
              // swapped for a fresh one without focus (2026-10-17).
              value={(current && current.title) || ''}
              onChange={(e) => handleTitle(e.target.value)}
              maxLength={NOTEBOOK_MAX_TITLE_LEN}
              placeholder={tp.padTitlePlaceholder}
              aria-label={tp.padTitlePlaceholder}
              data-testid="pad-title"
              data-log-redact
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-stone-800 outline-none placeholder:font-normal placeholder:text-stone-400"
            />
          ) : (
            <h3 className="text-sm font-semibold text-stone-800 truncate">{mode === 'import' ? tp.padInsertTitle : tp.padTitle}</h3>
          )}
          {insert && mode === 'import' && <span className="text-xs text-stone-500 truncate hidden sm:inline">· {insert.label}</span>}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={onToggleFull} aria-pressed={full} aria-label={full ? tp.padFullExit : tp.padFull} title={full ? tp.padFullExit : tp.padFull} className="p-1.5 rounded text-stone-500 hover:bg-stone-100 hover:text-stone-800">
              {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded text-stone-500 hover:bg-stone-100 hover:text-stone-800" aria-label={tp.padClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        {mode === 'import' && insert ? (
          <>
            <p className="px-4 py-2 text-xs text-stone-600 bg-stone-50 border-b border-stone-200">{fill(tp.padInsertFor, { role: insert.role, name: insert.name })}</p>
            <div className="px-4 py-2 border-b border-stone-100 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase text-stone-500">{tp.padInsertTarget}</span>
              <div className="flex flex-wrap rounded-lg border border-stone-300 bg-white shadow-sm overflow-hidden" role="group" aria-label={tp.padInsertTarget}>
                {FIELD_KEYS.map((f) => (
                  <button key={f} type="button" onClick={() => setField(f)} className={cn('px-3 h-9 text-xs font-medium transition-colors', field === f ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-50')}>
                    {fieldLabel(f)}
                  </button>
                ))}
              </div>
              <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-stone-500">
                <input type="checkbox" checked={showUsed} onChange={(e) => setShowUsed(e.target.checked)} /> {tp.padShowUsed}
              </label>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-2" data-log-redact>
              {importList.length === 0 && <p className="text-sm text-stone-500 py-6 text-center">{tp.padEmpty}</p>}
              <ul className="space-y-1.5">
                {importList.map((p) => {
                  const isInk = !hasTyped(p);
                  const used = usedHere(p);
                  return (
                    <li key={p.pageId} className={cn('rounded-lg border px-3 py-2 text-sm', isInk ? 'border-stone-200 bg-stone-50 text-stone-400' : selected.has(p.pageId) ? 'border-slate-900 bg-white' : 'border-stone-200 bg-white')}>
                      <label className="flex items-start gap-2 cursor-pointer">
                        {isInk
                          ? <span className="mt-0.5 inline-block w-4 h-4 rounded-full border border-stone-300" aria-hidden="true" />
                          : <input type="checkbox" className="mt-1" checked={selected.has(p.pageId)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p.pageId); else n.delete(p.pageId); return n; })} />}
                        <span className="min-w-0 flex-1">
                          {/* Named pages are picked by name here too — the
                              preview under it is three lines of the middle of
                              a page, which is not what a coach remembers it by. */}
                          {p.title && <span className="block text-xs font-semibold text-stone-800 truncate">{p.title}</span>}
                          <span className="block text-[10.5px] text-stone-500">{dayTimeLabel(p.createdAt)}{used ? ` · ${tp.padUsedIn.split(' → ')[0]}` : ''}</span>
                          {isInk
                            ? <span className="block text-xs">{tp.padInkOnly}</span>
                            : <span className="block whitespace-pre-wrap break-words line-clamp-3 text-stone-800">{richToPlain(pageBlock(p))}</span>}
                          {/* Both sides: only the typed one goes in, and the
                              list says so where the choice is made. */}
                          {!isInk && hasInk(p) && <span className="block text-[10.5px] text-stone-500">{tp.padInkNotImported}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {chosen.length > 0 && (
                <div className="mt-3">
                  <p className="text-[10.5px] font-bold uppercase text-stone-500 mb-1">{de ? 'Vorschau' : 'Preview'}</p>
                  <pre className="whitespace-pre-wrap break-words text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg p-3 max-h-40 overflow-y-auto font-sans">{richToPlain(importBlock(chosen))}</pre>
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-stone-200 space-y-2">
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠ {field === 'tips' ? tp.padImportWarnTips : tp.padImportWarn}</p>
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => setMode('pages')} className="h-10 px-4 rounded-xl border border-stone-300 bg-white text-sm font-medium text-stone-700 hover:bg-stone-50">{tp.padCancel}</button>
                <button type="button" onClick={() => void doInsert()} disabled={chosen.length === 0} className="h-10 px-5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                  {chosen.length === 0 ? tp.padInsertNone : fill(chosen.length === 1 ? tp.padInsertCount1 : tp.padInsertCountN, { n: chosen.length, field: fieldLabel(field), role: insert.role })}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {reviewOnly && <p className="px-4 py-1.5 text-[11px] text-stone-500 bg-stone-50 border-b border-stone-200 leading-snug">{tp.padReviewOnly}</p>}

            {/* page strip */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-stone-100">
              <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }} data-log-redact>
                {/* A page not yet written shows as a page would — with the
                    time it will carry — and only once there are other pages
                    to come back from. */}
                {showVirtual && pages.length > 0 && (
                  <span aria-current="page" className="shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-slate-900 bg-slate-900 text-white text-[11px] font-medium">
                    {virtualKind === 'ink' ? <PenLine size={12} /> : <Keyboard size={12} />}{clockLabel(Date.now())}
                  </span>
                )}
                {pages.map(pill)}
              </div>
              {/* One kind of page: what goes on it is chosen on the page, by
                  the switch below, and can change while writing. As tall as
                  the switch, for the same finger. */}
              <button type="button" onClick={newPage} disabled={pagesPending} data-testid="pad-new-page" className="shrink-0 disabled:opacity-40 h-9 [@media(pointer:coarse)_and_(min-height:56rem)]:h-10 px-2.5 inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800">
                <Plus size={13} /> {tp.padNewPage}
              </button>
            </div>

            {/* meta line */}
            {(current || showVirtual) && (
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 px-4 py-1 text-[10.5px] text-stone-500">
                {sideSwitch}
                {/* On a phone the switch and the page turner share the first
                    row, and what the page says goes under them: between the
                    two it was squeezed to three lines and pushed the turner
                    off the edge. */}
                {/* The dates keep their one line each and their full width;
                    what gives way is the "übernommen →" line (or a refusal),
                    cut short — it squeezed the dates onto three lines (UI
                    review, 25.10.2026). */}
                <span className="order-last basis-full min-w-0 flex items-center gap-2 leading-4 sm:order-none sm:basis-auto">
                  {current ? (
                    <>
                      <span className="shrink-0 whitespace-nowrap">{fill(tp.padCreated, { date: dayTimeLabel(current.createdAt) })}</span>
                      {/* Only once it says something the line above does not: a
                          page written in ten minutes ago was not "created" then. */}
                      {current.updatedAt - current.createdAt > 60_000 && (
                        <>
                          <span className="hidden sm:inline shrink-0">·</span>
                          <span className="hidden sm:inline shrink-0 whitespace-nowrap">{fill(tp.padEdited, { time: clockLabel(current.updatedAt) })}</span>
                        </>
                      )}
                      <span className="shrink-0">·</span>
                      <span className={cn('shrink-0 whitespace-nowrap', expiryLine(current).soon && 'text-amber-700 font-semibold')}>{expiryLine(current).text}</span>
                      {(current.rejectedReason || current.inkRejected) && (
                        <span className="min-w-0 truncate text-amber-700" title={fill(tp.padSyncRejected, { reason: current.rejectedReason || current.inkRejected || '' })}>· {fill(tp.padSyncRejected, { reason: current.rejectedReason || current.inkRejected || '' })}</span>
                      )}
                      {current.usedIn.length > 0 && (
                        <span className="min-w-0 truncate text-emerald-700">· {fill(tp.padUsedIn, { field: fieldLabel(current.usedIn[current.usedIn.length - 1].f), role: current.usedIn[current.usedIn.length - 1].r, label: current.usedIn[current.usedIn.length - 1].label })}</span>
                      )}
                    </>
                  ) : <span className="shrink-0 whitespace-nowrap">{fill(tp.padExpires, { date: dayLabel(Date.now() + NOTEBOOK_TTL_MS) })}</span>}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {pageNav}
                </span>
              </div>
            )}

            {/* body */}
            <div className="flex-1 min-h-0 flex flex-col" data-log-redact>
              {pagesPending ? (
                <div className="flex-1 min-h-[40vh] flex items-center justify-center bg-white">
                  <AppSpinner size={64} />
                </div>
              ) : side === 'text' && typedUnknown ? (
                // Not an empty page to type on: the server's copy of this side
                // has not come in (typedUnknown says why).
                <div role="status" className="flex-1 min-h-[40vh] flex flex-col items-center justify-center gap-3 px-6 text-center bg-white">
                  <p className="text-sm text-stone-500">{status.loaded ? tp.padTextLoadFailed : tp.padTextLoading}</p>
                  {status.loaded && (
                    <button type="button" onClick={() => void notebookSync.flushNow().then(() => notebookSync.pullIndex({ force: true }))} className="h-9 px-4 rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-700 hover:bg-stone-50">
                      {tp.padRetry}
                    </button>
                  )}
                </div>
              ) : side === 'text' ? (
                <div ref={surfaceRef} className="relative flex-1 min-h-0 flex flex-col">
                  <div className="px-3 py-1.5 border-b border-stone-100 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
                    <RichToolbar de={de} onCommand={format} onBullet={() => handleText(appendBullet(currentText))} onNumber={() => handleText(appendNumbered(currentText))} onCheck={() => handleText(appendCheck(currentText))}>
                      <span className="mx-0.5 h-5 w-px bg-stone-200" />
                      {/* With the other things that go into the text, not up by
                          the page arrows. mousedown is prevented so the stamp
                          lands at the caret instead of the end of the page. */}
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={insertTime}
                        title={tp.padTimeTitle}
                        data-testid="pad-time"
                        className="h-8 px-2 inline-flex items-center gap-1 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                      >
                        <Clock size={12} className="shrink-0" />{tp.padTime}
                      </button>
                      {/* One button, not nine: nine pills wrap, and a wrapped
                          row is a second row of height this sheet does not
                          have. mousedown is prevented so the page keeps the
                          caret — the heading goes where the coach was typing. */}
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setSectionMenu((v) => !v)}
                        aria-expanded={sectionMenu}
                        title={tp.padSectionTitle}
                        data-testid="pad-section"
                        className="h-8 px-2 inline-flex items-center gap-1 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                      >
                        <Plus size={12} className="shrink-0" />{tp.padSection}
                      </button>
                      {canFilm && <CameraButton tp={tp} ownerId={ownerId} clips={clips} insertLine={insertLine} />}
                    </RichToolbar>
                  </div>
                  <ClipStrip tp={tp} lang={lang} pageId={current ? current.pageId : null} text={currentText} clips={clips} />
                  {mentionMenu && clips.length > 0 && (
                    <>
                      <button
                        type="button"
                        aria-label={tp.padCancel}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setMentionMenu(false)}
                        className="absolute inset-0 z-10 cursor-default"
                      />
                      <div role="menu" aria-label={tp.padMentionTitle} data-testid="pad-mention" className="absolute left-3 right-3 top-[2.85rem] z-20 max-h-72 overflow-auto rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg sm:max-w-sm">
                        <p className="px-2 pb-1 text-[11px] font-medium text-stone-500">{tp.padMentionTitle}</p>
                        {[...clips].sort((a, b) => b.at - a.at).slice(0, 20).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            role="menuitem"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => mentionClip(c)}
                            className="w-full h-8 px-2 inline-flex items-center gap-2 rounded-lg text-left text-xs text-stone-700 hover:bg-stone-100"
                          >
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.file ? 'bg-red-600' : 'bg-stone-300')} />
                            <span className="truncate">{clipLabel(tp, c)}</span>
                            <span className="ml-auto shrink-0 text-stone-400">{dayLabel(c.at)}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {sectionMenu && (
                    <>
                      {/* Anywhere else closes it, including the page itself. */}
                      <button
                        type="button"
                        aria-label={tp.padCancel}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setSectionMenu(false)}
                        className="absolute inset-0 z-10 cursor-default"
                      />
                      <div className="absolute left-3 right-3 top-[2.85rem] z-20 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg sm:max-w-sm">
                        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                          {sectionLabels().map((label) => (
                            <button
                              key={label}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { insertSection(label); setSectionMenu(false); }}
                              className="h-8 rounded-lg border border-stone-200 px-2 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {/* One scroller for the margin and the page, so a time stays
                      beside its note however far down the evening goes. */}
                  <div ref={scrollRef} className="flex-1 min-h-0 flex overflow-auto bg-white">
                    {showTimes && <NoteTimes scrollRef={scrollRef} times={times} lineTitle={(date) => fill(tp.padTimesLine, { date })} />}
                    <RichSurface
                      autoFocus
                      initialCaret={textViews.current.get(current ? current.pageId : '')?.caret ?? null}
                      value={currentText}
                      onChange={handleText}
                      placeholder={tp.padPlaceholder}
                      atoms={CLIP_LINE_RE}
                      atomTone={clipTone}
                      onAtSign={() => { if (clips.length) setMentionMenu(true); }}
                      onAtom={(text) => { const m = CLIP_LINE_RE.exec(text); if (m) openClipByNumber(Number(m[1])); }}
                      className={cn('notebook-surface flex-1 min-w-0 min-h-[40vh] text-sm leading-relaxed py-3 bg-white', showTimes ? 'pl-3 pr-4' : 'px-4')}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col">
                  {/* The pad fills the grey and places the page in it itself:
                      where the page sits and how big it is IS the zoom. */}
                  <div ref={inkBoxRef} className="relative flex-1 min-h-0 bg-stone-100 overflow-hidden">
                    {inkWaiting ? (
                      <p className="absolute inset-0 flex items-center justify-center text-sm text-stone-500">{tp.padInkLoading}</p>
                    ) : (
                      <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><AppSpinner size={64} /></div>}>
                        <InkPad
                          key={viewKey}
                          page={inkPage}
                          bg={activeBg}
                          readOnly={!inkWritable}
                          tool={tool}
                          fingerDraws={fingerDraws}
                          initialZoom={zoomLevel.current ?? 1}
                          initialView={inkViews.current.get(current ? current.pageId : '') ?? null}
                          controlRef={inkControl}
                          onZoomChange={onZoomChange}
                          onPenSeen={onPenSeen}
                          onStrokeEnd={onStrokeEnd}
                          onErase={onErase}
                          onFull={() => toast.error(tp.padPageFull, { lang })}
                          onCancelledStroke={() => setCancelled((n) => n + 1)}
                        />
                      </Suspense>
                    )}
                    {/* Strokes on screen that are not known to be the page's
                        latest: shown, read-only, and said so — with the way to
                        ask again where the asking failed. */}
                    {!inkWaiting && !!current && (inkFailed || (!!inkFor && inkStaleNow)) && (
                      <div role="status" className="absolute top-2 inset-x-2 z-10 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 shadow-sm">
                        <span>{inkFailed ? tp.padInkLoadFailed : tp.padInkLoading}</span>
                        {inkFailed && (
                          <button type="button" onClick={() => setInkRetry((n) => n + 1)} className="h-8 px-3 rounded-lg border border-amber-300 bg-white text-xs font-medium text-amber-900 hover:bg-amber-100">
                            {tp.padRetry}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {/* One row on every iPad. With every label, in German, it
                      needs about 750 px, and the sheet is 768 wide only from
                      an 800 px screen up: below that (an iPad mini or a 9.7"
                      iPad upright, 744 and 768) Spielfeld, Rückgängig and
                      Leeren show their icon alone, named as before. A phone
                      still scrolls the row sideways. Leeren, not "Handschrift
                      leeren" on the button itself: the whole name pushed
                      Finger off a 768 px sheet (24.10.2026), and the button
                      sits in the handwriting's own toolbar. */}
                  <div className="flex items-center gap-1 px-3 py-2 border-t border-stone-200 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {([
                      { key: 'black', label: tp.padPenBlack, icon: <PenLine size={14} />, active: tool.kind === 'pen' && tool.colour === 0, on: () => setTool({ kind: 'pen', colour: 0 }) },
                      { key: 'red', label: tp.padPenRed, icon: <span className="inline-block w-3 h-3 rounded-full bg-red-700" />, active: tool.kind === 'pen' && tool.colour === 1, on: () => setTool({ kind: 'pen', colour: 1 }) },
                      { key: 'eraser', label: tp.padEraser, icon: <Eraser size={14} />, active: tool.kind === 'eraser', on: () => setTool({ kind: 'eraser' }) },
                    ]).map((b) => (
                      <button key={b.key} type="button" onClick={b.on} aria-pressed={b.active} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1 rounded-lg border text-xs font-medium', b.active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}>
                        {b.icon} {b.label}
                      </button>
                    ))}
                    <button type="button" onClick={toggleCourt} disabled={!inkWritable} aria-pressed={activeBg === 'court'} aria-label={tp.padCourt} title={tp.padCourt} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1 rounded-lg border text-xs font-medium disabled:opacity-40', activeBg === 'court' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}><LayoutTemplate size={14} /><span className="hidden min-[50rem]:inline">{tp.padCourt}</span></button>
                    <button type="button" onClick={undo} disabled={inkPage.strokes.length === 0 || !inkWritable} aria-label={tp.padUndo} title={tp.padUndo} className="shrink-0 h-9 px-2.5 inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40"><Undo2 size={14} /><span className="hidden min-[50rem]:inline">{tp.padUndo}</span></button>
                    <button type="button" onClick={() => void clearInk()} disabled={inkPage.strokes.length === 0 || !inkWritable} aria-label={tp.padClearInk} title={tp.padClearInk} className="shrink-0 h-9 px-2.5 inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40"><BrushCleaning size={14} /><span className="hidden min-[50rem]:inline">{tp.padClearInkShort}</span></button>
                    {/* Zoom for whoever does not think to pinch, and for a
                        mouse without a wheel. The middle shows the level, and
                        an icon for where a tap goes: the whole page, or back
                        to the page width. */}
                    <div role="group" aria-label={tp.padZoom} className="shrink-0 ml-auto inline-flex items-center gap-1">
                      <button type="button" onClick={() => inkControl.current?.zoomOut()} disabled={!inkZoom || inkZoom.z <= inkZoom.min + 0.001} aria-label={tp.padZoomOut} title={tp.padZoomOut} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-40"><ZoomOut size={14} /></button>
                      {/* The name starts with what the button shows, so a screen
                          reader says the level and voice control finds it by
                          what is on it. */}
                      <button
                        type="button"
                        onClick={() => (zoomToWidth ? inkControl.current?.zoomWidth() : inkControl.current?.zoomFit())}
                        disabled={zoomLevelOff}
                        aria-label={`${zoomPct} — ${zoomAction}`}
                        title={zoomAction}
                        data-testid="ink-zoom"
                        className="h-9 min-w-[3.75rem] px-1 inline-flex items-center justify-center gap-0.5 rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-700 tabular-nums hover:bg-stone-50 disabled:opacity-40"
                      >
                        {zoomPct}
                        {zoomToWidth ? <MoveHorizontal size={12} className="shrink-0" /> : <FileIcon size={12} className="shrink-0" />}
                      </button>
                      <button type="button" onClick={() => inkControl.current?.zoomIn()} disabled={!inkZoom || inkZoom.z >= inkZoom.max - 0.001} aria-label={tp.padZoomIn} title={tp.padZoomIn} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-40"><ZoomIn size={14} /></button>
                    </div>
                    <button type="button" onClick={toggleFinger} aria-pressed={fingerDraws} title={fingerDraws ? tp.padFingerOn : tp.padFingerOff} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1 rounded-lg border text-xs font-medium', fingerDraws ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}><Hand size={14} /> {tp.padFinger}</button>
                  </div>
                  <p className="px-4 pb-1 text-[11px] text-stone-500">{cancelled >= 2 ? tp.padScribbleHint : !zoomedOnce && touchScreen ? tp.padZoomHint : tp.padInkNotImported}</p>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex items-center gap-2 px-4 py-2 border-t border-stone-200">
              <p className={cn('flex-1 min-w-0 text-[11px] truncate', statusTone)} aria-live="polite">{statusText}</p>
              {/* Down here, not by the page arrows: that line already runs to
                  two rows on a phone, and this row has room on every screen. */}
              {side === 'text' && !pagesPending && (
                <button
                  type="button"
                  onClick={toggleTimes}
                  aria-pressed={showTimes}
                  aria-label={tp.padTimes}
                  title={showTimes ? tp.padTimesOn : tp.padTimesOff}
                  data-testid="pad-times-toggle"
                  className={cn(
                    'shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-colors',
                    showTimes ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50',
                  )}
                >
                  <Clock size={14} /> <span className="hidden sm:inline">{tp.padTimes}</span>
                </button>
              )}
              {(current || virtual) && (
                <button type="button" onClick={() => void deletePage()} aria-label={tp.padDeletePage} title={tp.padDeletePage} className="shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 hover:bg-stone-50">
                  <Trash2 size={14} /> <span className="hidden sm:inline">{tp.padDeletePage}</span>
                </button>
              )}
              {insert && (
                <button type="button" onClick={openImport} disabled={textPages.length === 0} className="shrink-0 h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50">
                  {tp.padInsert}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
