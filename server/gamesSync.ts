// The rules the games import applies to a VolleyManager row once it is in the
// collection's shape. Kept out of index.ts so they can be tested without a
// PocketBase or a VolleyManager session — the sync itself cannot be.
import { samePerson } from '../src/lib/identity.ts';

/** The two whistle slots a game record carries, name column beside id column. */
const REFEREE_SLOTS = [
  ['first_referee', 'first_referee_id'],
  ['second_referee', 'second_referee_id'],
] as const;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** The same referee on a slot of the stored row and of the incoming one —
 *  by the printed name alone, folded, because the stored number is the very
 *  thing in question. Two empty names are nobody, never the same person. */
const sameNameOnSlot = (existing: Record<string, unknown>, incoming: Record<string, unknown>, nameKey: string) =>
  samePerson({ id: '', name: text(existing[nameKey]) }, { id: '', name: text(incoming[nameKey]) });

/** VolleyManager marked the game for observation: RD-Spiel (`isSupervised`,
 *  "Contrassegnato per RD") or RSV-Markierung (`refereeSupervisorNeeded`).
 *  Line-judge marks are deliberately not in this: they are about the linesmen,
 *  not the referees the coaches follow — the same line /api/eligible-games and
 *  the amber "Flagged" star draw. */
export function isVmMarkedRow(row: Record<string, unknown>): boolean {
  return Boolean(row.is_rd_game) || Boolean(row.is_rsv_game);
}

/** Whether the sync keeps a row at all. Two grounds: a coachee is on it, or
 *  VolleyManager marked it. The mark used to count for nothing on its own — it
 *  only ever became a star on a game that was ALREADY in on the strength of
 *  its referees — so a mark the RD set on any other game was silently invisible
 *  here. An RD marks by their own criteria, not by the coachee list. */
export function isRowWanted(row: Record<string, unknown>, hasCoachee: boolean): boolean {
  return hasCoachee || isVmMarkedRow(row);
}

/** The VolleyManager-owned facts a stored game keeps current even when the
 *  sync has no reason to keep the game itself. */
export const VM_OWNED_MARKS = ['is_rd_game', 'is_rsv_game', 'is_ld_game'] as const;

/** What to write onto a stored game the sync is NOT keeping this time — only
 *  the fields that actually changed, so a row that is already right costs no
 *  write. The league text, because the U23 rename left stored games carrying
 *  the old name and that text decides whether a game is in a coachee's focus.
 *  And the marks, because they cut both ways: a game that came in on its RD
 *  mark alone and then lost it in VolleyManager must lose its star here too,
 *  or it stays "flagged" forever. And a referee's SV number the stored row
 *  lacks, when the incoming row has it for the SAME name: two thirds of the
 *  stored games predate the number and were only ever refreshed through this
 *  patch, so without it they would stay name-matched forever. A number is
 *  never blanked or replaced here — a changed name is a changed referee, and
 *  that is the kept path's business (mergeIncomingGame), not a refresh's.
 *  Nothing else — a row with no coachee on it is not the sync's to rewrite,
 *  its stale facts are. */
export function vmFactsPatch(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const league = typeof incoming.league === 'string' ? incoming.league.trim() : '';
  if (league && String(existing.league ?? '').trim() !== league) patch.league = league;
  for (const key of VM_OWNED_MARKS) {
    if (Boolean(existing[key]) !== Boolean(incoming[key])) patch[key] = Boolean(incoming[key]);
  }
  for (const [nameKey, idKey] of REFEREE_SLOTS) {
    const id = text(incoming[idKey]);
    if (!id || text(existing[idKey])) continue;
    if (sameNameOnSlot(existing, incoming, nameKey)) patch[idKey] = id;
  }
  return patch;
}

/** What a KEPT game is written with: the incoming row, whole — VolleyManager
 *  owns every column the sync writes — with two exceptions the row cannot
 *  know about.
 *
 *  A referee's stored SV number survives an incoming row that has none, but
 *  ONLY while the name on that slot folds to the same person: a convocation
 *  that is only a name (the `active…Name` fallback in the transform) carries
 *  no number, and dropping the one an earlier sync stored would send the game
 *  back to name matching for no reason. A different name is a different
 *  referee, and the number of the one who was replaced must not travel with
 *  the slot — that is how the wrong coachee gets a report. An incoming number
 *  always wins, equal or not: the convocation is the source of the numbers.
 *
 *  And the result: VolleyManager publishes the score days after the match,
 *  so a sync that runs before it does carries an empty one. That absence is
 *  not news — blanking the record would throw away a score already on it,
 *  whether an earlier sync or a coach typing it into the feedback form put it
 *  there. */
export function mergeIncomingGame(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };
  for (const [nameKey, idKey] of REFEREE_SLOTS) {
    if (text(incoming[idKey])) continue;
    const kept = text(existing[idKey]);
    if (kept && sameNameOnSlot(existing, incoming, nameKey)) merged[idKey] = kept;
  }
  if (!text(incoming.game_result)) merged.game_result = text(existing.game_result);
  return merged;
}

/** What the börse poll writes onto a stored game's whistle slots, from the
 *  convocations its offers carry — only what changed, so a row already right
 *  costs no write. The name is the börse's spelling whenever it differs. The
 *  SV number follows the same rule as a kept row (mergeIncomingGame): a
 *  number on the convocation always wins; a convocation without one keeps
 *  the stored number only while the name still folds to the same person,
 *  and BLANKS it when the name is somebody else's. The poll used to leave a
 *  stored number alone whenever the börse had none, so a slot a coach gave
 *  away kept the coach's number on it until the nightly sync — and because
 *  the RC-Spiel test reads the number before the name, the game stayed an
 *  RC-Spiel, hidden from every coachee row, for a day after it stopped being
 *  one. */
export function boerseCrewPatch(
  existing: Record<string, unknown>,
  convocations: Array<{ slot: string; name: string; sv: string }>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const c of convocations) {
    const name = text(c.name);
    if (!name) continue;
    const [nameKey, idKey] = c.slot === '1' ? REFEREE_SLOTS[0] : c.slot === '2' ? REFEREE_SLOTS[1] : [];
    if (!nameKey || !idKey) continue;
    if (text(existing[nameKey]) !== name) patch[nameKey] = name;
    const sv = text(c.sv);
    const stored = text(existing[idKey]);
    if (sv) {
      if (stored !== sv) patch[idKey] = sv;
    } else if (stored && !sameNameOnSlot(existing, { [nameKey]: name }, nameKey)) {
      patch[idKey] = '';
    }
  }
  return patch;
}
