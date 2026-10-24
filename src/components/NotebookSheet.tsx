// The Notizblock sheet: the coach's pages, newest on top, one on screen at a
// time — a text page (a plain textarea, so iPadOS Scribble, Samsung's S Pen
// and Gboard write into it natively) or a pen page (InkPad). On the
// observation form the footer also offers "Übernehmen…", the only way a page
// ever reaches the report.
//
// Rendering and state come from notebookSync: this component never touches
// IndexedDB or the network itself. A page that does not exist yet (the empty
// notebook, or "Neue Seite") is VIRTUAL until its first keystroke or stroke,
// so opening and closing the sheet never syncs an empty row.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, Eraser, Hand, LayoutTemplate, Maximize2, Minimize2, NotebookPen, PenLine, Pencil, Plus, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '../lib/utils';
import { clockLabel, dayLabel, dayTimeLabel } from '../lib/appTime';
import { PAD_STRINGS, fill, type PadLang } from '../lib/notepadStrings';
import {
  NOTEBOOK_MAX_PAGES, NOTEBOOK_MAX_TITLE_LEN, NOTEBOOK_INK_DEBOUNCE_MS, NOTEBOOK_TTL_MS, inkPoints, makePage, pageExpiresAt,
  type InkPage, type InkStroke, type NotebookPage, type PadField, type PageBackground, type PageKind,
} from '../lib/notebook';
import * as notebookSync from '../lib/notebookSync';
import type { PadSyncStatus } from '../lib/notebookSync';
import { importBlock, pageBlock } from '../lib/notebookImport';
import { richToPlain } from '../lib/richText';
import { lineTimes, withLineTimes } from '../lib/notebookTimes';
import { RichSurface, RichToolbar, appendBullet, appendCheck, appendNumbered } from './RichText';
import { confirmDialog, toast } from './ui';
import AppSpinner from './AppSpinner';
import StaleBuildNotice from './StaleBuildNotice';
import NoteTimes from './NoteTimes';
import { importFresh } from '../lib/freshImport';
import type { InkPadControl, InkTool, InkZoom } from './InkPad';

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
/** The time column beside a text page: on unless this device turned it off. */
const TIMES_KEY = 'svrz_pad_times';
/** The pen page's zoom level on this device (relative to fit-width), like
 *  svrz_pad_full: a coach who writes zoomed in should not pinch on every new
 *  page. The level, never the position — each page opens at its top. */
const ZOOM_KEY = 'svrz_ink_zoom';
/** A touch on the sheet's buttons this soon after the pen is the writing hand. */
const PALM_CLICK_MS = 500;
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
  const [virtual, setVirtual] = useState<{ kind: PageKind; bg: PageBackground } | null>(null);
  const [ink, setInk] = useState<InkPage | null>(null);
  const [inkLoading, setInkLoading] = useState(false);
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
  // A fresh pad, and with it a fresh view at the top of the page, for every
  // page the coach turns to. Not for the first stroke on a page not yet
  // written: that stroke MAKES the page, and the view she is writing in stays.
  const [viewKey, setViewKey] = useState(0);
  const turnPage = () => setViewKey((k) => k + 1);
  const [inkZoom, setInkZoom] = useState<InkZoom | null>(null);
  const zoomLevel = useRef<number | null>(null);
  if (zoomLevel.current === null) {
    const stored = parseFloat(readPref(ZOOM_KEY) || '');
    zoomLevel.current = Number.isFinite(stored) && stored > 0 ? stored : 1;
  }
  /** The two-finger hint shows until this device has zoomed once. */
  const [zoomedOnce, setZoomedOnce] = useState(() => readPref(ZOOM_KEY) !== null);

  const current = pages.find((p) => p.pageId === currentId) || null;
  // Before the boot's first pull has answered, an empty list is only the
  // local cache — empty on a wiped device or a new sign-in. A blank writable
  // "Seite 1 von 1" in that window committed a new page next to the real
  // ones, so the page area waits. A page the coach asked for still shows.
  const pagesPending = !status.loaded && pages.length === 0 && !virtual;
  const showVirtual = !!virtual || (pages.length === 0 && !current && !pagesPending);
  const virtualKind: PageKind = virtual ? virtual.kind : 'text';
  const virtualBg: PageBackground = virtual ? virtual.bg : '';
  const activeKind: PageKind = current ? current.kind : virtualKind;
  const activeBg: PageBackground = current ? current.bg : virtualBg;

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
  // Finger turned finger drawing on. A touch's click this soon after the pen is
  // swallowed here, in the capture phase, before any button sees it — the
  // signature dialog's failure, on the notebook (Jennifer, 23.10.2026).
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
    const touched: { target: Node; at: number }[] = [];
    const onTouch = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !(e.target instanceof Node)) return;
      touched.push({ target: e.target, at: performance.now() });
      if (touched.length > 8) touched.shift();
    };
    const byTouch = (e: MouseEvent): boolean => {
      if ((e as PointerEvent).pointerType === 'touch') return true;
      const target = e.target instanceof Node ? e.target : null;
      const now = performance.now();
      // The click goes to the element the touch hit, or to one around it.
      return !!target && touched.some((t) => now - t.at < TAP_CLICK_MS && target.contains(t.target));
    };
    const onClick = (e: MouseEvent) => {
      if (!byTouch(e)) return;
      const penAt = inkControl.current?.lastPenAt() ?? 0;
      if (!penAt || performance.now() - penAt >= PALM_CLICK_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };
    panel.addEventListener('pointerdown', onTouch, true);
    panel.addEventListener('pointerup', onTouch, true);
    panel.addEventListener('click', onClick, true);
    return () => {
      panel.removeEventListener('pointerdown', onTouch, true);
      panel.removeEventListener('pointerup', onTouch, true);
      panel.removeEventListener('click', onClick, true);
    };
  }, []);

  // Escape peels this menu first. App.tsx keeps a window-level Escape handler
  // that closes the whole sheet, and losing the page you are writing on is a
  // lot to pay for a menu opened by mistake. Capture, so it runs before that
  // one — the ConfirmDialog does the same.
  useEffect(() => {
    if (!sectionMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSectionMenu(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sectionMenu]);

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

  // The strokes of the pen page on screen: local first, the server if newer.
  useEffect(() => {
    let alive = true;
    if (!current || current.kind !== 'ink') { setInk(null); setInkLoading(false); return; }
    setInkLoading(!notebookSync.hasLocalInk(current.pageId));
    void notebookSync.getInk(current.pageId).then((page) => {
      if (!alive) return;
      setInk(page || { w: 1000, h: 1414, strokes: [] });
      setInkLoading(false);
    });
    return () => { alive = false; };
    // Keyed on the page id and its version: a pull that brought newer strokes re-reads them.
  }, [current?.pageId, current?.updatedAt, current?.kind]);

  // ── text ────────────────────────────────────────────────────────────
  // The page the first keystroke on a fresh page just made, until it is on
  // screen. A multi-line insert fires one input event per line, all before the
  // next render, and each of them still saw `current` empty — a heading as the
  // first thing written made three pages, two of them blank (2026-10-13).
  const madePage = useRef<NotebookPage | null>(null);
  useEffect(() => { if (current || virtual) madePage.current = null; }, [current, virtual]);
  const handleText = (value: string) => {
    const open = current && current.kind === 'text' ? current : madePage.current;
    // Every change stamps the lines it made: kept whether or not the column is
    // on, so turning it back on shows the evening as it was written.
    if (open) {
      const extra = withLineTimes(open.text, open.extra, value, Date.now());
      const next = { ...open, text: value, ...(extra ? { extra } : {}) };
      if (!extra) delete next.extra;
      if (open === madePage.current) madePage.current = next;
      notebookSync.commit(next);
      return;
    }
    if (!value) return;
    const page = makePage(ownerId, 'text');
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

  const currentText = current && current.kind === 'text' ? current.text : '';
  const currentExtra = current && current.kind === 'text' ? current.extra : undefined;
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
    if (current && current.kind === 'ink') {
      notebookSync.commit({ ...current, points: inkPoints(next) }, next, NOTEBOOK_INK_DEBOUNCE_MS);
    } else {
      const page = makePage(ownerId, 'ink', virtualBg);
      page.points = inkPoints(next);
      notebookSync.commit(page, next, 0);
      setVirtual(null);
      setCurrentId(page.pageId);
    }
    setInk(next);
  };
  const inkPage: InkPage = ink || { w: 1000, h: 1414, strokes: [] };
  const onStrokeEnd = (stroke: InkStroke) => commitInk({ ...inkPage, strokes: [...inkPage.strokes, stroke] });
  const onErase = (strokes: InkStroke[]) => {
    const gone = new Set(strokes);
    const kept = inkPage.strokes.filter((s) => !gone.has(s));
    if (kept.length !== inkPage.strokes.length) commitInk({ ...inkPage, strokes: kept });
  };
  const undo = () => { if (inkPage.strokes.length) commitInk({ ...inkPage, strokes: inkPage.strokes.slice(0, -1) }); };
  const clearPage = async () => {
    if (inkPage.strokes.length === 0) return;
    if (inkPage.strokes.length > 3 && !(await confirmDialog({ title: tp.padClearPageTitle, message: tp.padClearPageMsg, tone: 'danger', lang }))) return;
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
  const newPage = (kind: PageKind) => {
    if (pages.length >= NOTEBOOK_MAX_PAGES) { toast.error(tp.padPagesFull, { lang }); return; }
    setVirtual({ kind, bg: '' });
    setCurrentId('');
    setInk(null);
    turnPage();
  };
  // The court outline under a pen page: a toggle, so a coach who started
  // sketching can still put the lines under what is already there.
  const toggleCourt = () => {
    const next: PageBackground = activeBg === 'court' ? '' : 'court';
    if (current && current.kind === 'ink') notebookSync.commit({ ...current, bg: next }, undefined, 0);
    else if (virtual) setVirtual({ ...virtual, bg: next });
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
  const textPages = useMemo(() => pages.filter((p) => p.kind === 'text' && pageBlock(p)), [pages]);
  const usedHere = (p: NotebookPage) => !!insert && p.usedIn.some((u) => u.f === field && u.r === insert.role && u.g === insert.gameId);
  const importList = pages.filter((p) => p.kind === 'ink' || (pageBlock(p) && (showUsed || !usedHere(p))));
  const openImport = () => {
    if (!insert) return;
    // The page on screen is pre-ticked — unless it already went into this
    // field, in which case it is hidden and the newest unused one is offered.
    const candidates = textPages.filter((p) => !usedHere(p));
    const first = current && current.kind === 'text' && pageBlock(current) && !usedHere(current) ? current.pageId : (candidates[0] ? candidates[0].pageId : '');
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

  const pill = (p: NotebookPage) => (
    <button
      key={p.pageId}
      type="button"
      onClick={() => { setVirtual(null); setCurrentId(p.pageId); setMode('pages'); turnPage(); }}
      aria-current={current && current.pageId === p.pageId ? 'page' : undefined}
      title={p.updatedAt - p.createdAt > 60_000
        ? `${fill(tp.padCreated, { date: dayTimeLabel(p.createdAt) })} · ${fill(tp.padEdited, { time: clockLabel(p.updatedAt) })}`
        : fill(tp.padCreated, { date: dayTimeLabel(p.createdAt) })}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border text-[11px] font-medium transition-colors',
        current && current.pageId === p.pageId && !virtual ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-600 border-stone-300 hover:bg-stone-50',
      )}
    >
      {p.kind === 'ink' ? <PenLine size={12} className="shrink-0" /> : <Pencil size={12} className="shrink-0" />}
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
                  const isInk = p.kind === 'ink';
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
                    {virtualKind === 'ink' ? <PenLine size={12} /> : <Pencil size={12} />}{clockLabel(Date.now())}
                  </span>
                )}
                {pages.map(pill)}
              </div>
              <div className="shrink-0 flex items-center gap-1.5">
                <button type="button" onClick={() => newPage('text')} disabled={pagesPending} data-testid="pad-new-text" className="disabled:opacity-40 h-8 px-2.5 inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800">
                  <Plus size={13} /><Pencil size={12} /> {tp.padTextPageShort}
                </button>
                <button type="button" onClick={() => newPage('ink')} disabled={pagesPending} data-testid="pad-new-ink" className="disabled:opacity-40 h-8 px-2.5 inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800">
                  <Plus size={13} /><PenLine size={12} /> {tp.padInkPageShort}
                </button>
              </div>
            </div>

            {/* meta line */}
            {(current || showVirtual) && (
              <div className="flex items-center gap-2 px-4 py-1 text-[10.5px] text-stone-500">
                {current ? (
                  <>
                    <span>{fill(tp.padCreated, { date: dayTimeLabel(current.createdAt) })}</span>
                    {/* Only once it says something the line above does not: a
                        page written in ten minutes ago was not "created" then. */}
                    {current.updatedAt - current.createdAt > 60_000 && (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="hidden sm:inline">{fill(tp.padEdited, { time: clockLabel(current.updatedAt) })}</span>
                      </>
                    )}
                    <span>·</span>
                    <span className={expiryLine(current).soon ? 'text-amber-700 font-semibold' : ''}>{expiryLine(current).text}</span>
                    {current.rejectedReason && <span className="text-amber-700">· {fill(tp.padSyncRejected, { reason: current.rejectedReason })}</span>}
                    {current.usedIn.length > 0 && (
                      <span className="text-emerald-700 truncate">· {fill(tp.padUsedIn, { field: fieldLabel(current.usedIn[current.usedIn.length - 1].f), role: current.usedIn[current.usedIn.length - 1].r, label: current.usedIn[current.usedIn.length - 1].label })}</span>
                    )}
                  </>
                ) : <span>{fill(tp.padExpires, { date: dayLabel(Date.now() + NOTEBOOK_TTL_MS) })}</span>}
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
              ) : activeKind === 'text' ? (
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
                    </RichToolbar>
                  </div>
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
                      value={currentText}
                      onChange={handleText}
                      placeholder={tp.padPlaceholder}
                      className={cn('notebook-surface flex-1 min-w-0 min-h-[40vh] text-sm leading-relaxed py-3 bg-white', showTimes ? 'pl-3 pr-4' : 'px-4')}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col">
                  {/* The pad fills the grey and places the page in it itself:
                      where the page sits and how big it is IS the zoom. */}
                  <div className="relative flex-1 min-h-0 bg-stone-100 overflow-hidden">
                    {inkLoading ? (
                      <p className="absolute inset-0 flex items-center justify-center text-sm text-stone-500">{tp.padInkLoading}</p>
                    ) : (
                      <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><AppSpinner size={64} /></div>}>
                        <InkPad
                          key={viewKey}
                          page={inkPage}
                          bg={activeBg}
                          tool={tool}
                          fingerDraws={fingerDraws}
                          initialZoom={zoomLevel.current ?? 1}
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
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-2 border-t border-stone-200 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {([
                      { key: 'black', label: tp.padPenBlack, icon: <PenLine size={14} />, active: tool.kind === 'pen' && tool.colour === 0, on: () => setTool({ kind: 'pen', colour: 0 }) },
                      { key: 'red', label: tp.padPenRed, icon: <span className="inline-block w-3 h-3 rounded-full bg-red-700" />, active: tool.kind === 'pen' && tool.colour === 1, on: () => setTool({ kind: 'pen', colour: 1 }) },
                      { key: 'eraser', label: tp.padEraser, icon: <Eraser size={14} />, active: tool.kind === 'eraser', on: () => setTool({ kind: 'eraser' }) },
                    ]).map((b) => (
                      <button key={b.key} type="button" onClick={b.on} aria-pressed={b.active} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium', b.active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}>
                        {b.icon} {b.label}
                      </button>
                    ))}
                    <button type="button" onClick={toggleCourt} aria-pressed={activeBg === 'court'} title={tp.padCourt} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium', activeBg === 'court' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}><LayoutTemplate size={14} /> {tp.padCourt}</button>
                    <button type="button" onClick={undo} disabled={inkPage.strokes.length === 0} aria-label={tp.padUndo} title={tp.padUndo} className="shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40"><Undo2 size={14} /> {tp.padUndo}</button>
                    <button type="button" onClick={() => void clearPage()} disabled={inkPage.strokes.length === 0} className="shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40">{tp.padClearPage}</button>
                    {/* Zoom for whoever does not think to pinch, and for a
                        mouse without a wheel. The middle shows the level and
                        goes to the whole page. */}
                    <div role="group" aria-label={tp.padZoom} className="shrink-0 ml-auto inline-flex items-center gap-1">
                      <button type="button" onClick={() => inkControl.current?.zoomOut()} disabled={!inkZoom || inkZoom.z <= inkZoom.min + 0.001} aria-label={tp.padZoomOut} title={tp.padZoomOut} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-40"><ZoomOut size={14} /></button>
                      <button type="button" onClick={() => inkControl.current?.zoomFit()} disabled={!inkZoom} aria-label={tp.padZoomFit} title={tp.padZoomFit} data-testid="ink-zoom" className="h-9 min-w-[3.5rem] px-1.5 inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-700 tabular-nums hover:bg-stone-50 disabled:opacity-40">{`${Math.round((inkZoom ? inkZoom.z : 1) * 100)} %`}</button>
                      <button type="button" onClick={() => inkControl.current?.zoomIn()} disabled={!inkZoom || inkZoom.z >= inkZoom.max - 0.001} aria-label={tp.padZoomIn} title={tp.padZoomIn} className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-40"><ZoomIn size={14} /></button>
                    </div>
                    <button type="button" onClick={toggleFinger} aria-pressed={fingerDraws} title={fingerDraws ? tp.padFingerOn : tp.padFingerOff} className={cn('shrink-0 h-9 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium', fingerDraws ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50')}><Hand size={14} /> {tp.padFinger}</button>
                  </div>
                  <p className="px-4 pb-1 text-[11px] text-stone-500">{cancelled >= 2 ? tp.padScribbleHint : !zoomedOnce ? tp.padZoomHint : tp.padInkNotImported}</p>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex items-center gap-2 px-4 py-2 border-t border-stone-200">
              <p className={cn('flex-1 min-w-0 text-[11px] truncate', statusTone)} aria-live="polite">{statusText}</p>
              {/* Down here, not by the page arrows: that line already runs to
                  two rows on a phone, and this row has room on every screen. */}
              {activeKind === 'text' && !pagesPending && (
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
