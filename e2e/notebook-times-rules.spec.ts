import { test, expect } from '@playwright/test';
import { NOTEBOOK_TIMES_KEY, decodeTimes, lineHash, lineTimes, linesOf, withLineTimes } from '../src/lib/notebookTimes';

/**
 * The time beside each line of a text page: when that note was written. The
 * text itself is never touched — the times ride in the page's `extra` bag —
 * so the whole feature is one rule: after an edit, which line keeps which
 * time. Pinned here without a browser (the sw-reload-guard idiom).
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 18, 0);   // 20:00 in Zürich
const at = (minutes: number) => T0 + minutes * MIN;

/** Writes `steps` one after another, each `[text, minute]`, the way the sheet
 *  commits them, and returns the page's extra after the last one. */
function write(steps: [string, number][], start: { text: string; extra?: Record<string, unknown> } = { text: '' }) {
  let text = start.text;
  let extra = start.extra;
  for (const [next, minute] of steps) {
    extra = withLineTimes(text, extra, next, at(minute));
    text = next;
  }
  return { text, extra };
}
const shown = (p: { text: string; extra?: Record<string, unknown> }) => lineTimes(p.text, p.extra).map((t) => (t ? (t - T0) / MIN : null));

test('every new line gets the minute it was written; a blank line gets none', () => {
  const p = write([['a', 0], ['ab', 0], ['ab\n', 1], ['ab\n\nc', 5], ['ab\n\ncd', 6]]);
  expect(shown(p)).toEqual([0, null, 5]);
});

test('typing onto a note, or cutting it short, keeps its time', () => {
  const p = write([['Netz nicht kontrolliert', 0], ['Netz nicht kontrolliert\nPfiff spät', 4]]);
  const longer = write([['Netz nicht kontrolliert — Antennen auch nicht\nPfiff spät', 9]], p);
  expect(shown(longer)).toEqual([0, 4]);
  const shorter = write([['Netz\nPfiff spät', 12]], longer);
  expect(shown(shorter)).toEqual([0, 4]);
  // At the front as well as at the end.
  const front = write([['! Netz\nPfiff spät', 13]], shorter);
  expect(shown(front)).toEqual([0, 4]);
});

test('a new line in the middle is new; the lines around it keep theirs', () => {
  const p = write([['eins\nzwei', 0], ['eins\n\nzwei', 3], ['eins\ndrei\nzwei', 7]]);
  expect(shown(p)).toEqual([0, 7, 0]);
});

test('Enter at the start of a note pushes it down with its time; splitting one gives both halves its time', () => {
  const base = write([['vorher\nSR steht zu weit links', 0]]);
  expect(shown(write([['vorher\n\nSR steht zu weit links', 10]], base))).toEqual([0, null, 0]);
  expect(shown(write([['vorher\nSR steht\nzu weit links', 10]], base))).toEqual([0, 0, 0]);
});

test('joining two notes keeps the earlier time', () => {
  const p = write([['eins', 0], ['eins\nzwei', 5], ['einszwei', 9]]);
  expect(shown(p)).toEqual([0]);
});

test('a note typed over another is a new note, not a version of it', () => {
  const p = write([['apple pie', 0], ['x', 8]]);
  expect(shown(p)).toEqual([8]);
});

test('the same text again writes nothing new — the same object comes back', () => {
  const p = write([['eins\nzwei', 0]]);
  expect(withLineTimes(p.text, p.extra, p.text, at(30))).toBe(p.extra);
});

test('a page from before times has no time on its old lines, and its new ones do', () => {
  const p = write([['alt\nauch alt\nneu', 15]], { text: 'alt\nauch alt' });
  expect(shown(p)).toEqual([null, null, 15]);
  // Edited in place, an old line stays unknown rather than claiming now.
  expect(shown(write([['alt!\nauch alt\nneu', 16]], p))).toEqual([null, null, 15]);
});

test('an edit by a build that keeps no times costs only the lines it touched', () => {
  const p = write([['eins', 0], ['eins\nzwei', 2], ['eins\nzwei\ndrei', 4]]);
  // The installed app edits the text and carries the old list along untouched.
  const foreign = { text: 'null\neins\nZWEI\ndrei', extra: p.extra };
  expect(shown(foreign)).toEqual([null, 0, null, 4]);
  // The next edit here repairs the list against the text as it now stands.
  const next = write([['null\neins\nZWEI\ndrei\nvier', 20]], foreign);
  expect(shown(next)).toEqual([null, 0, null, 4, 20]);
  expect(decodeTimes(next.extra)!.map((e) => e.h)).toEqual(linesOf(next.text).map(lineHash));
});

test('rich text is stamped by its plain reading, and other keys in the bag survive', () => {
  const p = write([['<b>fett</b> und mehr', 0]], { text: '', extra: { other: 1 } });
  expect(p.extra!.other).toBe(1);
  expect(shown(write([['<b>fett</b> und mehr\n<i>neu</i>', 3]], p))).toEqual([0, 3]);
});

test('a list too long for the bag is dropped, never sent to be refused', () => {
  const huge = Array.from({ length: 2_000 }, (_, i) => `Zeile ${i}`).join('\n');
  const p = write([[huge, 0]], { text: '', extra: { other: 1 } });
  expect(p.extra).toEqual({ other: 1 });
  expect(p.extra![NOTEBOOK_TIMES_KEY]).toBeUndefined();
});

test('a list that is not ours is ignored, not trusted', () => {
  expect(decodeTimes({ [NOTEBOOK_TIMES_KEY]: ['<img>', 'x.y'] })).toBeNull();
  expect(lineTimes('eins', { [NOTEBOOK_TIMES_KEY]: 'nope' })).toEqual([0]);
});
