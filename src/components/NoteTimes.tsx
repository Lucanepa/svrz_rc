// The margin beside a text page: the time each line was written, small, at
// the height of that line's first row. The times come from notebookTimes.ts;
// this only finds where each line starts on screen.
//
// Lines are counted by the rules domToRich reads them with — a <br>, a block
// element, a newline inside a text node — so line i here is line i of the
// stored text whatever markup the browser made of the editing. The positions
// are measured, not computed: a long note wraps, and only the browser knows
// onto how many rows.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { clockLabel, dayTimeLabel } from '../lib/appTime';

type Start = { node: Text; offset: number } | null;

/** The first written character of every line, or null for a blank one. */
function lineStarts(root: HTMLElement): Start[] {
  const starts: Start[] = [null];
  let wrote = false;      // domToRich: something has been emitted
  let atBreak = true;     // … and it ends with a newline
  const newline = () => { starts.push(null); wrote = true; atBreak = true; };
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!text) return;
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') { newline(); continue; }
        if (!starts[starts.length - 1] && text[i].trim()) starts[starts.length - 1] = { node: node as Text, offset: i };
      }
      wrote = true;
      atBreak = text.endsWith('\n');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.nodeName === 'BR') { newline(); return; }
    const block = /^(DIV|P|LI|TR|H[1-6])$/.test(node.nodeName);
    if (block && wrote && !atBreak) newline();
    node.childNodes.forEach(walk);
    if (block && wrote && !atBreak) newline();
  };
  root.childNodes.forEach(walk);
  return starts;
}

type Label = { key: number; top: number; height: number; at: number; repeat: boolean };

export default function NoteTimes({ scrollRef, times, lineTitle }: {
  /** The box holding both this margin and the page's .rich-surface. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Epoch ms per line of the page, 0 where nothing is shown. */
  times: number[];
  /** The tooltip for one line, from its full date and time. */
  lineTitle: (date: string) => string;
}) {
  const [labels, setLabels] = useState<Label[]>([]);
  const timesRef = useRef(times);
  timesRef.current = times;
  const frame = useRef(0);

  const measure = () => {
    const surface = scrollRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (!surface) { setLabels([]); return; }
    const origin = surface.getBoundingClientRect().top;
    const list = timesRef.current;
    const starts = lineStarts(surface);
    const out: Label[] = [];
    let previous = '';
    const range = document.createRange();
    for (let i = 0; i < starts.length && i < list.length; i += 1) {
      const start = starts[i];
      if (!start || !list[i]) continue;
      range.setStart(start.node, start.offset);
      range.setEnd(start.node, start.offset + 1);
      const rect = range.getClientRects()[0] || range.getBoundingClientRect();
      if (!rect || (!rect.height && !rect.top)) continue;
      const label = clockLabel(list[i]);
      // The same minute twice running is still printed — every note has its
      // time — but quieter, so the column reads as the evening's rhythm.
      out.push({ key: i, top: rect.top - origin, height: rect.height, at: list[i], repeat: label === previous });
      previous = label;
    }
    setLabels(out);
  };
  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  useLayoutEffect(measure, [times]);

  // Typing changes the DOM before the page's new times arrive, and a rewrap
  // (rotation, the sheet going fullscreen, a font arriving late) moves every
  // line without touching the text.
  useEffect(() => {
    const surface = scrollRef.current?.querySelector('.rich-surface') as HTMLElement | null;
    if (!surface) return;
    const mo = new MutationObserver(schedule);
    mo.observe(surface, { childList: true, characterData: true, subtree: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(surface);
    void document.fonts?.ready.then(schedule);
    return () => { mo.disconnect(); ro?.disconnect(); cancelAnimationFrame(frame.current); };
  }, [scrollRef]);

  return (
    <div className="relative shrink-0 w-12 border-r border-stone-200 bg-stone-50/60 select-none" aria-hidden="true" data-testid="pad-times">
      {labels.map((l) => (
        <span
          key={l.key}
          title={lineTitle(dayTimeLabel(l.at))}
          data-line={l.key}
          className={`absolute right-1.5 flex items-center text-[10px] leading-none tabular-nums ${l.repeat ? 'text-stone-300' : 'text-stone-500'}`}
          style={{ top: l.top, height: l.height }}
        >
          {clockLabel(l.at)}
        </span>
      ))}
    </div>
  );
}
