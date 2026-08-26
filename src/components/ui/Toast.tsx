import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, Check, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { dismissToast, getToastsSnapshot, subscribeToasts, type ToastItem } from './store';

const ICONS = { success: Check, error: AlertCircle, info: Info };

const ACCENT = {
  success: { border: 'border-l-emerald-500', icon: 'text-emerald-600' },
  error: { border: 'border-l-red-500', icon: 'text-red-600' },
  info: { border: 'border-l-blue-500', icon: 'text-blue-600' },
};

function ToastRow({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  // Banked so that leaving the pointer restarts the remainder, not the whole
  // duration — hovering a toast to read it should not make it immortal either.
  const remainingRef = useRef(item.duration);
  const startedRef = useRef(0);

  useEffect(() => {
    if (paused || item.duration <= 0) return;
    startedRef.current = Date.now();
    const timer = window.setTimeout(() => dismissToast(item.id), Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
    };
  }, [paused, item.id, item.duration]);

  const Icon = ICONS[item.kind];
  const accent = ACCENT[item.kind];

  return (
    <div
      data-testid="toast"
      data-toast-kind={item.kind}
      // Deliberately NO role/aria-live on the card. role="alert" is itself a
      // live region, and nesting one inside the container's role="status" made
      // several screen readers announce an error toast twice. Errors in this app
      // always also land inline (setErr/setNotice/setIcalError), so the polite
      // container announcement is a supplement, not the only signal.
      // Pointer events, and only a real mouse: a tap fires pointerenter with no
      // pointerleave to follow it, so a mis-tap on the toast — it sits over the
      // Home row buttons on a phone — used to park it on screen for good.
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPaused(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setPaused(false); }}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        // pointer-events-none below sm: the stack sits over the Home game-row
        // buttons on a phone, and a 4-second toast must never eat a courtside
        // tap. The dismiss button re-enables events for itself.
        'pointer-events-none sm:pointer-events-auto w-full sm:w-auto sm:min-w-[15rem] max-w-sm bg-white rounded-xl shadow-lg',
        'border border-stone-200 border-l-4 flex items-start gap-2.5 py-3 pl-3 pr-2',
        accent.border,
      )}
    >
      <Icon size={18} className={cn('shrink-0 mt-px', accent.icon)} />
      <p className="flex-1 text-sm text-stone-700 leading-snug break-words">{item.message}</p>
      <button
        type="button"
        data-testid="toast-dismiss"
        aria-label={item.lang === 'EN' ? 'Dismiss notification' : 'Meldung schliessen'}
        onClick={() => dismissToast(item.id)}
        className="pointer-events-auto shrink-0 h-10 w-10 sm:h-7 sm:w-7 -my-1.5 sm:my-0 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function ToastStack() {
  const items = useSyncExternalStore(subscribeToasts, getToastsSnapshot);

  // Rendered even when empty: a live region has to be in the DOM *before* its
  // content changes, or screen readers announce nothing for the first toast.
  // z-[60] keeps it above the confirm dialog (z-50) — a toast fired from a
  // confirm handler must not disappear behind the next queued dialog.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="fixed inset-x-0 bottom-0 sm:inset-x-auto sm:right-0 z-[60] no-print pointer-events-none flex flex-col items-center sm:items-end gap-2 p-4"
    >
      {/* Keyed on a Fragment, the repo's standing workaround for shipping no
          @types/react: `key` on a plain component is not in its props type and
          tsc rejects it (see AdminConsole.tsx). */}
      {items.map((item) => <React.Fragment key={item.id}><ToastRow item={item} /></React.Fragment>)}
    </div>
  );
}
