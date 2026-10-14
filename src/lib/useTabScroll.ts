import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// How long a restore follows a tab whose rows are still arriving before it
// gives up and leaves the page wherever it got to.
const RESTORE_WAIT_MS = 2500;
// What counts as the user taking the scroll over: from then on the page is
// theirs, and a restore still waiting must not yank it back.
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** Scrolls the window without the smooth animation index.css gives every
 *  scroll. Not `behavior: 'instant'`: an older WebKit throws on that value.
 *  The computed style is read on purpose: Chromium otherwise scrolls with the
 *  style it had before the override, and animated anyway. */
function jump(top: number) {
  const root = document.documentElement;
  const was = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  void getComputedStyle(root).scrollBehavior;
  window.scrollTo(0, top);
  root.style.scrollBehavior = was;
}

const reached = (top: number) => Math.abs(window.scrollY - top) < 2;

/**
 * Where each tab was left, for a screen whose tabs all scroll the one window.
 *
 * The window keeps a single offset, so a switch carried the old tab's offset
 * over to the new one, and a shorter tab clamped it to its own bottom: every
 * switch away from a long list landed at the foot of the next page (Luca,
 * 2026-10-14). Each tab now opens where it was last left, or at the top on its
 * first visit.
 *
 * `tab` names the tab on screen. `enabled` false is a screen without the tabs
 * (a form, a detail view): the window is left alone there, as it always was,
 * and stepping back onto the tabs from one restores nothing either.
 *
 * Returns `forget`, for a switch that opens a tab on something new (a search
 * for one game) rather than going back to it: that tab then opens at the top.
 */
export function useTabScroll(tab: string, enabled = true): (tab: string) => void {
  const saved = useRef(new Map<string, number>());
  const shown = useRef<string | null>(enabled ? tab : null);
  const stopRestore = useRef<(() => void) | null>(null);

  // Recorded as it happens, not at the switch: by the time an effect sees the
  // new tab the browser has laid it out and already clamped the offset. Not
  // while a restore is running, whose own clamps are not where anyone left it.
  useEffect(() => {
    const onScroll = () => {
      if (shown.current !== null && !stopRestore.current) saved.current.set(shown.current, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); stopRestore.current?.(); };
  }, []);

  // A layout effect, so the tab is never painted at the old offset first.
  useLayoutEffect(() => {
    const next = enabled ? tab : null;
    if (next === shown.current) return;
    const leaving = shown.current;
    shown.current = next;
    stopRestore.current?.();
    if (leaving === null || next === null) return;

    const target = saved.current.get(next) ?? 0;
    jump(target);
    if (reached(target)) return;
    // The tab is still shorter than where it was left: its rows are on their
    // way (a remounted tab fetching them again). Follow the page as it grows
    // until the spot exists, the user scrolls themselves, or time runs out.
    const grows = new ResizeObserver(() => { jump(target); if (reached(target)) stop(); });
    const timer = window.setTimeout(() => stop(), RESTORE_WAIT_MS);
    function stop() {
      grows.disconnect();
      window.clearTimeout(timer);
      for (const type of USER_INPUT) window.removeEventListener(type, stop, { capture: true });
      if (stopRestore.current === stop) stopRestore.current = null;
    }
    grows.observe(document.body);
    for (const type of USER_INPUT) window.addEventListener(type, stop, { capture: true, passive: true });
    stopRestore.current = stop;
  }, [tab, enabled]);

  return useCallback((which: string) => { saved.current.delete(which); }, []);
}
