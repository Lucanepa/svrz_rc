import type { FeedbackFormData } from '../types';

/**
 * A half-filled observation lives only in React state: there is no draft
 * persistence, so anything that reloads the page throws it away. Two things
 * reload the page on their own schedule — the service worker taking control
 * after a deploy (main.tsx) and the browser being closed — and a coach fills
 * this form courtside over the length of a match. So the app publishes "there
 * is work in progress" here, and those callers wait for it to clear.
 */
let unsaved = false;
const listeners = new Set<() => void>();

export function hasUnsavedWork(): boolean {
  return unsaved;
}

export function setUnsavedWork(value: boolean): void {
  if (unsaved === value) return;
  unsaved = value;
  for (const fn of listeners) fn();
}

/** Called whenever the flag flips; used to run a deferred reload the moment it is safe. */
export function onUnsavedWorkChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * True once the coach has entered anything worth losing. Deliberately ignores
 * the fields the app fills in by itself (role, language, and the meta block
 * copied from the selected game) — those carry no typing and come back for
 * free after a reload.
 */
export function formHasContent(f: FeedbackFormData | null | undefined, tipsAndTricks?: string): boolean {
  if (!f) return false;
  if (f.signature || f.rcSignature) return true;
  if (tipsAndTricks?.trim()) return true;
  const r = f.results;
  if (r) {
    if (r.motivation || r.einstufung || r.spielniveau || r.secondBesuch) return true;
    if (r.bemerkungen?.trim() || r.srZiel?.trim()) return true;
    if (r.highlights?.trim() || r.improvements?.trim() || r.goals?.trim()) return true;
  }
  return (f.sections || []).some((s) => (s.items || []).some((i) => i.rating));
}
