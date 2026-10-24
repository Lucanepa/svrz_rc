// The notebook's rules for one page, kept apart from the routes so they can be
// tested without a database: what of a pushed page may be stored. The routes,
// the lock, the merge by version and the prune stay in index.ts.

export const NOTEBOOK_MAX_TEXT_LEN = 20_000;          // a page, not a report
export const NOTEBOOK_MAX_TITLE_LEN = 60;             // a label in the page strip, not a heading
export const NOTEBOOK_MAX_INK_CHARS = 800_000;        // serialised ink page — the SAME predicate src/lib/notebook.ts checks at stroke end
export const NOTEBOOK_MAX_INK_STROKES = 4_000;
export const NOTEBOOK_MAX_USED_IN = 10;
export const NOTEBOOK_MAX_EXTRA_BYTES = 20_000;
export const NOTEBOOK_MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
/** A use's label is a game's name: the parked drafts' short-text cap. */
const NOTEBOOK_MAX_LABEL_LEN = 300;
export const NOTEBOOK_PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const NOTEBOOK_KINDS = new Set(['text', 'ink']);
export const NOTEBOOK_FIELDS = new Set(['bemerkungen', 'highlights', 'improvements', 'goals', 'tips']);
/** The two halves of a report a page can be lifted into (FEEDBACK_ROLES). */
const NOTEBOOK_ROLES = ['1. SR', '2. SR'];
// A pen page may carry a printed background under the ink — today only the
// court outline a coach sketches positions on. Not ink, not stored as ink.
export const NOTEBOOK_BACKGROUNDS = new Set(['', 'court']);

export type NotebookUse = { f: string; r: string; g: string; label: string; t: number };
export type NotebookPagePayload = {
  pageId: string;
  kind: 'text' | 'ink';
  title: string;
  text: string;
  bg: string;
  points: number;
  usedIn: NotebookUse[];
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  schema: number;
  ink?: unknown;
  extra?: Record<string, unknown>;
};
// Flat, not a tagged union: tsconfig has no `strict`, so a union tagged by an
// optional key does not narrow.
export type NotebookSanitised = { page: NotebookPagePayload | null; reason: string; pageId: string };

// String(), not a trim: a page has to come back exactly as the coach left it.
// Objects and arrays become '' rather than "[object Object]". The same rule as
// parkText in index.ts.
function cut(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max);
  return '';
}

// Forward compatibility, bounded, as parkExtra in index.ts: keys a newer build
// wrote travel through unread, capped by their serialised size.
function notebookExtra(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > NOTEBOOK_MAX_EXTRA_BYTES) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch { return undefined; }
}

// A device clock that is merely wrong is normal; one a day ahead would pin a
// page to the top of every list and, for createdAt, stretch its week. Beyond a
// day of skew the server's own now is used, and the client adopts what the ack
// reports back, so the expiry it shows is the one that will be enforced.
export function notebookStamp(raw: unknown, now: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return now;
  return n > now + NOTEBOOK_MAX_CLOCK_SKEW_MS ? now : Math.floor(n);
}

export function notebookRawId(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const id = (raw as Record<string, unknown>).pageId;
  return id === null || id === undefined ? '' : String(id).trim().slice(0, 64);
}

// Ink is numbers and nothing else: a page is { w: 1000, h: 1414, strokes }, a
// stroke is { c, w, p, d } with `d` a flat array of integers in groups of four.
// There is no string anywhere in it, so nothing in a stored page can be a URL,
// markup or a beacon — the reason parkSignature exists does not arise here.
export function sanitizeNotebookInk(raw: unknown): { page: { w: number; h: number; strokes: unknown[] }; points: number } | { reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'ink-shape' };
  const source = raw as Record<string, unknown>;
  if (source.w !== 1000 || source.h !== 1414 || !Array.isArray(source.strokes)) return { reason: 'ink-shape' };
  if (source.strokes.length > NOTEBOOK_MAX_INK_STROKES) return { reason: 'ink-too-big' };
  const strokes: unknown[] = [];
  let points = 0;
  for (const item of source.strokes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { reason: 'ink-shape' };
    const st = item as Record<string, unknown>;
    const c = st.c === 1 ? 1 : st.c === 0 ? 0 : -1;
    const w = Number(st.w);
    const p = st.p === 1 ? 1 : st.p === 0 ? 0 : -1;
    const d = st.d;
    if (c < 0 || p < 0 || !Number.isInteger(w) || w < 1 || w > 20 || !Array.isArray(d) || d.length % 4 !== 0) return { reason: 'ink-shape' };
    for (const v of d) if (!Number.isInteger(v)) return { reason: 'ink-shape' };
    points += d.length / 4;
    strokes.push({ c, w, p, d });
  }
  const page = { w: 1000, h: 1414, strokes };
  if (JSON.stringify(page).length > NOTEBOOK_MAX_INK_CHARS) return { reason: 'ink-too-big' };
  return { page, points };
}

/**
 * One page, reduced to what may be stored. DROPPED: `ownerId` and `id` (the
 * body asserting whose page this is — the session says), `dirty`, `savedAt`,
 * `rejectedReason` (one device's bookkeeping). An unreadable page is refused
 * with a reason the client can show, never defaulted into something else.
 */
export function sanitizeNotebookPage(raw: unknown, now: number): NotebookSanitised {
  const pageId = notebookRawId(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { page: null, reason: 'bad-page', pageId };
  const source = raw as Record<string, unknown>;
  if (!NOTEBOOK_PAGE_ID_RE.test(pageId)) return { page: null, reason: 'bad-id', pageId };
  const kind = cut(source.kind, 8);
  if (!NOTEBOOK_KINDS.has(kind)) return { page: null, reason: 'bad-kind', pageId };
  const deleted = source.deleted === true;
  const schema = Number(source.schema);
  const usedIn: NotebookUse[] = [];
  if (Array.isArray(source.usedIn)) {
    for (const u of source.usedIn.slice(0, NOTEBOOK_MAX_USED_IN)) {
      if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
      const use = u as Record<string, unknown>;
      const f = cut(use.f, 32);
      const r = cut(use.r, 8);
      if (!NOTEBOOK_FIELDS.has(f) || !NOTEBOOK_ROLES.includes(r)) continue;
      usedIn.push({ f, r, g: cut(use.g, 64), label: cut(use.label, NOTEBOOK_MAX_LABEL_LEN), t: notebookStamp(use.t, now) });
    }
  }
  const page: NotebookPagePayload = {
    pageId,
    kind: kind as 'text' | 'ink',
    // One line of plain text on either kind of page: a pen page is named the
    // same way a written one is. Whitespace is collapsed here rather than
    // trusted, because this string is drawn, not parsed.
    title: deleted ? '' : cut(source.title, NOTEBOOK_MAX_TITLE_LEN).replace(/\s+/g, ' ').trim(),
    text: deleted || kind !== 'text' ? '' : cut(source.text, NOTEBOOK_MAX_TEXT_LEN),
    bg: !deleted && kind === 'ink' && NOTEBOOK_BACKGROUNDS.has(cut(source.bg, 16)) ? cut(source.bg, 16) : '',
    points: 0,
    usedIn: deleted ? [] : usedIn,
    createdAt: notebookStamp(source.createdAt, now),
    updatedAt: notebookStamp(source.updatedAt, now),
    deleted,
    schema: Number.isFinite(schema) && schema >= 1 ? Math.floor(schema) : 1,
    extra: deleted ? undefined : notebookExtra(source.extra),
  };
  if (!deleted && kind === 'ink') {
    // An ink page pushed without its strokes is a metadata-only update (a
    // usedIn mark cannot happen on ink, so in practice: nothing) — and a page
    // whose strokes are present must pass the shape check whole.
    if (source.ink !== undefined) {
      const ink = sanitizeNotebookInk(source.ink);
      if ('reason' in ink) return { page: null, reason: ink.reason, pageId };
      page.ink = ink.page;
      page.points = ink.points;
    } else {
      const points = Number(source.points);
      page.points = Number.isFinite(points) && points >= 0 ? Math.floor(points) : 0;
    }
  }
  return { page, reason: '', pageId };
}

/** The payload a row stores for a page: everything but the row's own columns
 *  (page_id, kind, the stamps, deleted, schema). A tombstone stores nothing. */
export function notebookPayload(page: NotebookPagePayload): Record<string, unknown> {
  if (page.deleted) return {};
  const { pageId: _id, kind: _k, updatedAt: _u, deleted: _d, schema: _s, createdAt: _c, ink, ...rest } = page;
  void _id; void _k; void _u; void _d; void _s; void _c;
  return { ...rest, ...(ink ? { ink } : {}) };
}
