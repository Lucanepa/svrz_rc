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
    const setup = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
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

  useImperativeHandle(ref, () => ({
    clear: () => { const c = canvasRef.current; if (!c) return; const ctx = c.getContext('2d'); ctx?.clearRect(0, 0, c.width, c.height); dirty.current = false; },
    isEmpty: () => !dirty.current,
    toDataURL: () => canvasRef.current?.toDataURL('image/png') ?? '',
  }));

  return <canvas ref={canvasRef} className={className} style={{ touchAction: 'none' }} />;
});
SignaturePad.displayName = 'SignaturePad';
export default SignaturePad;
