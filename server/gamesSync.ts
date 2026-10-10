// The rules the games import applies to a VolleyManager row once it is in the
// collection's shape. Kept out of index.ts so they can be tested without a
// PocketBase or a VolleyManager session — the sync itself cannot be.
import { nameKeys, samePerson } from '../src/lib/identity.ts';

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

/** What a crew change does to a game a coach holds (asked 2026-09-30, after
 *  #408228 stayed booked for weeks once the Börse swapped its coachee for a
 *  referee nobody coaches). Only the transition counts — a coachee on an open
 *  role before, none after — so a game that was already empty is not mailed
 *  again on every sync.
 *
 *  More than a week out, the booking is released: there is nothing left to
 *  observe, and a coach who keeps an evening for it is better off told and
 *  free. Closer than that the coach may already have arranged the evening,
 *  so the game stays theirs and they are told; releasing it is their call.
 *  A game already played is left alone — its report is what matters now. */
export const CREW_RELEASE_MIN_DAYS = 7;
export type CrewChangeAction = 'none' | 'release' | 'notify';

export function crewChangeAction(o: {
  held: boolean;
  gameDate: string;
  now: string;
  /** Coachees on roles whose report is not sent yet, before and after. */
  coacheesBefore: number;
  coacheesAfter: number;
}): CrewChangeAction {
  if (!o.held || o.coacheesBefore === 0 || o.coacheesAfter > 0) return 'none';
  const ahead = Date.parse(o.gameDate) - Date.parse(o.now);
  if (!Number.isFinite(ahead) || ahead < 0) return 'none';
  return ahead > CREW_RELEASE_MIN_DAYS * 24 * 60 * 60 * 1000 ? 'release' : 'notify';
}

/** One whistle slot of a held game as the change rule sees it: who stands on
 *  it, and — when that person is a coachee of the game's season — which
 *  coachee row, and whether their report is still to come. */
export type HeldSlot = { name: string; sv: string; coacheeId: string; open: boolean };

/** A held game, before or after a sync wrote it. */
export type HeldGameSide = {
  date: string;
  location: string;
  slots: [HeldSlot, HeldSlot];
  /** 4.4.10: a referee coach on the whistle next to a coachee. */
  rcGame: boolean;
};

/** One thing the coach is told about, in the order the mail lists them. */
export type HeldGameChange =
  | { kind: 'moved'; from: string; to: string }
  | { kind: 'hall'; from: string; to: string }
  | { kind: 'coachee-left'; names: string[] }
  | { kind: 'coachee-joined'; names: string[] }
  | { kind: 'referee'; slot: '1' | '2'; from: string; to: string }
  | { kind: 'rc-game' };

export type HeldGameVerdict = {
  action: CrewChangeAction;
  changes: HeldGameChange[];
  /** Nothing is left to observe: the last open coachee went, or the game
   *  became an RC-Spiel. Decides release-or-keep and the commission's copy. */
  purposeLost: boolean;
};

/** Two slot occupants are different people: by the SV number when both
 *  carry one, otherwise by the name in either order — VolleyManager writes
 *  "Vorname Nachname" on some feeds and "Nachname Vorname" on others, and a
 *  spelling flip between the nightly sync and the börse poll must not read
 *  as a new referee. */
function differentPerson(a: HeldSlot, b: HeldSlot): boolean {
  if (text(a.sv) && text(b.sv)) return text(a.sv) !== text(b.sv);
  const ka = nameKeys(a.name);
  const kb = new Set(nameKeys(b.name));
  if (ka.length === 0 || kb.size === 0) return ka.length !== kb.size;
  return !ka.some((k) => kb.has(k));
}

/** The hall as a person reads it — its name and its town — so VolleyManager
 *  re-spelling a street address is not a move. */
function hallKey(location: string): string {
  const parts = text(location).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0] : `${parts[0]}|${parts[parts.length - 1]}`;
}

const MOVE_TOLERANCE_MS = 60 * 1000;

/** What a sync's rewrite of a game means for the coach who holds it (asked
 *  2026-10-10: "when games get moved, börse in etc there is always an email
 *  … in case of any game change/coachee change etc. also if … the other ref
 *  is an RC, so it becomes an RC game").
 *
 *  Told about: a new kick-off (a minute or more), a new hall, a coachee who
 *  left or joined the open roles, the other referee replaced by somebody
 *  else (a slot merely filled or emptied is the appointments happening, not
 *  news), and the game turning into an RC-Spiel. Only transitions — the
 *  stored row against the written one — so a sync that runs again finds
 *  nothing to say.
 *
 *  Nothing left to observe — the last open coachee gone, or an RC-Spiel,
 *  where 4.4.10 allows no observation — is crewChangeAction's rule: released
 *  more than a week out, kept and flagged closer. Anything else is a notice;
 *  the booking stays. A game already played says nothing: its report is
 *  what matters now. */
export function heldGameChange(o: { held: boolean; now: string; before: HeldGameSide; after: HeldGameSide }): HeldGameVerdict {
  const none: HeldGameVerdict = { action: 'none', changes: [], purposeLost: false };
  if (!o.held) return none;
  const now = Date.parse(o.now);
  const at = Date.parse(o.after.date || o.before.date);
  if (!Number.isFinite(at) || !Number.isFinite(now) || at < now) return none;

  const changes: HeldGameChange[] = [];
  const from = Date.parse(o.before.date);
  if (Number.isFinite(from) && Math.abs(at - from) >= MOVE_TOLERANCE_MS) {
    changes.push({ kind: 'moved', from: o.before.date, to: o.after.date });
  }
  const hallBefore = hallKey(o.before.location);
  const hallAfter = hallKey(o.after.location);
  if (hallBefore && hallAfter && hallBefore !== hallAfter) {
    changes.push({ kind: 'hall', from: text(o.before.location), to: text(o.after.location) });
  }

  const open = (side: HeldGameSide) => side.slots.filter((s) => s.coacheeId && s.open);
  const openBefore = open(o.before);
  const openAfter = open(o.after);
  const idsAfter = new Set(openAfter.map((s) => s.coacheeId));
  const idsBefore = new Set(openBefore.map((s) => s.coacheeId));
  const left = openBefore.filter((s) => !idsAfter.has(s.coacheeId)).map((s) => text(s.name));
  const joined = openAfter.filter((s) => !idsBefore.has(s.coacheeId)).map((s) => text(s.name));
  if (left.length) changes.push({ kind: 'coachee-left', names: left });
  if (joined.length) changes.push({ kind: 'coachee-joined', names: joined });

  o.before.slots.forEach((b, i) => {
    const a = o.after.slots[i];
    // A coachee arriving or leaving is said above, by name; this is only the
    // other referee — somebody named replaced by somebody else named.
    if (b.coacheeId || a.coacheeId) return;
    if (!text(b.name) || !text(a.name)) return;
    if (differentPerson(b, a)) changes.push({ kind: 'referee', slot: i === 0 ? '1' : '2', from: text(b.name), to: text(a.name) });
  });

  const becameRcGame = !o.before.rcGame && o.after.rcGame;
  if (becameRcGame) changes.push({ kind: 'rc-game' });

  const purposeLost = (openBefore.length > 0 && openAfter.length === 0) || becameRcGame;
  if (purposeLost) {
    const action = crewChangeAction({
      held: true, gameDate: o.after.date || o.before.date, now: o.now, coacheesBefore: 1, coacheesAfter: 0,
    });
    return { action, changes, purposeLost };
  }
  return { action: changes.length ? 'notify' : 'none', changes, purposeLost };
}

/** What the "no longer in VolleyManager" watch remembers between runs (kept in
 *  app_settings `vm_missing_games`): the size of the last complete fetch, and
 *  per held game — by record id — since when and in how many runs in a row
 *  its number was missing, and when the coach was told. */
export type MissingGameEntry = { since: string; runs: number; notifiedAt?: string };
export type MissingGamesState = { lastTotal: number; games: Record<string, MissingGameEntry> };

/** A held game as the watch sees it: the record, its number, its kick-off. */
export type HeldFixture = { id: string; matchNo: string; date: string };

/** How many complete runs in a row a held game must be absent before the
 *  coach is told. One run is a blip; two is a pattern. */
export const MISSING_RUNS_BEFORE_NOTICE = 2;

/** Which held games VolleyManager no longer lists (asked 2026-10-10: "game
 *  cancelled in VolleyManager" was the one change nobody heard of).
 *  VolleyManager has no "cancelled" flag the import can read: a cancelled
 *  game simply stops coming back. Absence is only evidence from a fetch that
 *  is provably whole — the caller passes `complete` only when every page came
 *  back (rows = VolleyManager's own total) for the default window — and only
 *  for a game still to come inside that window. A fetch less than half the
 *  size of the last complete one is not trusted at all: an upstream hiccup
 *  must not mail every coach that their game is gone.
 *
 *  A game absent from MISSING_RUNS_BEFORE_NOTICE complete runs in a row is
 *  `notify` (once); one that was notified and is back is `returned`. The
 *  booking itself is never touched: VolleyManager is where the coach checks. */
export function missingHeldGames(o: {
  held: HeldFixture[];
  fetchedMatchNos: Set<string>;
  total: number;
  complete: boolean;
  window: { from: string; to: string };
  now: string;
  state: MissingGamesState;
}): { state: MissingGamesState; notify: string[]; returned: string[]; skipped: '' | 'incomplete' | 'shrunk' } {
  const prev = o.state ?? { lastTotal: 0, games: {} };
  if (!o.complete || o.total <= 0) return { state: prev, notify: [], returned: [], skipped: 'incomplete' };
  if (prev.lastTotal > 0 && o.total < prev.lastTotal / 2) return { state: prev, notify: [], returned: [], skipped: 'shrunk' };
  const now = Date.parse(o.now);
  const from = Date.parse(o.window.from);
  const to = Date.parse(o.window.to);
  const games: Record<string, MissingGameEntry> = {};
  const notify: string[] = [];
  const returned: string[] = [];
  for (const g of o.held) {
    const at = Date.parse(g.date);
    if (!g.matchNo || !Number.isFinite(at) || at < now || at < from || at > to) continue;
    const before = prev.games[g.id];
    if (o.fetchedMatchNos.has(g.matchNo)) {
      if (before?.notifiedAt) returned.push(g.id);
      continue;
    }
    const entry: MissingGameEntry = { since: before?.since ?? o.now, runs: (before?.runs ?? 0) + 1, ...(before?.notifiedAt ? { notifiedAt: before.notifiedAt } : {}) };
    if (entry.runs >= MISSING_RUNS_BEFORE_NOTICE && !entry.notifiedAt) {
      entry.notifiedAt = o.now;
      notify.push(g.id);
    }
    games[g.id] = entry;
  }
  return { state: { lastTotal: o.total, games }, notify, returned, skipped: '' };
}
