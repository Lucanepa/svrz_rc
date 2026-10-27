// The app's own PDF reader: the rulebook, searchable, without leaving the app.
//
// A referee coach looking up what counts as a double contact does not want a
// 7 MB download and a browser tab — they want the paragraph, in the gym, on a
// phone. So every document in the "Nützliche Infos & Dokumente" card opens
// here: rendered page by page, searched across all pages at once, and kept in
// Cache Storage afterwards so the second look costs nothing.
//
// pdf.js is loaded only when a document is opened (this whole module is behind
// a lazy import), which keeps roughly a megabyte of renderer out of the way of
// everyone who never opens one.
//
// After the first coaching on an iPad mini (Mike, 27.10.2026) and
// Luca's "zooming is super bad resolution" the same day, a page is more than a
// picture:
//  - its words lie invisibly over it (pdf.js's TextLayer), so a passage can be
//    selected and copied — into the Notizblock, whose button stays on screen
//    over the reader (App.tsx);
//  - its links work: the table of contents jumps to the article, and a
//    "Zurück" in the header goes back to where the jump started;
//  - a pinch (or a trackpad pinch, or Ctrl + wheel) zooms the reader, not the
//    browser: the page grows under the fingers while they move and is drawn
//    again, sharp, at the new size when they lift. Before, the browser
//    magnified a bitmap drawn for the old size;
//  - the reader remembers, per document and per device, where it was left
//    (page, zoom, search), so going back to the form and coming back to the
//    rulebook does not mean scrolling to the article again.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, CornerUpLeft, ExternalLink, Loader2, Minus, Plus, Search, X } from 'lucide-react';
// The legacy build, deliberately. The default one calls Math.sumPrecise, which
// no Safari has yet — and half of these coaches read this on an iPhone in a
// gym. Where the modern build failed it did not fail loudly: font parsing threw,
// pdf.js substituted a font, and the page rendered every letter as the wrong
// glyph while the text underneath stayed perfectly searchable.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { fetchDocBytes } from '../lib/docCache';
import { foldText, phrasePattern } from '../lib/docText';
import type { Lang } from '../lib/prefs';
import { clientLog } from '../lib/logger';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfLoadingTask = ReturnType<typeof pdfjsLib.getDocument>;
type PdfDoc = Awaited<PdfLoadingTask['promise']>;
type PdfPageProxy = Awaited<ReturnType<PdfDoc['getPage']>>;
type PdfTextContent = Awaited<ReturnType<PdfPageProxy['getTextContent']>>;

/** One run of characters pdf.js drew as a unit, and where it sits on the page. */
type Span = { start: number; end: number; transform: number[]; width: number };
type PageText = { text: string; folded: string; spans: Span[] };
type Hit = { page: number; start: number; end: number; snippet: string };
type Rect = { left: number; top: number; width: number; height: number };
/** A place in the document that survives a zoom: a page, and how far down it. */
type Anchor = { page: number; frac: number };
/** A link on a page, in CSS pixels at the page's current zoom. */
type LinkBox = Rect & { dest: unknown; url: string | null };

const STR = {
  DE: {
    search: 'Im Dokument suchen',
    noHits: 'Keine Treffer',
    hits: (n: number) => `${n} Treffer`,
    scanning: (a: number, b: number) => `Seite ${a} von ${b} durchsucht…`,
    /** In the search row while the document itself is still on its way. */
    notYet: 'Dokument lädt noch…',
    page: 'Seite',
    of: 'von',
    /** In front of a page number in the list of hits, where space is short. */
    pageShort: 'S.',
    loading: 'Dokument wird geladen…',
    failed: 'Das Dokument liess sich nicht laden.',
    original: 'Original öffnen',
    close: 'Schliessen',
    zoomIn: 'Grösser',
    zoomOut: 'Kleiner',
    prevHit: 'Vorheriger Treffer',
    nextHit: 'Nächster Treffer',
    back: 'Zurück',
    backTo: (n: number) => `Zurück zu Seite ${n}`,
    /** A link inside the document, read out by a screen reader. */
    jump: 'Zur verlinkten Stelle springen',
    /** Beside the count when the phrase was not found but its words were. */
    wordByWord: 'Wörter einzeln',
    wordByWordHint: 'Der Ausdruck kommt so nicht vor — gezeigt sind die Seiten, auf denen alle Wörter stehen.',
  },
  EN: {
    search: 'Search this document',
    noHits: 'No matches',
    hits: (n: number) => `${n} matches`,
    scanning: (a: number, b: number) => `searched page ${a} of ${b}…`,
    notYet: 'Still loading…',
    page: 'Page',
    of: 'of',
    pageShort: 'p.',
    loading: 'Loading the document…',
    failed: 'The document could not be loaded.',
    original: 'Open the original',
    close: 'Close',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    prevHit: 'Previous match',
    nextHit: 'Next match',
    back: 'Back',
    backTo: (n: number) => `Back to page ${n}`,
    jump: 'Go to the linked place',
    wordByWord: 'words one by one',
    wordByWordHint: 'The phrase does not occur as typed — these are the pages that hold every word of it.',
  },
} satisfies Record<Lang, Record<string, unknown>>;

// Folding (lower case, no accents, same length) is shared with the
// search across documents on Home: lib/docText.ts.
const fold = foldText;

const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

/**
 * The most pixels one page's bitmap may have. iOS Safari refuses a canvas over
 * 16.7 million pixels outright (it stays blank), and keeps every canvas of a
 * page or two near the viewport in memory at once. At 400 % on an iPad a page
 * wants three times this at full sharpness; it gets slightly less than full
 * sharpness rather than nothing.
 */
const MAX_CANVAS_PIXELS = 12_000_000;

/** Device pixels per CSS pixel for a page of this size: the screen's own,
 *  up to 3, unless that would break the budget above. */
function outputRatio(w: number, h: number): number {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const area = w * h;
  return area * dpr * dpr > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / area) : dpr;
}

// --- where a document was left ---------------------------------------------

/** Per document, on this device: the page and how far down it, the zoom (null
 *  = fit to the width) and the search. Not synced: the iPad and the phone
 *  are read differently. */
const POS_KEY = 'svrz_reader_pos';
/** Enough for every document in the card, and a few gone from it. */
const POS_KEEP = 40;
type SavedPos = { p: number; f: number; s: number | null; q: string; t: number };

function readPositions(): Record<string, SavedPos> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(POS_KEY) || '{}');
    return value && typeof value === 'object' ? value as Record<string, SavedPos> : {};
  } catch {
    return {};
  }
}

function readPosition(key: string): SavedPos | null {
  const pos = readPositions()[key];
  if (!pos || !Number.isInteger(pos.p) || pos.p < 1 || !Number.isFinite(pos.f)) return null;
  return {
    p: pos.p,
    f: pos.f,
    s: typeof pos.s === 'number' && Number.isFinite(pos.s) ? clampScale(pos.s) : null,
    q: typeof pos.q === 'string' ? pos.q : '',
    t: pos.t,
  };
}

function writePosition(key: string, pos: SavedPos): void {
  try {
    const all = readPositions();
    all[key] = pos;
    const stale = Object.keys(all).sort((a, b) => (all[b].t || 0) - (all[a].t || 0)).slice(POS_KEEP);
    for (const k of stale) delete all[k];
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch { /* private mode or full storage — the reader just opens at the top */ }
}

/**
 * Where a link points: a page, and the height on it in PDF units (null = the
 * top). A destination is either named — looked up in the document — or an
 * explicit array whose first entry is the page (a reference, or its index).
 */
async function resolveDest(doc: PdfDoc, dest: unknown): Promise<{ page: number; y: number | null } | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length < 2) return null;
    const [ref, mode, ...args] = explicit as [unknown, { name?: string } | undefined, ...unknown[]];
    let index: number;
    if (ref && typeof ref === 'object') index = await doc.getPageIndex(ref as Parameters<PdfDoc['getPageIndex']>[0]);
    else if (Number.isInteger(ref)) index = ref as number;
    else return null;
    if (index < 0 || index >= doc.numPages) return null;
    let y: unknown = null;
    switch (mode?.name) {
      case 'XYZ': y = args[1]; break;
      case 'FitH': case 'FitBH': y = args[0]; break;
      case 'FitR': y = args[3]; break;
      default: y = null;
    }
    return { page: index + 1, y: typeof y === 'number' && Number.isFinite(y) ? y : null };
  } catch {
    return null;
  }
}

export type PdfReaderProps = {
  /** Where the bytes come from — and, with `load`, only the document's key. */
  url: string;
  title: string;
  /** "Open the original": a link in the header and under a failure. Left out
   *  where there is no public original (a referee's own report). */
  originalHref?: string;
  lang: Lang;
  onClose: () => void;
  /** Bytes from somewhere other than the document shelf: the coachee's
   *  dossier holds its PDF already, fetched with its own session header, and
   *  a private report must not land in Cache Storage. Must hand back a fresh
   *  buffer each call — pdf.js detaches the one it is given. */
  load?: (onProgress: (p: number) => void, signal: AbortSignal) => Promise<ArrayBuffer>;
  /** More buttons in the header, before the close button (download, …). */
  actions?: ReactNode;
  /** Under the failure message when there is no original to send them to. */
  fallback?: ReactNode;
  /** Opened from a hit of the search across documents: the term goes into the
   *  reader's own search, and the reader lands on the hit's page. */
  initialQuery?: string;
  initialPage?: number;
  /** Remember on this device where this document was left — page, zoom,
   *  search — under this key, and open it there next time. Not for a private
   *  report. A hit to land on wins over the remembered place. */
  rememberAs?: string;
  /** The Notizblock is open over the reader: the reader sinks under it (it
   *  stays mounted, scrolled where it was) and leaves Escape and ⌘F alone. */
  covered?: boolean;
};

export default function PdfReader({ url, title, originalHref, lang, onClose, load, actions, fallback, initialQuery, initialPage, rememberAs, covered }: PdfReaderProps) {
  const t = STR[lang];
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<number, PageText>());
  // The loading task, not the document, owns the worker — closing the reader
  // without destroying it leaves a worker thread per document opened.
  const taskRef = useRef<PdfLoadingTask | null>(null);

  // Where this document was left, read once. Not when opened on a hit: that
  // is a question about a different place.
  const [saved] = useState(() => (rememberAs && !initialPage && !initialQuery ? readPosition(rememberAs) : null));

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(saved?.s ?? 1);
  const [fitWidth, setFitWidth] = useState(!saved?.s);
  // True once the pages have their first size, fitted or remembered: a jump
  // computed before that lands on the layout of a different zoom.
  const [laidOut, setLaidOut] = useState(false);
  const [current, setCurrent] = useState(1);
  /** Where the last link was followed from, for "Zurück". */
  const [backTo, setBackTo] = useState<Anchor | null>(null);

  const [query, setQuery] = useState(initialQuery ?? saved?.q ?? '');
  // The page to land on, once — consumed by the first search that finds it.
  const landOnRef = useRef(initialPage ?? 0);
  // The place to restore, once the pages are laid out.
  const restoreRef = useRef<Anchor | null>(saved ? { page: saved.p, frac: saved.f } : null);
  // A search typed here jumps to its first hit; one restored or handed over
  // from Home does not move the page under the reader.
  const typedRef = useRef(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [searching, setSearching] = useState(false);
  /** The hits are the words one by one, the phrase itself being nowhere. */
  const [looseHits, setLooseHits] = useState(false);

  // Live values for listeners registered once.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const fitRef = useRef(fitWidth);
  fitRef.current = fitWidth;
  const queryRef = useRef(query);
  queryRef.current = query;
  const currentRef = useRef(current);
  currentRef.current = current;
  const coveredRef = useRef(!!covered);
  coveredRef.current = !!covered;

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        const onProgress = (p: number) => { if (!cancelled) setProgress(p); };
        const bytes = load ? await load(onProgress, abort.signal) : await fetchDocBytes(url, onProgress, abort.signal);
        if (cancelled) return;
        const task = pdfjsLib.getDocument({
          data: new Uint8Array(bytes),
          // Where the substitutes for non-embedded fonts live (a vite plugin
          // puts them there). Leave this out and a document that names Arial
          // renders as line noise — see vite.config.ts.
          standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
        });
        taskRef.current = task;
        const loaded = await task.promise;
        if (cancelled) { void task.destroy(); return; }
        const first = await loaded.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (cancelled) { void task.destroy(); return; }
        setBase({ w: viewport.width, h: viewport.height });
        setDoc(loaded);
      } catch (error) {
        if (cancelled || abort.signal.aborted) return;
        // A document that will not open is worth knowing about — it means the
        // proxy or the upstream changed under us — but the reader still has
        // somewhere to send the coach, so it is not an outage.
        clientLog.warn('pdf.open_failed', 'A document could not be opened in the reader', {
          url, error: error instanceof Error ? error.message : String(error),
        });
        setFailed(true);
      }
    })();
    return () => { cancelled = true; abort.abort(); };
  }, [url]);

  useEffect(() => () => { void taskRef.current?.destroy(); }, []);

  // --- places -------------------------------------------------------------
  // The pages' wrapper is `relative`, and so is the scrolling box: a page's
  // offsetTop is its distance from the top of the pages, and the wrapper's is
  // the box's top padding. (Before, the nearest positioned ancestor was the
  // whole dialog, header included.)
  const pageEl = (n: number): HTMLElement | null => (pagesRef.current?.children[n - 1] as HTMLElement | undefined) ?? null;
  const pageTop = (el: HTMLElement): number => (pagesRef.current?.offsetTop ?? 0) + el.offsetTop;

  /** The place `cy` CSS pixels below the top of the visible area. */
  const anchorAt = useCallback((cy: number): Anchor | null => {
    const box = scrollRef.current;
    const wrap = pagesRef.current;
    const pages = wrap?.children;
    if (!box || !wrap || !pages?.length) return null;
    const y = box.scrollTop + cy - wrap.offsetTop;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((pages[mid] as HTMLElement).offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    const el = pages[lo] as HTMLElement;
    return { page: lo + 1, frac: (y - el.offsetTop) / Math.max(1, el.offsetHeight) };
  }, []);

  /** Scroll so that `anchor` sits `cy` CSS pixels below the top of the visible area. */
  const scrollToAnchor = useCallback((anchor: Anchor, cy: number, smooth = false) => {
    const box = scrollRef.current;
    const el = pageEl(anchor.page);
    if (!box || !el) return;
    box.scrollTo({ top: Math.max(0, pageTop(el) + anchor.frac * el.offsetHeight - cy), behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // --- remember where it was left ------------------------------------------
  const lastAnchor = useRef<Anchor | null>(null);
  const saveTimer = useRef(0);
  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    // Not before the remembered place is back: the first scroll event, at the
    // top of page 1, would otherwise overwrite it.
    if (!rememberAs || restoreRef.current || !lastAnchor.current) return;
    writePosition(rememberAs, {
      p: lastAnchor.current.page,
      f: Math.round(lastAnchor.current.frac * 1000) / 1000,
      s: fitRef.current ? null : Math.round(scaleRef.current * 100) / 100,
      q: queryRef.current.trim(),
      t: Date.now(),
    });
  }, [rememberAs]);
  // Closing the reader, and the app going away — iOS may end a backgrounded
  // tab without another word, and the coach comes back to a reloaded app.
  useEffect(() => {
    if (!rememberAs) return;
    const onHide = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [rememberAs, save]);
  // A zoom or a new search is worth keeping even without a scroll after it.
  useEffect(() => {
    if (!rememberAs) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, 600);
  }, [rememberAs, save, scale, fitWidth, query]);

  // Fit the page to the window, and keep fitting it while the window changes —
  // until someone zooms, which is a decision the reader should not undo.
  useEffect(() => {
    if (!base) return;
    const fit = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (fitWidth) {
        const width = el.clientWidth - (window.innerWidth < 640 ? 12 : 48);
        setScale(clampScale(Math.min(3, width / base.w)));
      }
      setLaidOut(true);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [base, fitWidth]);

  // Opened on a hit: go to its page as soon as the pages are laid out, rather
  // than after the search has read the whole document. Or back to where the
  // document was left. Once per document: a place to start, not a leash.
  useEffect(() => {
    if (!doc || !laidOut) return;
    if (!restoreRef.current && !initialPage) return;
    const frame = window.requestAnimationFrame(() => {
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (restore) {
        scrollToAnchor(restore, 0);
      } else if (initialPage) {
        const el = pageEl(initialPage);
        const box = scrollRef.current;
        if (el && box) box.scrollTo({ top: pageTop(el) - 12 });
      }
      onScroll();
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, laidOut]);

  // --- zoom ---------------------------------------------------------------
  // A zoom keeps the point it was aimed at where it was: the middle of the
  // screen for the buttons, the fingers for a pinch, the pointer for Ctrl +
  // wheel. The place is taken before the pages change size, and put back in a
  // layout effect, before the new size is ever painted.
  const pendingZoom = useRef<{ anchor: Anchor; cx: number; cy: number; xf: number } | null>(null);
  const clearLive = () => {
    const wrap = pagesRef.current;
    if (wrap) { wrap.style.transform = ''; wrap.style.transformOrigin = ''; }
  };
  const placeAfterZoom = (z: { anchor: Anchor; cx: number; cy: number; xf: number }) => {
    const box = scrollRef.current;
    if (!box) return;
    scrollToAnchor(z.anchor, z.cy);
    box.scrollLeft = Math.max(0, z.xf * box.scrollWidth - z.cx);
  };
  const commitZoom = useCallback((next: number, anchor: Anchor | null, cx: number, cy: number, xf: number) => {
    const to = Math.round(clampScale(next) * 100) / 100;
    setFitWidth(false);
    if (to === scaleRef.current) {
      // No new size to wait for: only the live transform to take off.
      clearLive();
      if (anchor) placeAfterZoom({ anchor, cx, cy, xf });
      return;
    }
    pendingZoom.current = anchor ? { anchor, cx, cy, xf } : null;
    setScale(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    clearLive();
    const z = pendingZoom.current;
    pendingZoom.current = null;
    if (z) placeAfterZoom(z);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const zoomBy = (delta: number) => {
    const box = scrollRef.current;
    if (!box) return;
    const cx = box.clientWidth / 2;
    const cy = box.clientHeight / 2;
    commitZoom(scaleRef.current + delta, anchorAt(cy), cx, cy, (box.scrollLeft + cx) / Math.max(1, box.scrollWidth));
  };

  // Pinch, trackpad pinch and Ctrl + wheel. While the fingers move the pages
  // are only scaled (a transform: cheap, and blurry for those moments); on
  // the lift the zoom is committed and every page near the screen is drawn
  // again at its new size. `touch-action: pan-x pan-y` on the box keeps the
  // browser's own pinch out of it, and iOS's gesture events are refused for
  // the same reason.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !doc) return;
    type Live = { s0: number; d0: number; anchor: Anchor; ox: number; oy: number; mx0: number; my0: number; mx: number; my: number; ratio: number; xf: number };
    let pinch: Live | null = null;
    let wheel: Live | null = null;
    let gesture: Live | null = null;
    let wheelTimer = 0;
    const begin = (clientX: number, clientY: number, d0: number): Live | null => {
      const wrap = pagesRef.current;
      if (!wrap) return null;
      const r = box.getBoundingClientRect();
      const cx = clientX - r.left;
      const cy = clientY - r.top;
      const anchor = anchorAt(cy);
      if (!anchor) return null;
      return {
        s0: scaleRef.current, d0, anchor,
        // The point under the fingers in the wrapper's own coordinates: the
        // live scale pivots there.
        ox: box.scrollLeft + cx - wrap.offsetLeft,
        oy: box.scrollTop + cy - wrap.offsetTop,
        mx0: cx, my0: cy, mx: cx, my: cy, ratio: 1,
        xf: (box.scrollLeft + cx) / Math.max(1, box.scrollWidth),
      };
    };
    const show = (g: Live) => {
      const wrap = pagesRef.current;
      if (!wrap) return;
      wrap.style.transformOrigin = `${g.ox}px ${g.oy}px`;
      wrap.style.transform = `translate(${g.mx - g.mx0}px, ${g.my - g.my0}px) scale(${g.ratio})`;
    };
    const finish = (g: Live) => {
      if (Math.abs(g.ratio - 1) < 0.01 && Math.abs(g.mx - g.mx0) < 1 && Math.abs(g.my - g.my0) < 1) { clearLive(); return; }
      commitZoom(g.s0 * g.ratio, g.anchor, g.mx, g.my, g.xf);
    };
    const ratioFor = (g: Live, raw: number) => clampScale(g.s0 * raw) / g.s0;

    const dist = (ts: TouchList) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    const mid = (ts: TouchList) => ({ x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 });
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      pinch = begin(m.x, m.y, Math.max(1, dist(e.touches)));
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      const r = box.getBoundingClientRect();
      pinch.mx = m.x - r.left;
      pinch.my = m.y - r.top;
      pinch.ratio = ratioFor(pinch, dist(e.touches) / pinch.d0);
      show(pinch);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!pinch || e.touches.length >= 2) return;
      const g = pinch;
      pinch = null;
      finish(g);
    };

    // Chrome, Edge and Firefox report a trackpad pinch as a wheel with Ctrl.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!wheel) wheel = begin(e.clientX, e.clientY, 1);
      if (!wheel) return;
      const unit = e.deltaMode === 1 ? 16 : 1;
      wheel.ratio = ratioFor(wheel, wheel.ratio * Math.exp(-e.deltaY * unit * 0.01));
      show(wheel);
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => { const g = wheel; wheel = null; if (g) finish(g); }, 200);
    };

    // Safari: a Mac trackpad pinch arrives as gesture events and nothing else.
    // On an iPad they come alongside the touches above, which do the work.
    type WebKitGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      const g = e as WebKitGestureEvent;
      const r = box.getBoundingClientRect();
      gesture = pinch ? null : begin(g.clientX ?? r.left + r.width / 2, g.clientY ?? r.top + r.height / 2, 1);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as WebKitGestureEvent;
      if (!gesture || pinch || typeof g.scale !== 'number') return;
      gesture.ratio = ratioFor(gesture, g.scale);
      show(gesture);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      const g = gesture;
      gesture = null;
      if (g && !pinch) finish(g);
    };

    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchmove', onTouchMove, { passive: false });
    box.addEventListener('touchend', onTouchEnd);
    box.addEventListener('touchcancel', onTouchEnd);
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('gesturestart', onGestureStart);
    box.addEventListener('gesturechange', onGestureChange);
    box.addEventListener('gestureend', onGestureEnd);
    return () => {
      window.clearTimeout(wheelTimer);
      box.removeEventListener('touchstart', onTouchStart);
      box.removeEventListener('touchmove', onTouchMove);
      box.removeEventListener('touchend', onTouchEnd);
      box.removeEventListener('touchcancel', onTouchEnd);
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('gesturestart', onGestureStart);
      box.removeEventListener('gesturechange', onGestureChange);
      box.removeEventListener('gestureend', onGestureEnd);
      clearLive();
    };
  }, [doc, anchorAt, commitZoom]);

  // --- search -------------------------------------------------------------
  const pageText = useCallback(async (n: number): Promise<PageText> => {
    const cached = textCache.current.get(n);
    if (cached) return cached;
    const page = await doc!.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    const spans: Span[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const start = text.length;
      text += item.str;
      spans.push({ start, end: text.length, transform: item.transform as number[], width: item.width });
      // A line break is a space as far as searching goes: without it "der" at
      // the end of one line and "Ball" at the start of the next read as one
      // word and nothing matches either.
      if (item.hasEOL) text += '\n';
    }
    const built: PageText = { text, folded: fold(text), spans };
    textCache.current.set(n, built);
    return built;
  }, [doc]);

  /** Where a hit sits on its page, in CSS pixels from the page's top. */
  const hitOffset = useCallback(async (hit: Hit): Promise<number> => {
    try {
      const [page, text] = await Promise.all([doc!.getPage(hit.page), pageText(hit.page)]);
      const span = text.spans.find((s) => s.start < hit.end && s.end > hit.start);
      if (!span) return 0;
      const viewport = page.getViewport({ scale: scaleRef.current });
      const tx = pdfjsLib.Util.transform(viewport.transform, span.transform);
      return Math.max(0, tx[5] - (Math.hypot(tx[2], tx[3]) || 10));
    } catch {
      return 0;
    }
  }, [doc, pageText]);

  const goToHit = useCallback(async (index: number, list: Hit[] = hits, smooth = true) => {
    const hit = list[index];
    if (!hit) return;
    setHitIndex(index);
    const el = pageEl(hit.page);
    const box = scrollRef.current;
    if (!el || !box) return;
    // A third of the way down the screen, not at the top edge: on an iPad
    // with the keyboard up the top of the box is under the hit list.
    const y = await hitOffset(hit);
    box.scrollTo({ top: Math.max(0, pageTop(el) + y - box.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
  }, [hits, hitOffset]);

  useEffect(() => {
    const q = query.trim();
    if (!doc || q.length < 2) { setHits([]); setScanned(0); setSearching(false); setLooseHits(false); return; }
    let cancelled = false;
    // Word by word, with any run of spaces or line breaks between them: a
    // justified paragraph breaks a phrase over two lines as often as not, and
    // "doppelte berührung" typed with one space never matched "doppelte" at
    // the end of one line and "Berührung" at the start of the next.
    const words = fold(q).split(/\s+/).filter(Boolean);
    const phrase = phrasePattern(q)!;
    const timer = window.setTimeout(() => {
      void (async () => {
        const started = performance.now();
        setSearching(true);
        setHits([]);
        const found: Hit[] = [];
        // Every word on a page that has all of them: what is shown when the
        // phrase itself is nowhere — the rulebook says "Doppelberührung" or
        // "berührt den Ball zweimal", never what the coach typed.
        const loose: Hit[] = [];
        let unreadable = 0;
        const hitAt = (n: number, page: PageText, at: number, length: number): Hit => {
          const start = Math.max(0, at - 40);
          return {
            page: n,
            start: at,
            end: at + length,
            snippet: (start > 0 ? '…' : '') + page.text.slice(start, at + length + 40).replace(/\s+/g, ' ').trim() + '…',
          };
        };
        // From the page in view outwards, so the first results are the ones
        // next to what the coach is already reading.
        const from = currentRef.current;
        const order = [...Array(doc.numPages).keys()]
          .map((i) => i + 1)
          .sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
        for (let i = 0; i < order.length; i += 1) {
          if (cancelled) return;
          const n = order[i];
          let page: PageText;
          try { page = await pageText(n); } catch { unreadable += 1; continue; }
          for (const m of page.folded.matchAll(phrase)) found.push(hitAt(n, page, m.index ?? 0, m[0].length));
          if (words.length > 1 && words.every((w) => page.folded.includes(w))) {
            for (const w of words) {
              for (let at = page.folded.indexOf(w); at !== -1; at = page.folded.indexOf(w, at + w.length)) loose.push(hitAt(n, page, at, w.length));
            }
          }
          setScanned(i + 1);
          if (found.length && (i % 8 === 0 || i === order.length - 1)) {
            setHits([...found].sort((a, b) => a.page - b.page || a.start - b.start));
          }
        }
        if (cancelled) return;
        const byPlace = (a: Hit, b: Hit) => a.page - b.page || a.start - b.start;
        const wordByWord = !found.length && loose.length > 0;
        const sorted = (wordByWord ? loose : found).sort(byPlace);
        setLooseHits(wordByWord);
        setHits(sorted);
        setSearching(false);
        const landOn = landOnRef.current;
        landOnRef.current = 0;
        if (landOn) {
          // Opened on a hit from Home: start at that page's first match.
          const at = sorted.findIndex((h) => h.page >= landOn);
          if (at >= 0) void goToHit(at, sorted, false);
          else {
            setHitIndex(0);
            const el = pageEl(landOn);
            const box = scrollRef.current;
            if (el && box) box.scrollTo({ top: pageTop(el) - 12 });
          }
        } else if (typedRef.current && sorted.length) {
          // Typed here: show the first match from the page being read on,
          // the way a browser's find does. Until 27.10.2026 the list filled
          // and the page stayed where it was, and on an iPad mini, with the
          // keyboard over half the screen, that looked like no search at all.
          const at = sorted.findIndex((h) => h.page >= currentRef.current);
          void goToHit(Math.max(0, at), sorted);
        } else {
          setHitIndex(0);
        }
        if (typedRef.current) {
          // Counts only, never the term: whether a search on a real iPad
          // reads every page, how long that takes, and how often it finds
          // nothing.
          clientLog.info('pdf.search', 'searched a document in the reader', {
            pages: doc.numPages, hits: sorted.length, wordByWord, words: words.length, unreadable, chars: q.length, ms: Math.round(performance.now() - started),
          });
        }
      })();
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // `current` seeds the scan order; re-running the search when the reader
    // scrolls would be a new search on every wheel tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, doc, pageText]);

  const stepHit = useCallback((delta: number) => {
    if (!hits.length) return;
    void goToHit((hitIndex + delta + hits.length) % hits.length);
  }, [goToHit, hitIndex, hits.length]);

  // --- links --------------------------------------------------------------
  const followLink = useCallback(async (dest: unknown) => {
    if (!doc) return;
    const target = await resolveDest(doc, dest);
    const box = scrollRef.current;
    const el = target ? pageEl(target.page) : null;
    if (!target || !box || !el) return;
    let y = 0;
    if (target.y !== null) {
      try {
        const page = await doc.getPage(target.page);
        const viewport = page.getViewport({ scale: scaleRef.current });
        y = Math.max(0, Math.min(el.offsetHeight, viewport.convertToViewportPoint(0, target.y)[1]));
      } catch { /* the page's top, then */ }
    }
    const from = anchorAt(0);
    if (from) setBackTo(from);
    box.scrollTo({ top: Math.max(0, pageTop(el) + y - 12) });
  }, [doc, anchorAt]);

  const goBack = () => {
    if (!backTo) return;
    scrollToAnchor(backTo, 0);
    setBackTo(null);
  };

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The Notizblock is on top: its keys are its own.
      if (coveredRef.current) return;
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { // identity:display — a keyboard shortcut, not a name
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The page behind must not scroll while the reader is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  // Which page the header names. An IntersectionObserver per page answered
  // this with "whichever one reported last", which on an eleven-page document
  // meant the reader claimed page 3 while page 1 was on screen. The page under
  // the top edge of the viewport is the page you are reading.
  const onScroll = useCallback(() => {
    const top = anchorAt(0);
    if (top) lastAnchor.current = top;
    const reading = anchorAt(80);
    if (reading) setCurrent(reading.page);
    if (rememberAs) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, 400);
    }
  }, [anchorAt, rememberAs, save]);

  const hitsByPage = useMemo(() => {
    const map = new Map<number, Hit[]>();
    for (const hit of hits) {
      const list = map.get(hit.page);
      if (list) list.push(hit);
      else map.set(hit.page, [hit]);
    }
    return map;
  }, [hits]);

  // The words of each page for its text layer, kept while the reader is open:
  // a zoom lays them out again, it does not ask the worker for them again.
  const layerText = useRef(new Map<number, Promise<PdfTextContent>>());
  const textForLayer = useCallback((page: PdfPageProxy): Promise<PdfTextContent> => {
    const n = page.pageNumber;
    let pending = layerText.current.get(n);
    if (!pending) {
      pending = page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
      pending.catch(() => layerText.current.delete(n));
      layerText.current.set(n, pending);
    }
    return pending;
  }, []);

  const searchStatus = !doc
    ? t.notYet
    : searching && !hits.length
      ? t.scanning(scanned, doc.numPages)
      : hits.length ? `${hitIndex + 1}/${hits.length}` : t.noHits;
  const showLoose = looseHits && hits.length > 0 && !searching;

  return (
    <div className={`fixed inset-0 ${covered ? 'z-[45]' : 'z-[60]'} flex flex-col bg-stone-900/95 no-print`} role="dialog" aria-modal={!covered} aria-label={title}>
      <header className="flex-none bg-stone-900 text-stone-100 border-b border-stone-700">
        <div className="flex items-center gap-2 px-2 sm:px-3 h-12">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {backTo && (
            <button
              type="button"
              onClick={goBack}
              title={t.backTo(backTo.page)}
              aria-label={t.backTo(backTo.page)}
              className="inline-flex items-center gap-1 h-8 px-2 rounded-lg bg-stone-800 text-xs font-medium text-stone-100 hover:bg-stone-700 whitespace-nowrap"
            >
              <CornerUpLeft size={14} />
              {t.back}
              <span className="text-stone-400 tabular-nums">{t.pageShort} {backTo.page}</span>
            </button>
          )}
          {doc && (
            <span className="hidden sm:inline text-xs text-stone-400 tabular-nums whitespace-nowrap">
              {t.page} {current} {t.of} {doc.numPages}
            </span>
          )}
          {/* Zoom belongs on the phone most of all: these are landscape A4
              tables, and fit-width on a 390 px screen is text nobody can read.
              Only the percentage is desktop-only. */}
          <div className="flex items-center gap-0.5 sm:gap-1">
            <button type="button" onClick={() => zoomBy(-0.2)} aria-label={t.zoomOut} className="p-1.5 rounded hover:bg-stone-700"><Minus size={15} /></button>
            <span className="hidden sm:inline text-xs text-stone-400 tabular-nums w-10 text-center">{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoomBy(0.2)} aria-label={t.zoomIn} className="p-1.5 rounded hover:bg-stone-700"><Plus size={15} /></button>
          </div>
          {actions}
          {originalHref && <a href={originalHref} target="_blank" rel="noopener noreferrer" title={t.original} aria-label={t.original} className="p-1.5 rounded hover:bg-stone-700"><ExternalLink size={15} /></a>}
          <button type="button" onClick={onClose} aria-label={t.close} className="p-1.5 rounded hover:bg-stone-700"><X size={17} /></button>
        </div>

        <div className="flex items-center gap-2 px-2 sm:px-3 pb-2">
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
            {/* 16 px, not 14: Safari on an iPhone — and on an iPad mini, which
                gets the mobile site — zooms the whole page into any field
                with smaller type the moment it is tapped, and the reader came
                out of that zoom half off the screen. No autocorrect either: it
                "fixes" the very terms of art a coach searches for. */}
            <input
              id="pdf-search"
              ref={searchRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => { typedRef.current = true; setQuery(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } }}
              placeholder={t.search}
              aria-label={t.search}
              className="w-full h-9 pl-8 pr-3 rounded-lg bg-stone-800 border border-stone-700 text-base text-stone-100 placeholder:text-stone-500 focus:outline-none focus:border-stone-500 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          {query.trim().length >= 2 && (
            <>
              <span className="text-xs text-stone-400 tabular-nums whitespace-nowrap" aria-live="polite">{searchStatus}</span>
              {showLoose && <span className="hidden sm:inline text-xs text-amber-300/90 whitespace-nowrap" title={t.wordByWordHint}>{t.wordByWord}</span>}
              <button type="button" onClick={() => stepHit(-1)} disabled={!hits.length} aria-label={t.prevHit} className="p-1.5 rounded hover:bg-stone-700 disabled:opacity-40"><ChevronUp size={15} /></button>
              <button type="button" onClick={() => stepHit(1)} disabled={!hits.length} aria-label={t.nextHit} className="p-1.5 rounded hover:bg-stone-700 disabled:opacity-40"><ChevronDown size={15} /></button>
            </>
          )}
        </div>

        {hits.length > 0 && query.trim().length >= 2 && (
          <ul className="max-h-28 overflow-y-auto border-t border-stone-800 divide-y divide-stone-800">
            {hits.slice(0, 40).map((hit, i) => (
              <li key={`${hit.page}-${hit.start}`}>
                <button
                  type="button"
                  onClick={() => void goToHit(i)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-stone-800 ${i === hitIndex ? 'bg-stone-800 text-stone-100' : 'text-stone-400'}`}
                >
                  <span className="text-stone-500 tabular-nums mr-2">{t.pageShort} {hit.page}</span>
                  {hit.snippet}
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-pdf-scroll
        className="relative flex-1 overflow-auto overscroll-contain bg-stone-800 px-1.5 sm:px-6 py-3"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        {!doc && !failed && (
          <div className="h-full grid place-items-center text-stone-300">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={22} className="animate-spin" />
              <p className="text-sm">{t.loading}</p>
              {progress > 0 && (
                <div className="w-48 h-1 rounded-full bg-stone-700 overflow-hidden">
                  <div className="h-full bg-red-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
        {failed && (
          <div className="h-full grid place-items-center text-center px-6">
            <div>
              <p className="text-sm text-stone-300">{t.failed}</p>
              {originalHref ? (
                <a href={originalHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-3 text-sm text-red-400 hover:text-red-300 underline">
                  <ExternalLink size={14} /> {t.original}
                </a>
              ) : fallback}
            </div>
          </div>
        )}
        {doc && base && (
          // As wide as the widest page, and never narrower than the box: a
          // page zoomed past the width then scrolls into view from its left
          // edge, where centring it in a narrower column put its left part
          // out of reach.
          <div ref={pagesRef} className="relative flex flex-col items-center gap-3 w-max min-w-full">
            {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
              <Page
                key={n}
                doc={doc}
                num={n}
                scale={scale}
                base={base}
                hits={hitsByPage.get(n)}
                activeHit={hits[hitIndex]}
                pageText={pageText}
                textForLayer={textForLayer}
                onLink={followLink}
                linkLabel={t.jump}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One page: a placeholder until it is near the viewport; a canvas, its words
 * and its links once it is.
 *
 * A 300-page rulebook is 300 canvases if you let it, and a phone runs out of
 * memory long before that — so a page paints when it comes close and drops its
 * bitmap when it leaves. A zoom draws a new bitmap off screen and swaps it in
 * when it is done; until then the old one is stretched to the new size, so
 * the page never goes white under the reader.
 */
type PageProps = {
  /**
   * React strips this before the component ever sees it — it is declared
   * because the project ships without @types/react, so JSX attributes are
   * checked against these props alone, with no IntrinsicAttributes to hold a
   * key.
   */
  key?: number;
  doc: PdfDoc;
  num: number;
  scale: number;
  base: { w: number; h: number };
  hits?: Hit[];
  activeHit?: Hit;
  pageText: (n: number) => Promise<PageText>;
  textForLayer: (page: PdfPageProxy) => Promise<PdfTextContent>;
  onLink: (dest: unknown) => void;
  linkLabel: string;
};

/** Shrinking a canvas to nothing gives its memory back at once; iOS otherwise
 *  holds it until a garbage collection that may come too late. */
function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function Page({ doc, num, scale, base, hits, activeHit, pageText, textForLayer, onLink, linkLabel }: PageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  // This page's own size at 100 %, once known — most documents have one page
  // size, a few mix in a landscape table. The size on screen follows the zoom
  // in the same render, so a zoom's scroll correction measures the new layout.
  const [own, setOwn] = useState<{ w: number; h: number } | null>(null);
  const w = (own ?? base).w * scale;
  const h = (own ?? base).h * scale;
  const [rects, setRects] = useState<Rect[]>([]);
  const [activeRects, setActiveRects] = useState<Rect[]>([]);
  const [links, setLinks] = useState<LinkBox[]>([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: el.closest('[data-pdf-scroll]'), rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Away from the screen: no bitmap, no words, no links.
  useEffect(() => {
    if (near) return;
    const host = hostRef.current;
    if (host) { host.querySelectorAll('canvas').forEach(release); host.replaceChildren(); }
    textRef.current?.replaceChildren();
    setDrawn(false);
    setLinks([]);
  }, [near]);
  useEffect(() => {
    // Captured now: by the time an unmount's cleanup runs, the ref is empty.
    const host = hostRef.current;
    return () => { host?.querySelectorAll('canvas').forEach(release); };
  }, []);

  // The bitmap.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let canvas: HTMLCanvasElement | null = null;
    (async () => {
      let page: PdfPageProxy;
      try { page = await doc.getPage(num); } catch { return; }
      if (cancelled) return;
      const unit = page.getViewport({ scale: 1 });
      setOwn((prev) => (prev && prev.w === unit.width && prev.h === unit.height ? prev : { w: unit.width, h: unit.height }));
      const viewport = page.getViewport({ scale });
      const ratio = outputRatio(viewport.width, viewport.height);
      canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = 'absolute inset-0 block w-full h-full';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const render = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      task = render;
      try { await render.promise; } catch { return; /* superseded by a newer zoom */ }
      const host = hostRef.current;
      if (cancelled || !host) return;
      host.querySelectorAll('canvas').forEach(release);
      host.replaceChildren(canvas);
      canvas = null;
      setDrawn(true);
    })();
    return () => {
      cancelled = true;
      try { task?.cancel(); } catch { /* already done */ }
      if (canvas) release(canvas);
    };
  }, [near, doc, num, scale]);

  // The words, invisible over the picture of them, to select and copy.
  useEffect(() => {
    const container = textRef.current;
    if (!near || !container) return;
    let cancelled = false;
    let layer: InstanceType<typeof pdfjsLib.TextLayer> | null = null;
    (async () => {
      try {
        const page = await doc.getPage(num);
        const content = await textForLayer(page);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const fresh = document.createElement('div');
        fresh.className = 'pdf-text-layer';
        layer = new pdfjsLib.TextLayer({ textContentSource: content, container: fresh, viewport });
        await layer.render();
        if (cancelled) return;
        // What a drag past the last word lands on, so the selection does not
        // jump to the top of the page (pdf.js's viewer does the same).
        const end = document.createElement('div');
        end.className = 'endOfContent';
        fresh.append(end);
        container.replaceChildren(fresh);
      } catch { /* a page whose words will not come out can still be read */ }
    })();
    return () => { cancelled = true; try { layer?.cancel(); } catch { /* done */ } };
  }, [near, doc, num, scale, textForLayer]);

  // The links: the table of contents to its articles, and the odd web address.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(num);
        const annotations = await page.getAnnotations();
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const boxes: LinkBox[] = [];
        for (const a of annotations as Array<{ subtype?: string; rect?: number[]; dest?: unknown; url?: string }>) {
          if (a.subtype !== 'Link' || !a.rect) continue;
          const url = typeof a.url === 'string' && /^(https?:|mailto:)/i.test(a.url) ? a.url : null;
          if (!url && (a.dest === undefined || a.dest === null)) continue;
          const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
          const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
          boxes.push({
            left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
            dest: url ? null : a.dest, url,
          });
        }
        setLinks(boxes);
      } catch { setLinks([]); }
    })();
    return () => { cancelled = true; };
  }, [near, doc, num, scale]);

  // Highlights are drawn from the same text run that produced the hit, so
  // they land on the words the search actually matched.
  useEffect(() => {
    if (!near || !hits?.length) { setRects([]); setActiveRects([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const [page, text] = await Promise.all([doc.getPage(num), pageText(num)]);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const toRects = (hit: Hit): Rect[] => text.spans
          .filter((span) => span.start < hit.end && span.end > hit.start)
          .map((span) => {
            const tx = pdfjsLib.Util.transform(viewport.transform, span.transform);
            const height = Math.hypot(tx[2], tx[3]) || 10;
            const width = span.width * scale;
            const length = Math.max(1, span.end - span.start);
            const from = Math.max(hit.start, span.start) - span.start;
            const to = Math.min(hit.end, span.end) - span.start;
            return {
              left: tx[4] + (from / length) * width,
              top: tx[5] - height,
              width: Math.max(2, ((to - from) / length) * width),
              height,
            };
          });
        setRects(hits.flatMap(toRects));
        setActiveRects(activeHit && activeHit.page === num ? toRects(activeHit) : []);
      } catch { /* a page whose text will not come out simply gets no highlight */ }
    })();
    return () => { cancelled = true; };
  }, [near, doc, num, scale, hits, activeHit, pageText]);

  return (
    <div
      id={`pdf-page-${num}`}
      ref={wrapRef}
      data-page={num}
      className="relative shrink-0 bg-white shadow-lg"
      style={{ width: w, height: h, '--total-scale-factor': scale } as CSSProperties}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {!drawn && <span className="absolute inset-0 grid place-items-center text-xs text-stone-400 pointer-events-none">{num}</span>}
      {rects.map((r, i) => (
        <span key={i} className="absolute bg-amber-300/40 pointer-events-none rounded-[1px]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
      {activeRects.map((r, i) => (
        <span key={`a${i}`} className="absolute bg-amber-400/60 ring-1 ring-amber-500 pointer-events-none rounded-[1px]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
      <div ref={textRef} className="absolute inset-0" />
      {links.map((link, i) => {
        const box = { left: link.left, top: link.top, width: link.width, height: link.height };
        const cls = 'absolute z-10 rounded-sm hover:bg-blue-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
        return link.url ? (
          <a key={i} href={link.url} target="_blank" rel="noopener noreferrer" data-pdf-link className={cls} style={box} aria-label={link.url} />
        ) : (
          <button key={i} type="button" data-pdf-link className={cls} style={box} onClick={() => onLink(link.dest)} aria-label={linkLabel} />
        );
      })}
    </div>
  );
}
