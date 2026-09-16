// Who is who — the one rule both sides of the app agree on.
//
// Three kinds of person and thing get matched here: a referee (SV number,
// `coachees.referee_id` / a game's `*_referee_id`), a referee coach (the
// roster record id) and a game (the VolleyManager match number). Each has an
// identity that survives a spelling correction, and each used to be matched by
// its folded display name alone in a dozen places that did not quite agree.
// The rule is now written once: the id first, the folded name only when a side
// has no id to offer, and never the record id where a human reads it.
//
// Pure on purpose: the server imports this file the way it imports
// `appTime.ts` and `statistics.ts`, and the e2e specs pin it without a
// browser (identity-rules.spec.ts). Nothing here reads a clock, a store or
// the DOM.
//
// The URL helpers at the bottom describe the address-bar scheme
// (/games/<sv>, /form/<matchNo>/<half>) before the app emits it. They are the
// resolvers steps 8 and 9 of the identity plan wire in; until then the app
// still emits and resolves record ids, which stay a first-class shape forever
// (an unlinked coachee, a manual game and a duplicated number have nothing
// better to be addressed by).
import { inSeasonOrManual } from './season';

/** Fold a name for COMPARISON — case-blind, accent-blind, spaces squeezed.
 *
 *  "Müller" off a game sheet and "Muller" in the coachee list are the same
 *  referee, and which of the two a record carries is not something the app gets
 *  to choose. Lived in App.tsx and again in the admin console, which is one copy
 *  too many for a rule both sides have to agree on to the letter: a game whose
 *  referee folds differently in the two places is a coachee in one list and a
 *  stranger in the other. The server's `normalizeName` is the same fold.
 */
export function foldName(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
}

/** Every key a name can be looked up under: folded, and folded in the other
 *  order. VolleyManager writes "Vorname Nachname" on some fixtures and
 *  "Nachname Vorname" on others, the XLSX has its own idea, and nothing
 *  downstream knows which one it is holding. The server's `nameKeyVariants`,
 *  verbatim: a one-word name gives one key, and so does a name that reads the
 *  same reversed. The whole list is reversed, not a surname picked out, so a
 *  middle name keeps "Kevin León Peña" from meeting "Peña Kevin León" — that
 *  is what the register tier and the SV number are for.
 */
export function nameKeys(name: string): string[] {
  const norm = foldName(name);
  if (!norm) return [];
  const parts = norm.split(' ').filter(Boolean);
  if (parts.length < 2) return [norm];
  const reversed = [...parts].reverse().join(' ');
  return reversed === norm ? [norm] : [norm, reversed];
}

/** A stored reference to a person, or the person a session is: an id and the
 *  name written next to it. Either half may be empty — rows written before the
 *  ids were stored carry a name only, and an admin's session has no RC id. */
export type PersonRef = { id: string; name: string };

/** Is the person a record points at this person?
 *
 *  The id decides when it can. A stored id equal to the person's is a yes; a
 *  stored id that belongs to somebody the roster knows is a no, however the
 *  names read — two active coaches can fold to the same string, and a name
 *  is not permission to give away the other's game or read their feedback.
 *  But an id that resolves to NOBODY (the coach was deleted, the id predates
 *  a data fix, or no roster has loaded yet) would strand the row forever if
 *  it were a no; that one falls through to the name, exactly as the server's
 *  `rcRefMatches` does — this IS that rule, so the client cannot veto an id
 *  the server would let through. Pass `knownIds` only once the roster is in
 *  hand; `undefined` means "nothing is known", not "nobody exists".
 *
 *  With no id on either side this is folded-name equality, which is what
 *  every caller did before the ids existed.
 */
export function samePerson(rec: PersonRef, person: PersonRef, knownIds?: Set<string>): boolean {
  const id = (rec.id ?? '').trim();
  if (id) {
    if (id === person.id) return true;
    if (knownIds?.has(id)) return false;
  }
  const name = foldName(rec.name ?? '');
  return name !== '' && name === foldName(person.name ?? '');
}

/** One person as the index sees them: their id (an SV number for a referee,
 *  a roster id for a coach — whatever the caller matches on, NOT necessarily
 *  the record id), every spelling the caller wants matched, the season the
 *  row belongs to (`null` for a row that predates the field and belongs to
 *  every season), and what `find` should hand back. */
export type PersonRow<T> = { id: string; names: string[]; season: number | null; value: T };

/** What a lookup asks with: the id on the game's slot and the name written
 *  there. Both optional — most stored games carry no slot id at all. */
export type PersonQuery = { id?: string; name?: string };

export type PersonHit<T> = { value: T; via: 'id' | 'name' };

export type PeopleIndex<T> = {
  /** The row for this query in this season, or null. `via` says which tier
   *  answered so a caller can warn when the name tier found a row whose id
   *  disagrees with the slot's. */
  find: (season: number | null, query: PersonQuery) => PersonHit<T> | null;
  has: (season: number | null, query: PersonQuery) => boolean;
};

/** An index over people that are one row per season — coachees — answering
 *  "which row is this slot?" id first, folded name second.
 *
 *  Seasons are the whole difficulty. The same referee has a row per season,
 *  and everything derived from the row (Niveau, group, whether they are a
 *  coachee at all) has to come from the season the GAME falls in, or last
 *  season's people leak onto this season's fixtures wearing last season's
 *  badge. So a lookup names its season: rows of that season are tried first,
 *  then the seasonless ones, and rows of another season never answer. A
 *  `null` season is an undated fixture and matches every row — today's
 *  server rule (`forSeason(null)` is everyone), kept so such a game does not
 *  lose its coachees.
 *
 *  Within a tier the first row in input order wins — the caller sorts the
 *  roster by name, so two same-season rows with one SV resolve the same way
 *  every time; the admin routes refuse to create that state.
 *
 *  The name tier does NOT refuse a row whose id differs from the slot's. The
 *  register links were made partly by a word-subset heuristic and are not yet
 *  trusted enough to veto a name; the server logs such a hit
 *  (`identity.sv-mismatch`) and the audit lists it, and the veto is a decision
 *  for after that list has been read once.
 */
export function indexPeople<T>(rows: PersonRow<T>[]): PeopleIndex<T> {
  type Keyed = { id: string; keys: Set<string>; season: number | null; value: T };
  const keyed: Keyed[] = rows.map((r) => ({
    id: (r.id ?? '').trim(),
    // The row's spellings are folded as written; the QUERY supplies both
    // orders (nameKeys), the same split the server's index makes.
    keys: new Set((r.names ?? []).map((n) => foldName(n ?? '')).filter(Boolean)),
    season: r.season,
    value: r.value,
  }));
  // Per-season candidate lists, built once each: the games list asks for
  // every slot of every game, and the roster is the same for all of them.
  const bySeason = new Map<number, Keyed[]>();
  const candidates = (season: number | null): Keyed[] => {
    if (season == null || !Number.isFinite(season)) return keyed;
    const cached = bySeason.get(season);
    if (cached) return cached;
    const list = [...keyed.filter((r) => r.season === season), ...keyed.filter((r) => r.season == null)];
    bySeason.set(season, list);
    return list;
  };
  const find = (season: number | null, query: PersonQuery): PersonHit<T> | null => {
    const list = candidates(season);
    const id = (query.id ?? '').trim();
    if (id) {
      const hit = list.find((r) => r.id === id);
      if (hit) return { value: hit.value, via: 'id' };
    }
    const keys = nameKeys(query.name ?? '');
    if (keys.length) {
      const hit = list.find((r) => keys.some((k) => r.keys.has(k)));
      if (hit) return { value: hit.value, via: 'name' };
    }
    return null;
  };
  return { find, has: (season, query) => find(season, query) !== null };
}

// ── URL tokens ───────────────────────────────────────────────────────────────
// A token is an opaque string compared trimmed. No shape test: a 15-character
// PocketBase id can be all digits, and nothing in the repo states how long an
// SV number is. What a token means is decided by looking it up, id column
// first, record id second.

/** A coachee row's season, as the app reads it: a row with no season at all
 *  predates the field and belongs to every season (App.tsx `isInSeason`). */
function rowInSeason(row: { season?: number }, season: number): boolean {
  return typeof row.season !== 'number' || row.season === season;
}

/** The token `/games/<coachee>` and `/feedbacks/<coachee>[/<fb>]` carry: the
 *  SV number once the row is linked to the register, the record id until then.
 *  A referee keeps their number across seasons, so the link survives the
 *  roll-over; a record id is one season's row and nobody's licence. */
export function coacheeUrlToken(c: { id: string; referee_id?: string }): string {
  return (c.referee_id ?? '').trim() || c.id;
}

export type CoacheeTokenHit<T> = {
  row: T;
  /** True when the only row answering to the token belongs to another season
   *  — the screen should say so ("Coachee gehört zu einer anderen Saison")
   *  rather than "nicht gefunden", and must not open last season's Niveau. */
  otherSeason: boolean;
};

/** Which coachee a `/games/<token>` names, against the loaded roster.
 *
 *  SV number on a row of the season on screen, then record id on a row of the
 *  season on screen, then either on a row of ANY season. The first two are the
 *  two shapes the app emits (linked / unlinked); the third is the roll-over —
 *  a link sent in April, opened in September, names a person who has a row
 *  for last season only. That is a different answer from "no such coachee",
 *  so it is reported as one instead of being silently opened with last
 *  season's badge. With the SV in two seasons' rows the season on screen wins.
 */
export function resolveCoacheeToken<T extends { id: string; referee_id?: string; season?: number }>(
  token: string,
  coachees: T[],
  season: number,
): CoacheeTokenHit<T> | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  const sv = (c: T) => (c.referee_id ?? '').trim();
  const inSeason = coachees.filter((c) => rowInSeason(c, season));
  const hit = inSeason.find((c) => sv(c) === t) ?? inSeason.find((c) => c.id === t);
  if (hit) return { row: hit, otherSeason: false };
  const elsewhere = coachees.find((c) => sv(c) === t) ?? coachees.find((c) => c.id === t);
  return elsewhere ? { row: elsewhere, otherSeason: true } : null;
}

type GameRef = { id: string; matchNo?: string; isManual?: boolean; date?: string };

/** The token `/form/<game>/<half>` carries: the match number when it names
 *  exactly this game among the eligible list, the record id otherwise.
 *
 *  A manual game keeps its record id whatever its number says — its number
 *  is typed, and a typed number is the one that can collide with a real
 *  fixture's. A blank number and a number two games share fall back the same
 *  way. Uniqueness is measured against the list every coach receives
 *  (/api/eligible-games has no per-viewer cut), so two phones only disagree
 *  while one holds a stale list, and both shapes resolve to the same record
 *  either way.
 */
export function gameUrlToken(g: GameRef, eligibleGames: GameRef[]): string {
  const no = (g.matchNo ?? '').trim();
  if (g.isManual || !no) return g.id;
  const hits = eligibleGames.filter((e) => (e.matchNo ?? '').trim() === no);
  return hits.length === 1 && hits[0].id === g.id ? no : g.id;
}

/** Which game a `/form/<token>` names, against the eligible list.
 *
 *  Match number first: of the games carrying it, the one inside the season on
 *  screen (or a manual one), else the first — the list arrives newest first,
 *  so a number VolleyManager reused across seasons opens the current fixture.
 *  Then the record id. The caller keeps its own season guard on the answer:
 *  a game from last March resolves here and is then refused there, with the
 *  same "vielleicht eine andere Saison" as today, so a link from an old mail
 *  never opens a blank form on the wrong season. A typed `/form/TEST-…` is
 *  just a number and resolves when unique.
 */
export function resolveGameToken<T extends GameRef>(token: string, eligibleGames: T[], season: number): T | undefined {
  const t = (token ?? '').trim();
  if (!t) return undefined;
  const byNo = eligibleGames.filter((g) => (g.matchNo ?? '').trim() === t);
  if (byNo.length) return byNo.find((g) => inSeasonOrManual(g, season)) ?? byNo[0];
  return eligibleGames.find((g) => g.id === t);
}
