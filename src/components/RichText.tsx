// The rich-text editor the form's long-form fields and the notebook share:
// one contenteditable surface over the restricted subset in src/lib/richText.ts,
// and the toolbar that formats a selection. Moved out of App.tsx unchanged
// when the notebook needed the same editor.

import React, { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import { domToRich, richToEditableHtml, richToPlain, toRuns } from '../lib/richText';

// One editable surface, used both inline and in the full-screen editor.
//
// Uncontrolled on purpose: writing `value` back into the DOM on every keystroke
// puts the caret at position zero, which is the classic contenteditable bug. The
// DOM is authoritative while the field has focus, and the incoming value is only
// applied when it differs from what is already rendered.
export function RichSurface({ value, onChange, placeholder, className, style, autoFocus, onFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = richToEditableHtml(value);
    // Comparing against what we last emitted, not against innerHTML verbatim:
    // the browser normalises its own markup and would otherwise look changed
    // after every keystroke.
    if (domToRich(el) !== value) el.innerHTML = next;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
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
      onInput={() => { const el = ref.current; if (el) onChange(domToRich(el)); }}
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
export function RichToolbar({ de, onCommand, onBullet, onNumber, children }: {
  de: boolean;
  onCommand: (command: string, value?: string) => void;
  onBullet: () => void;
  /** A numbered line, continuing the count above it. Only where a caller wants it. */
  onNumber?: () => void;
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
