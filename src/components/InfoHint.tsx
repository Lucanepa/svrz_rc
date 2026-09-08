import { useEffect, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';
import { INFO_HINTS, type InfoHintId } from '../lib/infoHints';

/**
 * A tappable (i) beside a label, showing what the Infoschreiben says about it.
 *
 * A tap, not a hover: the coach reading this is standing in a hall with a phone,
 * where `title=` never appears at all. It is a real button for the same reason —
 * a div with an onClick is invisible to a keyboard and to a screen reader, and
 * this is the one control on the form whose entire job is to explain the others.
 *
 * Hidden in print. The paper form is the SVRZ's own layout and a row of little
 * circles down its side is not part of it.
 */
export default function InfoHint({ id, lang, className }: { id: InfoHintId; lang: 'DE' | 'EN'; className?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const hint = INFO_HINTS[id];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Capture phase: the form below has handlers that stop propagation, and a
    // popover that only closes when you click nothing in particular is a trap.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = lang === 'DE' ? 'Erklärung anzeigen' : 'Show explanation';

  return (
    <span ref={wrap} className={`relative inline-flex align-middle print:hidden ${className ?? ''}`}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-stone-400 hover:text-sky-700 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-colors"
      >
        <Info size={13} />
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={label}
          // Anchored to the left edge and clamped to the viewport width: these
          // sit in a five-column grid whose last column ends at the page edge,
          // where a fixed-width panel would open off-screen on a phone.
          className="absolute left-0 top-6 z-40 w-[min(20rem,calc(100vw-2.5rem))] rounded-lg border border-stone-300 bg-white p-3 text-left shadow-xl"
        >
          <span className="flex items-start justify-between gap-2 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-700">
              {lang === 'DE' ? 'Infoschreiben' : 'RC information sheet'} {hint.ref}
            </span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
              aria-label={lang === 'DE' ? 'Schliessen' : 'Close'}
              className="shrink-0 -mt-0.5 -mr-0.5 text-stone-400 hover:text-stone-700"
            >
              <X size={13} />
            </button>
          </span>
          <span className="block text-xs leading-relaxed text-stone-700 whitespace-pre-line normal-case font-normal not-italic">
            {hint[lang]}
          </span>
        </span>
      )}
    </span>
  );
}
