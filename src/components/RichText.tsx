// The rich-text editor the form's long-form fields and the notebook share:
// one contenteditable surface over the restricted subset in src/lib/richText.ts,
// and the toolbar that formats a selection. Moved out of App.tsx unchanged
// when the notebook needed the same editor.

import React, { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import { BOX_DONE, BOX_OPEN, domToRich, richToEditableHtml, richToPlain, toRuns } from '../lib/richText';

/** A line that is a list item: its indent, its mark (a box, a bullet, or a
 *  number with its dot) and the space after it. */
const LIST_LINE = new RegExp(`^([ \\t]*)([${BOX_OPEN}${BOX_DONE}•]|(\\d{1,3})\\.)(?: |$)`);

/** The text of the caret's line on one side of it, read off the DOM the way
 *  domToRich reads it: a <br> or a block ends a line, as does a newline in a
 *  text node. (Range.toString() would lose the <br>s, and with them the lines.) */
function lineText(root: HTMLElement, caret: Range, side: 'before' | 'after'): string {
  const range = document.createRange();
  if (side === 'before') { range.setStart(root, 0); range.setEnd(caret.startContainer, caret.startOffset); }
  else { range.setStart(caret.startContainer, caret.startOffset); range.setEnd(root, root.childNodes.length); }
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { out += node.textContent || ''; return; }
    if (node.nodeName === 'BR') { out += '\n'; return; }
    const block = /^(DIV|P|LI)$/.test(node.nodeName);
    if (block && out && !out.endsWith('\n')) out += '\n';
    node.childNodes.forEach(walk);
    if (block && side === 'after' && !out.endsWith('\n')) out += '\n';
  };
  range.cloneContents().childNodes.forEach(walk);
  return side === 'before' ? out.slice(out.lastIndexOf('\n') + 1) : out.split('\n')[0];
}

/** The plain text a fragment reads as, the way lineText reads it: a <br> is a
 *  newline, and so is the start of a block after text. */
function plainOf(node: Node): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent || ''; return; }
    if (n.nodeName === 'BR') { out += '\n'; return; }
    if (/^(DIV|P|LI)$/.test(n.nodeName) && out && !out.endsWith('\n')) out += '\n';
    n.childNodes.forEach(walk);
  };
  node.childNodes.forEach(walk);
  return out;
}

/** A selection's place in a surface as character offsets from its start: a
 *  bookmark that outlives the surface's DOM, which is rebuilt from the value
 *  when the surface comes back (the notebook's typed side, after the
 *  handwriting was on screen). Null when the range is not in the surface. */
export function caretOffsets(root: HTMLElement, range: Range): [number, number] | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const upTo = (node: Node, offset: number): number => {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return plainOf(r.cloneContents()).length;
  };
  try { return [upTo(range.startContainer, range.startOffset), upTo(range.endContainer, range.endOffset)]; } catch { return null; }
}

/** The DOM point `target` characters into a surface, counted as caretOffsets
 *  counts them. */
function pointAt(root: HTMLElement, target: number): [Node, number] {
  let count = 0;
  let last = '';
  let found: [Node, number] | null = null;
  const walk = (n: Node): void => {
    if (found) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent || '';
      if (count + t.length >= target) { found = [n, target - count]; return; }
      count += t.length;
      if (t) last = t[t.length - 1];
      return;
    }
    if (n.nodeName === 'BR') {
      const parent = n.parentNode as Node;
      if (count >= target) { found = [parent, Array.prototype.indexOf.call(parent.childNodes, n)]; return; }
      count += 1; last = '\n';
      return;
    }
    if (/^(DIV|P|LI)$/.test(n.nodeName) && count > 0 && last !== '\n') { count += 1; last = '\n'; }
    n.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return found || [root, root.childNodes.length];
}

/** Puts the selection back where caretOffsets read it, focusing the surface
 *  without scrolling it: the caller puts the scroll back itself. */
export function setCaretOffsets(root: HTMLElement, [start, end]: [number, number]): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  try {
    const [sn, so] = pointAt(root, start);
    const [en, eo] = pointAt(root, end);
    range.setStart(sn, so);
    range.setEnd(en, eo);
  } catch { return; }
  if (document.activeElement !== root) root.focus({ preventScroll: true });
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Nothing written: no text, and no more than the one line break a browser
 *  leaves in a box emptied by hand. The placeholder is keyed on this, set
 *  from here (data-empty): the CSS rule it replaced — "only a <br>" — also
 *  matched "Hallo<br>", since a text node is no element, and put the
 *  placeholder in front of the coach's first line (UI review, 25.10.2026). */
function markEmpty(el: HTMLElement): void {
  const empty = !(el.textContent || '') && el.querySelectorAll('br').length <= 1;
  el.dataset.empty = empty ? 'true' : 'false';
}

// One editable surface, used both inline and in the full-screen editor.
//
// Uncontrolled on purpose: writing `value` back into the DOM on every keystroke
// puts the caret at position zero, which is the classic contenteditable bug. The
// DOM is authoritative while the field has focus, and the incoming value is only
// applied when it differs from what is already rendered.
export function RichSurface({ value, onChange, placeholder, className, style, autoFocus, initialCaret, onFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  /** With autoFocus: where the caret goes, as caretOffsets read it when this
   *  surface was last on screen. Read once, at mount. */
  initialCaret?: [number, number] | null;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const caretAtMount = useRef(initialCaret);
  caretAtMount.current = initialCaret;
  /** The checklist box under the pointer, if the pointer is ON one: a click
   *  beside it is a click into the text, and must place the caret as always. */
  const boxAt = (x: number, y: number): { node: Text; index: number } | null => {
    const el = ref.current;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!el || !node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
    const text = node.textContent || '';
    // The caret lands before or after the glyph, depending on which half was hit.
    for (const index of [offset, offset - 1]) {
      if (text[index] !== BOX_OPEN && text[index] !== BOX_DONE) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const r = range.getBoundingClientRect();
      // A little give around it: the glyph is text-sized, and a thumb is not.
      if (x >= r.left - 6 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return { node: node as Text, index };
    }
    return null;
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = richToEditableHtml(value);
    // Comparing against what we last emitted, not against innerHTML verbatim:
    // the browser normalises its own markup and would otherwise look changed
    // after every keystroke.
    if (domToRich(el) !== value) el.innerHTML = next;
    markEmpty(el);
  }, [value]);
  // Focused with the caret where it was left, or at the END of what is there:
  // focus() alone puts it in front of the first letter, and what was typed
  // next landed there. Here and not in the caller: StrictMode runs a new
  // surface's effects twice, after its parent's, and a caret the parent put
  // back was moved to the end again (25.10.2026).
  useEffect(() => {
    const el = ref.current;
    if (!autoFocus || !el) return;
    if (caretAtMount.current) { setCaretOffsets(el, caretAtMount.current); return; }
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, [autoFocus]);
  // Enter on a list line starts the next one: a box after a box (open, even
  // under a ticked one), a bullet after a bullet, 3. after 2. Enter on an item
  // with nothing written ends the list instead, as every editor does. On
  // `beforeinput`, not keydown: a phone keyboard's Enter arrives there as
  // insertParagraph and often carries no usable key code at all.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== 'insertParagraph') return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
      const caret = sel.getRangeAt(0);
      if (!el.contains(caret.startContainer)) return;
      const before = lineText(el, caret, 'before');
      const m = LIST_LINE.exec(before);
      if (!m) return;
      const [marker, indent, mark, num] = m;
      const after = lineText(el, caret, 'after');
      if (!before.slice(marker.length).trim() && !after.trim()) {
        // An empty item: take its marker back off, and the list is over.
        for (let i = 0; i < before.length; i += 1) sel.modify('extend', 'backward', 'character');
        if (document.execCommand('delete')) e.preventDefault();
        return;
      }
      const next = mark === BOX_OPEN || mark === BOX_DONE ? `${BOX_OPEN} ` : mark === '•' ? '• ' : `${Number(num) + 1}. `;
      // Only once the browser has taken the insert is its own Enter cancelled:
      // a browser that refuses execCommand here still gets a plain new line.
      if (document.execCommand('insertText', false, `\n${indent}${next}`)) e.preventDefault();
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, []);
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      onFocus={onFocus}
      onInput={() => { const el = ref.current; if (el) { markEmpty(el); onChange(domToRich(el)); } }}
      // A box is ticked by tapping it. mousedown is held back on a box so the
      // caret stays where the coach was writing (and, on a desktop, the field
      // does not even take focus); the click then swaps the one character in
      // place, so nothing else in the text moves.
      onMouseDown={(e) => { if (boxAt(e.clientX, e.clientY)) e.preventDefault(); }}
      onClick={(e) => {
        const hit = boxAt(e.clientX, e.clientY);
        const el = ref.current;
        if (!hit || !el) return;
        hit.node.replaceData(hit.index, 1, hit.node.data[hit.index] === BOX_OPEN ? BOX_DONE : BOX_OPEN);
        onChange(domToRich(el));
      }}
      onBlur={() => { const el = ref.current; if (el) onChange(domToRich(el)); }}
      // Paste as text, then let the toolbar add formatting: pasting from Word
      // otherwise drags in fonts, sizes and background colours that the subset
      // would drop anyway, mid-sentence and invisibly.
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }}
      className={cn('rich-surface outline-none whitespace-pre-wrap break-words', className)}
      style={style}
    />
  );
}

export const RICH_COLOURS = ['#1c1917', '#b91c1c', '#b45309', '#15803d', '#1d4ed8', '#7e22ce'];

/** The formatting toolbar. execCommand is deprecated and still the only thing
 *  every browser implements for a contenteditable selection; the output is
 *  normalised by domToRich on the way out, so what it emits does not matter. */
export function RichToolbar({ de, onCommand, onBullet, onNumber, onCheck, children }: {
  de: boolean;
  onCommand: (command: string, value?: string) => void;
  onBullet: () => void;
  /** A numbered line, continuing the count above it. Only where a caller wants it. */
  onNumber?: () => void;
  /** A checklist line, its box ticked by tapping it. Only where a caller wants it. */
  onCheck?: () => void;
  children?: React.ReactNode;
}) {
  const btn = 'h-8 min-w-8 px-2 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" title={de ? 'Fett' : 'Bold'} aria-label={de ? 'Fett' : 'Bold'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('bold')} className={cn(btn, 'font-bold')}>B</button>
      <button type="button" title={de ? 'Kursiv' : 'Italic'} aria-label={de ? 'Kursiv' : 'Italic'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('italic')} className={cn(btn, 'italic')}>I</button>
      <button type="button" title={de ? 'Unterstrichen' : 'Underline'} aria-label={de ? 'Unterstrichen' : 'Underline'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('underline')} className={cn(btn, 'underline')}>U</button>
      <button type="button" title={de ? 'Durchgestrichen' : 'Strikethrough'} aria-label={de ? 'Durchgestrichen' : 'Strikethrough'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('strikeThrough')} className={cn(btn, 'line-through')}>S</button>
      <span className="mx-0.5 h-5 w-px bg-stone-200" />
      {RICH_COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          title={de ? 'Textfarbe' : 'Text colour'}
          aria-label={`${de ? 'Textfarbe' : 'Text colour'} ${colour}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommand('foreColor', colour)}
          className="h-6 w-6 rounded-full border border-stone-300 hover:scale-110 transition-transform"
          style={{ backgroundColor: colour }}
        />
      ))}
      <span className="mx-0.5 h-5 w-px bg-stone-200" />
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onBullet} className={btn}>• {de ? 'Aufzählung' : 'Bullet'}</button>
      {onNumber && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onNumber} className={btn}>1. {de ? 'Nummerierung' : 'Numbered'}</button>}
      {/* The box alone: with a word beside it the notebook's toolbar wrapped
          onto a second row, height that sheet does not have. */}
      {onCheck && <button type="button" title={de ? 'Checkliste' : 'Checklist'} aria-label={de ? 'Checkliste' : 'Checklist'} onMouseDown={(e) => e.preventDefault()} onClick={onCheck} className={cn(btn, 'text-sm')}>{BOX_DONE}</button>}
      {children}
    </div>
  );
}


/** A new bullet line at the end of the value — the literal "• " the subset
 *  keeps, which the PDF and the e-mail print as-is. */
export function appendBullet(value: string): string {
  const plain = richToPlain(value);
  return value ? `${value.replace(/\s+$/, '')}${plain ? '\n' : ''}• ` : '• ';
}

/** A new checklist line at the end of the value: an open box, ticked later by
 *  tapping it. Plain characters like the bullet, so the line survives every
 *  renderer — the PDF prints the box in a glyph its font has. */
export function appendCheck(value: string): string {
  const plain = richToPlain(value);
  return value ? `${value.replace(/\s+$/, '')}${plain ? '\n' : ''}${BOX_OPEN} ` : `${BOX_OPEN} `;
}

/** A new numbered line: one more than the last numbered line above, else 1. */
export function appendNumbered(value: string): string {
  const lines = richToPlain(value).split('\n');
  let last = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // A line that is only its number (the coach pressed the button twice) still counts.
    const m = /^(\d+)\.(\s|$)/.exec(lines[i].trim());
    if (m) { last = Number(m[1]); break; }
    if (lines[i].trim()) break;   // a non-numbered line ends the list
  }
  const next = `${last + 1}. `;
  return value ? `${value.replace(/\s+$/, '')}${richToPlain(value) ? '\n' : ''}${next}` : next;
}

/** A stored value shown, not edited: the subset rendered as elements, so no
 *  markup is ever handed to the DOM as a string. Lines become lines. */
export function RichView({ value, className }: { value: string; className?: string }) {
  const lines = toRuns(value || '');
  return (
    <div className={cn('whitespace-pre-wrap break-words', className)}>
      {lines.map((runs, li) => (
        <React.Fragment key={li}>
          {li > 0 && '\n'}
          {runs.map((run, ri) => {
            let node: React.ReactNode = run.text;
            if (run.color) node = <span style={{ color: run.color }}>{node}</span>;
            if (run.strike) node = <s>{node}</s>;
            if (run.underline) node = <u>{node}</u>;
            if (run.italic) node = <i>{node}</i>;
            if (run.bold) node = <b>{node}</b>;
            return <React.Fragment key={ri}>{node}</React.Fragment>;
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
