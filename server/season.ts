// The season, as the server reads it — pure, so it can be tested without a
// PocketBase (see e2e/season-rules.spec.ts). index.ts keeps only the I/O
// around these: reading the default season from app_settings, the manual-game
// ids, and the routes that ask.
//
// A season is named by its starting year and runs September to April:
// "2026" is 2026-09-01 .. 2027-04-30. Two readings of a DATE live here and
// must agree: seasonOfGame() names the season a game belongs to (a May–August
// date belongs to the season just ended), seasonDateFilter() is the window a
// list is cut to (May–August is in no window; test games are let through).

/** A season named by its starting year, or null when the text is not one.
 *  Whole years in 2000..2100 — the sanity range the query parser has always
 *  used; "2026.5" is not a season and must not build a window. */
export function parseSeason(raw: unknown): number | null {
  const text = raw == null ? '' : String(raw).trim();
  if (!/^\d{4}$/.test(text)) return null;
  const n = Number(text);
  return n >= 2000 && n <= 2100 ? n : null;
}

/** The season a coachee ROW belongs to, or null for a seasonless row (imports
 *  predating the field). Number(null) and Number('') are both 0 — a falsy
 *  season must not be read as the year zero, or every seasonless row lands in
 *  a bucket of its own. Any finite number counts, like getCoacheeNameIndex. */
export function coacheeRowSeason(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The season a game belongs to (Sept–Apr, named by its starting year), or
 *  null when it carries no usable date. Null means "match any season" rather
 *  than "drop it" — an undated fixture is a data gap, not a reason to hide a
 *  game. */
export function seasonOfGame(value: unknown): number | null {
  const text = value == null ? '' : String(value).trim();
  if (!text) return null;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}

/** Season a date belongs to, named by its starting year (Sept–Apr). Undated
 *  input keeps its old answer (the current calendar year) — president-note
 *  keys are written with it and must not shift. */
export function seasonOfDate(value: string): number {
  return seasonOfGame(value) ?? new Date().getFullYear();
}

/** The season a request is about: a valid `raw` wins; anything else — the
 *  parameter missing, empty, "abc" — is `fallback` (the app's default season),
 *  and if there is none either, the season today falls in. Never null.
 *
 *  It used to be null: seasonDateFilter answered null for a bad value and the
 *  filters read null as "every game passes". The admin console asked for the
 *  overview without a season and was told the sum of every season ever
 *  synced — a March fixture from the season before, counted as this season's
 *  unfinished observation. */
export function pickSeason(raw: unknown, fallback: number | null, now: Date = new Date()): number {
  return parseSeason(raw) ?? fallback ?? seasonOfDate(now.toISOString());
}

// Season "2026" spans 2026-09-01 → 2027-04-30 (same window convention as the
// client-side games filter). Records without a parseable date are kept.
export function seasonDateFilter(season: number): (dateText: string) => boolean {
  const from = new Date(`${season}-09-01T00:00:00`);
  const to = new Date(`${season + 1}-04-30T23:59:59`);
  return (dateText: string) => {
    const d = new Date(dateText);
    if (Number.isNaN(d.getTime())) return true;
    return d >= from && d <= to;
  };
}

/** The season window, with test games let through.
 *
 *  A season runs September to April, and a test game is usually made today —
 *  which in May, June, July or August is in no season at all. It then vanished
 *  from every list in the app while sitting in the console that made it: the
 *  one game whose whole purpose is to be walked through was the one game that
 *  could not be. Their badge says what they are, so showing them out of season
 *  misleads nobody. */
export function seasonWindowFilter(
  season: number,
  manual: Set<string>,
): (game: { id?: unknown; match_date?: unknown }) => boolean {
  const inSeason = seasonDateFilter(season);
  return (game) => {
    if (manual.has(String(game.id))) return true;
    return inSeason(game.match_date == null ? '' : String(game.match_date));
  };
}

// ── Coachee rows by season, for a name lookup ─────────────────────────
// Coachees are per-season rows. A game is matched against the row of ITS
// season, falling back to a seasonless row; an undated game matches any
// season's row, the way getCoacheeNameIndex's forSeason(null) answers with
// everyone. One flat map kept the first row per name — the oldest season's,
// by row order — so this season's game took its calendar dot from last
// season's observations.

export type SeasonNameIndex<T> = {
  /** The row for `name` (already normalised) on a game of `gameSeason`. */
  find: (gameSeason: number | null, name: string) => T | undefined;
};

export function indexBySeason<T>(
  rows: Array<{ season: number | null; names: string[]; value: T }>,
): SeasonNameIndex<T> {
  const bySeason = new Map<string, T>();
  const anySeason = new Map<string, T>();
  const key = (season: number | null, name: string) => `${season ?? '*'}|${name}`;
  for (const row of rows) {
    for (const name of row.names) {
      if (!name) continue;
      const k = key(row.season, name);
      if (!bySeason.has(k)) bySeason.set(k, row.value);
      if (!anySeason.has(name)) anySeason.set(name, row.value);
    }
  }
  return {
    find: (gameSeason, name) => {
      if (!name) return undefined;
      if (gameSeason == null) return anySeason.get(name);
      return bySeason.get(key(gameSeason, name)) ?? bySeason.get(key(null, name));
    },
  };
}
