// The notebook's rules for one page, kept apart from the routes so they can be
// tested without a database (e2e/notebook-server-rules.spec.ts): what of a
// pushed page may be stored, and what a push does to the copy already stored.
// The routes, the lock, the merge by version and the prune stay in index.ts.
//
// A page has two sides since 24.10.2026: what the coach typed and what she
// wrote by hand, both optional (Jennifer, 23.10.2026: "combine it to 'new
// page' and then within a page one can switch between typing and
// handwriting"). `kind` keeps its two wire values and names the side last
// WRITTEN on the page (25.10.2026; for a day it was the side last shown). The
// installed apps 1.3.6 and 1.3.7 carry the frontend from before, and will for
// a while: they read `kind`, show that side only, and push the other one
// empty or not at all. That is acceptable on their screen — it is the side
// with the latest writing on it — and must never cost the other side on the
// server: the merge below is what keeps it, for every push that does not say
// `both`. The new client says `both` only for a record it knows both sides
// of; one the old frontend wrote on the same device goes without it.

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
// The handwriting may lie on a printed background — today only the court
// outline a coach sketches positions on. Not ink, not stored as ink.
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
// optional key does not narrow. `both` is the client saying it reads and writes
// both sides of a page; it describes the request, never the page, and is
// never stored.
export type NotebookSanitised = { page: NotebookPagePayload | null; reason: string; pageId: string; both: boolean };

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
 * `rejectedReason` (one device's bookkeeping), and `both` (returned beside the
 * page, never in it). An unreadable page is refused with a reason the client
 * can show, never defaulted into something else.
 *
 * Both sides are kept whatever `kind` says: the typed text, the background and
 * the strokes of either kind of page. What one client could not show is the
 * merge's business (mergeNotebookPayload), not the sanitiser's.
 */
export function sanitizeNotebookPage(raw: unknown, now: number): NotebookSanitised {
  const pageId = notebookRawId(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { page: null, reason: 'bad-page', pageId, both: false };
  const source = raw as Record<string, unknown>;
  const both = source.both === true;
  if (!NOTEBOOK_PAGE_ID_RE.test(pageId)) return { page: null, reason: 'bad-id', pageId, both };
  const kind = cut(source.kind, 8);
  if (!NOTEBOOK_KINDS.has(kind)) return { page: null, reason: 'bad-kind', pageId, both };
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
  const bg = cut(source.bg, 16);
  const page: NotebookPagePayload = {
    pageId,
    kind: kind as 'text' | 'ink',
    // One line of plain text on either kind of page: a pen page is named the
    // same way a written one is. Whitespace is collapsed here rather than
    // trusted, because this string is drawn, not parsed.
    title: deleted ? '' : cut(source.title, NOTEBOOK_MAX_TITLE_LEN).replace(/\s+/g, ' ').trim(),
    text: deleted ? '' : cut(source.text, NOTEBOOK_MAX_TEXT_LEN),
    bg: !deleted && NOTEBOOK_BACKGROUNDS.has(bg) ? bg : '',
    points: 0,
    usedIn: deleted ? [] : usedIn,
    createdAt: notebookStamp(source.createdAt, now),
    updatedAt: notebookStamp(source.updatedAt, now),
    deleted,
    schema: Number.isFinite(schema) && schema >= 1 ? Math.floor(schema) : 1,
    extra: deleted ? undefined : notebookExtra(source.extra),
  };
  if (!deleted) {
    // A page pushed without its strokes is a metadata-only update — the merge
    // keeps the strokes already stored — and a page whose strokes are present
    // must pass the shape check whole.
    if (source.ink !== undefined) {
      const ink = sanitizeNotebookInk(source.ink);
      if ('reason' in ink) return { page: null, reason: ink.reason, pageId, both };
      page.ink = ink.page;
      page.points = ink.points;
    } else {
      const points = Number(source.points);
      page.points = Number.isFinite(points) && points >= 0 ? Math.floor(points) : 0;
    }
  }
  return { page, reason: '', pageId, both };
}

/** Whether storing this page needs the payload already stored: a live page
 *  without its strokes, or one from a client that does not write both sides.
 *  Only then is the stored payload read — never every row's ink. */
export function notebookMergeNeedsStored(page: NotebookPagePayload, both: boolean): boolean {
  return !page.deleted && (page.ink === undefined || !both);
}

/**
 * The payload to store for a pushed page, given the one stored for it (null
 * when there is none, or when it is a tombstone). The row's own columns
 * (page_id, kind, the stamps, deleted, schema) are not in it.
 *
 *  (a) A live page that carries no `ink` keeps the stored `ink` and `points`.
 *      A push without strokes is metadata-only: a new client that never
 *      opened the handwriting here, a title on an old one. It used to replace
 *      the payload whole and wipe the strokes on the server.
 *  (b) A page from a client that does not write both sides, shown as
 *      handwriting, keeps the stored `text`: the old apps push '' for the
 *      text they cannot show on a pen page.
 *  (c) The same client's page shown as text keeps the stored `bg`: they push
 *      '' for the court under a page they show as text.
 *  A client that writes both sides sends what it shows: its text always wins,
 *  an empty one included, and explicit strokes — `[]` too — replace the
 *  stored ones. A tombstone stores nothing.
 *
 *  With nothing stored (a new row, or one revived over a tombstone), a push
 *  without strokes stores a count of none: the count is the server's word
 *  that it holds strokes to fetch, and here it holds none. The client said
 *  otherwise when its strokes stayed home — a page it had pushed before, whose
 *  row the server lost — and the next device then listed a pen page with
 *  nothing behind it (25.10.2026). The ack's `newRow` tells that client to
 *  send its strokes.
 */
export function mergeNotebookPayload(stored: unknown, page: NotebookPagePayload, both: boolean): Record<string, unknown> {
  if (page.deleted) return {};
  const { pageId: _id, kind, updatedAt: _u, deleted: _d, schema: _s, createdAt: _c, ink, ...rest } = page;
  void _id; void _u; void _d; void _s; void _c;
  const payload: Record<string, unknown> = { ...rest, ...(ink !== undefined ? { ink } : {}) };
  const prev = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null;
  if (!prev) {
    if (ink === undefined) payload.points = 0;
    return payload;
  }
  if (ink === undefined) {
    if (prev.ink !== undefined) payload.ink = prev.ink;
    const points = Number(prev.points);
    payload.points = Number.isFinite(points) && points >= 0 ? Math.floor(points) : 0;
  }
  if (!both && kind === 'ink') payload.text = typeof prev.text === 'string' ? prev.text : '';
  if (!both && kind === 'text') payload.bg = typeof prev.bg === 'string' && NOTEBOOK_BACKGROUNDS.has(prev.bg) ? prev.bg : '';
  return payload;
}
