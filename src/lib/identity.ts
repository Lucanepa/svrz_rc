// Who is who — the one rule both sides of the app agree on.
//
// Three kinds of person and thing get matched here: a referee (SV number,
// `coachees.referee_id` / a game's `*_referee_id`), a referee coach (the
// roster record id) and a game (the VolleyManager match number). Each has an
// identity that survives a spelling correction, and each used to be matched by
// its folded display name alone in a dozen places that did not quite agree.
// The rule is now written once (docs/identity-plan-2026-09-16.md §2):
//
//   referee   the SV number first — the slot's number against a row of the
//             game's season, then a seasonless row; the register second, for
//             a slot without a number whose printed name the register spells
//             under exactly one licence (server/coacheeIndex.ts); the folded
//             name last, either order, and only then. A name hit whose row
//             carries a DIFFERENT number is accepted and warned about
//             (`identity.sv-mismatch`, listed by the audit) — not vetoed,
//             because the register links behind the rows were made partly by
//             a word-subset heuristic and have not yet been read once.
//   coach     the roster id first (samePerson): equal is a yes; an id the
//             roster KNOWS and that is somebody else's is a no however the
//             names read — a name is not permission to give away a
//             colleague's game or read their feedback; an id nobody knows
//             (deleted, pre-backfill, no roster loaded) falls to the folded
//             name so the row is not stranded. A coach's NAME turns back into
//             an id through resolveRcName only — aliases, both orders, and
//             nobody on ambiguity, never the first hit.
//   game      the match number, unique by code (409 on a typed duplicate,
//             TEST-<yyyymmdd>-<4> re-rolled) and by the audit; lookups by
//             number sort newest first. Storage, relations, drafts, the
//             outbox, the notebook and iCal UIDs keep the record id; a human
//             reads the number, or the teams and the day (gameLabel), never
//             the record id.
//
// The folded name is the FALLBACK, never the first question, and no
// name-only COMPARE — a folded name against ===, in a .has/.get/.includes,
// a lowercased string against ===, a raw coach name against === — stands
// outside this file, server/coacheeIndex.ts, server/dataHygiene.ts and
// server/forms.ts: e2e/identity-ratchet.spec.ts reads the repo for those
// idioms and fails the build on a new one anywhere else. That is what is
// measured, and two name-KEYED sites it does not see remain by design, both
// in server/index.ts and both tagged `identity:display` with their reason:
// the coachee import's upsert key (the sheet names people by name and
// nothing else) and sync-contacts' lookupContact (VolleyManager sends no SV
// number for a contact until step 11 of the plan adds the column). A reader
// auditing the name-only sites greps the tag; those two are on the list.
//
// Pure on purpose: the server imports this file the way it imports
// `appTime.ts` and `statistics.ts`, and the e2e specs pin it without a
// browser (identity-rules.spec.ts). Nothing here reads a clock, a store or
// the DOM.
//
// The URL helpers at the bottom are the address-bar scheme (plan §3, the
// full table in routes.ts): what App.tsx emits (currentRoute) and resolves
// (openDeepLink for a coachee; openGameRoute, openUrlGame and the draft boot
// for a game). Two shapes per token, both forever:
//
//   /games/<sv> · /feedbacks/<sv>/<fb>     a linked coachee, by SV number
//   /games/<recordId> · /feedbacks/<recordId>/<fb>
//                                           an unlinked one — still emitted,
//                                           still resolved
//   /form/<matchNo>/<half>                  a synced game whose number is
//                                           unique on the eligible list
//   /form/<recordId>/<half>                 a manual game, a blank or a
//                                           shared number — still emitted
//
// Number first, record id second, opaque tokens compared trimmed. An
// old-shape link that resolves is rewritten to the canonical shape in place
// (replaceState, no Back step). The record id is a first-class shape, not a
// transition: an unlinked coachee, a manual game and a duplicated number have
// nothing better to be addressed by, and every link that ever carried one
// keeps resolving.
import { inSeasonOrManual } from './season';
import { dayLabel } from './appTime';

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

// ── The client's side of the rule ────────────────────────────────────────────
// The server resolves who is on a game (buildCoacheeIndex) and sends the
// answer along: `firstCoacheeId` / `secondCoacheeId` on every game row, the
// coachee record id of the game's season, '' when the referee is nobody's
// coachee. The client reads that answer and never re-derives it from the
// name. What follows is the reading — and, behind it, the one legacy path
// for a row the server did not answer: an API older than the field, or a
// list the PWA cached for up to 30 days before it existed.

/** A coachee row as the client holds it — the columns the legacy name index
 *  reads, and the id everything else reads. */
export type CoacheeLike = {
  id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  season?: number;
  /** The SV number the row is linked to, '' or absent when it is not. */
  referee_id?: string;
};

/** Every name a game's referee line can be written as, pointing at the coachee
 *  it belongs to. THE LEGACY PATH — consulted only for a game row that carries
 *  no `firstCoacheeId` / `secondCoacheeId` at all (see coacheeIdOnSlot).
 *
 *  Coachees are per-season rows: the same person has one per season, and
 *  everything derived from the row — Niveau, group, whether this referee is a
 *  coachee at all — has to read the season on screen, or last season's people
 *  leak onto this season's games wearing last season's badge. Rows from other
 *  seasons are left out entirely; among what remains (this season's rows plus
 *  the seasonless ones that predate the field) the selected season's row is
 *  inserted last so it wins the key.
 *
 *  Both name orders are keyed. VolleyManager writes "Vorname Nachname" on some
 *  fixtures and "Nachname Vorname" on others, and a lookup that knew only one
 *  of them silently treated half the roster as strangers.
 */
export function coacheeIndex<T extends CoacheeLike>(coachees: T[], season: number): Map<string, T> {
  const map = new Map<string, T>();
  const ordered = coachees
    .filter((c) => typeof c.season !== 'number' || c.season === season)
    .sort((a, b) => Number(a.season === season) - Number(b.season === season));
  for (const c of ordered) {
    const fn = foldName(c.full_name || '');
    if (fn) map.set(fn, c);
    const first = (c.first_name || '').trim();
    const last = (c.last_name || '').trim();
    if (first && last) {
      map.set(foldName(`${first} ${last}`), c);
      map.set(foldName(`${last} ${first}`), c);
    }
  }
  return map;
}

export type SlotRole = '1. SR' | '2. SR';

/** A game row as far as its two whistle slots go: the printed names, and
 *  the coachee ids the server resolved for them (absent from an older API). */
export type SlotGame = {
  firstReferee?: string;
  secondReferee?: string;
  /** The SV numbers on the slots, as the convocation carried them: '' for
   *  most stored games, absent from an older API. */
  firstRefereeId?: string;
  secondRefereeId?: string;
  firstCoacheeId?: string;
  secondCoacheeId?: string;
};

/** The SV number a submit claims for the referee the report is about.
 *
 *  The server's guard (claimNamesSlot in server/coacheeIndex.ts) accepts a
 *  claim carrying the SLOT's number whatever the name field says — the coach
 *  may have typed the everyday name where VolleyManager prints the licence
 *  one. A claim carrying any OTHER number is read as a claim about another
 *  person and refused without a second look, and two thirds of stored games
 *  carry no number on the slot at all: the row's number sent against such a
 *  slot turned the manual upload for a linked coachee into a 422. So the
 *  row's number travels only when it is the slot's own; otherwise the claim
 *  is nameless and the guard settles the two spellings through the index,
 *  the way it did before the client knew any number. */
export function svClaimOnSlot(game: SlotGame, role: SlotRole, row: { referee_id?: string } | undefined): string {
  const rowSv = (row?.referee_id ?? '').trim();
  const slotSv = ((role === '1. SR' ? game.firstRefereeId : game.secondRefereeId) ?? '').trim();
  return rowSv && rowSv === slotSv ? rowSv : '';
}

/** The coachee record id on a game's slot: what the server said, or nothing.
 *
 *  `''` is an answer — "not a coachee", exactly the server's verdict — and is
 *  never second-guessed by the name, or the client would badge a referee the
 *  server refused (a namesake, a row of another season) and the two screens
 *  would disagree again. Only a row with NO such field at all, from an API
 *  that predates it or a cached list that does, falls to the folded name
 *  through `legacy` — the index the whole app used to match on. Without a
 *  legacy index the answer is then nobody.
 */
export function coacheeIdOnSlot(game: SlotGame, role: SlotRole, legacy?: Map<string, { id: string }>): string {
  const served = role === '1. SR' ? game.firstCoacheeId : game.secondCoacheeId;
  if (served != null) return served.trim();
  const name = role === '1. SR' ? game.firstReferee : game.secondReferee;
  return legacy?.get(foldName(name ?? ''))?.id ?? '';
}

/** A reference to a coachee as a server row carries it: the record id when
 *  the API sent one (`''` for nobody), the name it printed beside it. */
export type CoacheeRef = { id?: string; name?: string };

export type CoacheeLookup<T extends CoacheeLike> = {
  /** This season's rows (a seasonless row belongs to every season), by id. */
  byId: Map<string, T>;
  /** The row a server reference names — by id when the field is present,
   *  by the folded name only when it is not. */
  resolve: (ref: CoacheeRef) => T | undefined;
  /** The coachee on a game's slot, or undefined. */
  onSlot: (game: SlotGame, role: SlotRole) => T | undefined;
  /** The record id on a game's slot, '' for nobody. */
  idOnSlot: (game: SlotGame, role: SlotRole) => string;
};

/** The one lookup the client's lists share, built once per roster and season.
 *
 *  Seasons are read here and nowhere else on the client: `byId` holds the rows
 *  of the season on screen. An id the server resolved for a game of some
 *  OTHER season — a past-games list reaches back, a test game made in July
 *  belongs to the season just ended, an observation group keeps the row its
 *  first report was filed on — names the same person's row of that season,
 *  which is on the roster the client holds (every season's rows come down)
 *  but not in `byId`. That person is carried over to this season's row by
 *  their SV number when both rows are linked, and by the folded name when
 *  they are not — what the name index answered for such a game before the
 *  ids existed; a person with no row this season is nobody, as then. Only a
 *  served '' is never second-guessed: it is the server's own "not a coachee". */
export function coacheeLookup<T extends CoacheeLike>(coachees: T[], season: number): CoacheeLookup<T> {
  const byId = new Map<string, T>();
  const bySv = new Map<string, T>();
  for (const c of coachees) {
    if (typeof c.season === 'number' && c.season !== season) continue;
    byId.set(c.id, c);
    const sv = (c.referee_id ?? '').trim();
    if (sv && !bySv.has(sv)) bySv.set(sv, c);
  }
  const anySeason = new Map(coachees.map((c) => [c.id, c]));
  // Built lazily: a current API answers every row, and then the name index
  // is never asked for. The one name-tier site of this lookup.
  let legacy: Map<string, T> | undefined;
  const byName = (name: string): T | undefined => (legacy ??= coacheeIndex(coachees, season)).get(foldName(name));
  /** This season's row for a served id: the row itself when it is this
   *  season's, else the same person's through the number, else the name. */
  const thisSeason = (id: string, name: string): T | undefined => {
    if (!id) return undefined;
    const hit = byId.get(id);
    if (hit) return hit;
    const sv = (anySeason.get(id)?.referee_id ?? '').trim();
    return (sv ? bySv.get(sv) : undefined) ?? byName(name);
  };
  const resolve = (ref: CoacheeRef): T | undefined => {
    if (ref.id != null) return thisSeason(ref.id.trim(), ref.name ?? '');
    return byName(ref.name ?? '');
  };
  const idOnSlot = (game: SlotGame, role: SlotRole): string => {
    const served = role === '1. SR' ? game.firstCoacheeId : game.secondCoacheeId;
    const name = (role === '1. SR' ? game.firstReferee : game.secondReferee) ?? '';
    if (served == null) return byName(name)?.id ?? '';
    return thisSeason(served.trim(), name)?.id ?? '';
  };
  return {
    byId,
    resolve,
    idOnSlot,
    onSlot: (game, role) => byId.get(idOnSlot(game, role)),
  };
}

/** The session, as the client knows it. */
export type MeRef = { rcId: string | null; rcName: string | null };

/** Does the signed-in coach hold this game?
 *
 *  `samePerson` on the game's `assignedRcId` / `assignedRc`, with the roster
 *  as the known ids: the id decides when the row carries one, a known other
 *  id is a no however the name reads, and an id nobody knows — or none at all,
 *  from an older API or a cached list — falls to the folded name, which is
 *  the rule the server enforces on the same row (`rcRefMatches`). Whether the
 *  game is held AT ALL is the caller's question, asked of `assignedRc` as it
 *  always has been; this answers only whose it is. */
export function isMyGame(
  game: { assignedRc?: string; assignedRcId?: string },
  me: MeRef,
  knownIds?: Set<string>,
): boolean {
  return samePerson({ id: game.assignedRcId ?? '', name: game.assignedRc ?? '' }, { id: me.rcId ?? '', name: me.rcName ?? '' }, knownIds);
}

/** Did the signed-in coach file this record? The same rule on a feedback
 *  row's `rc_id` / `rc_name`. */
export function isMyRecord(record: { rc_id?: string; rc_name?: string }, me: MeRef, knownIds?: Set<string>): boolean {
  return samePerson({ id: record.rc_id ?? '', name: record.rc_name ?? '' }, { id: me.rcId ?? '', name: me.rcName ?? '' }, knownIds);
}

/** People to test a game's whistle slot against, as a coach who also
 *  referees is known: every SV number and every folded spelling among them.
 *  One coach — their roster name and the aliases their record lists — when
 *  the question is "is this slot me?", the whole active roster when it is
 *  "is a coach whistling this game?". Folded once, here, because the games
 *  list asks the question of both slots of every game. */
export type RefereeSet = { svs: Set<string>; names: Set<string> };

export function refereeSet(people: { svNumber?: string; names: string[] }[]): RefereeSet {
  const svs = new Set<string>();
  const names = new Set<string>();
  for (const p of people) {
    const sv = (p.svNumber ?? '').trim();
    if (sv) svs.add(sv);
    for (const n of p.names ?? []) {
      const key = foldName(n ?? '');
      if (key) names.add(key);
    }
  }
  return { svs, names };
}

/** Is the referee printed on a game's slot one of these people?
 *
 *  The number first, when the convocation carried one and the set knows it:
 *  a number does not change when somebody marries, which is exactly what
 *  broke the name-only version of this test for every fixture the sync had
 *  written before the wedding. The folded name after that, against every
 *  spelling in the set — the roster's own and the aliases a coach's record
 *  lists as also theirs. A number the set does NOT know is no veto: two
 *  thirds of stored games carry none at all, and where one is there the
 *  register link behind the row is not yet trusted to overrule a name
 *  (identity plan §2, open question 4), so the name keeps the game attached
 *  until it is. The coach-as-referee test of every server list — the
 *  RC-Spiel flag, the Börse verdict's "my slot", Home's own SR-Spiele and
 *  the calendar feed — so that the four cannot drift apart. The slot's
 *  fields are `unknown` because that is how a PocketBase row hands them
 *  over (the server's CoacheeQuery); a non-string is nobody. */
export function refereeAmong(slot: { name?: unknown; sv?: unknown }, people: RefereeSet): boolean {
  const sv = typeof slot.sv === 'string' || typeof slot.sv === 'number' ? String(slot.sv).trim() : '';
  if (sv && people.svs.has(sv)) return true;
  return typeof slot.name === 'string' && people.names.has(foldName(slot.name));
}

/** A coach as a roster hands them out: the record id, the display name, and
 *  the other spellings an admin listed for them (`name_aliases` — the maiden
 *  name, the everyday short form, the order VolleyManager prints). */
export type RcPersonLike = { id: string; fullName: string; aliases?: string[] };

/** The roster id a typed or stored coach NAME resolves to — or '', when
 *  nobody answers to it and, just as firmly, when more than one does.
 *
 *  Both orders of the name (nameKeys) against the coach's own name and every
 *  alias, folded. Two coaches answering is exactly the ambiguity the id exists
 *  to remove, and taking the first would hand one of them the other's game or
 *  file an observation under the wrong name; so an ambiguous name is nobody,
 *  and the caller refuses with the name rather than guess. Two hits on the
 *  SAME coach — an alias that repeats the name the other way round — are one.
 *  This is where every server-side name→id lookup for a coach ends up
 *  (`rcIdForName`, the admin submit, the raw feedback routes, the migration),
 *  so that they agree on what a name means.
 */
export function resolveRcName(name: string, people: RcPersonLike[]): string {
  const wanted = new Set(nameKeys(name ?? ''));
  if (!wanted.size) return '';
  let found = '';
  for (const p of people) {
    if (![p.fullName, ...(p.aliases ?? [])].some((spelling) => wanted.has(foldName(spelling ?? '')))) continue;
    if (found && found !== p.id) return '';
    found = p.id;
  }
  return found;
}

/** The coach a reference names — the roster id when it is one, else a name
 *  through resolveRcName. What a URL segment or a stored reference to a
 *  coach means when the caller cannot tell which shape it holds: the
 *  console asks `/api/rc-overview/<name>/coachees?rcId=<id>` (the name in
 *  the path for an API that predates the id), older clients and typed
 *  addresses ask with the name alone, and all must land on the same coach. The
 *  id is tried first because it is exact; two coaches folding to one name
 *  resolve separately by id and to nobody by name. */
export function resolveRcRef<T extends RcPersonLike>(ref: string, people: T[]): T | undefined {
  const wanted = (ref ?? '').trim();
  if (!wanted) return undefined;
  const byId = people.find((p) => p.id === wanted);
  if (byId) return byId;
  const id = resolveRcName(wanted, people);
  return id ? people.find((p) => p.id === id) : undefined;
}

// ── A game, as a human reads it ──────────────────────────────────────────────

/** What `gameLabel` reads: the number, the two teams (or the API's "Home vs
 *  Away" string, whichever the caller holds) and the date. Every field is
 *  optional — a draft record carries its teams as one string, a manual game
 *  may carry no number, an older server no date. */
export type GameLabelInput = {
  matchNo?: string;
  homeTeam?: string;
  awayTeam?: string;
  /** The API's "Home vs Away" string, for a caller that holds no halves. */
  teams?: string;
  date?: string;
};

/** The one way a game is named where a person reads it: the draft banner,
 *  the outbox row, the notebook's "übernommen" line, the take dialog, the
 *  console's "Angelegt" line.
 *
 *  "#<matchNo> · <teams>" — the number VolleyManager printed on the sheet is
 *  what the coach, the referee and the commission all call the game by, and
 *  the teams beside it say which one that is without a lookup. A game with
 *  no number (a manual fixture made before numbers were generated for them)
 *  reads "<teams> · <date>" instead; the date is the next thing two people
 *  can agree on. The PocketBase record id is never part of it: it means
 *  nothing to anyone reading a screen, and where it used to stand in for a
 *  missing number it was mistaken for one. Empty when nothing is known,
 *  so the caller decides what an unknown game is called.
 *
 *  Not the audit's `gameLabel` (server/identityAudit.ts): that one is the
 *  compact form its lists send over the wire — the number alone, since the
 *  row it sits on already names the slot — and is pinned separately.
 */
export function gameLabel(g: GameLabelInput): string {
  const no = (g.matchNo ?? '').trim();
  const teams = (g.teams ?? '').trim()
    || [g.homeTeam, g.awayTeam].map((team) => (team ?? '').trim()).filter(Boolean).join(' vs ');
  if (no) return teams ? `#${no} · ${teams}` : `#${no}`;
  return [teams, dayLabel(g.date ?? '', { year: true })].filter(Boolean).join(' · ');
}

// ── URL tokens ───────────────────────────────────────────────────────────────
// A token is an opaque string compared trimmed. No shape test: a 15-character
// PocketBase id can be all digits, and nothing in the repo states how long an
// SV number is. What a token means is decided by looking it up, id column
// first, record id second.

/** The coachee rows a season's lookup may answer with, in the order they
 *  are asked: the rows OF that season, then the rows with no season at all —
 *  those predate the field and belong to every season (App.tsx `isInSeason`).
 *  The same two tiers, in the same order, as indexPeople's candidates. */
function rowsForSeason<T extends { season?: number }>(rows: T[], season: number): T[] {
  return [...rows.filter((r) => r.season === season), ...rows.filter((r) => typeof r.season !== 'number')];
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
 *
 *  Within the season the candidates are ordered the way indexPeople orders
 *  them — the rows OF the season first, the seasonless ones after — rather
 *  than as the roster lists them. The roster is sorted by name, so a person's
 *  two rows sit side by side in no particular order, and a legacy row from
 *  before the season field, linked to the same number, could otherwise open
 *  ahead of this season's with last year's Niveau in the header — the very
 *  row the Coachees tab, the games list and the audit call current would
 *  then not be the one the app's own link opens.
 */
export function resolveCoacheeToken<T extends { id: string; referee_id?: string; season?: number }>(
  token: string,
  coachees: T[],
  season: number,
): CoacheeTokenHit<T> | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  const sv = (c: T) => (c.referee_id ?? '').trim();
  const inSeason = rowsForSeason(coachees, season);
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
