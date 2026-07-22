import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type SignaturePadHandle = { clear: () => void; isEmpty: () => boolean; toDataURL: () => string };

const SignaturePad = forwardRef<SignaturePadHandle, { className?: string }>(({ className }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Assigning width/height resets the bitmap even when the value is
    // unchanged, so a routine resize — the on-screen keyboard opening, a
    // rotation while handing the phone over, the iOS toolbar collapsing — used
    // to wipe the strokes while `dirty` stayed true. isEmpty() then lied and a
    // fully blank PNG passed the mandatory-signature check.
    const setup = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      const sizeChanged = canvas.width !== width || canvas.height !== height;
      // Keep what is drawn across a resize that really did change the size.
      let snapshot: HTMLCanvasElement | null = null;
      if (sizeChanged && dirty.current && canvas.width > 0 && canvas.height > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        snapshot.getContext('2d')?.drawImage(canvas, 0, 0);
      }
      if (sizeChanged) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (snapshot) ctx.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1c1917';
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

  // The flag says a stroke was drawn; this says one is still there. Both have
  // to agree before a signature counts, so no path can submit a blank image
  // that validation then waves through because the string is non-empty.
  const hasInk = () => {
    const c = canvasRef.current;
    if (!c || !c.width || !c.height) return false;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return dirty.current;
    try {
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
      return false;
    } catch { return dirty.current; }
  };

  useImperativeHandle(ref, () => ({
    clear: () => { const c = canvasRef.current; if (!c) return; const ctx = c.getContext('2d'); ctx?.clearRect(0, 0, c.width, c.height); dirty.current = false; },
    isEmpty: () => !dirty.current || !hasInk(),
    toDataURL: () => canvasRef.current?.toDataURL('image/png') ?? '',
  }));

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />;
});
SignaturePad.displayName = 'SignaturePad';
export default SignaturePad;
