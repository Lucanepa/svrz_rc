// The remarks a coach writes can carry bold, italic, underline, strikethrough
// and colour. Three very different renderers have to agree on what that means —
// the form on screen, the PDF the referee files, and the HTML e-mail — so the
// format is deliberately the smallest thing all three can render:
//
//   plain text, newlines, and these inline tags only:
//     <b> <i> <u> <s> <span style="color:#rrggbb">
//
// No block elements, no nesting rules to honour, no lists: a bullet is still the
// literal "• " the plain editor always inserted, so every line is a sequence of
// runs and the PDF's line-by-line layout still applies. Text written before any
// of this existed carries no tags and renders exactly as it did.
//
// The subset is also what makes this safe: anything not on the list is escaped,
// on the way in AND again on the server, because a coach's remarks end up inside
// an e-mail somebody else opens.

export interface RichRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** '#rrggbb', lower case. Absent means the document's own ink. */
  color?: string;
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Expand #abc to #aabbcc and lower-case it, or null when it is not a colour. */
export function normalizeColor(value: string): string | null {
  const raw = (value || '').trim().toLowerCase();
  if (!COLOR_RE.test(raw)) return null;
  if (raw.length === 4) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  return raw;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** True when the value carries formatting from the allowed subset. */
export function isRich(value: string): boolean {
  return /<(b|i|u|s|span|br)\b/i.test(value || '');
}

/** True when the value is markup at all — a tag of any kind, or an entity.
 *
 *  This, not isRich, is what decides whether a value is interpreted. A value
 *  holding "<script>" carries no ALLOWED tag, and treating it as plain text
 *  would store it verbatim: safe only for as long as every render site
 *  remembers to escape it, and one dangerouslySetInnerHTML away from not being.
 *  Anything tag-shaped therefore goes through the parser, which escapes
 *  everything outside the subset — so what is stored is already safe. */
export function isHtmlValue(value: string): boolean {
  return /<[a-z/!]|&(?:amp|lt|gt|quot|nbsp|#\d+);/i.test(value || '');
}

/**
 * Split one already-sanitised value into lines of runs. Newlines and <br> both
 * end a line; the caller lays lines out, this only says what is on them.
 */
export function toRuns(value: string): RichRun[][] {
  // A value with no tags is text, not markup: it must not be run through the
  // entity decoder, or a coach who typed "&amp;" as three words would see it
  // turn into "&".
  if (!isHtmlValue(value || '')) {
    return (value || '').split('\n').map((line) => (line ? [{ text: line }] : []));
  }
  const lines: RichRun[][] = [];
  let current: RichRun[] = [];
  // The tags that are open at this point, innermost last.
  const open: { tag: string; color?: string }[] = [];

  const style = (): Omit<RichRun, 'text'> => {
    const out: Omit<RichRun, 'text'> = {};
    for (const entry of open) {
      if (entry.tag === 'b') out.bold = true;
      else if (entry.tag === 'i') out.italic = true;
      else if (entry.tag === 'u') out.underline = true;
      else if (entry.tag === 's') out.strike = true;
      else if (entry.tag === 'span' && entry.color) out.color = entry.color;
    }
    return out;
  };

  const push = (text: string) => {
    if (!text) return;
    const decoded = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    for (const [index, part] of decoded.split('\n').entries()) {
      if (index > 0) { lines.push(current); current = []; }
      if (part) current.push({ text: part, ...style() });
    }
  };

  const pattern = /<(\/?)(b|strong|i|em|u|s|strike|del|span|br)\b([^>]*)>/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value || ''))) {
    push(value.slice(last, match.index));
    last = pattern.lastIndex;
    const closing = match[1] === '/';
    const raw = match[2].toLowerCase();
    const tag = raw === 'strong' ? 'b' : raw === 'em' ? 'i' : (raw === 'strike' || raw === 'del') ? 's' : raw;
    if (tag === 'br') { lines.push(current); current = []; continue; }
    if (closing) {
      // Close the innermost matching tag; a stray close is simply ignored.
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].tag === tag) { open.splice(i, 1); break; }
      }
    } else {
      const color = tag === 'span' ? normalizeColor((/color\s*:\s*([^;"']+)/i.exec(match[3]) || [])[1] || '') : null;
      open.push({ tag, color: color ?? undefined });
    }
  }
  push((value || '').slice(last));
  lines.push(current);
  return lines;
}

/**
 * Everything that is not the allowed subset becomes text. Runs are re-emitted
 * from the parse rather than patched in place, so no malformed markup can
 * survive by being unparseable — what comes out is always well-formed.
 */
export function sanitizeRich(value: string): string {
  // Plain text in, plain text out, unchanged — that is what every value written
  // before this existed looks like, and escaping it here would rewrite history
  // for no gain. Only markup is interpreted, and once it is, everything that is
  // not the allowed subset has already become escaped text.
  if (!isHtmlValue(value || '')) return value || '';
  const lines = toRuns(value || '');
  const out = lines.map((runs) => runs.map((run) => {
    let html = escapeHtml(run.text);
    if (run.color) html = `<span style="color:${run.color}">${html}</span>`;
    if (run.strike) html = `<s>${html}</s>`;
    if (run.underline) html = `<u>${html}</u>`;
    if (run.italic) html = `<i>${html}</i>`;
    if (run.bold) html = `<b>${html}</b>`;
    return html;
  }).join('')).join('\n');
  return out;
}

/** The same content with every tag dropped — for the plain-text mail part, for
 *  previews, and for anything that counts characters. */
export function richToPlain(value: string): string {
  return toRuns(value || '').map((runs) => runs.map((r) => r.text).join('')).join('\n');
}

/** Sanitised HTML for an e-mail body: the subset, plus <br> for the newlines. */
export function richToEmailHtml(value: string): string {
  const clean = sanitizeRich(value);
  // Sanitised markup is already escaped where it had to be; plain text has not
  // been touched at all and is escaped here, once.
  const html = isHtmlValue(clean) ? clean : escapeHtml(clean);
  return html.split('\n').join('<br />');
}

/** The same thing for the screen: safe HTML for one value, newlines kept as
 *  newlines so CSS (white-space: pre-wrap) lays them out. Every place that
 *  renders remarks as HTML must go through this. */
export function richToDisplayHtml(value: string): string {
  const clean = sanitizeRich(value);
  return isHtmlValue(clean) ? clean : escapeHtml(clean);
}

/**
 * Read a contenteditable back into the stored subset.
 *
 * Browsers do not agree on what execCommand emits — <b> or <span
 * style="font-weight:bold">, <strike> or <s>, <font color> or a style — and a
 * paste brings in whatever the source page had. So the DOM is walked and the
 * subset is re-emitted from what each text node actually inherits, rather than
 * the markup being cleaned up in place.
 */
export function domToRich(root: HTMLElement): string {
  const parts: string[] = [];

  const rgbToHex = (value: string): string | null => {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value.trim());
    if (m) {
      const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      return normalizeColor(`#${hex}`);
    }
    return normalizeColor(value);
  };

  const walk = (node: Node, style: Omit<RichRun, 'text'>): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').replace(/ /g, ' ');
      if (!text) return;
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      if (style.color) html = `<span style="color:${style.color}">${html}</span>`;
      if (style.strike) html = `<s>${html}</s>`;
      if (style.underline) html = `<u>${html}</u>`;
      if (style.italic) html = `<i>${html}</i>`;
      if (style.bold) html = `<b>${html}</b>`;
      parts.push(html);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') { parts.push('\n'); return; }
    // A block element starts a new line unless nothing has been written yet.
    const isBlock = /^(div|p|li|tr|h[1-6])$/.test(tag);
    if (isBlock && parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');

    const inline = el.style;
    const next: Omit<RichRun, 'text'> = {
      bold: style.bold || tag === 'b' || tag === 'strong' || Number(inline.fontWeight) >= 600 || inline.fontWeight === 'bold',
      italic: style.italic || tag === 'i' || tag === 'em' || inline.fontStyle === 'italic',
      underline: style.underline || tag === 'u' || inline.textDecorationLine?.includes('underline') || inline.textDecoration?.includes('underline'),
      strike: style.strike || tag === 's' || tag === 'strike' || tag === 'del'
        || inline.textDecorationLine?.includes('line-through') || inline.textDecoration?.includes('line-through'),
      color: rgbToHex(inline.color || '') ?? (tag === 'font' ? normalizeColor(el.getAttribute('color') || '') : null) ?? style.color,
    };
    for (const child of Array.from(el.childNodes)) walk(child, next);
    if (isBlock && parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
  };

  for (const child of Array.from(root.childNodes)) walk(child, {});
  // Collapse the trailing newline a contenteditable always leaves behind.
  return sanitizeRich(parts.join('').replace(/\n+$/, ''));
}

/** The stored value as HTML for a contenteditable: newlines become <br>. */
export function richToEditableHtml(value: string): string {
  return richToDisplayHtml(value).split('\n').join('<br>');
}
