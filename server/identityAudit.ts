// The identity audit — everything that is still matched by a name, listed.
//
// The app now asks for a person or a game by its identity first (the SV
// number, the roster id, the match number — docs/identity-plan-2026-09-16.md
// §2) and by the folded name only where a side has no id to offer. That
// fallback is silent on purpose: a list must not lose a game because a link
// is missing. But silent means nobody sees how much of the data still rides
// on the spelling, and a wrong register link (the word-subset heuristic's
// guess) pairs a game with the wrong person by id, which the name fallback
// cannot catch. This is the surface for all of it: the coachee rows without
// a number and who the register would link them to, two rows of one season
// on one number, a slot whose number contradicts the row it was matched to
// by name, the slots the number did not settle, match numbers reused or
// blank, and the coach references (games, feedbacks, Rückmeldungen, the
// chair's notes) that carry no roster id or one nobody knows.
//
// Pure: no PocketBase, no clock, no log. index.ts reads the rows and hands
// them in (GET /api/admin/identity-audit); e2e/identity-rules.spec.ts pins
// the classifier on fixtures. The name matching itself is NOT done here —
// the coachee candidates come from dataHygiene.ts's registerCandidates (the
// lookup the link writes with), the slot resolution from coacheeIndex.ts,
// the coach names from resolveRcName — so the audit reports exactly what the
// app does, and can never disagree with it about what a name means.
import { buildCoacheeIndex, registerNumbers, type CoacheeVia } from './coacheeIndex.ts';
import { coacheeDisplayName, refereeLinkProblem, registerCandidates } from './dataHygiene.ts';
import { coacheeRowSeason, seasonOfGame, seasonWindowFilter } from './season.ts';
import { resolveRcName, type RcPersonLike } from '../src/lib/identity.ts';

type AnyRecord = Record<string, unknown>;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** A coach as the people table holds them, with the two facts the audit
 *  reads beside the resolver's three: the SV number (a coach is a referee
 *  too, and the RC-Spiel test asks for it) and whether they are active. */
export type AuditRcPerson = RcPersonLike & { svNumber: string; active: boolean };

/** The chair's note as the store keeps it (presidentNotes.ts), reduced to
 *  the coach reference and a label. */
export type AuditPresidentNote = { id: string; rcId?: string; rcName?: string; matchNo?: string; teams?: string; gameDate?: string };

export type AuditInput = {
  /** The season the report is about — the console's selector. */
  season: number;
  /** Every coachee row, every season: the index reads the seasons itself,
   *  and a seasonless row belongs to this season too. Roster order. */
  coachees: AnyRecord[];
  register: AnyRecord[];
  /** Every stored game — the identity columns suffice. The season cut is
   *  made here where a rule is per season, and not where a key is global
   *  (the match number). */
  games: AnyRecord[];
  /** The manual games (`manual_games` setting): in every season, like the
   *  lists show them. */
  manualIds: Set<string>;
  /** `id, rc_id, rc_name, game, role_assessed, submitted_at`. */
  feedbacks: AnyRecord[];
  /** `id, rc_id, rc_name, game, season, submitted_at`. */
  rcNotes: AnyRecord[];
  /** This season's notes only — the store keeps one row per season. */
  presidentNotes: AuditPresidentNote[];
  /** The WHOLE people table, inactive coaches included: a feedback filed by
   *  a coach who has since left still names a known id. */
  rcPeople: AuditRcPerson[];
};

/** Why a coachee row carries no number.
 *
 *  unmatched     the register does not hold the name under any spelling —
 *                nothing to offer, the admin picks from the whole register
 *  ambiguous     the register holds it twice, or the one licence it names is
 *                already another row's this season — a person decides
 *  never-linked  exactly one free licence: the link would write it, but has
 *                not run since the row was made — the pick is pre-filled */
export type UnlinkedReason = 'unmatched' | 'ambiguous' | 'never-linked';

export type UnlinkedCoachee = {
  id: string;
  name: string;
  season: number | null;
  reason: UnlinkedReason;
  /** The register rows the name answers to (registerCandidates). */
  candidates: { sv: string; name: string }[];
};

export type DuplicateSv = { sv: string; season: number | null; rowIds: string[]; names: string[] };

/** A slot matched to a row by its NAME whose number is not the slot's — the
 *  step 2 warning (`identity.sv-mismatch`), made durable. Either the register
 *  link on the row is wrong or VolleyManager's number on the game is.
 *  `label` is the game as a human reads it (gameLabel), never the record id. */
/** A row naming a game says when that game is a manual (test) fixture — a
 *  Testspiel typed with a made-up referee sits in these lists like a real
 *  slot nobody linked. Present only when true, so the row shapes the specs
 *  pin stay as they are for every real fixture. */
type TestMark = { isManual?: true };
export type SvDisagreement = { coacheeId: string; coacheeName: string; rowSv: string; gameId: string; matchNo: string; label: string; slot: SlotName; slotSv: string; name: string } & TestMark;

export type SlotName = '1. SR' | '2. SR';

/** A slot the number did not settle: resolved to a coachee by the name tier
 *  (`via: 'name'` — link the row or number the game), or to nobody while
 *  carrying no number at all (`via: 'none'`). A nobody without a number is
 *  listed only when the register does not spell the printed name exactly
 *  once — `registerHits` 0 (not in the register) or 2+ (two licences under
 *  one name): a name the register spells once is the backfill's to number,
 *  not a name match, and is counted in `gameSlotsNoSvInRegister` instead.
 *  A slot resolved to nobody WITH a number is identified and simply not a
 *  coachee's, and is not listed. `label` as on SvDisagreement. */
export type SlotByName = { gameId: string; matchNo: string; label: string; slot: SlotName; name: string; via: CoacheeVia; coacheeId: string; registerHits?: number } & TestMark;

export type DuplicateMatchNo = { matchNo: string; gameIds: string[]; seasons: number[] };

/** A game without a number, labelled the way a human reads it — teams and
 *  date, never the record id. */
export type BlankMatchNo = { gameId: string; teams: string; date: string } & TestMark;

export type RcRefSource = 'games' | 'feedbacks' | 'rc_game_notes' | 'president_notes';

/** A stored reference to a coach that the id does not settle: `blank` (a
 *  row written before ids were stored), `unknown` (an id no row of the
 *  people table carries — a deleted coach, or a data fix gone wrong).
 *  `resolvable` says whether migrate-rc-ids would stamp it from the name. */
export type RcRefUnresolved = { source: RcRefSource; id: string; label: string; rcName: string; rcId: string; reason: 'blank' | 'unknown'; resolvable: boolean };

export type IdentityAuditReport = {
  season: number;
  coacheesUnlinked: UnlinkedCoachee[];
  duplicateSvPerSeason: DuplicateSv[];
  svDisagreesWithGame: SvDisagreement[];
  gameSlotsByName: SlotByName[];
  /** This season's whistle slots with a printed name and no number. */
  gameSlotsNoSv: number;
  /** Of those, the slots whose printed name the register spells under
   *  exactly one licence — what "SV-Nr. auf Spielen nachtragen" numbers. */
  gameSlotsNoSvInRegister: number;
  duplicateMatchNos: DuplicateMatchNo[];
  blankMatchNo: BlankMatchNo[];
  rcRefsUnresolved: RcRefUnresolved[];
  rcsWithoutSv: { id: string; name: string }[];
};

/** What a human reads for a game: the number, else teams and date. The
 *  compact form for the audit's lists, off a PocketBase row; the screens
 *  name a game through `gameLabel` in src/lib/identity.ts ("#<Nr.> · teams"). */
export function gameLabel(game: AnyRecord | undefined): string {
  if (!game) return '';
  const no = text(game.match_no);
  if (no) return `#${no}`;
  const teams = `${text(game.home_team)} – ${text(game.away_team)}`.replace(/^ – | – $/g, '').trim();
  const day = text(game.match_date).slice(0, 10);
  return [teams, day].filter(Boolean).join(' · ');
}

/** A row is this season's when its season is this one or none at all — the
 *  cut every list makes (coacheeRowSeason null = every season). */
const rowInSeason = (row: AnyRecord, season: number): boolean => {
  const s = coacheeRowSeason(row.season);
  return s === null || s === season;
};

const SLOTS: [SlotName, string, string][] = [
  ['1. SR', 'first_referee', 'first_referee_id'],
  ['2. SR', 'second_referee', 'second_referee_id'],
];

/**
 * The report, from the rows. Every list is deterministic in input order —
 * the rows arrive sorted (coachees by name, games as stored) — so two runs
 * over the same data read the same, and a spec can pin the order.
 */
export function identityAudit(input: AuditInput): IdentityAuditReport {
  const { season, coachees, register, games, manualIds, rcPeople } = input;

  // ── Coachees: the rows without a number, and who they could be ────
  // Classified over copies, in roster order, the way planCoacheeLinks
  // decides: a licence the link would write onto an earlier row is on the
  // list the check for the next row reads, so two unlinked rows answering
  // to one free licence read "never-linked" and "ambiguous", not twice
  // "never-linked" with the same number pre-filled on both — the button
  // links the first and reports the second, and the card has to say so
  // before it is pressed.
  const candidatesFor = registerCandidates(register);
  const coacheesUnlinked: UnlinkedCoachee[] = [];
  const planned = coachees.map((row) => ({ ...row }));
  for (const row of planned) {
    if (!rowInSeason(row, season) || text(row.referee_id)) continue;
    const name = coacheeDisplayName(row);
    if (!name) continue;
    const rowSeason = coacheeRowSeason(row.season);
    const candidates = candidatesFor(row)
      .map((r) => ({ sv: text(r.sv_number), name: `${text(r.first_name)} ${text(r.last_name)}`.trim() || text(r.full_name) }))
      .filter((c) => c.sv);
    let reason: UnlinkedReason;
    if (candidates.length === 0) reason = 'unmatched';
    else if (candidates.length > 1) reason = 'ambiguous';
    // The one licence is another row's already: the link refuses it
    // (planCoacheeLinks reports it as ambiguous) and so would the hand-link.
    else if (refereeLinkProblem({ sv: candidates[0].sv, season: rowSeason, rowId: String(row.id) }, register, planned)) reason = 'ambiguous';
    else { reason = 'never-linked'; row.referee_id = candidates[0].sv; }
    coacheesUnlinked.push({ id: String(row.id), name, season: rowSeason, reason, candidates });
  }

  // ── Two rows of one season on one number ──────────────────────────
  // The state the index resolves by roster order and the routes refuse to
  // create; it can still exist from before they did. A seasonless row is
  // its own group (`null`), the way refereeLinkProblem reads it.
  const bySv = new Map<string, AnyRecord[]>();
  for (const row of coachees) {
    const sv = text(row.referee_id);
    if (!sv || !rowInSeason(row, season)) continue;
    const key = `${coacheeRowSeason(row.season) ?? '*'}|${sv}`;
    const bucket = bySv.get(key);
    if (bucket) bucket.push(row); else bySv.set(key, [row]);
  }
  const duplicateSvPerSeason: DuplicateSv[] = [...bySv.values()]
    .filter((rows) => rows.length > 1)
    .map((rows) => ({
      sv: text(rows[0].referee_id),
      season: coacheeRowSeason(rows[0].season),
      rowIds: rows.map((r) => String(r.id)),
      names: rows.map(coacheeDisplayName),
    }));

  // ── The slots of this season's games, through the index ───────────
  // The same index every list resolves with, mismatches collected off the
  // hits rather than the callback so each carries the row's id.
  const index = buildCoacheeIndex(coachees.map((row) => ({ ...row, id: String(row.id) })), register);
  // The register's own answer for a printed name — the backfill's lookup
  // (planRefereeIdBackfill asks the same function), so "the register does
  // not spell it" here is what the button would report.
  const numbersFor = registerNumbers(register);
  const inSeason = seasonWindowFilter(season, manualIds);
  const svDisagreesWithGame: SvDisagreement[] = [];
  const gameSlotsByName: SlotByName[] = [];
  let gameSlotsNoSv = 0;
  let gameSlotsNoSvInRegister = 0;
  for (const game of games) {
    if (!inSeason(game)) continue;
    const gameSeason = seasonOfGame(game.match_date);
    const gameId = String(game.id);
    const matchNo = text(game.match_no);
    const label = gameLabel(game);
    const test: TestMark = manualIds.has(gameId) ? { isManual: true } : {};
    for (const [slot, nameKey, idKey] of SLOTS) {
      const name = text(game[nameKey]);
      const sv = text(game[idKey]);
      if (!name) continue;
      const registerHits = sv ? 0 : numbersFor(name).length;
      if (!sv) gameSlotsNoSv++;
      if (!sv && registerHits === 1) gameSlotsNoSvInRegister++;
      const hit = index.find(gameSeason, { sv, name, matchNo });
      const coacheeId = hit.row ? String(hit.row.id) : '';
      if (hit.via === 'name') {
        const rowSv = text(hit.row?.referee_id);
        if (sv && rowSv && rowSv !== sv) {
          svDisagreesWithGame.push({ coacheeId, coacheeName: coacheeDisplayName(hit.row ?? {}), rowSv, gameId, matchNo, label, slot, slotSv: sv, name, ...test });
        }
        gameSlotsByName.push({ gameId, matchNo, label, slot, name, via: 'name', coacheeId, ...test });
      } else if (hit.via === 'none' && !sv && registerHits !== 1) {
        // A name the register spells once is the backfill's: after it the
        // slot carries a number and is nobody's coachee by identity, which
        // is not listed. Only the names the register cannot settle are —
        // and the card must not call a licensed referee "not in the
        // register" while the register holds them.
        gameSlotsByName.push({ gameId, matchNo, label, slot, name, via: 'none', coacheeId: '', registerHits, ...test });
      }
    }
  }

  // ── Match numbers: reused or blank, over every stored game ────────
  // The number is a global key (findGameByMatchNo answers the newest of
  // them), so this is not cut to the season: whether VolleyManager reuses
  // numbers across seasons is exactly the question (open question 3).
  const byNo = new Map<string, AnyRecord[]>();
  const blankMatchNo: BlankMatchNo[] = [];
  for (const game of games) {
    const no = text(game.match_no);
    if (!no) {
      blankMatchNo.push({ gameId: String(game.id), teams: `${text(game.home_team)} – ${text(game.away_team)}`, date: text(game.match_date), ...(manualIds.has(String(game.id)) ? { isManual: true as const } : {}) });
      continue;
    }
    const bucket = byNo.get(no);
    if (bucket) bucket.push(game); else byNo.set(no, [game]);
  }
  const duplicateMatchNos: DuplicateMatchNo[] = [...byNo.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([matchNo, rows]) => ({
      matchNo,
      gameIds: rows.map((g) => String(g.id)),
      seasons: [...new Set(rows.map((g) => seasonOfGame(g.match_date)).filter((s): s is number => s != null))].sort(),
    }));

  // ── Coach references the id does not settle ───────────────────────
  const knownRcIds = new Set(rcPeople.map((p) => p.id));
  const rcRefsUnresolved: RcRefUnresolved[] = [];
  const checkRef = (source: RcRefSource, id: string, label: string, rcId: string, rcName: string) => {
    if (!rcId && !rcName) return;
    if (rcId && knownRcIds.has(rcId)) return;
    rcRefsUnresolved.push({
      source, id, label, rcName, rcId,
      reason: rcId ? 'unknown' : 'blank',
      // What migrate-rc-ids would do with it: a blank id it resolves from
      // the name; an unknown id it leaves alone (it only fills blanks).
      resolvable: !rcId && resolveRcName(rcName, rcPeople) !== '',
    });
  };
  const gameById = new Map(games.map((g) => [String(g.id), g]));
  for (const game of games) {
    if (!inSeason(game)) continue;
    checkRef('games', String(game.id), gameLabel(game), text(game.assigned_rc_id), text(game.assigned_rc));
  }
  // A feedback or a Rückmeldung belongs to the season of its game; one whose
  // game is gone is placed by the day it was filed.
  const recordInSeason = (row: AnyRecord): boolean => {
    const game = gameById.get(text(row.game));
    if (game) return inSeason(game);
    const own = coacheeRowSeason(row.season);
    if (own !== null) return own === season;
    return seasonOfGame(row.submitted_at) === season;
  };
  for (const row of input.feedbacks) {
    if (!recordInSeason(row)) continue;
    const label = [gameLabel(gameById.get(text(row.game))) || text(row.submitted_at).slice(0, 10), text(row.role_assessed)].filter(Boolean).join(' · ');
    checkRef('feedbacks', String(row.id), label, text(row.rc_id), text(row.rc_name));
  }
  for (const row of input.rcNotes) {
    if (!recordInSeason(row)) continue;
    const label = gameLabel(gameById.get(text(row.game))) || text(row.submitted_at).slice(0, 10);
    checkRef('rc_game_notes', String(row.id), label, text(row.rc_id), text(row.rc_name));
  }
  for (const note of input.presidentNotes) {
    const label = text(note.matchNo) ? `#${text(note.matchNo)}` : [text(note.teams), text(note.gameDate).slice(0, 10)].filter(Boolean).join(' · ');
    checkRef('president_notes', note.id, label, text(note.rcId), text(note.rcName));
  }

  // ── Coaches without their own number ──────────────────────────────
  // Active ones only: the RC-Spiel test and the Börse's "is me" ask the
  // number of a coach who is still whistling.
  const rcsWithoutSv = rcPeople
    .filter((p) => p.active && !text(p.svNumber))
    .map((p) => ({ id: p.id, name: p.fullName }));

  return {
    season,
    coacheesUnlinked,
    duplicateSvPerSeason,
    svDisagreesWithGame,
    gameSlotsByName,
    gameSlotsNoSv,
    gameSlotsNoSvInRegister,
    duplicateMatchNos,
    blankMatchNo,
    rcRefsUnresolved,
    rcsWithoutSv,
  };
}
