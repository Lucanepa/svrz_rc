// Which coachee row a referee on a game is — the one rule, written once.
//
// A game names each referee twice: by the name VolleyManager printed on the
// convocation that day and, since 2026-08-27, by their SV number. A coachee
// row names its person the same two ways, the number only once the register
// import has linked it. Every list on the server used to answer "is this
// referee a coachee?" by folding the name and looking it up in one shared set
// of spellings, which is exactly the question that broke on "Kevin León Peña
// de los Santos" (what VolleyManager prints) against "Kevin Peña" (what the
// coaching sheet says): the same person, no spelling in common, and a game
// that was a coachee's in one list and nobody's in the next.
//
// So the number is asked first, the register second and the folded name last
// (docs/identity-plan-2026-09-16.md §2):
//
//   sv        the slot carries a number and a row of the game's season is
//             linked to it; a seasonless row after that
//   register  the slot carries no number, but the register spells the slot
//             name under exactly one licence — its number is then tried as
//             above. This is what lets the licence name on the convocation
//             reach the row the sheet wrote under the everyday name
//   name      the folded name, either order, against the six spellings a row
//             can hold — what every list did before, and still the answer
//             for an unlinked row or a convocation without a number
//
// A name-tier hit whose row is linked to a DIFFERENT number than the slot's
// is accepted and reported to the caller (`onMismatch`), not refused: the
// register links were made partly by a word-subset heuristic and are not yet
// trusted enough to veto a name. Turning that into a veto is a decision for
// after the audit has listed every such disagreement once.
//
// Pure: no PocketBase, no clock, no log. index.ts reads the rows and the
// register and hands them in, and e2e/identity-rules.spec.ts pins the tiers on
// fixtures. The season logic is indexPeople's — the row of the game's season
// first, then a seasonless one, never another season's, and a null season
// (an undated fixture) matches every row.
import { foldName, nameKeys, indexPeople } from '../src/lib/identity.ts';
import { coacheeRowSeason } from './season.ts';

type AnyRecord = Record<string, unknown>;
/** A coachee row as PocketBase hands it out: a record id under the columns. */
export type CoacheeRow = AnyRecord & { id: string };

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Which tier answered — or none. Carried onto the wire by the games
 *  projection later, so a screen can say a row was matched on its name alone. */
export type CoacheeVia = 'sv' | 'register' | 'name' | 'none';

export type CoacheeQuery = {
  /** The SV number on the game's slot, when the convocation carried one.
   *  About a third of stored games do. */
  sv?: unknown;
  /** The name printed on the slot. */
  name?: unknown;
  /** The game, for the mismatch report only — nothing is matched on it. */
  matchNo?: unknown;
};

/** The row, or null with `via: 'none'`. Always an object, never undefined,
 *  so a caller that only wants to know WHICH tier answered reads `via`
 *  without a null check first. */
export type CoacheeHit = { row: CoacheeRow | null; via: CoacheeVia };

/** A name-tier hit that disagrees with the slot's number. */
export type SvMismatch = { matchNo: string; name: string; gameSv: string; rowSv: string };

export type CoacheeIndex = {
  find: (season: number | null, query: CoacheeQuery) => CoacheeHit;
  has: (season: number | null, query: CoacheeQuery) => boolean;
  /** `find` for the game's own season, and when that answers nothing, the
   *  other seasons newest first — each with the same three tiers. The
   *  submit's and the reminder's lookup: a slightly stale row still beats
   *  no recipient at all. */
  findOrNewest: (season: number | null, query: CoacheeQuery) => CoacheeHit;
  /** Distinct folded spellings over every season — for the sync
   *  diagnostics, never for matching. */
  size: number;
};

/** Every spelling a coachee row holds: the four name columns the schemas of
 *  this app have carried at one time or another, and the two orders of
 *  first + last. What the old name index folded, verbatim — so a row the
 *  old index matched is matched by the name tier here too. */
export function coacheeRowNames(row: AnyRecord): string[] {
  const first = text(row.first_name ?? row.vorname);
  const last = text(row.last_name ?? row.nachname);
  return [
    text(row.full_name),
    text(row.name),
    text(row.coachee_name),
    text(row.referee_name),
    `${first} ${last}`.trim(),
    `${last} ${first}`.trim(),
  ].filter(Boolean);
}

/** The register folded three ways per licence — the licence name as written,
 *  and both orders of first + last — to the numbers found under each. A
 *  spelling two licences share resolves to nothing: the same coin flip
 *  linkCoacheesToReferees and the contact sync refuse. */
function indexRegister(register: AnyRecord[]): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const r of register) {
    const sv = text(r.sv_number);
    if (!sv) continue;
    const first = text(r.first_name);
    const last = text(r.last_name);
    for (const spelling of [text(r.full_name), `${first} ${last}`, `${last} ${first}`]) {
      const key = foldName(spelling);
      if (!key) continue;
      const set = byName.get(key) ?? new Set<string>();
      set.add(sv);
      byName.set(key, set);
    }
  }
  return byName;
}

/** The distinct numbers the register spells a name under — one for a name
 *  that is one licence, several for a name two referees share, none for a
 *  name it does not hold. The register tier below wants exactly one; the
 *  games backfill (dataHygiene.ts) asks the same question of every stored
 *  slot and reports the other two answers, so the lookup is one function
 *  and the two can never disagree about what the register says. */
export function registerNumbers(register: AnyRecord[]): (name: string) => string[] {
  const byName = indexRegister(register);
  return (name) => [...(byName.get(foldName(name)) ?? [])];
}

/**
 * The index over the coachee rows, with the register beside it.
 *
 * `rows` in roster order (the caller sorts by full_name): with two same-season
 * rows linked to one number the first wins, the same way every time, and the
 * admin routes refuse to create that state. `register` may be empty — before
 * the XLSX has been imported once there is no register tier, and the index is
 * the old name index with the number in front of it.
 */
export function buildCoacheeIndex(
  rows: CoacheeRow[],
  register: AnyRecord[],
  onMismatch?: (mismatch: SvMismatch) => void,
): CoacheeIndex {
  const people = indexPeople(rows.map((row) => ({
    id: text(row.referee_id),
    names: coacheeRowNames(row),
    season: coacheeRowSeason(row.season),
    value: row,
  })));
  const numbersFor = registerNumbers(register);
  const everyone = new Set<string>();
  for (const row of rows) for (const n of coacheeRowNames(row)) everyone.add(foldName(n));
  everyone.delete('');

  /** The one number the register spells this name under, or ''. */
  const registerSv = (name: string): string => {
    const numbers = numbersFor(name);
    return numbers.length === 1 ? numbers[0] : '';
  };

  const find = (season: number | null, query: CoacheeQuery): CoacheeHit => {
    const sv = text(query.sv);
    const name = text(query.name);
    if (sv) {
      const hit = people.find(season, { id: sv });
      if (hit) return { row: hit.value, via: 'sv' };
    } else if (name) {
      // Only for a slot WITHOUT a number: with one, the sv tier above has
      // already asked the question the register would answer.
      const fromRegister = registerSv(name);
      if (fromRegister) {
        const hit = people.find(season, { id: fromRegister });
        if (hit) return { row: hit.value, via: 'register' };
      }
    }
    if (name) {
      const hit = people.find(season, { name });
      if (hit) {
        const rowSv = text(hit.value.referee_id);
        if (sv && rowSv && rowSv !== sv) onMismatch?.({ matchNo: text(query.matchNo), name, gameSv: sv, rowSv });
        return { row: hit.value, via: 'name' };
      }
    }
    return { row: null, via: 'none' };
  };

  // Every season the roster holds, newest first — the fallback order below.
  const seasons = [...new Set(rows.map((row) => coacheeRowSeason(row.season)).filter((n): n is number => n != null))]
    .sort((a, b) => b - a);

  // The game's own season is asked completely — number, register, name —
  // before any other season is looked at, so a number linked on last
  // season's row only can never outrank this season's row that every list
  // matched by name. A seasonless row is this season's too (find reads it
  // so, and so does every list), which is why it answers before last
  // season's row does: the row the lists showed the game under is the row
  // the report is filed on. Only when the season has nothing — a referee
  // carried over without a re-import, a game outside the window — do the
  // other seasons answer, newest first, the way the old `-season` sort made
  // them; and a game with no season at all takes the newest row there is.
  const findOrNewest = (season: number | null, query: CoacheeQuery): CoacheeHit => {
    const inSeason = season != null && Number.isFinite(season) ? Math.trunc(season) : null;
    const order = inSeason != null ? [inSeason, ...seasons.filter((s) => s !== inSeason)] : seasons;
    for (const s of order) {
      const hit = find(s, query);
      if (hit.row) return hit;
    }
    // No row carries a season at all (every import predates the field) and
    // the game names none either: the index's "any season" answer, first in
    // roster order.
    return order.length === 0 ? find(null, query) : { row: null, via: 'none' };
  };

  return {
    find,
    has: (season, query) => find(season, query).row !== null,
    findOrNewest,
    size: everyone.size,
  };
}

/** The submit's guard: does the report's own "SR" field name the referee on
 *  the game's slot?
 *
 *  meta.srName is a freely editable field, and a report filed under the wrong
 *  role once mailed one coachee's complete assessment to the other referee on
 *  the same match. The number settles it when the client sends one: a claim
 *  carrying the slot's SV number names that referee whatever the name field
 *  says — the coach may well have typed the everyday name where VolleyManager
 *  prints the licence one. Without a number the two names are compared
 *  folded, in both orders, because the XLSX and VolleyManager disagree on
 *  which comes first. A claim or a slot with no name at all is not a
 *  disagreement — the guard has nothing to compare and lets the submit reach
 *  the checks that do. */
export function claimNamesSlot(claim: { name: unknown; sv: unknown }, slot: { name: unknown; sv: unknown }): boolean {
  const slotSv = text(slot.sv);
  if (slotSv && text(claim.sv) === slotSv) return true;
  const claimed = text(claim.name);
  const printed = text(slot.name);
  if (!claimed || !printed) return true;
  return nameKeys(claimed).includes(foldName(printed));
}

/** The guard's second look, for a claim that carries no number.
 *
 *  The manual upload dialog offers the COACHEE LIST for the "SR" field, not
 *  the convocation, so the claim reads "Kevin Peña" where the slot prints
 *  "Kevin León Peña de los Santos" — and no fold makes those two strings
 *  meet, although the row the report is about is one and the same. The
 *  index knows that: when the claimed name and the slot resolve to the same
 *  row (the slot by its number or the register, the claim by its spelling),
 *  the claim names the slot. Resolved the way the submit resolves the
 *  recipient one step later (findOrNewest), so the two cannot disagree. A
 *  claim carrying another number is a claim about another person and is not
 *  looked up; a claim with no name has nothing to look up and is not this
 *  function's to accept. */
export function claimNamesRow(
  index: CoacheeIndex,
  season: number | null,
  claim: { name: unknown; sv: unknown },
  slot: CoacheeQuery,
): boolean {
  const claimed = text(claim.name);
  if (!claimed || text(claim.sv)) return false;
  const slotRow = index.findOrNewest(season, slot).row;
  if (!slotRow) return false;
  const claimRow = index.findOrNewest(season, { name: claimed }).row;
  return claimRow !== null && claimRow.id === slotRow.id;
}
