// The rules the games import applies to a VolleyManager row once it is in the
// collection's shape. Kept out of index.ts so they can be tested without a
// PocketBase or a VolleyManager session — the sync itself cannot be.

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
 *  or it stays "flagged" forever. Nothing else — a row with no coachee on it
 *  is not the sync's to rewrite, its stale facts are. */
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
  return patch;
}
