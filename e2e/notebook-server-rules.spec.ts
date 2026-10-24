import { test, expect } from '@playwright/test';
import { mergeNotebookPayload, notebookMergeNeedsStored, sanitizeNotebookPage, type NotebookPagePayload } from '../server/notebook';

// The server's half of a page with two sides, without a database: what of a
// pushed page is kept, and what a push does to the copy already stored. The
// installed apps (1.3.6, 1.3.7) show one side of a page and push the other one
// empty or not at all; nothing they send may cost the side they cannot show
// (24.10.2026).

const NOW = Date.parse('2026-10-24T18:00:00Z');
const STROKE = { c: 0, w: 4, p: 1, d: [1000, 2000, 50, 0, 30, 10, 60, 16] };
const INK = { w: 1000, h: 1414, strokes: [STROKE] };

function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageId: 'page-rules-0001', kind: 'text', title: 'Halbzeit', text: 'getippt', bg: '', points: 0, usedIn: [],
    createdAt: NOW - 60_000, updatedAt: NOW - 1_000, deleted: false, schema: 1, ...over,
  };
}
function sane(over: Record<string, unknown> = {}): { page: NotebookPagePayload; both: boolean } {
  const s = sanitizeNotebookPage(wire(over), NOW);
  expect(s.reason).toBe('');
  return { page: s.page!, both: s.both };
}
/** What a page of both sides looks like once stored. */
const STORED = { title: 'Halbzeit', text: 'getippt', bg: 'court', points: 2, usedIn: [], ink: INK };

test.describe('A pushed page keeps both sides', () => {
  test('text and strokes on a page shown as text', () => {
    const { page } = sane({ kind: 'text', ink: INK, bg: 'court' });
    expect(page.text).toBe('getippt');
    expect(page.ink).toEqual(INK);
    expect(page.points).toBe(2);
    expect(page.bg).toBe('court');
  });

  test('text and strokes on a page shown as handwriting', () => {
    const { page } = sane({ kind: 'ink', ink: INK });
    expect(page.text).toBe('getippt');
    expect(page.ink).toEqual(INK);
    expect(page.points).toBe(2);
  });

  test('without strokes, the count is the one the page says', () => {
    expect(sane({ kind: 'text', points: 37 }).page.points).toBe(37);
    expect(sane({ kind: 'ink', points: -4 }).page.points).toBe(0);
    expect(sane({ kind: 'text', points: 37 }).page.ink).toBeUndefined();
  });

  test('a background that is not the court is none', () => {
    expect(sane({ bg: 'https://example.org/x.png' }).page.bg).toBe('');
  });

  test('"both" describes the request: returned beside the page, never stored', () => {
    const s = sane({ both: true, ink: INK });
    expect(s.both).toBe(true);
    expect(s.page).not.toHaveProperty('both');
    expect(mergeNotebookPayload(null, s.page, s.both)).not.toHaveProperty('both');
    // Anything but the boolean true is a client that does not write both.
    expect(sane({ both: 'yes' }).both).toBe(false);
    expect(sane().both).toBe(false);
  });

  test('strokes of the wrong shape are still refused, whatever side is shown', () => {
    for (const kind of ['text', 'ink']) {
      const s = sanitizeNotebookPage(wire({ kind, ink: { w: 1000, h: 1414, strokes: [{ c: 0, w: 4, p: 1, d: [1, 2, 3] }] } }), NOW);
      expect(s.page).toBeNull();
      expect(s.reason).toBe('ink-shape');
      const big = sanitizeNotebookPage(wire({ kind, ink: { w: 1000, h: 1414, strokes: Array.from({ length: 4_001 }, () => STROKE) } }), NOW);
      expect(big.reason).toBe('ink-too-big');
    }
    // A string where a number belongs: nothing in a stored page may be a URL.
    const url = sanitizeNotebookPage(wire({ ink: { w: 1000, h: 1414, strokes: [{ ...STROKE, d: ['https://x', 0, 0, 0] }] } }), NOW);
    expect(url.reason).toBe('ink-shape');
  });

  test('a tombstone keeps neither side', () => {
    const { page } = sane({ deleted: true, ink: INK, bg: 'court' });
    expect(page.text).toBe('');
    expect(page.bg).toBe('');
    expect(page.ink).toBeUndefined();
    expect(page.points).toBe(0);
  });
});

test.describe('A push merged into the stored page', () => {
  test('an installed app pushing a page it shows as handwriting keeps the typed text', () => {
    // The old frontend cannot show the text of a pen page and pushes '' for it.
    const { page, both } = sane({ kind: 'ink', text: '', ink: { w: 1000, h: 1414, strokes: [STROKE, STROKE] } });
    expect(notebookMergeNeedsStored(page, both)).toBe(true);
    const merged = mergeNotebookPayload(STORED, page, both);
    expect(merged.text).toBe('getippt');
    expect((merged.ink as typeof INK).strokes).toHaveLength(2);
    expect(merged.points).toBe(4);
  });

  test('an installed app pushing a page it shows as text keeps the strokes and the court', () => {
    // No ink on the wire and bg '' — the old frontend's text page.
    const { page, both } = sane({ kind: 'text', text: 'neu getippt', bg: '', points: 0 });
    expect(notebookMergeNeedsStored(page, both)).toBe(true);
    const merged = mergeNotebookPayload(STORED, page, both);
    expect(merged.text).toBe('neu getippt');
    expect(merged.ink).toEqual(INK);
    expect(merged.points).toBe(2);
    expect(merged.bg).toBe('court');
  });

  test('a push without strokes keeps them for a client that writes both sides too', () => {
    // A new client that never opened the handwriting of this page here.
    const { page, both } = sane({ kind: 'text', text: 'Titel geändert', points: 2, bg: 'court', both: true });
    expect(notebookMergeNeedsStored(page, both)).toBe(true);
    const merged = mergeNotebookPayload(STORED, page, both);
    expect(merged.ink).toEqual(INK);
    expect(merged.points).toBe(2);
  });

  test('a client that writes both sides clears the text by sending none', () => {
    const { page, both } = sane({ kind: 'ink', text: '', ink: INK, both: true });
    // Everything it stores came with the push: nothing to read.
    expect(notebookMergeNeedsStored(page, both)).toBe(false);
    const merged = mergeNotebookPayload(STORED, page, both);
    expect(merged.text).toBe('');
    expect(merged.ink).toEqual(INK);
  });

  test('explicit empty strokes clear the handwriting, from any client', () => {
    for (const extra of [{ both: true }, {}]) {
      const { page, both } = sane({ kind: 'ink', ink: { w: 1000, h: 1414, strokes: [] }, ...extra });
      const merged = mergeNotebookPayload(STORED, page, both);
      expect((merged.ink as typeof INK).strokes).toEqual([]);
      expect(merged.points).toBe(0);
    }
  });

  test('a new page stores what it was given; a tombstone stores nothing', () => {
    const fresh = sane({ kind: 'ink', ink: INK, both: true });
    expect(mergeNotebookPayload(null, fresh.page, fresh.both)).toMatchObject({ title: 'Halbzeit', text: 'getippt', ink: INK, points: 2 });
    // The row's own columns are not in the payload.
    for (const key of ['pageId', 'kind', 'updatedAt', 'createdAt', 'deleted', 'schema']) expect(mergeNotebookPayload(null, fresh.page, fresh.both)).not.toHaveProperty(key);
    const gone = sane({ deleted: true });
    expect(notebookMergeNeedsStored(gone.page, gone.both)).toBe(false);
    expect(mergeNotebookPayload(STORED, gone.page, gone.both)).toEqual({});
  });

  test('a stored payload that is not an object is no payload', () => {
    const { page, both } = sane({ kind: 'text', text: 'neu', points: 5, both: true });
    for (const stored of [null, [], 'x', 3]) {
      const merged = mergeNotebookPayload(stored, page, both);
      expect(merged.text).toBe('neu');
      expect(merged).not.toHaveProperty('ink');
    }
  });

  test('a push without strokes onto no stored page stores no count of strokes it does not have', () => {
    // A new row, or one revived over a tombstone, from a push that carried no
    // strokes: `points` said the page has some, and the next device listed it
    // as a pen page with nothing to fetch (25.10.2026).
    for (const extra of [{ both: true }, {}]) {
      for (const kind of ['text', 'ink']) {
        const { page, both } = sane({ kind, points: 37, ...extra });
        expect(mergeNotebookPayload(null, page, both).points).toBe(0);
      }
    }
    // With its strokes, a new row counts them.
    const fresh = sane({ kind: 'ink', points: 37, ink: INK, both: true });
    expect(mergeNotebookPayload(null, fresh.page, fresh.both).points).toBe(2);
    // Onto a stored page the stored count stays, as before.
    const meta = sane({ kind: 'text', points: 37, both: true });
    expect(mergeNotebookPayload(STORED, meta.page, meta.both).points).toBe(2);
  });
});
