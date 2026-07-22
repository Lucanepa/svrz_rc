import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type SignaturePadHandle = { clear: () => void; isEmpty: () => boolean; toDataURL: () => string };

/**
 * Copy of what is currently drawn, so a resize can put it back. The CSS size is
 * derived from the buffer rather than measured: by the time this runs the
 * element has already been laid out at its NEW size.
 */
function keepStrokes(canvas: HTMLCanvasElement, dpr: number): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  return { canvas: copy, cssWidth: canvas.width / dpr, cssHeight: canvas.height / dpr };
}

const SignaturePad = forwardRef<SignaturePadHandle, { className?: string }>(({ className }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Resizing is routine here — the phone gets rotated to hand it to the
    // referee, the iOS toolbar collapses while scrolling the modal, the Android
    // keyboard opens over the name field above the pad. Assigning canvas.width
    // erases every stroke, and `dirty` stayed true through it, so a blank PNG
    // used to sail through isEmpty() and be filed as a signature.
    const setup = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      // Same buffer size: leave it alone. Re-assigning would clear it for nothing.
      if (canvas.width === width && canvas.height === height) return;
      const previous = keepStrokes(canvas, dpr);
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1c1917';
      // Redrawn at its original CSS size, so the strokes keep their proportions
      // and simply sit where they were drawn.
      if (previous) ctx.drawImage(previous.canvas, 0, 0, previous.cssWidth, previous.cssHeight);
    };
    const raf = requestAnimationFrame(setup);
    window.addEventListener('resize', setup);
    const point = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e: PointerEvent) => { e.preventDefault(); drawing.current = true; last.current = point(e); canvas.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drawing.current) return; e.preventDefault();
      const ctx = canvas.getContext('2d'); if (!ctx || !last.current) return;
      const p = point(e);
      ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last.current = p; dirty.current = true;
    };
    const up = () => { drawing.current = false; last.current = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', setup); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  useImperativeHandle(ref, () => ({
    clear: () => { const c = canvasRef.current; if (!c) return; const ctx = c.getContext('2d'); ctx?.clearRect(0, 0, c.width, c.height); dirty.current = false; },
    // Asks the pixels, not the flag. Everything downstream — the dual-signature
    // requirement, the PDF, the mail — treats "not empty" as "this was signed",
    // so a canvas that lost its strokes must not be able to claim otherwise.
    isEmpty: () => {
      if (!dirty.current) return true;
      const c = canvasRef.current;
      if (!c || c.width === 0 || c.height === 0) return true;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      try {
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
        return true;
      } catch { return false; }
    },
    toDataURL: () => canvasRef.current?.toDataURL('image/png') ?? '',
  }));

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />;
});
SignaturePad.displayName = 'SignaturePad';
export default SignaturePad;
