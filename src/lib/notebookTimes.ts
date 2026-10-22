// When each line of a text page was written — the small clock in the margin
// beside every note (Luca, 2026-10-22: "a column on the left of every note …
// what time the note has been written").
//
// The page's text stays exactly what it was: the subset in richText.ts has no
// block elements and no attributes, and the times are not content — they never
// go into the form, the PDF or the mail. They ride in the page's `extra` bag,
// which both the device store and the server already keep (≤ 20 KB, dropped
// WHOLE by the server above that, hence the cap below), so no migration.
//
// One entry per line of the page's plain reading (richToPlain → split '\n'):
//   ''              an empty line — nothing written, nothing to stamp
//   '<t36>.<h36>'   epoch MINUTES and a hash of that line's text
//   '.<h36>'        a line whose time is not known (written before this
//                   existed, or by a build that does not keep times)
//
// The hash is what makes the list survive a writer that does not maintain it.
// The installed apps carry the build they shipped with, and an edit made there
// keeps the old list against a new text. Read back, the entries are matched to
// the lines by hash first and by position only inside the stretches that
// changed, so a foreign edit costs the times of the lines it touched — never a
// time printed beside the wrong note.

import { richToPlain } from './richText';

export const NOTEBOOK_TIMES_KEY = 'lt';
/** Well under the server's 20 000-byte cap on the whole bag. */
export const NOTEBOOK_TIMES_MAX_CHARS = 16_000;
/** Above this many line pairs in one changed stretch, lines are paired by
 *  position alone: a paste of a whole evening must not stall the keyboard. */
const GAP_SCAN_LIMIT = 20_000;
const LCS_LIMIT = 250_000;

type Entry = { t: number; h: string; text?: string };

const isBlank = (line: string): boolean => line.trim() === '';

/** FNV-1a over the line, base 36. '' for a blank line, so every blank line
 *  matches every other one. */
export function lineHash(line: string): string {
  if (isBlank(line)) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i += 1) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const linesOf = (text: string): string[] => richToPlain(text || '').split('\n');

const ENTRY_RE = /^([0-9a-z]{0,9})\.([0-9a-z]{1,8})$/;

/** The stored list, or null when there is none or it is not ours to read. */
export function decodeTimes(extra: unknown): Entry[] | null {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const raw = (extra as Record<string, unknown>)[NOTEBOOK_TIMES_KEY];
  if (!Array.isArray(raw)) return null;
  const out: Entry[] = [];
  for (const item of raw) {
    if (item === '') { out.push({ t: 0, h: '' }); continue; }
    const m = typeof item === 'string' ? ENTRY_RE.exec(item) : null;
    if (!m) return null;
    out.push({ t: m[1] ? parseInt(m[1], 36) : 0, h: m[2] });
  }
  return out;
}

/** The list as stored, or null when it would not fit the bag. */
export function encodeTimes(entries: { t: number; h: string }[]): string[] | null {
  const out = entries.map((e) => (e.h ? `${e.t > 0 ? e.t.toString(36) : ''}.${e.h}` : ''));
  return JSON.stringify(out).length > NOTEBOOK_TIMES_MAX_CHARS ? null : out;
}

/** How much two versions of a line have in common: the longer of their shared
 *  start and shared end, or the whole of the new one when the old one holds it
 *  (the second half of a line split in two). */
function kinship(oldLine: string, newLine: string): number {
  if (oldLine.length >= 2 && newLine.length >= 2 && oldLine.includes(newLine)) return newLine.length;
  let p = 0;
  while (p < oldLine.length && p < newLine.length && oldLine[p] === newLine[p]) p += 1;
  let s = 0;
  while (s < oldLine.length - p && s < newLine.length - p && oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]) s += 1;
  return Math.max(p, s);
}

/** A short line is its own threshold: "a" → "ab" is the same note, while "a"
 *  typed over the whole page is not a version of "apple pie". */
const sameNote = (oldLine: string, newLine: string): number => {
  if (isBlank(oldLine)) return 0;
  const score = kinship(oldLine, newLine);
  return score >= Math.min(3, oldLine.length) ? score : 0;
};

/** The times of one changed stretch. A new line keeps the time of the old line
 *  it is still recognisably a version of — typed onto, cut short, split, joined
 *  — and a line that is new takes `fill`. Without the old texts (an edit by a
 *  build that keeps no times) nothing says which note a changed line was, so
 *  it is shown with no time rather than with somebody else's. */
function fillGap(old: Entry[], next: string[], fill: number): number[] {
  if (!old.every((o) => o.text !== undefined)) return next.map(() => 0);
  const scan = old.length * next.length <= GAP_SCAN_LIMIT;
  return next.map((line, j) => {
    if (isBlank(line)) return 0;
    if (!scan) {
      const o = old[j];
      return o && sameNote(o.text as string, line) ? o.t : fill;
    }
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < old.length; i += 1) {
      const score = sameNote(old[i].text as string, line);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best >= 0 ? old[best].t : fill;
  });
}

/** Lines matched by hash: the longest common subsequence, trimmed of the
 *  shared head and tail first so a keystroke compares one line, not the page. */
function align(old: Entry[], next: string[], fill: number): number[] {
  const nextH = next.map(lineHash);
  const out = new Array<number>(next.length).fill(0);
  let head = 0;
  while (head < old.length && head < next.length && old[head].h === nextH[head]) { out[head] = old[head].t; head += 1; }
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail].h === nextH[next.length - 1 - tail]) {
    out[next.length - 1 - tail] = old[old.length - 1 - tail].t;
    tail += 1;
  }
  const o = old.slice(head, old.length - tail);
  const n = next.slice(head, next.length - tail);
  const nh = nextH.slice(head, next.length - tail);
  const pairs: [number, number][] = [];
  if (o.length && n.length && o.length * n.length <= LCS_LIMIT) {
    const w = n.length + 1;
    const dp = new Uint32Array((o.length + 1) * w);
    for (let i = o.length - 1; i >= 0; i -= 1) {
      for (let j = n.length - 1; j >= 0; j -= 1) {
        dp[i * w + j] = o[i].h === nh[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < o.length && j < n.length;) {
      if (o[i].h === nh[j]) { pairs.push([i, j]); i += 1; j += 1; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1;
      else j += 1;
    }
  }
  // The stretches between matched lines are the ones that changed.
  let pi = 0;
  let pj = 0;
  for (const [mi, mj] of [...pairs, [o.length, n.length] as [number, number]]) {
    const filled = fillGap(o.slice(pi, mi), n.slice(pj, mj), fill);
    filled.forEach((t, k) => { out[head + pj + k] = t; });
    if (mi < o.length && mj < n.length) out[head + mj] = o[mi].t;
    pi = mi + 1;
    pj = mj + 1;
  }
  return out;
}

/** The stored list as it stands against `text`: one time per line (epoch
 *  minutes, 0 = none). Matched by hash when a writer that does not keep times
 *  changed the text under it. */
function entriesFor(extra: unknown, lines: string[]): Entry[] {
  const stored = decodeTimes(extra);
  const hashes = lines.map(lineHash);
  if (!stored) return lines.map((text, i) => ({ t: 0, h: hashes[i], text }));
  const inStep = stored.length === lines.length && stored.every((e, i) => e.h === hashes[i]);
  const times = inStep ? stored.map((e) => e.t) : align(stored, lines, 0);
  return lines.map((text, i) => ({ t: hashes[i] ? times[i] : 0, h: hashes[i], text }));
}

/** What the margin shows: epoch milliseconds per line of `text`, 0 where
 *  there is nothing to show. */
export function lineTimes(text: string, extra: unknown): number[] {
  return entriesFor(extra, linesOf(text)).map((e) => e.t * 60_000);
}

/**
 * The page's `extra` after its text went from `prevText` to `nextText` at
 * `now`: unchanged lines keep their time, edited ones keep theirs, new ones
 * get `now`. The same object back when nothing changed, so a blur that
 * re-emits the same text writes nothing new.
 */
export function withLineTimes(
  prevText: string,
  prevExtra: Record<string, unknown> | undefined,
  nextText: string,
  now: number,
): Record<string, unknown> | undefined {
  const prevLines = linesOf(prevText);
  const nextLines = linesOf(nextText);
  const old = entriesFor(prevExtra, prevLines);
  const times = align(old, nextLines, Math.floor(now / 60_000));
  const encoded = encodeTimes(nextLines.map((line, i) => ({ t: times[i], h: lineHash(line) })));
  const before = prevExtra && Array.isArray(prevExtra[NOTEBOOK_TIMES_KEY]) ? prevExtra[NOTEBOOK_TIMES_KEY] as unknown[] : null;
  if (encoded && before && before.length === encoded.length && before.every((v, i) => v === encoded[i])) return prevExtra;
  const { [NOTEBOOK_TIMES_KEY]: _drop, ...rest } = prevExtra || {};
  void _drop;
  if (!encoded) return Object.keys(rest).length ? rest : undefined;
  return { ...rest, [NOTEBOOK_TIMES_KEY]: encoded };
}
