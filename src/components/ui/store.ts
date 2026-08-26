import { type ReactNode } from 'react';

// Imperative UI singletons that replace window.confirm / window.alert.
//
// Deliberately NOT a React context: the call sites are hundreds of lines deep
// inside App.tsx and AdminConsole.tsx, and those two live in SEPARATE React
// roots (see main.tsx). A provider would have to be threaded through both trees
// and every call site would need a hook — for handlers that are mostly plain
// async functions, not components. A module-level store plus
// useSyncExternalStore gives the same reactivity with a plain function call.

export type UiLang = 'DE' | 'EN';

/* ── Confirm ─────────────────────────────────────────────────────────── */

export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  lang?: UiLang;
};

export type ConfirmEntry = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

let seq = 0;
// A queue, not a single slot: a second confirmDialog() while one is open used to
// mean either a clobbered dialog or a promise that never settled. Whoever asks
// second simply waits, and every promise resolves exactly once.
let confirmQueue: ConfirmEntry[] = [];
const confirmListeners = new Set<() => void>();

const emitConfirm = () => { confirmListeners.forEach((l) => l()); };

export function subscribeConfirm(listener: () => void) {
  confirmListeners.add(listener);
  // A Set makes StrictMode's subscribe → unsubscribe → subscribe a no-op rather
  // than a double-fire.
  return () => { confirmListeners.delete(listener); };
}

/** The dialog currently on screen, or null. Reference-stable between changes. */
export function getConfirmSnapshot(): ConfirmEntry | null {
  return confirmQueue.length > 0 ? confirmQueue[0] : null;
}

/**
 * Ask the user to confirm something. Resolves true on confirm, false on cancel,
 * Escape or a backdrop click. Never rejects.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmQueue = [...confirmQueue, { ...opts, id: ++seq, resolve }];
    emitConfirm();
  });
}

/** Settle one queued dialog. Ignores ids already gone, so a double click or a
 *  StrictMode-replayed handler cannot resolve the same promise twice. */
export function settleConfirm(id: number, answer: boolean) {
  const entry = confirmQueue.find((e) => e.id === id);
  if (!entry) return;
  confirmQueue = confirmQueue.filter((e) => e.id !== id);
  emitConfirm();
  entry.resolve(answer);
}

/* ── Toasts ──────────────────────────────────────────────────────────── */

export type ToastKind = 'success' | 'error' | 'info';

export type ToastOptions = {
  /** ms until auto-dismiss; 0 (or negative) pins the toast until dismissed. */
  duration?: number;
  lang?: UiLang;
};

export type ToastItem = { id: number; kind: ToastKind; message: string; duration: number; lang: UiLang };

// Anything past this is dropped oldest-first, so a burst of queued-offline
// replies cannot bury the screen — and no timer is kept for a toast nobody sees.
const MAX_VISIBLE = 4;
const DEFAULT_MS = 4000;
// Errors get longer: they usually carry something the user must read, not an
// acknowledgement they already expected.
const ERROR_MS = 6000;

let toastList: ToastItem[] = [];
const toastListeners = new Set<() => void>();

const emitToasts = () => { toastListeners.forEach((l) => l()); };

export function subscribeToasts(listener: () => void) {
  toastListeners.add(listener);
  return () => { toastListeners.delete(listener); };
}

export function getToastsSnapshot(): ToastItem[] { return toastList; }

export function dismissToast(id: number) {
  if (!toastList.some((t) => t.id === id)) return;
  toastList = toastList.filter((t) => t.id !== id);
  emitToasts();
}

function pushToast(kind: ToastKind, message: string, opts?: ToastOptions): number {
  const id = ++seq;
  const duration = opts?.duration ?? (kind === 'error' ? ERROR_MS : DEFAULT_MS);
  const next = [...toastList, { id, kind, message, duration, lang: opts?.lang ?? 'DE' }];
  toastList = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
  emitToasts();
  return id;
}

/** Transient notices. Each call returns the toast id, for `toast.dismiss(id)`. */
export const toast = {
  success: (message: string, opts?: ToastOptions) => pushToast('success', message, opts),
  error: (message: string, opts?: ToastOptions) => pushToast('error', message, opts),
  info: (message: string, opts?: ToastOptions) => pushToast('info', message, opts),
  dismiss: (id: number) => dismissToast(id),
  clear: () => { if (toastList.length) { toastList = []; emitToasts(); } },
};
