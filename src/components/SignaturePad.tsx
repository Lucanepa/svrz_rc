// The signature pad: one canvas, the strokes kept as vectors in pad units
// (1000 × 400, the 5:2 box it is drawn in) and the bitmap always rendered from
// them. A resize, a rotation or the keyboard opening re-renders the same
// strokes at the new size; nothing is stretched, nothing is lost.
//
// One pointer draws at a time, tracked by its id, and a pen is authoritative.
// Before this, one shared "drawing" flag took every pointer, so a palm landing
// on the pad drew a straight line into the Pencil's stroke and a palm lifting
// anywhere on screen ended it (Jennifer, 23.10.2026).
//
// Two palm rules are the notebook pen page's too, from src/lib/inkInput.ts: a
// contact wider than a fingertip is a palm, and a touch right after the pen is
// the writing hand. The rest is this pad's own, because a finger must still be
// able to sign here: the pen lock (after a pen, only the pen draws unless the
// signer allows the finger), the purge (touch strokes made just before the
// first pen-down go), and the settle (a contact that spreads past a fingertip
// as it lands is a palm; later, it is a finger pressed flat).
//
// The line is perfect-freehand through src/lib/inkPath.ts with this pad's own
// options: real pressure for the Pencil, through the pen page's pressure curve,
// simulated from speed for a finger or a mouse.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { StrokeOptions } from 'perfect-freehand';
import { freehandPath, type InkSample } from '../lib/inkPath';
import { PEN_TRAILING_MS, captureQuietly, coalescedOf, isLargeContact } from '../lib/inkInput';
import { penPressure } from '../lib/inkStyle';

const PAD_W = 1000;
const PAD_H = 400;

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
  /** The widest touch contact that drew, in CSS px (0: none). With the next
   *  one it brackets the palm limit, which rests on community figures. */
  touchMaxPx: number;
  /** The narrowest touch contact refused or cut as too big (0: none). */
  tooBigMinPx: number;
};

export type SignaturePadHandle = {
  clear(): void;
  /** Takes back the last stroke; right after Löschen it brings the strokes back. */
  undo(): void;
  isEmpty(): boolean;
  toDataURL(): string;
  /** A stroke is in progress, or the pen was on the glass a moment ago. A
   *  hovering pen does not count: this is what the dialog's buttons ask, and
   *  the other hand's deliberate tap must work while the Pencil hovers. */
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
// drew a flat 2.2 px. Half that on a phone's pad.
const SIZE = 6;
// Less ink than this is a stray dot or a twitch, not a signature: it does not
// satisfy the mandatory-signature check.
const MIN_INK_UNITS = 20;
const PALM_PURGE_MS = 1000;    // touch strokes on the glass this recently are the hand that came down ahead of the pen
// A contact that grows past a fingertip (inkInput's PALM_MAX_CONTACT_PX) this
// soon after landing is a palm settling; later, it is a finger pressed flat
// while signing.
const PALM_SETTLE_MS = 150;
const HISTORY_MAX = 50;
const EXPORT_PX_PER_UNIT = 1.2;
const EXPORT_MAX_W = 1400;
// The phone page's POST goes through the server's 256 kB JSON parser.
const EXPORT_MAX_CHARS = 240_000;

// The Pencil's pressure goes through the pen page's curve (penPressure, tldraw's
// boost and easing): Safari reports normal handwriting at about 0.1-0.35,
// which a linear curve turns into a faint line. Size, thinning and smoothing
// are this pad's own, for a signature line on a 1000-unit-wide pad.
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
    samples.push([pts[i], pts[i + 1], real ? penPressure(pts[i + 2]) : 0.5]);
  }
  return freehandPath(samples, { ...(real ? PEN_OPTIONS : SIMULATED_OPTIONS), last });
}

/** Total length of the ink, in pad units. */
function inkLength(strokes: SigStroke[]): number {
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
  // When each touch stroke of THIS mount was last on the glass, for the purge
  // at the first pen-down, and its widest contact, for the stats. A draft's
  // strokes have no entry, so they are never purged.
  const touchSeenRef = useRef(new WeakMap<SigStroke, number>());
  const touchWidthRef = useRef(new WeakMap<SigStroke, number>());
  // Everything about the stroke in progress lives in refs: the pointer
  // handlers are attached once and must not close over a render.
  const activeRef = useRef<{ pointerId: number; stroke: SigStroke; lastP: number; t0: number } | null>(null);
  /** The pen's last event, hover included: a touch on the pad this soon after
   *  is the writing hand. */
  const penAtRef = useRef(-Infinity);
  /** The pen's last contact (down, a move while touching, up), hover not
   *  included: what isBusy() and so the dialog's buttons go by, as the
   *  notebook's InkPad does with its penContactAt (24.10.2026). */
  const penContactAtRef = useRef(-Infinity);
  // Per mount, so per dialog: the referee can sign with a finger right after
  // the coach signed with the Pencil.
  const penLockRef = useRef(false);
  const countsRef = useRef({ palmRejected: 0, cancels: 0, tooBigMinPx: 0 });
  const rafRef = useRef(0);
  const propsRef = useRef({ onChange, onPenLockChange, fingerToo: !!fingerToo });
  propsRef.current = { onChange, onPenLockChange, fingerToo: !!fingerToo };

  // The helpers below run from mount-time closures (the layout effect, the
  // pointer effect and the handle are all made once), so they read refs only:
  // a prop or state read here would stay its value from the first render.
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
    const tooBig = (e: PointerEvent) => {
      if (!isLargeContact(e)) return false;
      const px = Math.round(Math.max(e.width, e.height));
      const counts = countsRef.current;
      if (!counts.tooBigMinPx || px < counts.tooBigMinPx) counts.tooBigMinPx = px;
      return true;
    };
    const noteTouch = (stroke: SigStroke, e: PointerEvent) => {
      touchSeenRef.current.set(stroke, performance.now());
      const px = Math.max(e.width || 0, e.height || 0);
      if (px > (touchWidthRef.current.get(stroke) ?? 0)) touchWidthRef.current.set(stroke, px);
    };
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
      const active = { pointerId: e.pointerId, stroke, lastP: 0, t0: performance.now() };
      activeRef.current = active;
      const [x, y] = toPad(e);
      addSample(active, x, y, e.pressure);
      if (by === 'touch') noteTouch(stroke, e);
      captureQuietly(canvas, e.pointerId);
      schedule();
    };

    const dropActive = () => {
      const active = activeRef.current;
      if (!active) return;
      activeRef.current = null;
      try { canvas.releasePointerCapture(active.pointerId); } catch { /* not captured */ }
      render();
    };

    // Ends the stroke in progress, committed synchronously: a Save tapped right
    // after the pointer lifts must already see it. 'lost' is a stroke whose up
    // and cancel never came.
    const end = (how: 'up' | 'cancel' | 'lost') => {
      const active = activeRef.current;
      if (!active) return;
      if (active.stroke.by === 'pen') { penAtRef.current = performance.now(); penContactAtRef.current = penAtRef.current; }
      activeRef.current = null;
      try { canvas.releasePointerCapture(active.pointerId); } catch { /* not captured */ }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      const pts = active.stroke.pts;
      if (how === 'cancel') {
        countsRef.current.cancels += 1;
        // A pen or mouse stroke the system took over was real writing up to
        // that point. A cancelled touch is far more often the system deciding
        // it was a palm, so it goes.
        if (active.stroke.by === 'touch' || pts.length < 6) { render(); return; }
      }
      if (how === 'lost' && pts.length < 6) { render(); return; }
      // A tap is one sample; a second one makes it a dot instead of nothing.
      if (pts.length === 3) pts.push(pts[0] + 0.5, pts[1], pts[2]);
      if (active.stroke.by === 'touch') touchSeenRef.current.set(active.stroke, performance.now());
      commit([...strokesRef.current, active.stroke]);
    };

    const down = (e: PointerEvent) => {
      const now = performance.now();
      // A pen or a mouse going down while a pen or mouse stroke is still open:
      // that stroke lost its up and its cancel, since nobody holds two. It ends
      // with what it drew. Before, it blocked every later stroke until Löschen,
      // which on an iPad would read as "the Pencil stopped writing".
      const open = activeRef.current;
      if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && open && open.stroke.by !== 'touch') end('lost');
      if (e.pointerType === 'pen') {
        penAtRef.current = now;
        penContactAtRef.current = now;
        // The palm landed first and started a "stroke"; the pen is the writer.
        if (activeRef.current) { countsRef.current.palmRejected += 1; dropActive(); }
        if (!penLockRef.current) {
          penLockRef.current = true;
          // Measured from when each touch was last on the glass, not from when
          // it began: a heel of the hand that rested a while and lifted as the
          // pen landed is the same hand.
          const recent = new Set(strokesRef.current.filter((s) => s.by === 'touch' && now - (touchSeenRef.current.get(s) ?? -Infinity) < PALM_PURGE_MS));
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
      const active = activeRef.current;
      // Hover counts for the pad: an M2 iPad Pro reports the Pencil above the
      // glass, and a hand resting while the pen hovers is still the writing
      // hand. For the buttons only a pen on the glass counts.
      if (e.pointerType === 'pen') {
        penAtRef.current = performance.now();
        if (e.buttons > 0 || active?.pointerId === e.pointerId) penContactAtRef.current = penAtRef.current;
      }
      if (!active) return;
      // A real pen or mouse moving with no button and no pressure is not on
      // the glass, so its stroke's up got lost (the Pencil hovering after it, a
      // mouse released outside the window). Trusted events only: synthetic
      // moves carry buttons 0, which is also why drawing is gated on the
      // tracked pointer and never on e.buttons.
      if (e.isTrusted && active.stroke.by !== 'touch' && e.pointerType === active.stroke.by && e.buttons === 0 && e.pressure === 0) { end('up'); return; }
      if (e.pointerId !== active.pointerId) return;
      e.preventDefault();
      if (active.stroke.by === 'touch') {
        if (tooBig(e)) {
          // Right after landing, a contact that spreads past a fingertip is a
          // palm settling, and its "stroke" goes. Later, it is a finger pressed
          // flat while signing: the line stops there and keeps what it drew,
          // where it used to vanish whole.
          if (performance.now() - active.t0 < PALM_SETTLE_MS) { countsRef.current.palmRejected += 1; dropActive(); } else end('up');
          return;
        }
        noteTouch(active.stroke, e);
      }
      for (const ev of coalescedOf(e)) {
        const [x, y] = toPad(ev);
        addSample(active, x, y, ev.pressure);
      }
      schedule();
    };

    const finish = (e: PointerEvent, how: 'up' | 'cancel') => {
      if (activeRef.current?.pointerId === e.pointerId) end(how);
    };
    const up = (e: PointerEvent) => finish(e, 'up');
    const cancel = (e: PointerEvent) => finish(e, 'cancel');
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
    isBusy: () => !!activeRef.current || performance.now() - penContactAtRef.current < PEN_TRAILING_MS,
    stats: () => {
      const by = (kind: SigStroke['by']) => strokesRef.current.filter((s) => s.by === kind).length;
      // Of the touch strokes in the signature, so a palm purged at the first
      // pen-down does not count as a finger.
      const touchMaxPx = Math.round(Math.max(0, ...strokesRef.current.map((s) => touchWidthRef.current.get(s) ?? 0)));
      return { pen: by('pen'), touch: by('touch'), mouse: by('mouse'), penLock: penLockRef.current, ...countsRef.current, touchMaxPx };
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
