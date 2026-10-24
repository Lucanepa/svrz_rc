// The pen page: a fixed A4-ratio sheet of 1000 × 1414 logical units, drawn on
// with a stylus, a finger or a mouse, stored as strokes (never as a bitmap) so
// it survives any resize, any DPR and any device, and is small enough to sync.
//
// The pad is a STAGE that fills the grey area of the sheet. On it lie the
// PAPER (a white div, placed by the view) and two canvases the size of the
// stage: the PAGE canvas holds the committed strokes, the LIVE canvas on top
// only the stroke in progress. Both are drawn through the view's transform
// (lib/inkView.ts), so zooming never grows a bitmap: a page-sized canvas at
// 2.5× passes iPadOS's 16.7 MP per-canvas limit and stays blank. Each stroke's
// outline is computed once, in page units, and a frame of a pinch is only
// fills.
//
// Who may do what (the input router): the pen always draws. Two fingers pinch
// and move the page together. One finger moves the page while the finger
// does not draw (the default once a pen was seen) and draws when it does. A
// touch that starts while the pen is busy, within PEN_TRAILING_MS of it, or as
// a large contact, is a palm: ignored until it lifts. A mouse draws (the
// desktop, and the test suite); its wheel pans, and zooms with Ctrl or a
// trackpad pinch.
//
// Ink is checked against the SAME size predicate the server enforces, at
// stroke end, so a stroke that would not sync is refused at once rather than
// silently dropped hours later by a 413.

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type RefObject } from 'react';
import { freehandPath, type InkSample } from '../lib/inkPath';
import { INK_COLOURS, NEW_STROKE_W, minRadiusFor, outlineSamples, strokeOptions } from '../lib/inkStyle';
import {
  PAGE_H, PAGE_W, clampZoom, fitPageScale, pageVisibleWhole, panBy, pinchView, resizeView, scaleOf, toPage, topView, visibleRect, zoomAbout,
  zoomRange, zoomStepIn, zoomStepOut, type Point, type Stage, type View,
} from '../lib/inkView';
import { clientLog } from '../lib/logger';
import { NOTEBOOK_INK_MAX_CHARS, NOTEBOOK_INK_MAX_STROKES, inkSize, type InkPage, type InkStroke, type PageBackground } from '../lib/notebook';

export type InkTool = { kind: 'pen'; colour: 0 | 1 } | { kind: 'eraser' };

/** The zoom level (relative to fit-width) and its range on this stage. */
export type InkZoom = { z: number; min: number; max: number };

/** What the sheet around the pad may ask of it. */
export type InkPadControl = {
  zoomIn(): void;
  zoomOut(): void;
  /** The whole page. */
  zoomFit(): void;
  /** performance.now() of the pen's last contact with the page (down, a move
   *  while touching, up); 0 = none yet. Hover does not count: a coach holding
   *  the Pencil over the page still taps the toolbar with the other hand. */
  lastPenAt(): number;
};

export type InkPadProps = {
  page: InkPage;
  bg: PageBackground;
  readOnly?: boolean;
  tool: InkTool;
  /** Touch draws. Off by default once a pen has been seen on this device. */
  fingerDraws: boolean;
  /** The zoom level to open at, relative to fit-width. Read once, at the first layout. */
  initialZoom?: number;
  controlRef?: RefObject<InkPadControl | null>;
  /** The view's zoom changed, or its range did (a resize). `byUser` when the
   *  coach zoomed: a pinch, a wheel, a button. */
  onZoomChange?(zoom: InkZoom, byUser: boolean): void;
  onPenSeen(): void;
  onStrokeEnd(stroke: InkStroke): void;
  /** The eraser touched these strokes. Every call carries ALL the strokes this
   *  drag has touched so far, so a call made before the previous one was
   *  rendered loses nothing. */
  onErase(strokes: InkStroke[]): void;
  /** The page cannot take this stroke (size or stroke count). */
  onFull(): void;
  /** The browser cancelled a pen stroke (Scribble, a gesture) — counted by the parent. */
  onCancelledStroke(): void;
  className?: string;
};

/** A fingertip is smaller; a palm is hundreds of px. Not 40: WebKit reports
 *  width = 2 × UITouch.majorRadius, about 42 for a light fingertip, so the old
 *  rule took every finger for a palm. */
const PALM_MAX_CONTACT_PX = 80;
/** Touch stays a palm this long after the pen was last seen. */
const PEN_TRAILING_MS = 500;
/** A gesture that started moving this soon before the pen landed was the
 *  writing hand arriving first: it is undone. */
const PALM_LEAD_MS = 300;
/** A second finger this soon after the first turns a young finger stroke into a pinch. */
const PINCH_GRACE_MS = 250;
/** Fingers must move this far before the page moves: a resting hand stays still. */
const SLOP_PX = 8;
const ERASE_RADIUS_PX = 10;
/** Samples closer than this on screen are merged (keeping the higher pressure). */
const SAMPLE_MIN_PX = 0.6;
/** Pencil pressure is smoothed a little: its noise showed as width jitter. */
const PRESSURE_EMA = 0.5;
const WHEEL_REPORT_MS = 150;

/** Absolute samples of one stroke: [x, y, p01][] in page units. */
export function strokePoints(stroke: InkStroke): InkSample[] {
  const out: InkSample[] = [];
  const d = stroke.d;
  let x = 0; let y = 0;
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (i === 0) { x = d[0] / 10; y = d[1] / 10; }
    else { x += d[i] / 10; y += d[i + 1] / 10; }
    out.push([x, y, d[i + 2] / 100]);
  }
  return out;
}

// ── outlines, once per stroke ─────────────────────────────────────────
// Strokes are immutable and keep their identity through [...strokes, s],
// filter and slice, so a WeakMap keyed by the stroke object is the cache, and
// an erased or undone stroke takes its entry with it. Never one Path2D for
// several strokes: perfect-freehand outlines wind either way, and an overlap
// of opposite windings would be a hole.
type Shape = { path: Path2D; bbox: [number, number, number, number]; minR: number };
const shapes = new WeakMap<InkStroke, Shape | null>();

function shapeOf(stroke: InkStroke, minR: number): Shape | null {
  const hit = shapes.get(stroke);
  if (hit === null || (hit && hit.minR === minR)) return hit;
  const points = strokePoints(stroke);
  const path = freehandPath(outlineSamples(points, stroke.p === 1), strokeOptions(stroke, minR, true));
  if (!path) { shapes.set(stroke, null); return null; }
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // The radius never exceeds the size (the easing is at most 1) or the floor;
  // +2 covers perfect-freehand's [1, 1] offset for a single dot.
  const pad = Math.max(stroke.w, minR) + 2;
  const shape: Shape = { path, bbox: [x0 - pad, y0 - pad, x1 + pad, y1 + pad], minR };
  shapes.set(stroke, shape);
  return shape;
}

/** Distance from a point to the segment a–b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax; const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether the eraser at (x, y) with this radius touches the stroke: its
 *  segments, not only its samples, so a fast stroke with sparse samples is
 *  still hit. */
function eraserHits(stroke: InkStroke, x: number, y: number, radius: number, minR: number): boolean {
  const shape = shapeOf(stroke, minR);
  if (!shape) return false;
  const [b0, b1, b2, b3] = shape.bbox;
  if (x < b0 - radius || x > b2 + radius || y < b1 - radius || y > b3 + radius) return false;
  const reach = radius + stroke.w / 2;
  const pts = strokePoints(stroke);
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= reach;
  for (let i = 1; i < pts.length; i += 1) {
    if (segmentDistance(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
  }
  return false;
}

// ── the size guard ────────────────────────────────────────────────────
// inkSize() is JSON.stringify(page).length — the whole page, on every stroke
// end, on the main thread while the next letter's samples arrive. The same
// number from cached per-stroke lengths: the page with no strokes, plus each
// stroke as JSON, plus the commas between them.
const strokeChars = new WeakMap<InkStroke, number>();

function pageChars(page: InkPage): number {
  let n = JSON.stringify({ ...page, strokes: [] }).length;
  for (const s of page.strokes) {
    if (!s || typeof s !== 'object') return inkSize(page);   // not a stroke as we know it: count it the slow, sure way
    let c = strokeChars.get(s);
    if (c === undefined) { c = JSON.stringify(s).length; strokeChars.set(s, c); }
    n += c;
  }
  return n + Math.max(0, page.strokes.length - 1);
}

/** The court a coach sketches positions on: 9 × 18 m, portrait, net across the
 *  middle, attack lines 3 m from it. Light lines under the ink, never part of
 *  it. Drawn in page units under the view's transform; `scale` (CSS px per
 *  unit) keeps the lines at least a pixel wide at any zoom. */
export function renderBackground(ctx: CanvasRenderingContext2D, bg: PageBackground, scale: number): void {
  if (bg !== 'court') return;
  const left = 175; const right = 825;
  const top = 57; const bottom = 1357;
  const mid = (top + bottom) / 2;
  const attack = ((bottom - top) / 6);
  ctx.save();
  ctx.strokeStyle = '#d6d3d1';
  ctx.lineWidth = Math.max(2, 1 / scale);
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.beginPath(); ctx.moveTo(left, mid - attack); ctx.lineTo(right, mid - attack);
  ctx.moveTo(left, mid + attack); ctx.lineTo(right, mid + attack); ctx.stroke();
  // The net: heavier, and a little wider than the court like the real one.
  ctx.strokeStyle = '#a8a29e';
  ctx.lineWidth = Math.max(5, 2 / scale);
  ctx.beginPath(); ctx.moveTo(left - 30, mid); ctx.lineTo(right + 30, mid); ctx.stroke();
  ctx.restore();
}

// ── the engine: everything per frame lives here, outside React ─────────

type Sample = { x: number; y: number; p: number; t: number };
type Active = {
  pointerId: number;
  kind: 'pen' | 'touch' | 'mouse';
  startedAt: number;
  eraser: boolean;
  samples: Sample[];
  /** Page units under which two samples are one (SAMPLE_MIN_PX at this zoom). */
  minDist: number;
  /** A pen has reported a pressure above 0 in this stroke. */
  pressureSeen: boolean;
  ema: number;
  /** Strokes the eraser touched in this drag. */
  erased: Set<InkStroke>;
};
type TouchState = { x: number; y: number; tainted: boolean };
type Gesture = {
  kind: 'pan' | 'pinch';
  ids: number[];
  /** The view this motion is computed from, and the fingers' centroid and distance then. */
  start: View;
  c0: Point;
  d0: number;
  /** The view before the hand touched: what a palm-first gesture is undone to. */
  origin: View;
  engaged: boolean;
  engagedAt: number;
};
type Stats = {
  pen: number; touch: number; mouse: number;
  penZeroStart: number; penMoves: number; penCoalesced: number;
  cancels: number; palms: number; hist: number[]; zoomMax: number; slowFrameMs: number;
};

type Engine = {
  pageChanged(): void;
  zoomStep(dir: 1 | -1): void;
  zoomFit(): void;
  lastPenAt(): number;
  destroy(): void;
};

function createEngine(els: { stage: HTMLDivElement; paper: HTMLDivElement; pageCanvas: HTMLCanvasElement; liveCanvas: HTMLCanvasElement }, props: () => InkPadProps): Engine {
  const { stage, paper, pageCanvas, liveCanvas } = els;
  let stageSize: Stage | null = null;
  let rect = { left: 0, top: 0 };
  let view: View = { z: 1, ox: 0, oy: 0 };
  /** Bitmap px per CSS px, per axis: exact, so toPage inverts the drawing. */
  let kx = 1; let ky = 1;
  /** The thinnest radius a line draws with on this stage (lib/inkStyle.ts). */
  let minR = 0;
  /** What the page canvas shows now, so a stroke end can draw just that stroke. */
  let drawn: { strokes: InkStroke[]; bg: PageBackground; view: View; minR: number; w: number; h: number } | null = null;
  /** Strokes handed to onStrokeEnd that the page prop does not carry yet. */
  let pending: InkStroke[] = [];
  let frame = 0; let pageDirty = true; let liveDirty = false;
  let active: Active | null = null;
  const touches = new Map<number, TouchState>();
  let gesture: Gesture | null = null;
  /** The pen's last event, hover included: a touch this soon after is a palm. */
  let penAt = 0;
  /** The pen's last contact, hover not included: what the sheet's buttons ask. */
  let penContactAt = 0;
  let penSeen = false;
  let wheelTimer = 0; let wheelZ0: number | null = null;
  let webkitGesture: { z0: number } | null = null;
  const freshStats = (): Stats => ({ pen: 0, touch: 0, mouse: 0, penZeroStart: 0, penMoves: 0, penCoalesced: 0, cancels: 0, palms: 0, hist: new Array(10).fill(0), zoomMax: view.z, slowFrameMs: 0 });
  let stats = freshStats();

  const scale = () => (stageSize ? scaleOf(stageSize, view.z) : 1);
  const refreshRect = () => { const r = stage.getBoundingClientRect(); rect = { left: r.left, top: r.top }; };
  const stagePoint = (cx: number, cy: number): Point => ({ x: cx - rect.left, y: cy - rect.top });
  const pagePoint = (cx: number, cy: number): [number, number] => (stageSize ? toPage(stageSize, view, cx - rect.left, cy - rect.top) : [0, 0]);

  const report = (byUser: boolean) => {
    if (!stageSize) return;
    const r = zoomRange(stageSize);
    props().onZoomChange?.({ z: view.z, min: r.min, max: r.max }, byUser);
  };

  // ── drawing ──────────────────────────────────────────────────────────
  const withPageTransform = (ctx: CanvasRenderingContext2D, draw: (s: number) => void) => {
    const s = scale();
    ctx.save();
    ctx.setTransform(kx * s, 0, 0, ky * s, kx * view.ox, ky * view.oy);
    ctx.beginPath(); ctx.rect(0, 0, PAGE_W, PAGE_H); ctx.clip();
    draw(s);
    ctx.restore();
  };

  const strokesOnPage = (): InkStroke[] => {
    const strokes = props().page.strokes;
    return pending.length ? [...strokes, ...pending.filter((s) => !strokes.includes(s))] : strokes;
  };

  const drawPage = () => {
    pageDirty = false;
    const ctx = pageCanvas.getContext('2d');
    if (!ctx || !stageSize) return;
    const bg = props().bg;
    const strokes = strokesOnPage();
    const prev = drawn;
    if (prev && prev.bg === bg && prev.view === view && prev.minR === minR && prev.w === pageCanvas.width && prev.h === pageCanvas.height && strokes.length >= prev.strokes.length) {
      let same = true;
      for (let i = 0; i < prev.strokes.length; i += 1) if (prev.strokes[i] !== strokes[i]) { same = false; break; }
      if (same && strokes.length === prev.strokes.length) return;
      // The page plus one stroke (a stroke end, or a pull that brought one):
      // that stroke alone, on top, as a full render would have put it.
      if (same && strokes.length === prev.strokes.length + 1) {
        const shape = shapeOf(strokes[strokes.length - 1], minR);
        if (shape) withPageTransform(ctx, () => { ctx.fillStyle = INK_COLOURS[strokes[strokes.length - 1].c] || INK_COLOURS[0]; ctx.fill(shape.path); });
        drawn = { ...prev, strokes };
        return;
      }
    }
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
    withPageTransform(ctx, (s) => {
      renderBackground(ctx, bg, s);
      const [x0, y0, x1, y1] = visibleRect(stageSize!, view);
      let colour = -1;
      for (const stroke of strokes) {
        const shape = shapeOf(stroke, minR);
        if (!shape) continue;
        const b = shape.bbox;
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
        if (stroke.c !== colour) { ctx.fillStyle = INK_COLOURS[stroke.c] || INK_COLOURS[0]; colour = stroke.c; }
        ctx.fill(shape.path);
      }
    });
    stats.slowFrameMs = Math.max(stats.slowFrameMs, performance.now() - t0);
    drawn = { strokes, bg, view, minR, w: pageCanvas.width, h: pageCanvas.height };
  };

  const drawLive = () => {
    liveDirty = false;
    const ctx = liveCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    const a = active;
    if (!a || a.eraser || a.samples.length === 0 || !stageSize) return;
    const t = props().tool;
    const style = { w: NEW_STROKE_W, p: (a.pressureSeen ? 1 : 0) as 0 | 1 };
    const path = freehandPath(outlineSamples(a.samples.map((s) => [s.x, s.y, s.p]), style.p === 1), strokeOptions(style, minR, false));
    if (path) withPageTransform(ctx, () => { ctx.fillStyle = INK_COLOURS[t.kind === 'pen' ? t.colour : 0]; ctx.fill(path); });
  };

  /** Paper and ink in the same frame, or the page would lag its own ink. */
  const renderNow = () => {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!stageSize) return;
    const s = scale();
    paper.style.width = `${PAGE_W * s}px`;
    paper.style.height = `${PAGE_H * s}px`;
    paper.style.transform = `translate(${view.ox}px, ${view.oy}px)`;
    stage.dataset.zoom = view.z.toFixed(2);
    if (pageDirty) drawPage();
    if (liveDirty) drawLive();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderNow(); }); };

  const setView = (v: View, now = false) => {
    view = v;
    stats.zoomMax = Math.max(stats.zoomMax, v.z);
    pageDirty = true;
    if (now) renderNow(); else schedule();
  };

  // ── the stage's size ─────────────────────────────────────────────────
  // The canvases are reassigned ONLY when their size changed (assigning
  // resets the bitmap even for the same value — the on-screen keyboard
  // opening used to wipe the SignaturePad), and a stage not laid out yet is
  // left alone. Zoom never changes them.
  const measure = () => {
    const r = stage.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    rect = { left: r.left, top: r.top };
    const next: Stage = { w: r.width, h: r.height };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(next.w * dpr); const bh = Math.round(next.h * dpr);
    let resized = false;
    for (const c of [pageCanvas, liveCanvas]) if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; resized = true; }
    const moved = !stageSize || stageSize.w !== next.w || stageSize.h !== next.h;
    if (!moved && !resized) return;
    kx = bw / next.w; ky = bh / next.h;
    if (moved) {
      view = stageSize ? resizeView(stageSize, next, view) : topView(next, clampZoom(next, props().initialZoom ?? 1));
      if (!stageSize) stats.zoomMax = view.z;
      stageSize = next;
      minR = minRadiusFor(fitPageScale(next));
    }
    pageDirty = true; liveDirty = !!active;
    renderNow();
    if (moved) report(false);
  };

  // ── strokes ──────────────────────────────────────────────────────────
  const clearLive = () => { liveDirty = true; drawLive(); };

  const addSample = (a: Active, x: number, y: number, raw: number, t: number) => {
    let p = 0;
    if (a.kind === 'pen') {
      // A 0 is "no reading" (Safari can report it on the first event, and
      // the Pencil on some moves), never a pressure: the stroke's first real
      // value is backfilled over the zeros before it.
      if (raw > 0) {
        stats.hist[Math.min(9, Math.floor(raw * 10))] += 1;
        if (!a.pressureSeen) { a.pressureSeen = true; a.ema = raw; for (const s of a.samples) s.p = raw; }
        else a.ema = PRESSURE_EMA * raw + (1 - PRESSURE_EMA) * a.ema;
      }
      p = a.pressureSeen ? a.ema : 0;
    }
    const last = a.samples[a.samples.length - 1];
    // A merged sample keeps the higher pressure: the force rises over the
    // first samples while the tip barely moves, and dropping them left every
    // stroke starting in a hairline.
    if (last && Math.hypot(x - last.x, y - last.y) < a.minDist) { if (p > last.p) last.p = p; return; }
    a.samples.push({ x, y, p, t });
  };

  const coalesced = (e: PointerEvent): PointerEvent[] => {
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    return list.length ? list : [e];
  };

  const flushErase = (force: boolean) => {
    const a = active;
    if (!a || a.erased.size === 0) return;
    // A finger may still become a pinch: what it rubbed out waits until then.
    if (a.kind === 'touch' && !force && performance.now() - a.startedAt < PINCH_GRACE_MS) return;
    props().onErase([...a.erased]);
  };

  const eraseAt = (x: number, y: number) => {
    const a = active;
    if (!a) return;
    const radius = ERASE_RADIUS_PX / scale();
    let hit = false;
    for (const s of props().page.strokes) {
      if (!a.erased.has(s) && eraserHits(s, x, y, radius, minR)) { a.erased.add(s); hit = true; }
    }
    if (hit) flushErase(false);
  };

  const startStroke = (e: PointerEvent, kind: Active['kind'], now: number): boolean => {
    if (!stageSize) return false;
    refreshRect();
    const [x, y] = pagePoint(e.clientX, e.clientY);
    // The grey around the paper starts nothing.
    if (x < 0 || x > PAGE_W || y < 0 || y > PAGE_H) return false;
    e.preventDefault();
    const eraser = props().tool.kind === 'eraser' || (kind === 'pen' && e.button === 5);
    active = { pointerId: e.pointerId, kind, startedAt: now, eraser, samples: [], minDist: SAMPLE_MIN_PX / scale(), pressureSeen: false, ema: 0, erased: new Set() };
    // Capture AFTER the stroke started: setPointerCapture throws NotFoundError
    // for a pointer that is not active — every synthetic dispatch — and
    // unguarded it would abort the stroke and file a js.error.
    try { stage.setPointerCapture(e.pointerId); } catch { /* see above */ }
    if (eraser) { eraseAt(x, y); return true; }
    if (kind === 'pen' && !(e.pressure > 0)) stats.penZeroStart += 1;
    addSample(active, x, y, kind === 'pen' ? e.pressure : 0, e.timeStamp);
    liveDirty = true; schedule();
    return true;
  };

  /** A finger stroke that turned out to be the start of a pinch, or that the
   *  pen overrode: gone without a trace, and not a cancelled stroke (that
   *  counter is the Scribble hint's). */
  const dropActive = () => {
    const a = active;
    if (!a) return;
    active = null;
    try { stage.releasePointerCapture(a.pointerId); } catch { /* not captured */ }
    clearLive();
  };

  const finish = (e: PointerEvent, cancelled: boolean) => {
    const a = active;
    if (!a) return;
    active = null;
    try { stage.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const p = props();
    if (cancelled) stats.cancels += 1;
    // A cancelled touch was not the coach's: iPadOS cancels a contact it took
    // for the palm under the Pencil, and one an edge swipe claimed. It goes
    // without a trace, with whatever its eraser rubbed out and had not handed
    // over yet.
    if (cancelled && a.kind === 'touch') { clearLive(); return; }
    if (a.eraser) { flushErase(true); clearLive(); return; }
    // A cancelled pen stroke keeps what was drawn: iPadOS cancels a stroke it
    // hands to Scribble or a system gesture, and the coach's ink vanishing
    // looked exactly like "it does not recognise my handwriting". Scribble is
    // the Pencil's, so only the pen counts for its hint.
    if (cancelled && a.kind === 'pen') p.onCancelledStroke();
    if (a.samples.length === 0 || (cancelled && a.samples.length < 2)) { clearLive(); return; }
    const realPressure = a.kind === 'pen' && a.pressureSeen;
    const stroke: InkStroke = { c: p.tool.kind === 'pen' ? p.tool.colour : 0, w: NEW_STROKE_W, p: realPressure ? 1 : 0, d: [] };
    let px = 0; let py = 0; let pms = 0;
    const t0 = a.samples[0].t;
    a.samples.forEach((s, i) => {
      const X = Math.round(s.x * 10); const Y = Math.round(s.y * 10);
      const P = realPressure ? Math.round(Math.max(0, Math.min(1, s.p)) * 100) : 0;
      // Each sample's own time since the one before it, rounded on the
      // running total so the deltas add up to the stroke's duration.
      const ms = Math.round(s.t - t0);
      if (i === 0) stroke.d.push(X, Y, P, 0);
      else stroke.d.push(X - px, Y - py, P, Math.max(0, ms - pms));
      px = X; py = Y; pms = ms;
    });
    const current = p.page;
    const size = pageChars(current) + JSON.stringify(stroke).length + (current.strokes.length ? 1 : 0);
    if (current.strokes.length + 1 > NOTEBOOK_INK_MAX_STROKES || size > NOTEBOOK_INK_MAX_CHARS) { clearLive(); p.onFull(); return; }
    stats[a.kind] += 1;
    // On the page canvas now, in the frame the live layer clears: the line
    // never blinks while the sheet re-renders.
    pending.push(stroke);
    pageDirty = true;
    liveDirty = true;
    renderNow();
    p.onStrokeEnd(stroke);
  };

  // ── gestures ─────────────────────────────────────────────────────────
  const fingerPoints = (ids: number[]): Point[] | null => {
    const pts: Point[] = [];
    for (const id of ids) { const t = touches.get(id); if (!t) return null; pts.push(stagePoint(t.x, t.y)); }
    return pts;
  };
  const centroid = (pts: Point[]): Point => ({ x: pts.reduce((n, q) => n + q.x, 0) / pts.length, y: pts.reduce((n, q) => n + q.y, 0) / pts.length });

  const startGesture = (kind: Gesture['kind'], ids: number[]) => {
    refreshRect();
    const pts = fingerPoints(ids);
    if (!pts) return;
    const prev = gesture;
    gesture = {
      kind, ids, start: view, c0: centroid(pts), d0: kind === 'pinch' ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      origin: prev ? prev.origin : view,
      // A pan already moving goes on moving as a pinch, from where it is.
      engaged: !!prev && prev.engaged, engagedAt: prev ? prev.engagedAt : 0,
    };
  };

  const endGesture = () => {
    const g = gesture;
    gesture = null;
    if (g && g.engaged && view.z !== g.origin.z) report(true);
  };

  const taintAll = () => {
    for (const t of touches.values()) if (!t.tainted) { t.tainted = true; stats.palms += 1; }
  };

  const onTouchDown = (e: PointerEvent, now: number) => {
    const p = props();
    const palm = e.width > PALM_MAX_CONTACT_PX || e.height > PALM_MAX_CONTACT_PX;
    const penBusy = !p.readOnly && ((!!active && active.kind === 'pen') || now - penAt < PEN_TRAILING_MS);
    const t: TouchState = { x: e.clientX, y: e.clientY, tainted: palm || penBusy };
    touches.set(e.pointerId, t);
    try { stage.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
    e.preventDefault();
    if (t.tainted) { stats.palms += 1; return; }
    if (active) {
      if (active.kind === 'touch' && now - active.startedAt < PINCH_GRACE_MS) dropActive();
      else { t.tainted = true; stats.palms += 1; return; }
    }
    const free = [...touches.entries()].filter(([, v]) => !v.tainted).map(([id]) => id);
    if (free.length >= 2) {
      if (gesture && gesture.kind === 'pinch') return;   // a third finger changes nothing
      startGesture('pinch', gesture ? [gesture.ids[0], e.pointerId] : [free[0], free[1]]);
      return;
    }
    // One finger: it draws when the finger draws (and the margin around the
    // paper, where nothing draws, moves the page); otherwise it moves the page.
    if (p.fingerDraws && !p.readOnly && startStroke(e, 'touch', now)) return;
    startGesture('pan', [e.pointerId]);
  };

  const onTouchMove = (e: PointerEvent, now: number) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    t.x = e.clientX; t.y = e.clientY;
    const g = gesture;
    if (t.tainted || !g || !g.ids.includes(e.pointerId) || !stageSize) return;
    const pts = fingerPoints(g.ids);
    if (!pts) return;
    const c = centroid(pts);
    const d = g.kind === 'pinch' ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    if (!g.engaged) {
      if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) <= SLOP_PX && Math.abs(d - g.d0) <= SLOP_PX) return;
      g.engaged = true; g.engagedAt = now;
    }
    setView(g.kind === 'pinch' ? pinchView(stageSize, g.start, g.c0, g.d0, c, d) : panBy(stageSize, g.start, c.x - g.c0.x, c.y - g.c0.y));
  };

  const touchLeftGesture = (id: number, cancelled: boolean, now: number) => {
    const g = gesture;
    if (!g) return;
    // iPadOS cancels a touch it decided was a palm: what it moved is undone.
    if (cancelled && g.engaged && now - g.engagedAt < PALM_LEAD_MS) setView(g.origin);
    const rest = g.ids.filter((x) => x !== id && touches.has(x) && !touches.get(x)!.tainted);
    const p = props();
    if (g.kind === 'pinch' && rest.length === 1) {
      if (!p.fingerDraws || p.readOnly) {
        refreshRect();
        const t = touches.get(rest[0])!;
        // From where the finger is now, and only as engaged as the pinch was:
        // two contacts of a resting hand that never moved the page, one of
        // them lifting, must not let the other drag the page from its first
        // pixel, nor out of reach of the palm-first undo.
        gesture = { kind: 'pan', ids: rest, start: view, c0: stagePoint(t.x, t.y), d0: 0, origin: g.origin, engaged: g.engaged, engagedAt: g.engagedAt };
        return;
      }
      // A pinch never turns into a stroke.
      touches.get(rest[0])!.tainted = true;
    }
    endGesture();
  };

  // ── pointer listeners ────────────────────────────────────────────────
  const onDown = (e: PointerEvent) => {
    const now = performance.now();
    const p = props();
    if (e.pointerType === 'pen') {
      penAt = now; penContactAt = now;
      if (!penSeen) { penSeen = true; p.onPenSeen(); }
      // The hand landed first and moved the page: put it back.
      if (gesture) { if (gesture.engaged && now - gesture.engagedAt < PALM_LEAD_MS) setView(gesture.origin, true); endGesture(); }
      taintAll();
      // The pen wins over a finger stroke (the palm got there first).
      if (active && active.kind === 'touch') dropActive();
      if (active || p.readOnly) return;
      startStroke(e, 'pen', now);
      return;
    }
    if (e.pointerType === 'touch') { onTouchDown(e, now); return; }
    if (p.readOnly || active || gesture || e.button !== 0) return;
    startStroke(e, 'mouse', now);
  };

  const onMove = (e: PointerEvent) => {
    const now = performance.now();
    const a = active;
    // Hovering counts for the page's palm rule (an iPad Pro sees the Pencil
    // before it touches), but only a touching pen for the sheet's buttons.
    if (e.pointerType === 'pen') {
      penAt = now;
      if (e.buttons > 0 || (a && a.pointerId === e.pointerId)) penContactAt = now;
    }
    if (a && e.pointerId === a.pointerId) {
      // Gated on the tracked pointer, never on e.buttons (synthetic moves carry 0).
      e.preventDefault();
      if (a.kind === 'touch') { const t = touches.get(e.pointerId); if (t) { t.x = e.clientX; t.y = e.clientY; } }
      const list = coalesced(e);
      if (a.eraser) { for (const ev of list) { const [x, y] = pagePoint(ev.clientX, ev.clientY); eraseAt(x, y); } flushErase(false); return; }
      if (a.kind === 'pen') { stats.penMoves += 1; stats.penCoalesced += list.length; }
      for (const ev of list) {
        const [x, y] = pagePoint(ev.clientX, ev.clientY);
        addSample(a, x, y, a.kind === 'pen' ? ev.pressure : 0, ev.timeStamp);
      }
      liveDirty = true; schedule();
      return;
    }
    if (e.pointerType === 'touch') onTouchMove(e, now);
  };

  const onEnd = (e: PointerEvent, cancelled: boolean) => {
    const now = performance.now();
    if (e.pointerType === 'pen') { penAt = now; penContactAt = now; }
    if (active && e.pointerId === active.pointerId) finish(e, cancelled);
    if (touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (gesture && gesture.ids.includes(e.pointerId)) touchLeftGesture(e.pointerId, cancelled, now);
    }
  };
  const onUp = (e: PointerEvent) => onEnd(e, false);
  const onCancel = (e: PointerEvent) => onEnd(e, true);

  // The documented iPadOS Scribble workaround: a touchmove that is not
  // prevented lets the system claim the Pencil's gesture. Every touch on the
  // stage is the pad's (a pan, a pinch, a palm), so every one is prevented.
  const onTouchMoveNative = (e: TouchEvent) => { e.preventDefault(); };

  // ── wheel and WebKit gestures (desktop, Mac trackpad) ────────────────
  const onWheel = (e: WheelEvent) => {
    // Chrome, Edge and Firefox send a trackpad pinch as Ctrl + wheel; on the
    // pad it must never zoom the whole app instead, not even mid-stroke.
    if (e.ctrlKey) e.preventDefault();
    if (!stageSize || active || gesture) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageSize.h : 1;
    if (e.ctrlKey) {
      if (webkitGesture) return;
      refreshRect();
      const dy = Math.max(-100, Math.min(100, e.deltaY * unit));
      const c = stagePoint(e.clientX, e.clientY);
      if (wheelZ0 === null) wheelZ0 = view.z;
      setView(zoomAbout(stageSize, view, view.z * Math.exp(-dy * 0.004), c.x, c.y));
    } else {
      // Scrolling moves a page bigger than the stage; a page that fits lets
      // the wheel through.
      if (pageVisibleWhole(stageSize, view)) return;
      e.preventDefault();
      if (wheelZ0 === null) wheelZ0 = view.z;
      setView(panBy(stageSize, view, -e.deltaX * unit, -e.deltaY * unit));
    }
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => { const z0 = wheelZ0; wheelZ0 = null; if (z0 !== null && z0 !== view.z) report(true); }, WHEEL_REPORT_MS);
  };

  type WebKitGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
  // Safari's own pinch would zoom the whole app around the pad. On an iPad
  // the pointer path above does the pinch, so these are only prevented; with
  // no touch pointer down they are a Mac trackpad (or a Magic Keyboard's), and
  // drive the zoom.
  const onGestureStart = (e: Event) => { e.preventDefault(); webkitGesture = { z0: view.z }; };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as WebKitGestureEvent;
    if (!webkitGesture || !stageSize || touches.size || active || gesture || typeof g.scale !== 'number') return;
    refreshRect();
    const c = typeof g.clientX === 'number' && typeof g.clientY === 'number' ? stagePoint(g.clientX, g.clientY) : { x: stageSize.w / 2, y: stageSize.h / 2 };
    setView(zoomAbout(stageSize, view, webkitGesture.z0 * g.scale, c.x, c.y));
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    const g = webkitGesture;
    webkitGesture = null;
    if (g && g.z0 !== view.z) report(true);
  };

  /** The app went away mid-gesture: a missed pointerup must not leave a
   *  finger "down" that blocks the next pinch. */
  const forgetTouches = () => {
    touches.clear();
    if (gesture) endGesture();
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') { forgetTouches(); logVisit(); } };

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  stage.addEventListener('touchmove', onTouchMoveNative, { passive: false });
  // Natively and not passive: React's onWheel cannot prevent the browser's zoom.
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('gesturestart', onGestureStart);
  stage.addEventListener('gesturechange', onGestureChange);
  stage.addEventListener('gestureend', onGestureEnd);
  window.addEventListener('blur', forgetTouches);
  // On the window, in the capture phase: ahead of the logger's listener on the
  // document, which ships what is queued as the app goes to the background.
  window.addEventListener('visibilitychange', onVisibility, true);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
  if (ro) ro.observe(stage);
  window.addEventListener('resize', measure);
  measure();

  /** One line per page visit, numbers only: which of the causes behind thin or
   *  missing ink (a first pressure of 0, 60 Hz sampling, cancels, palms) a
   *  real iPad has, without reading a private notebook. Never a coordinate.
   *  Also filed when the app goes to the background, with the counts since the
   *  last line: iOS may end a suspended PWA without another event, and these
   *  numbers are the ones that settle the palm width and the first pressure of
   *  0 on a real iPad. */
  const logVisit = () => {
    const strokes = stats.pen + stats.touch + stats.mouse;
    if (!strokes && !stats.cancels && !stats.palms) return;
    const total = stats.hist.reduce((n, c) => n + c, 0);
    let median: number | null = null;
    for (let i = 0, run = 0; total && i < 10; i += 1) { run += stats.hist[i]; if (run >= total / 2) { median = i / 10; break; } }
    clientLog.info('ink.page', 'pen page input', {
      pen: stats.pen,
      touch: stats.touch,
      mouse: stats.mouse,
      penZeroStart: stats.penZeroStart,
      coalescedPerMove: stats.penMoves ? Math.round((stats.penCoalesced / stats.penMoves) * 10) / 10 : null,
      cancels: stats.cancels,
      palms: stats.palms,
      pressureMedian: median,
      zoomMax: Math.round(stats.zoomMax * 100) / 100,
      slowFrameMs: Math.round(stats.slowFrameMs),
    });
    stats = freshStats();
  };

  return {
    pageChanged() {
      pending = [];
      pageDirty = true;
      renderNow();
    },
    zoomStep(dir) {
      if (!stageSize || active) return;
      const z = dir > 0 ? zoomStepIn(stageSize, view.z) : zoomStepOut(stageSize, view.z);
      setView(zoomAbout(stageSize, view, z, stageSize.w / 2, stageSize.h / 2), true);
      report(true);
    },
    zoomFit() {
      if (!stageSize || active) return;
      setView(zoomAbout(stageSize, view, zoomRange(stageSize).min, stageSize.w / 2, stageSize.h / 2), true);
      report(true);
    },
    lastPenAt: () => penContactAt,
    destroy() {
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      stage.removeEventListener('touchmove', onTouchMoveNative);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', onGestureStart);
      stage.removeEventListener('gesturechange', onGestureChange);
      stage.removeEventListener('gestureend', onGestureEnd);
      window.removeEventListener('blur', forgetTouches);
      window.removeEventListener('visibilitychange', onVisibility, true);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      touches.clear(); gesture = null; active = null;
      logVisit();
      // Release the bitmaps: a phone runs out of canvas memory long before it
      // runs out of pages.
      for (const c of [pageCanvas, liveCanvas]) { c.width = 1; c.height = 1; }
    },
  };
}

export default function InkPad(props: InkPadProps) {
  const { tool, controlRef, className } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  // The engine's listeners are attached once and read the props through this.
  const propsRef = useRef(props);
  propsRef.current = props;

  useLayoutEffect(() => {
    const stage = stageRef.current; const paper = paperRef.current; const pageCanvas = pageRef.current; const liveCanvas = liveRef.current;
    if (!stage || !paper || !pageCanvas || !liveCanvas) return;
    const engine = createEngine({ stage, paper, pageCanvas, liveCanvas }, () => propsRef.current);
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.pageChanged(); }, [props.page, props.bg]);

  useImperativeHandle(controlRef, () => ({
    zoomIn: () => engineRef.current?.zoomStep(1),
    zoomOut: () => engineRef.current?.zoomStep(-1),
    zoomFit: () => engineRef.current?.zoomFit(),
    lastPenAt: () => engineRef.current?.lastPenAt() ?? 0,
  }), []);

  return (
    <div
      ref={stageRef}
      data-testid="ink-stage"
      className={className}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        touchAction: 'none', overscrollBehavior: 'contain',
        userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
        cursor: tool.kind === 'eraser' ? 'cell' : 'crosshair',
      }}
    >
      <div
        ref={paperRef}
        data-testid="ink-page"
        aria-hidden="true"
        style={{ position: 'absolute', left: 0, top: 0, background: '#fff', boxShadow: '0 0 0 1px #e7e5e4', pointerEvents: 'none', transformOrigin: '0 0' }}
      />
      <canvas ref={pageRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      <canvas ref={liveRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}
