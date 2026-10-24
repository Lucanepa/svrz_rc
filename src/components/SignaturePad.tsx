// The signature pad: one canvas, the strokes kept as vectors in pad units
// (1000 × 400, the 5:2 box it is drawn in) and the bitmap always rendered from
// them. A resize, a rotation or the keyboard opening re-renders the same
// strokes at the new size; nothing is stretched, nothing is lost.
//
// The pointer policy is the notebook's (InkPad.tsx), adapted so a finger can
// still sign: one pointer draws at a time, tracked by its id, and a pen is
// authoritative. Before this, one shared "drawing" flag took every pointer, so
// a palm landing on the pad drew a straight line into the Pencil's stroke and a
// palm lifting anywhere on screen ended it (Jennifer, 23.10.2026).
//
// The line is perfect-freehand through the shared helper (src/lib/inkPath.ts):
// real pressure for the Pencil, simulated from speed for a finger or a mouse.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { StrokeOptions } from 'perfect-freehand';
import { freehandPath, type InkSample } from '../lib/inkPath';

export const PAD_W = 1000;
export const PAD_H = 400;

/** One stroke: who drew it, and flat [x, y, pressure] triples in pad units.
 *  Pressure is what the pen reported (0 = none); finger and mouse store 0. */
export type SigStroke = { by: 'pen' | 'touch' | 'mouse'; pts: number[] };

/** Counts only, for the activity log: never a coordinate, never an image. */
export type SignaturePadStats = {
  pen: number;
  touch: number;
  mouse: number;
  penLock: boolean;
  /** Touches the policy refused: a palm, a finger while the pen writes. */
  palmRejected: number;
  /** Strokes the browser cancelled (Scribble, a system gesture). */
  cancels: number;
};

export type SignaturePadHandle = {
  clear(): void;
  /** Takes back the last stroke; right after Löschen it brings the strokes back. */
  undo(): void;
  isEmpty(): boolean;
  toDataURL(): string;
  /** A stroke is in progress, or the pen was active a moment ago. */
  isBusy(): boolean;
  stats(): SignaturePadStats;
};

type Props = {
  className?: string;
  /** Read once, at mount: the draft of an earlier open of the same form. */
  initialStrokes?: SigStroke[];
  onChange?(strokes: SigStroke[], canUndo: boolean): void;
  onPenLockChange?(locked: boolean): void;
  /** Touch draws even after a pen was seen. */
  fingerToo?: boolean;
};

const INK = '#1c1917';
// Pad units. Measured on an iPad-sized pad (636 CSS px): a Pencil line of 2.5
// px at light pressure (0.1) and 3.3 px at a normal 0.25, where the old pad
// drew a flat 2.2 px and the notebook 1.0-1.4 px. Half that on a phone's pad.
const SIZE = 6;
// Less ink than this is a stray dot or a twitch, not a signature: it does not
// satisfy the mandatory-signature check.
const MIN_INK_UNITS = 20;
const PEN_TRAILING_MS = 500;   // touch stays ignored this long after the pen moved
const PALM_PURGE_MS = 1000;    // touch strokes this recent are the hand that came down ahead of the pen
// WebKit reports a contact's width as twice its major radius: about 42 px for
// a light fingertip, hundreds for a palm. InkPad's 40 would refuse a finger.
const PALM_MAX_CONTACT_PX = 80;
const HISTORY_MAX = 50;
const EXPORT_PX_PER_UNIT = 1.2;
const EXPORT_MAX_W = 1400;
// The phone page's POST goes through the server's 256 kB JSON parser.
const EXPORT_MAX_CHARS = 240_000;

// tldraw's pen curve and pressure boost: Safari reports normal handwriting at
// about 0.1-0.35, which a linear curve turns into a faint line.
const PEN_EASING = (t: number) => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35;
const EASE_OUT_SINE = (t: number) => Math.sin((t * Math.PI) / 2);
const PEN_OPTIONS: StrokeOptions = { size: SIZE, thinning: 0.5, smoothing: 0.6, streamline: 0.4, simulatePressure: false };
// A finger's or a mouse's width comes from its speed, which thins a quick
// stroke: a little heavier and less thinned, so a finger signature on a phone
// is about the old 2.2 px line and not a hairline.
const SIMULATED_OPTIONS: StrokeOptions = { size: SIZE + 1, thinning: 0.4, smoothing: 0.6, streamline: 0.45, simulatePressure: true, easing: EASE_OUT_SINE };

function strokePath(stroke: SigStroke, last: boolean): Path2D | null {
  const { pts } = stroke;
  let real = false;
  if (stroke.by === 'pen') for (let i = 2; i < pts.length; i += 3) if (pts[i] > 0) { real = true; break; }
  const samples: InkSample[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    samples.push([pts[i], pts[i + 1], real ? PEN_EASING(Math.min(1, 1.25 * pts[i + 2])) : 0.5]);
  }
  return freehandPath(samples, { ...(real ? PEN_OPTIONS : SIMULATED_OPTIONS), last });
}

/** Total length of the ink, in pad units. */
export function inkLength(strokes: SigStroke[]): number {
  let total = 0;
  for (const { pts } of strokes) {
    for (let i = 3; i + 1 < pts.length; i += 3) total += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
  }
  return total;
}

export const isSignatureEmpty = (strokes: SigStroke[]): boolean => inkLength(strokes) < MIN_INK_UNITS;

const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad({ className, initialStrokes, onChange, onPenLockChange, fingerToo }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<SigStroke[]>(initialStrokes ? [...initialStrokes] : []);
  const historyRef = useRef<SigStroke[][]>([]);
  const pathsRef = useRef(new WeakMap<SigStroke, Path2D | null>());
  // When each touch stroke of THIS mount started, for the purge at the first
  // pen-down. A draft's strokes have no entry, so they are never purged.
  const touchStartedRef = useRef(new WeakMap<SigStroke, number>());
  // Everything about the stroke in progress lives in refs: the pointer
  // handlers are attached once and must not close over a render.
  const activeRef = useRef<{ pointerId: number; stroke: SigStroke; lastP: number } | null>(null);
  const penAtRef = useRef(-Infinity);
  // Per mount, so per dialog: the referee can sign with a finger right after
  // the coach signed with the Pencil.
  const penLockRef = useRef(false);
  const countsRef = useRef({ palmRejected: 0, cancels: 0 });
  const rafRef = useRef(0);
  const propsRef = useRef({ onChange, onPenLockChange, fingerToo: !!fingerToo });
  propsRef.current = { onChange, onPenLockChange, fingerToo: !!fingerToo };

  const pathOf = (stroke: SigStroke): Path2D | null => {
    const cache = pathsRef.current;
    if (!cache.has(stroke)) cache.set(stroke, strokePath(stroke, true));
    return cache.get(stroke) ?? null;
  };

  const render = () => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width <= 1) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / PAD_W, 0, 0, canvas.height / PAD_H, 0, 0);
    ctx.fillStyle = INK;
    for (const stroke of strokesRef.current) { const path = pathOf(stroke); if (path) ctx.fill(path); }
    const active = activeRef.current;
    if (active) { const path = strokePath(active.stroke, false); if (path) ctx.fill(path); }
  };

  const notify = () => propsRef.current.onChange?.(strokesRef.current, historyRef.current.length > 0);

  const commit = (next: SigStroke[]) => {
    historyRef.current.push(strokesRef.current);
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();
    strokesRef.current = next;
    render();
    notify();
  };

  // Size the bitmap to the box. width/height are reassigned only when the
  // computed size changed (assigning them clears the bitmap even for the same
  // value) and the strokes are then drawn again from the vectors.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      render();
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
      // Release the bitmap: a phone runs out of canvas memory before anything else.
      canvas.width = 1; canvas.height = 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toPad = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [((e.clientX - rect.left) / rect.width) * PAD_W, ((e.clientY - rect.top) / rect.height) * PAD_H];
    };
    // Only when the browser reports a size at all; a mouse or a pen reports 1 or 0.
    const tooBig = (e: PointerEvent) => e.width > PALM_MAX_CONTACT_PX || e.height > PALM_MAX_CONTACT_PX;
    const schedule = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; render(); });
    };

    const addSample = (active: { stroke: SigStroke; lastP: number }, x: number, y: number, pressure: number) => {
      const pts = active.stroke.pts;
      let p = 0;
      if (active.stroke.by === 'pen') {
        // The Pencil's force starts as an estimate and can read 0 on a move;
        // a 0 drawn as-is pinches the line. It takes the last real value, and
        // zeros before the first real one get that one.
        if (pressure > 0) {
          if (active.lastP === 0) for (let i = 2; i < pts.length; i += 3) pts[i] = pressure;
          active.lastP = pressure;
          p = pressure;
        } else p = active.lastP;
      }
      const n = pts.length;
      if (n >= 3 && Math.hypot(x - pts[n - 3], y - pts[n - 2]) < 1) { pts[n - 1] = Math.max(pts[n - 1], p); return; }
      pts.push(x, y, p);
    };

    const start = (e: PointerEvent, by: SigStroke['by']) => {
      e.preventDefault();
      const stroke: SigStroke = { by, pts: [] };
      const active = { pointerId: e.pointerId, stroke, lastP: 0 };
      activeRef.current = active;
      const [x, y] = toPad(e);
      addSample(active, x, y, e.pressure);
      if (by === 'touch') touchStartedRef.current.set(stroke, performance.now());
      // Capture AFTER the stroke started: setPointerCapture throws NotFoundError
      // for a pointer that is not active (every synthetic dispatch), and
      // unguarded it filed a js.error.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* see above */ }
      schedule();
    };

    const dropActive = () => {
      const active = activeRef.current;
      if (!active) return;
      activeRef.current = null;
      try { canvas.releasePointerCapture(active.pointerId); } catch { /* not captured */ }
      render();
    };

    const down = (e: PointerEvent) => {
      const now = performance.now();
      if (e.pointerType === 'pen') {
        penAtRef.current = now;
        const active = activeRef.current;
        if (active && active.stroke.by !== 'touch') return;
        // The palm landed first and started a "stroke"; the pen is the writer.
        if (active) { countsRef.current.palmRejected += 1; dropActive(); }
        if (!penLockRef.current) {
          penLockRef.current = true;
          const recent = new Set(strokesRef.current.filter((s) => s.by === 'touch' && now - (touchStartedRef.current.get(s) ?? -Infinity) < PALM_PURGE_MS));
          if (recent.size) {
            countsRef.current.palmRejected += recent.size;
            historyRef.current = historyRef.current.map((list) => list.filter((s) => !recent.has(s)));
            strokesRef.current = strokesRef.current.filter((s) => !recent.has(s));
            render();
            notify();
          }
          propsRef.current.onPenLockChange?.(true);
        }
        start(e, 'pen');
        return;
      }
      if (activeRef.current) { if (e.pointerType === 'touch') countsRef.current.palmRejected += 1; return; }
      if (e.pointerType === 'touch') {
        if ((penLockRef.current && !propsRef.current.fingerToo) || now - penAtRef.current < PEN_TRAILING_MS || tooBig(e)) {
          countsRef.current.palmRejected += 1;
          return;
        }
        start(e, 'touch');
        return;
      }
      if (e.button !== 0) return;
      start(e, 'mouse');
    };

    const move = (e: PointerEvent) => {
      // Hover counts: an M2 iPad Pro reports the Pencil above the glass, and
      // a hand resting while the pen hovers is still the writing hand.
      if (e.pointerType === 'pen') penAtRef.current = performance.now();
      const active = activeRef.current;
      // Gated on the tracked pointer, never on e.buttons (synthetic moves carry 0).
      if (!active || e.pointerId !== active.pointerId) return;
      e.preventDefault();
      // A contact that spreads past a fingertip mid-stroke is a palm settling.
      if (active.stroke.by === 'touch' && tooBig(e)) { countsRef.current.palmRejected += 1; dropActive(); return; }
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of (list.length ? list : [e])) {
        const [x, y] = toPad(ev);
        addSample(active, x, y, ev.pressure);
      }
      schedule();
    };

    // Committed synchronously: a Save tapped right after the pointer lifts must
    // already see the stroke.
    const finish = (e: PointerEvent, cancelled: boolean) => {
      const active = activeRef.current;
      if (!active || e.pointerId !== active.pointerId) return;
      if (active.stroke.by === 'pen') penAtRef.current = performance.now();
      activeRef.current = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      const pts = active.stroke.pts;
      if (cancelled) {
        countsRef.current.cancels += 1;
        // A pen or mouse stroke the system took over was real writing up to
        // that point. A cancelled touch is far more often the system deciding
        // it was a palm, so it goes.
        if (active.stroke.by === 'touch' || pts.length < 6) { render(); return; }
      }
      // A tap is one sample; a second one makes it a dot instead of nothing.
      if (pts.length === 3) pts.push(pts[0] + 0.5, pts[1], pts[2]);
      commit([...strokesRef.current, active.stroke]);
    };

    const up = (e: PointerEvent) => finish(e, false);
    const cancel = (e: PointerEvent) => finish(e, true);
    // The documented iPadOS Scribble workaround: a touchmove that is not
    // prevented lets the system claim the gesture (see InkPad.tsx).
    const touchMove = (e: TouchEvent) => { if (activeRef.current) e.preventDefault(); };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    canvas.addEventListener('touchmove', touchMove, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('touchmove', touchMove);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      activeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The ink alone, cropped to its box: the PDF fits the whole image into a
   *  34 pt slot, so the empty margins of a full-pad export used to shrink a
   *  signature to a third of its line. */
  const exportPng = (strokes: SigStroke[], scale: number): string => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const { pts } of strokes) {
      for (let i = 0; i + 1 < pts.length; i += 3) {
        if (pts[i] < minX) minX = pts[i];
        if (pts[i] > maxX) maxX = pts[i];
        if (pts[i + 1] < minY) minY = pts[i + 1];
        if (pts[i + 1] > maxY) maxY = pts[i + 1];
      }
    }
    if (!Number.isFinite(minX)) return '';
    const margin = SIZE + 12;
    // Clamped to the pad: what a captured pointer drew beyond it was never on screen.
    const x0 = Math.max(0, minX - margin); const x1 = Math.min(PAD_W, maxX + margin);
    let y0 = Math.max(0, minY - margin); let y1 = Math.min(PAD_H, maxY + margin);
    // At least 0.4 of the pad tall, so a flat scrawl or small initials do not
    // become a 34 pt-high blob in the PDF.
    const minH = 0.4 * PAD_H;
    if (y1 - y0 < minH) {
      const mid = (y0 + y1) / 2;
      y0 = mid - minH / 2; y1 = mid + minH / 2;
      if (y0 < 0) { y1 -= y0; y0 = 0; }
      if (y1 > PAD_H) { y0 -= y1 - PAD_H; y1 = PAD_H; }
    }
    const k = Math.min(scale, EXPORT_MAX_W / Math.max(1, x1 - x0));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.ceil((x1 - x0) * k));
    out.height = Math.max(1, Math.ceil((y1 - y0) * k));
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    ctx.fillStyle = INK;
    for (const stroke of strokes) { const path = pathOf(stroke); if (path) ctx.fill(path); }
    const url = out.toDataURL('image/png');
    out.width = 1; out.height = 1;
    if (url.length > EXPORT_MAX_CHARS && scale > 0.2) return exportPng(strokes, k / 2);
    return url;
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      activeRef.current = null;
      if (!strokesRef.current.length) { render(); return; }
      commit([]);
    },
    undo: () => {
      const previous = historyRef.current.pop();
      if (!previous) return;
      strokesRef.current = previous;
      render();
      notify();
    },
    isEmpty: () => isSignatureEmpty(strokesRef.current),
    toDataURL: () => exportPng(strokesRef.current, EXPORT_PX_PER_UNIT),
    isBusy: () => !!activeRef.current || performance.now() - penAtRef.current < PEN_TRAILING_MS,
    stats: () => {
      const by = (kind: SigStroke['by']) => strokesRef.current.filter((s) => s.by === kind).length;
      return { pen: by('pen'), touch: by('touch'), mouse: by('mouse'), penLock: penLockRef.current, ...countsRef.current };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        width: '100%', aspectRatio: `${PAD_W} / ${PAD_H}`, display: 'block',
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: 'crosshair',
      }}
    />
  );
});

export default SignaturePad;
