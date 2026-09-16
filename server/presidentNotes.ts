// The private note a coach leaves for the RC chair on an observation they
// have filed — the entry as it is written into app_settings.
//
// Pure on purpose: server/index.ts owns the store (one settings row per
// season, keyed by the feedback record id — see "Private notes to the RC
// president" there), and this is only the shape of one entry, so a spec can
// pin what an entry carries without a PocketBase behind it.

/** One note, as the chair's list reads it. The labels ride along so reading
 *  the list costs one settings read instead of a join per row; the ids beside
 *  them say WHO and WHICH game without going through a spelling. */
export type PresidentNoteEntry = {
  note: string;
  /** The game's record id — what the store joins on, never what a human reads. */
  gameId: string;
  /** The VolleyManager number, which is what a human reads. */
  matchNo: string;
  teams: string;
  league: string;
  gameDate: string;
  coacheeName: string;
  /** The coachee's SV number, when their row is linked to the register. */
  refereeId: string;
  /** The coach who filed the observation: the name for the list, the roster
   *  id for a rename — rcName is re-stamped when the coach is renamed, and
   *  the id is how the rename finds the entry however the name was spelled. */
  rcName: string;
  rcId: string;
  /** Who wrote the note — an admin may write on a feedback they did not file. */
  authorName: string;
  updatedAt: string;
};

const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** The entry for a note on a feedback record, from the record and what it
 *  expands to. Every field is read defensively: a feedback whose game or
 *  coachee row has since gone still keeps its note. */
export function presidentNoteEntry(input: {
  note: string;
  /** The feedback row: `game`, `rc_name`, `rc_id` are read off it. */
  record: Record<string, unknown>;
  /** Its expanded game (`match_no`, teams, `league`, `match_date`), if any. */
  game?: Record<string, unknown> | null;
  /** Its expanded coachee (`full_name` / `name`, `referee_id`), if any. */
  coachee?: Record<string, unknown> | null;
  authorName: string;
  now: Date;
}): PresidentNoteEntry {
  const { record, game, coachee } = input;
  return {
    note: input.note,
    gameId: txt(record.game),
    matchNo: txt(game?.match_no),
    teams: game ? `${txt(game.home_team)} vs ${txt(game.away_team)}` : '',
    league: txt(game?.league),
    gameDate: txt(game?.match_date),
    coacheeName: txt(coachee?.full_name) || txt(coachee?.name),
    refereeId: txt(coachee?.referee_id),
    rcName: txt(record.rc_name),
    rcId: txt(record.rc_id),
    authorName: input.authorName,
    updatedAt: input.now.toISOString(),
  };
}
