// The rules that put an SV number where one is missing, and keep two rows
// from claiming one — pure, so they can be tested without a PocketBase
// (e2e/coachee-import.spec.ts, e2e/referee-register.spec.ts,
// e2e/manual-game-picker.spec.ts). index.ts keeps the I/O: the reads, the
// writes and the routes.
//
// The number on a coachee row (`coachees.referee_id`) and on a game's whistle
// slots (`games.first/second_referee_id`) is what every match asks first
// (coacheeIndex.ts); a row or a slot without one falls back to the register
// and the folded name, which is where "Kevin León Peña de los Santos" against
// "Kevin Peña" went wrong. These rules widen where the number is present —
// inherited by next season's row, read off the coaching sheet, written onto
// stored games, hand-linked in the console — and refuse the one state the
// index cannot resolve: two rows of one season on one number
// (docs/identity-plan-2026-09-16.md, step 3).
import { personKey } from './forms.ts';
import { coacheeRowSeason } from './season.ts';
import { foldName } from '../src/lib/identity.ts';
import { seasonLabel } from '../src/lib/season.ts';

type AnyRecord = Record<string, unknown>;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** The name a coachee row goes by: the full name, else first + last. */
export function coacheeDisplayName(row: AnyRecord): string {
  return text(row.full_name) || `${text(row.first_name)} ${text(row.last_name)}`.trim();
}

export type LinkProblem = { status: 400 | 409; error: string };

/**
 * Whether `sv` may be written onto the coachee row `rowId` of `season`, and
 * the answer the route gives when it may not.
 *
 * '' always may — it unlinks. Otherwise the number has to be a licence in
 * the register (400): the console only offers register rows, so a number
 * that is none is a hand-edited request, and a typo must not create a
 * phantom identity the games would then match nobody to. And no OTHER row of
 * the same season may hold it (409, naming that row): the index resolves a
 * same-season tie by roster order, which is no answer at all. A row of
 * another season may — that is the same referee, coached again — and so may
 * a seasonless row, which the index reads as every season's.
 */
export function refereeLinkProblem(
  link: { sv: unknown; season: number | null; rowId: string },
  register: AnyRecord[],
  coachees: AnyRecord[],
): LinkProblem | null {
  const sv = text(link.sv);
  if (!sv) return null;
  if (!register.some((r) => text(r.sv_number) === sv)) {
    return { status: 400, error: `Die SV-Nr. ${sv} steht nicht im Schiedsrichter-Register.` };
  }
  const other = coachees.find((c) =>
    String(c.id) !== link.rowId && text(c.referee_id) === sv && coacheeRowSeason(c.season) === link.season);
  if (other) {
    const season = link.season == null ? '' : ` in der Saison ${seasonLabel(link.season)}`;
    return { status: 409, error: `Die SV-Nr. ${sv} ist${season} bereits „${coacheeDisplayName(other)}" zugeordnet.` };
  }
  return null;
}

/**
 * The number a NEW season row starts with: the one its person's rows of
 * other seasons carry. The same person by personKey — the folded parts,
 * sorted, so "Zwahlen Rita" on last year's sheet and "Rita Zwahlen" on this
 * year's are one referee — and exactly one distinct number among them.
 * Two numbers mean two people behind one name, or a wrong link somewhere;
 * nothing is inherited then, and the register link that runs after the
 * import reports what it could not settle. The register is asked before
 * this (startingRefereeId), the sheet before both.
 */
export function inheritedRefereeId(name: string, season: number | null, rows: AnyRecord[]): string {
  const key = personKey(name);
  if (!key) return '';
  const numbers = new Set<string>();
  for (const row of rows) {
    if (coacheeRowSeason(row.season) === season) continue;
    const sv = text(row.referee_id);
    if (sv && personKey(coacheeDisplayName(row)) === key) numbers.add(sv);
  }
  return numbers.size === 1 ? [...numbers][0] : '';
}

/**
 * The number a NEW season row starts with, when the sheet names none.
 *
 * The register first: a name it spells under exactly one licence is that
 * licence, and an exact register hit outranks whatever an earlier row
 * carries — the earlier link may be the word-subset heuristic's guess from a
 * season in which the person was not in the register yet. A name the
 * register spells under TWO licences inherits nothing: that is the one
 * ambiguity every other path refuses, and copying last season's number would
 * decide it silently, when last season's row may have been linked by hand
 * to the other namesake. Only a name the register does not hold at all
 * falls back to the person's earlier rows (inheritedRefereeId). `numbersFor`
 * is the register lookup (coacheeIndex.ts registerNumbers), the same three
 * spellings the register tier reads at match time.
 */
export function startingRefereeId(
  name: string,
  season: number | null,
  rows: AnyRecord[],
  numbersFor: (name: string) => string[],
): string {
  const licences = numbersFor(name);
  if (licences.length === 1) return licences[0];
  if (licences.length > 1) return '';
  return inheritedRefereeId(name, season, rows);
}

export type LinkPlan = {
  /** The write per coachee row: the number the register spells its name
   *  under, and the name for the report. */
  writes: { id: string; sv: string; name: string }[];
  alreadyLinked: number;
  /** Names the register does not hold under any spelling. */
  unmatched: string[];
  /** Names the link will not decide: spelled under two licences, matching
   *  two register names by their words, or resolving to a licence another
   *  row of the same season already holds. Distinct, capped. */
  ambiguousNames: string[];
};

const REPORT_CAP = 50;

/**
 * Which coachee rows can be given their SV number from the register: the
 * decision of linkCoacheesToReferees, without its reads and writes. This is
 * the one place a name is still matched to a number — after it, the number
 * is what everything else uses.
 *
 * The register is indexed under both name orders, because the exports
 * disagree about which half of a name comes first — the same reason the
 * contact sync does it. A coachee whose name is no register spelling is
 * tried by words: the coaching sheet writes the name a coach uses, the
 * register the name on the licence, middle names and all — "Kevin Peña"
 * against "Kevin León Peña de los Santos" (eleven of the 135 rows on
 * 2026-08-27) — so every word of the shorter name must appear in the longer
 * one. Two words minimum, because a lone surname is not a claim about a
 * person but about a family.
 *
 * Ambiguity is reported, never resolved: two referees answering to one name
 * — as a spelling or by words — is precisely how a coaching report ends up in
 * a stranger's inbox. And a licence another row of the same season already
 * holds is refused the way the hand-link refuses it (refereeLinkProblem):
 * the index resolves two same-season rows on one number by roster order,
 * which is no answer at all, so the automatic path must not create that
 * state either — a number planned for one row in this run is seen by the
 * check on the next.
 */
export function planCoacheeLinks(referees: AnyRecord[], coachees: AnyRecord[]): LinkPlan {
  const plan: LinkPlan = { writes: [], alreadyLinked: 0, unmatched: [], ambiguousNames: [] };
  if (referees.length === 0) return plan;
  const report = (list: string[], name: string) => {
    if (list.length < REPORT_CAP && !list.includes(name)) list.push(name);
  };

  const byName = new Map<string, AnyRecord[]>();
  const indexUnder = (key: string, row: AnyRecord) => {
    if (!key) return;
    const bucket = byName.get(key);
    if (bucket) { if (!bucket.some((x) => x.id === row.id)) bucket.push(row); } else byName.set(key, [row]);
  };
  // Every word of a referee's registered name, for the fallback below.
  const words = new Map<unknown, Set<string>>();
  for (const r of referees) {
    const first = text(r.first_name), last = text(r.last_name);
    indexUnder(foldName(`${first} ${last}`), r);
    indexUnder(foldName(`${last} ${first}`), r);
    indexUnder(foldName(text(r.full_name)), r);
    words.set(r.id, new Set(foldName(`${first} ${last}`).split(' ').filter(Boolean)));
  }
  const spelled = (spelling: string): AnyRecord[] | undefined => byName.get(foldName(spelling));
  const byWords = (name: string): AnyRecord[] => {
    const parts = new Set(foldName(name).split(' ').filter(Boolean));
    if (parts.size < 2) return [];
    return referees.filter((r) => {
      const full = words.get(r.id);
      return full ? [...parts].every((part) => full.has(part)) : false;
    });
  };

  // Copies, so a number planned for one row is on the list the check for
  // the next row reads — the caller's rows stay as they were read.
  const rows = coachees.map((c) => ({ ...c }));
  for (const row of rows) {
    const name = coacheeDisplayName(row);
    if (!name) continue;
    if (text(row.referee_id)) { plan.alreadyLinked++; continue; }
    const candidates = spelled(name) ?? spelled(`${text(row.last_name)} ${text(row.first_name)}`) ?? byWords(name);
    if (candidates.length === 0) { report(plan.unmatched, name); continue; }
    if (candidates.length > 1) { report(plan.ambiguousNames, name); continue; }
    const sv = text(candidates[0].sv_number);
    if (!sv) { report(plan.unmatched, name); continue; }
    if (refereeLinkProblem({ sv, season: coacheeRowSeason(row.season), rowId: String(row.id) }, referees, rows)) {
      report(plan.ambiguousNames, name);
      continue;
    }
    row.referee_id = sv;
    plan.writes.push({ id: String(row.id), sv, name });
  }
  return plan;
}

/** The two whistle slots of a game record, name column beside id column. */
const REFEREE_SLOTS = [
  ['first_referee', 'first_referee_id'],
  ['second_referee', 'second_referee_id'],
] as const;

export type BackfillPlan = {
  /** The write per game — only the slot columns that gain a number. */
  patches: { id: string; patch: Record<string, string> }[];
  /** Slots, not games: filled now, already numbered, no name printed. */
  filled: number;
  already: number;
  blank: number;
  /** Printed names the register does not hold, and names it holds under
   *  two licences — as printed, distinct, capped like every other report. */
  unresolved: string[];
  ambiguous: string[];
};

/**
 * Which stored games can be given a referee's number: a blank slot whose
 * printed name the register spells under exactly one licence. `numbersFor`
 * is the register lookup (coacheeIndex.ts registerNumbers) — the same three
 * spellings the register tier reads at match time, so a slot this fills is
 * one the index already resolved that way, only now the number is written
 * down and survives a register edit or a rename. No word-subset heuristic:
 * on a game the name is VolleyManager's, spelled the way the licence is.
 * A name the register does not hold, or holds twice, is reported and never
 * guessed at — a wrong number on a game files a report against the wrong
 * person, and the name fallback cannot catch it.
 */
export function planRefereeIdBackfill(games: AnyRecord[], numbersFor: (name: string) => string[]): BackfillPlan {
  const plan: BackfillPlan = { patches: [], filled: 0, already: 0, blank: 0, unresolved: [], ambiguous: [] };
  const report = (list: string[], name: string) => {
    if (list.length < REPORT_CAP && !list.includes(name)) list.push(name);
  };
  for (const game of games) {
    const patch: Record<string, string> = {};
    for (const [nameKey, idKey] of REFEREE_SLOTS) {
      if (text(game[idKey])) { plan.already++; continue; }
      const name = text(game[nameKey]);
      if (!name) { plan.blank++; continue; }
      const numbers = numbersFor(name);
      if (numbers.length === 1) { patch[idKey] = numbers[0]; plan.filled++; }
      else report(numbers.length === 0 ? plan.unresolved : plan.ambiguous, name);
    }
    if (Object.keys(patch).length > 0) plan.patches.push({ id: String(game.id), patch });
  }
  return plan;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * `TEST-20260916-k3z9`: the day a manual game was made, in the region, and
 * four base-36 characters. The old default was the last six digits of the
 * clock, which wrap every 16.7 minutes and say nothing about when; this one
 * reads as a date in every list and has 1.7 million values per day. `pick`
 * is the caller's source of an integer in [0, max) — node's randomInt on the
 * server, a constant in a test — and the route re-rolls when a stored game
 * already carries the number.
 */
export function manualMatchNo(dayKey: string, pick: (max: number) => number): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += BASE36[pick(36) % 36];
  return `TEST-${dayKey.replace(/-/g, '')}-${suffix}`;
}
