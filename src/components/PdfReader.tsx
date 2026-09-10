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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Minus, Plus, Search, X } from 'lucide-react';
// The legacy build, deliberately. The default one calls Math.sumPrecise, which
// no Safari has yet — and half of these coaches read this on an iPhone in a
// gym. Where the modern build failed it did not fail loudly: font parsing threw,
// pdf.js substituted a font, and the page rendered every letter as the wrong
// glyph while the text underneath stayed perfectly searchable.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { fetchDocBytes } from '../lib/docCache';
import type { Lang } from '../lib/prefs';
import { clientLog } from '../lib/logger';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfLoadingTask = ReturnType<typeof pdfjsLib.getDocument>;
type PdfDoc = Awaited<PdfLoadingTask['promise']>;
type PdfPageProxy = Awaited<ReturnType<PdfDoc['getPage']>>;

/** One run of characters pdf.js drew as a unit, and where it sits on the page. */
type Span = { start: number; end: number; transform: number[]; width: number };
type PageText = { text: string; folded: string; spans: Span[] };
type Hit = { page: number; start: number; end: number; snippet: string };
type Rect = { left: number; top: number; width: number; height: number };

const STR = {
  DE: {
    search: 'Im Dokument suchen',
    noHits: 'Keine Treffer',
    hits: (n: number) => `${n} Treffer`,
    scanning: (a: number, b: number) => `Seite ${a} von ${b} durchsucht…`,
    page: 'Seite',
    of: 'von',
    loading: 'Dokument wird geladen…',
    failed: 'Das Dokument liess sich nicht laden.',
    original: 'Original öffnen',
    close: 'Schliessen',
    zoomIn: 'Grösser',
    zoomOut: 'Kleiner',
    prevHit: 'Vorheriger Treffer',
    nextHit: 'Nächster Treffer',
  },
  EN: {
    search: 'Search this document',
    noHits: 'No matches',
    hits: (n: number) => `${n} matches`,
    scanning: (a: number, b: number) => `searched page ${a} of ${b}…`,
    page: 'Page',
    of: 'of',
    loading: 'Loading the document…',
    failed: 'The document could not be loaded.',
    original: 'Open the original',
    close: 'Close',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    prevHit: 'Previous match',
    nextHit: 'Next match',
  },
} satisfies Record<Lang, Record<string, unknown>>;

/**
 * Lower-cased and stripped of accents, one character in one character out.
 *
 * Length has to survive folding: a hit is a pair of offsets into this string,
 * and the highlight is drawn from the original text at the same offsets. The
 * usual `normalize('NFD').replace(...)` shortens "ü" to "u" plus a mark and
 * every offset after it drifts.
 */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD')[0].toLowerCase();
    out += base.length === 1 ? base : ch.toLowerCase()[0] || ch;
  }
  return out;
}

export type PdfReaderProps = {
  url: string;
  title: string;
  originalHref: string;
  lang: Lang;
  onClose: () => void;
};

export default function PdfReader({ url, title, originalHref, lang, onClose }: PdfReaderProps) {
  const t = STR[lang];
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<number, PageText>());
  // The loading task, not the document, owns the worker — closing the reader
  // without destroying it leaves a worker thread per document opened.
  const taskRef = useRef<PdfLoadingTask | null>(null);

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [current, setCurrent] = useState(1);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [searching, setSearching] = useState(false);

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        const bytes = await fetchDocBytes(url, (p) => { if (!cancelled) setProgress(p); }, abort.signal);
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

  // Fit the page to the window, and keep fitting it while the window changes —
  // until someone zooms, which is a decision the reader should not undo.
  useEffect(() => {
    if (!base) return;
    const fit = () => {
      const el = scrollRef.current;
      if (!el || !fitWidth) return;
      const width = el.clientWidth - (window.innerWidth < 640 ? 12 : 48);
      setScale(Math.max(0.3, Math.min(3, width / base.w)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [base, fitWidth]);

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

  useEffect(() => {
    const q = query.trim();
    if (!doc || q.length < 2) { setHits([]); setScanned(0); setSearching(false); return; }
    let cancelled = false;
    const needle = fold(q);
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true);
        setHits([]);
        const found: Hit[] = [];
        // From the page in view outwards, so the first results are the ones
        // next to what the coach is already reading.
        const order = [...Array(doc.numPages).keys()]
          .map((i) => i + 1)
          .sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
        for (let i = 0; i < order.length; i += 1) {
          if (cancelled) return;
          const n = order[i];
          let page: PageText;
          try { page = await pageText(n); } catch { continue; }
          let at = page.folded.indexOf(needle);
          while (at !== -1) {
            const from = Math.max(0, at - 40);
            found.push({
              page: n,
              start: at,
              end: at + needle.length,
              snippet: (from > 0 ? '…' : '') + page.text.slice(from, at + needle.length + 40).replace(/\s+/g, ' ').trim() + '…',
            });
            at = page.folded.indexOf(needle, at + needle.length);
          }
          setScanned(i + 1);
          if (found.length && (i % 8 === 0 || i === order.length - 1)) {
            setHits([...found].sort((a, b) => a.page - b.page || a.start - b.start));
          }
        }
        if (cancelled) return;
        setHits(found.sort((a, b) => a.page - b.page || a.start - b.start));
        setHitIndex(0);
        setSearching(false);
      })();
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // `current` seeds the scan order; re-running the search when the reader
    // scrolls would be a new search on every wheel tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, doc, pageText]);

  const goToHit = useCallback((index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setHitIndex(index);
    const el = document.getElementById(`pdf-page-${hit.page}`);
    const box = scrollRef.current;
    if (el && box) box.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
  }, [hits]);

  const stepHit = useCallback((delta: number) => {
    if (!hits.length) return;
    goToHit((hitIndex + delta + hits.length) % hits.length);
  }, [goToHit, hitIndex, hits.length]);

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
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
    const box = scrollRef.current;
    const pages = box?.firstElementChild?.children;
    if (!box || !pages?.length) return;
    const at = box.scrollTop + 80;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((pages[mid] as HTMLElement).offsetTop <= at) lo = mid;
      else hi = mid - 1;
    }
    setCurrent(lo + 1);
  }, []);

  const hitsByPage = useMemo(() => {
    const map = new Map<number, Hit[]>();
    for (const hit of hits) {
      const list = map.get(hit.page);
      if (list) list.push(hit);
      else map.set(hit.page, [hit]);
    }
    return map;
  }, [hits]);

  const zoom = (delta: number) => {
    setFitWidth(false);
    setScale((s) => Math.max(0.3, Math.min(4, Number((s + delta).toFixed(2)))));
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-stone-900/95 no-print" role="dialog" aria-modal="true" aria-label={title}>
      <header className="flex-none bg-stone-900 text-stone-100 border-b border-stone-700">
        <div className="flex items-center gap-2 px-2 sm:px-3 h-12">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {doc && (
            <span className="hidden sm:inline text-xs text-stone-400 tabular-nums whitespace-nowrap">
              {t.page} {current} {t.of} {doc.numPages}
            </span>
          )}
          {/* Zoom belongs on the phone most of all: these are landscape A4
              tables, and fit-width on a 390 px screen is text nobody can read.
              Only the percentage is desktop-only. */}
          <div className="flex items-center gap-0.5 sm:gap-1">
            <button type="button" onClick={() => zoom(-0.2)} aria-label={t.zoomOut} className="p-1.5 rounded hover:bg-stone-700"><Minus size={15} /></button>
            <span className="hidden sm:inline text-xs text-stone-400 tabular-nums w-10 text-center">{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoom(0.2)} aria-label={t.zoomIn} className="p-1.5 rounded hover:bg-stone-700"><Plus size={15} /></button>
          </div>
          <a href={originalHref} target="_blank" rel="noopener noreferrer" title={t.original} aria-label={t.original} className="p-1.5 rounded hover:bg-stone-700"><ExternalLink size={15} /></a>
          <button type="button" onClick={onClose} aria-label={t.close} className="p-1.5 rounded hover:bg-stone-700"><X size={17} /></button>
        </div>

        <div className="flex items-center gap-2 px-2 sm:px-3 pb-2">
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
            <input
              id="pdf-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } }}
              placeholder={t.search}
              className="w-full h-9 pl-8 pr-3 rounded-lg bg-stone-800 border border-stone-700 text-sm text-stone-100 placeholder:text-stone-500 focus:outline-none focus:border-stone-500"
            />
          </div>
          {query.trim().length >= 2 && (
            <>
              <span className="text-xs text-stone-400 tabular-nums whitespace-nowrap">
                {searching && !hits.length
                  ? t.scanning(scanned, doc?.numPages || 0)
                  : hits.length ? `${hitIndex + 1}/${hits.length}` : t.noHits}
              </span>
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
                  onClick={() => goToHit(i)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-stone-800 ${i === hitIndex ? 'bg-stone-800 text-stone-100' : 'text-stone-400'}`}
                >
                  <span className="text-stone-500 tabular-nums mr-2">S. {hit.page}</span>
                  {hit.snippet}
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto overscroll-contain bg-stone-800 px-1.5 sm:px-6 py-3">
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
              <a href={originalHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-3 text-sm text-red-400 hover:text-red-300 underline">
                <ExternalLink size={14} /> {t.original}
              </a>
            </div>
          </div>
        )}
        {doc && base && (
          <div className="flex flex-col items-center gap-3">
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One page: a placeholder until it is near the viewport, a canvas once it is.
 *
 * A 300-page rulebook is 300 canvases if you let it, and a phone runs out of
 * memory long before that — so a page paints when it comes close and drops its
 * bitmap when it leaves.
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
};

function Page({ doc, num, scale, base, hits, activeHit, pageText }: PageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState({ w: base.w * scale, h: base.h * scale });
  const [rects, setRects] = useState<Rect[]>([]);
  const [activeRects, setActiveRects] = useState<Rect[]>([]);

  useEffect(() => {
    setSize({ w: base.w * scale, h: base.h * scale });
  }, [base.w, base.h, scale]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: el.closest('.overflow-auto'), rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const page: PdfPageProxy = await doc.getPage(num);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      setSize({ w: viewport.width, h: viewport.height });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const render = page.render({ canvas, canvasContext: ctx, viewport });
      task = render;
      try { await render.promise; } catch { /* superseded by a re-render */ }

      // Highlights are drawn from the same text run that produced the hit, so
      // they land on the words the search actually matched.
      if (cancelled || !hits?.length) { setRects([]); setActiveRects([]); return; }
      try {
        const text = await pageText(num);
        if (cancelled) return;
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
    return () => { cancelled = true; try { task?.cancel(); } catch { /* already done */ } };
  }, [near, doc, num, scale, hits, activeHit, pageText]);

  return (
    <div
      id={`pdf-page-${num}`}
      ref={wrapRef}
      className="relative bg-white shadow-lg max-w-full"
      style={{ width: size.w, height: size.h }}
    >
      {near ? (
        <canvas ref={canvasRef} className="block" style={{ width: size.w, height: size.h }} />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-xs text-stone-400">{num}</span>
      )}
      {rects.map((r, i) => (
        <span key={i} className="absolute bg-amber-300/40 pointer-events-none rounded-[1px]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
      {activeRects.map((r, i) => (
        <span key={`a${i}`} className="absolute bg-amber-400/60 ring-1 ring-amber-500 pointer-events-none rounded-[1px]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
    </div>
  );
}
