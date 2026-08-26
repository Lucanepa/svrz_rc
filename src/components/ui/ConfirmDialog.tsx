import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { cn } from '../../lib/utils';
import { getConfirmSnapshot, settleConfirm, subscribeConfirm } from './store';

// Everything a Tab can land on. The message is a ReactNode, so it may well
// contain a link — trapping only the two buttons would skip it.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function ConfirmDialog() {
  const entry = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const messageId = `${baseId}-message`;
  const open = !!entry;
  const id = entry ? entry.id : 0;

  // Keyed on `open`, not on the entry: the body stays locked while the queue
  // drains from one dialog straight into the next, and the cleanup also covers
  // an unmount that happens with a dialog still on screen.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  // Focus the confirm button per dialog, so a queued second one does not leave
  // focus stranded on the first one's (now gone) button.
  useEffect(() => { if (open) acceptRef.current?.focus(); }, [open, id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // App.tsx keeps a window-level Escape handler that peels one of ITS
        // modals per press. Capture phase runs before that bubble-phase
        // listener, and stopping propagation here means a single Escape closes
        // this dialog only — never this dialog AND the screen behind it.
        e.stopPropagation();
        e.preventDefault();
        settleConfirm(id, false);
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)) as HTMLElement[];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && panel.contains(active);
      if (e.shiftKey ? (active === first || !inside) : (active === last || !inside)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, id]);

  if (!entry) return null;

  const de = (entry.lang ?? 'DE') === 'DE';
  const confirmLabel = entry.confirmLabel ?? (de ? 'Bestätigen' : 'Confirm');
  const cancelLabel = entry.cancelLabel ?? (de ? 'Abbrechen' : 'Cancel');
  const hasMessage = entry.message !== undefined && entry.message !== null && entry.message !== '';

  return (
    <div
      className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print"
      onClick={() => settleConfirm(entry.id, false)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasMessage ? messageId : undefined}
        data-testid="confirm-dialog"
        // max-h/overflow like the app's own modals (App.tsx:5396, 5471): the body
        // is scroll-locked while this is open, so a panel taller than the viewport
        // — a long question as the title — would push the buttons out of reach
        // with nothing left to scroll.
        className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} data-testid="confirm-title" className={cn('text-lg font-bold text-stone-900', hasMessage ? 'mb-3' : 'mb-6')}>
          {entry.title}
        </h3>
        {hasMessage && (
          <div id={messageId} data-testid="confirm-message" className="text-sm text-stone-600 mb-6">
            {entry.message}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={() => settleConfirm(entry.id, false)}
            className="px-4 py-2 text-sm rounded-lg border border-stone-300 hover:bg-stone-50 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={acceptRef}
            data-testid="confirm-accept"
            onClick={() => settleConfirm(entry.id, true)}
            className={cn(
              'px-4 py-2 text-sm rounded-lg font-medium transition-colors text-white',
              entry.tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
