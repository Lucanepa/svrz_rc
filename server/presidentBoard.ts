// The chair's own working layer over the RC notes (19.11.2026): which notes
// she has read, and her tags and memo per referee. Asked for by the chair:
// "a whiteboard for me, like next year N3 course, or a tick box which I have
// already read", and an overview she can filter by motivation and Einstufung.
//
// Pure on purpose, like presidentNotes.ts: server/index.ts owns the tables
// (president_note_reads, president_referee_marks — chair-only, see the
// schema) and builds every entry through these helpers, so a spec can pin the
// rules without a database behind it.

const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** What the coach ticked on the form, as the chair's list shows it beside the
 *  note. The written assessment stays in the report; these are its answers. */
export type NoteResults = {
  role: string;
  motivation: string;
  einstufung: string;
  spielniveau: string;
  srZiel: string;
  secondBesuch: string;
  secondBesuchRole: string;
  wantsPromotion: boolean;
  wantsCandidate: boolean;
};

export function noteResults(feedback: Record<string, unknown> | null | undefined): NoteResults {
  const json = (feedback?.feedback_json ?? {}) as Record<string, unknown>;
  const r = (json.results ?? {}) as Record<string, unknown>;
  return {
    role: txt(feedback?.role_assessed) || txt(json.role),
    motivation: txt(r.motivation),
    einstufung: txt(r.einstufung),
    spielniveau: txt(r.spielniveau),
    srZiel: txt(r.srZiel),
    secondBesuch: txt(r.secondBesuch).toUpperCase(),
    secondBesuchRole: txt(r.secondBesuchRole),
    wantsPromotion: txt(r.wantsPromotion).toUpperCase() === 'Y',
    wantsCandidate: txt(r.wantsCandidate).toUpperCase() === 'Y',
  };
}

/** Who a mark belongs to, across seasons: the SV number when the coachee row
 *  is linked to the register, else the folded name (prefixed, so a name can
 *  never read as a number). `fold` is the server's own name fold, passed in
 *  so this file holds no second copy of it. A key, not a match: the board
 *  is looked up by it, never compared with another person's name. */
export function refereeKeyOf(coachee: Record<string, unknown> | null | undefined, fold: (v: unknown) => string): string {
  const sv = txt(coachee?.referee_id);
  if (sv) return `sv:${sv}`;
  const name = fold(coachee?.full_name ?? coachee?.name);
  return name ? `name:${name}` : '';
}

/** The read tick's key: which list a note is in, and its id. */
export function readRef(kind: 'note' | 'sr', id: string): string {
  return `${kind === 'note' ? 'fb' : 'gn'}:${txt(id)}`;
}

export function isReadRef(ref: unknown): ref is string {
  return /^(fb|gn):[A-Za-z0-9_-]{1,30}$/.test(txt(ref));
}

export const TAG_MAX = 40;
export const TAGS_MAX = 20;
export const MEMO_MAX = 4000;

/** Tags as the chair typed them: trimmed, single-spaced, at most 40
 *  characters each and 20 per referee, no duplicates (case-insensitively —
 *  "N3 Kurs" and "n3 kurs" are one tag), first spelling kept. */
export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = txt(raw).replace(/\s+/g, ' ').slice(0, TAG_MAX).trim();
    const key = tag.toLocaleLowerCase('de-CH'); // identity:display — a tag label, not a name
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

export type RefereeMark = { key: string; name: string; tags: string[]; memo: string; updatedAt: string };

/** A mark with nothing on it is no mark: saving one deletes the row. */
export function isEmptyMark(mark: Pick<RefereeMark, 'tags' | 'memo'>): boolean {
  return mark.tags.length === 0 && !txt(mark.memo);
}

/** Newest game first, the order the chair reads in ("in chronological order
 *  by date"). A note on a game without a date goes last; ties by when the
 *  note was written, newest first. */
export function byGameDateDesc<T extends { gameDate?: string; updatedAt?: string; submittedAt?: string }>(a: T, b: T): number {
  const da = txt(a.gameDate).slice(0, 10);
  const db = txt(b.gameDate).slice(0, 10);
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return db.localeCompare(da);
  }
  const ta = txt(a.updatedAt) || txt(a.submittedAt);
  const tb = txt(b.updatedAt) || txt(b.submittedAt);
  return tb.localeCompare(ta);
}
