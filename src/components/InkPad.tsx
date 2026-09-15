// The pen page: a fixed A4-ratio sheet of 1000 × 1414 logical units, drawn on
// with a stylus, a finger or a mouse, stored as strokes (never as a bitmap) so
// it survives any resize, any DPR and any device, and is small enough to sync.
//
// Two canvases: the PAGE holds the committed strokes and is re-rendered from
// the vectors whenever its size changes (the SignaturePad's snapshot-and-
// stretch trick is not needed when the source of truth is the stroke list);
// the LIVE canvas on top shows only the stroke in progress, once per frame,
// and is cleared when the stroke lands on the page.
//
// Pointer Events only. A pen is authoritative: once one has been seen, touch
// is ignored for drawing (the resting palm) unless the coach turns the finger
// back on; a mouse always draws (the desktop, and the test suite).
//
// Ink is checked against the SAME size predicate the server enforces, at
// stroke end, so a stroke that would not sync is refused at once rather than
// silently dropped hours later by a 413.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getStroke } from 'perfect-freehand';
import { NOTEBOOK_INK_MAX_CHARS, NOTEBOOK_INK_MAX_STROKES, inkSize, type InkPage, type InkStroke, type PageBackground } from '../lib/notebook';

export type InkTool = { kind: 'pen'; colour: 0 | 1 } | { kind: 'eraser' };

export type InkPadProps = {
  page: InkPage;
  bg: PageBackground;
  readOnly?: boolean;
  tool: InkTool;
  /** Touch draws. Off by default once a pen has been seen on this device. */
  fingerDraws: boolean;
  onPenSeen(): void;
  onStrokeEnd(stroke: InkStroke): void;
  onEraseStroke(index: number): void;
  /** The page cannot take this stroke (size or stroke count). */
  onFull(): void;
  /** The browser cancelled a stroke (Scribble, a gesture) — counted by the parent. */
  onCancelledStroke(): void;
  className?: string;
};

const COLOURS = ['#1c1917', '#b91c1c'];        // the app's ink, and Swiss Volley red
const PALM_MAX_CONTACT_PX = 40;                // a finger tip is smaller; a palm is not
const PEN_TRAILING_MS = 500;                   // touch stays ignored this long after the pen lifted
const ERASE_RADIUS_UNITS = 12;
const PAGE_W = 1000;
const PAGE_H = 1414;

/** Absolute samples of one stroke: [x, y, p01][] in page units. */
export function strokePoints(stroke: InkStroke): [number, number, number][] {
  const out: [number, number, number][] = [];
  const d = stroke.d;
  let x = 0; let y = 0;
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (i === 0) { x = d[0] / 10; y = d[1] / 10; }
    else { x += d[i] / 10; y += d[i + 1] / 10; }
    out.push([x, y, d[i + 2] / 100]);
  }
  return out;
}

function outlinePath(points: [number, number, number][], scale: number, stroke: { w: number; p: 0 | 1 }, live: boolean): Path2D | null {
  if (points.length === 0) return null;
  const outline = getStroke(points.map(([x, y, p]) => [x * scale, y * scale, p]), {
    size: Math.max(2, stroke.w * scale),
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: stroke.p === 0,
    last: !live,
  });
  if (outline.length === 0) return null;
  const path = new Path2D();
  const [x0, y0] = outline[0];
  path.moveTo(x0, y0);
  for (let i = 1; i < outline.length; i += 1) {
    const [x1, y1] = outline[i];
    const [x2, y2] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  path.closePath();
  return path;
}

export function renderStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, scale: number, live = false): void {
  const path = outlinePath(strokePoints(stroke), scale, stroke, live);
  if (!path) return;
  ctx.fillStyle = COLOURS[stroke.c] || COLOURS[0];
  ctx.fill(path);
}

/** The court a coach sketches positions on: 9 × 18 m, portrait, net across the
 *  middle, attack lines 3 m from it. Light lines under the ink, never part of it. */
export function renderBackground(ctx: CanvasRenderingContext2D, bg: PageBackground, scale: number): void {
  if (bg !== 'court') return;
  const left = 175 * scale; const right = 825 * scale;
  const top = 57 * scale; const bottom = 1357 * scale;
  const mid = (top + bottom) / 2;
  const attack = ((bottom - top) / 6);
  ctx.save();
  ctx.strokeStyle = '#d6d3d1';
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.beginPath(); ctx.moveTo(left, mid - attack); ctx.lineTo(right, mid - attack);
  ctx.moveTo(left, mid + attack); ctx.lineTo(right, mid + attack); ctx.stroke();
  // The net: heavier, and a little wider than the court like the real one.
  ctx.strokeStyle = '#a8a29e';
  ctx.lineWidth = Math.max(2, 5 * scale);
  ctx.beginPath(); ctx.moveTo(left - 30 * scale, mid); ctx.lineTo(right + 30 * scale, mid); ctx.stroke();
  ctx.restore();
}

export function renderPage(canvas: HTMLCanvasElement, page: InkPage, bg: PageBackground, dpr: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  const scale = canvas.width / dpr / PAGE_W;
  renderBackground(ctx, bg, scale);
  for (const stroke of page.strokes) renderStroke(ctx, stroke, scale);
}

export default function InkPad({ page, bg, readOnly, tool, fingerDraws, onPenSeen, onStrokeEnd, onEraseStroke, onFull, onCancelledStroke, className }: InkPadProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  // Everything about the stroke in progress lives in refs: pointer handlers are
  // attached once and must not close over a render.
  const activeRef = useRef<{ pointerId: number; samples: [number, number, number][]; t0: number; p: 0 | 1 } | null>(null);
  const penSeenAtRef = useRef(0);
  const rafRef = useRef(0);
  const propsRef = useRef({ page, bg, readOnly: !!readOnly, tool, fingerDraws, onPenSeen, onStrokeEnd, onEraseStroke, onFull, onCancelledStroke });
  propsRef.current = { page, bg, readOnly: !!readOnly, tool, fingerDraws, onPenSeen, onStrokeEnd, onEraseStroke, onFull, onCancelledStroke };

  // Size the canvases to the box. width/height are reassigned ONLY when the
  // computed size changed (assigning them resets the bitmap even for the same
  // value — the on-screen keyboard opening used to wipe the SignaturePad), and
  // a zero-width box (not laid out yet) is left alone.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const rect = box.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      setSize((prev) => (prev.w === w && prev.h === h && prev.dpr === dpr ? prev : { w, h, dpr }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(box);
    window.addEventListener('resize', measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Re-render the page from its vectors whenever the size or the page changes.
  useEffect(() => {
    const canvas = pageRef.current; const live = liveRef.current;
    if (!canvas || !live || size.w === 0) return;
    for (const c of [canvas, live]) {
      if (c.width !== size.w || c.height !== size.h) { c.width = size.w; c.height = size.h; }
    }
    renderPage(canvas, page, bg, size.dpr);
    const lctx = live.getContext('2d');
    if (lctx) { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height); }
  }, [page, bg, size]);

  // Release the bitmaps when the pad goes away: a phone runs out of canvas
  // memory long before it runs out of pages.
  useEffect(() => () => {
    for (const c of [pageRef.current, liveRef.current]) if (c) { c.width = 1; c.height = 1; }
  }, []);

  const drawLive = useCallback(() => {
    rafRef.current = 0;
    const live = liveRef.current; const active = activeRef.current;
    if (!live || !active) return;
    const ctx = live.getContext('2d');
    if (!ctx) return;
    const dpr = size.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    ctx.scale(dpr, dpr);
    const scale = live.width / dpr / PAGE_W;
    const t = propsRef.current.tool;
    const colour = t.kind === 'pen' ? t.colour : 0;
    const path = outlinePath(active.samples, scale, { w: 4, p: active.p }, true);
    if (path) { ctx.fillStyle = COLOURS[colour]; ctx.fill(path); }
  }, [size.dpr]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const toPage = (e: PointerEvent): [number, number] => {
      const rect = box.getBoundingClientRect();
      return [((e.clientX - rect.left) / rect.width) * PAGE_W, ((e.clientY - rect.top) / rect.height) * PAGE_H];
    };

    const eraseAt = (x: number, y: number) => {
      const strokes = propsRef.current.page.strokes;
      for (let i = strokes.length - 1; i >= 0; i -= 1) {
        for (const [sx, sy] of strokePoints(strokes[i])) {
          if (Math.hypot(sx - x, sy - y) <= ERASE_RADIUS_UNITS) { propsRef.current.onEraseStroke(i); return; }
        }
      }
    };

    // The policy: who may draw right now.
    const mayDraw = (e: PointerEvent): boolean => {
      if (propsRef.current.readOnly) return false;
      if (e.pointerType === 'pen') { penSeenAtRef.current = performance.now(); return true; }
      if (e.pointerType === 'touch') {
        if (!propsRef.current.fingerDraws) return false;
        if (performance.now() - penSeenAtRef.current < PEN_TRAILING_MS) return false;
        if (e.width > PALM_MAX_CONTACT_PX || e.height > PALM_MAX_CONTACT_PX) return false;
        return true;
      }
      return true;   // mouse
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'pen' && !penSeenAtRef.current) propsRef.current.onPenSeen();
      if (e.pointerType === 'pen') penSeenAtRef.current = performance.now();
      if (!mayDraw(e) || activeRef.current) return;
      e.preventDefault();
      const [x, y] = toPage(e);
      const eraserEnd = e.pointerType === 'pen' && e.button === 5;
      if (propsRef.current.tool.kind === 'eraser' || eraserEnd) {
        activeRef.current = { pointerId: e.pointerId, samples: [], t0: e.timeStamp, p: 0 };
        eraseAt(x, y);
        try { box.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
        return;
      }
      const p: 0 | 1 = e.pointerType === 'pen' && e.pressure > 0 ? 1 : 0;
      activeRef.current = { pointerId: e.pointerId, samples: [[x, y, p ? e.pressure : 0]], t0: e.timeStamp, p };
      // Capture AFTER the stroke started: setPointerCapture throws NotFoundError
      // for a pointer that is not active — every synthetic dispatch — and
      // unguarded it would abort the stroke and file a js.error.
      try { box.setPointerCapture(e.pointerId); } catch { /* see above */ }
      if (!rafRef.current) rafRef.current = requestAnimationFrame(drawLive);
    };

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'pen') penSeenAtRef.current = performance.now();
      const active = activeRef.current;
      // Gated on the tracked pointer, never on e.buttons (synthetic moves carry 0).
      if (!active || e.pointerId !== active.pointerId) return;
      e.preventDefault();
      if (active.samples.length === 0 && (propsRef.current.tool.kind === 'eraser' || active.p === 0 && e.pointerType === 'pen' && e.button === 5)) {
        const [x, y] = toPage(e); eraseAt(x, y); return;
      }
      if (active.samples.length === 0) return;   // an eraser drag
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of (list.length ? list : [e])) {
        const [x, y] = toPage(ev);
        const last = active.samples[active.samples.length - 1];
        if (last && Math.hypot(x - last[0], y - last[1]) < 1) continue;
        active.samples.push([x, y, active.p ? ev.pressure : 0]);
      }
      if (!rafRef.current) rafRef.current = requestAnimationFrame(drawLive);
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      const active = activeRef.current;
      if (!active || e.pointerId !== active.pointerId) return;
      activeRef.current = null;
      try { box.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      const live = liveRef.current;
      if (live) { const ctx = live.getContext('2d'); if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, live.width, live.height); } }
      if (active.samples.length === 0) return;   // the eraser
      if (cancelled) { propsRef.current.onCancelledStroke(); return; }
      const t = propsRef.current.tool;
      const stroke: InkStroke = { c: t.kind === 'pen' ? t.colour : 0, w: 4, p: active.p, d: [] };
      let px = 0; let py = 0;
      active.samples.forEach(([x, y, p], i) => {
        const X = Math.round(x * 10); const Y = Math.round(y * 10); const P = Math.round(Math.max(0, Math.min(1, p)) * 100);
        if (i === 0) stroke.d.push(X, Y, P, 0);
        else stroke.d.push(X - px, Y - py, P, Math.max(0, Math.round(e.timeStamp - active.t0)));
        px = X; py = Y;
      });
      const current = propsRef.current.page;
      const next: InkPage = { w: PAGE_W, h: PAGE_H, strokes: [...current.strokes, stroke] };
      if (next.strokes.length > NOTEBOOK_INK_MAX_STROKES || inkSize(next) > NOTEBOOK_INK_MAX_CHARS) { propsRef.current.onFull(); return; }
      propsRef.current.onStrokeEnd(stroke);
    };

    const up = (e: PointerEvent) => finish(e, false);
    const cancel = (e: PointerEvent) => finish(e, true);
    // The documented iPadOS Scribble workaround: a touchmove that is not
    // prevented lets the system claim the gesture.
    const touchMove = (e: TouchEvent) => { if (activeRef.current) e.preventDefault(); };

    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    box.addEventListener('touchmove', touchMove, { passive: false });
    return () => {
      box.removeEventListener('pointerdown', down);
      box.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      box.removeEventListener('touchmove', touchMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [drawLive]);

  return (
    <div
      ref={boxRef}
      data-testid="ink-page"
      className={className}
      style={{
        position: 'relative', aspectRatio: `${PAGE_W} / ${PAGE_H}`, maxWidth: '100%', maxHeight: '100%',
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
        background: '#fff', boxShadow: '0 0 0 1px #e7e5e4',
        cursor: tool.kind === 'eraser' ? 'cell' : 'crosshair',
      }}
    >
      <canvas ref={pageRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      <canvas ref={liveRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}
