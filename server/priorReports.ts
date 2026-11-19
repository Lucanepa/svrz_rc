// How much of an earlier report the NEXT coach reads (19.11.2026).
//
// The chair asked for the whole form on a second visit ("the last RC's
// information, the full form", also from the season before). Luca narrowed
// it the same day: the full earlier form only where it is still about the
// same piece of work —
//   - the earlier report asked for a further visit ("Weiterer Besuch: Ja"), or
//   - the referee is on a cohort that is followed closely (Neu-SR, Beförderung?,
//     Beförderung) and the earlier report is from this season or the last one.
// Everything else (a Varia visit three years on) gets the goals only, as
// before. The coach's own reports are always theirs in full; that is decided
// by the caller, not here.
//
// Pure on purpose: server/index.ts reads the rows and asks this.

import { isNewSrGroup, isPromotionGroup } from '../src/lib/coacheeGroup.ts';

export function fullEarlierReport(args: {
  /** The earlier report's "Weiterer Besuch" answer ('Y' | 'N' | ''). */
  secondBesuch: unknown;
  /** The season the earlier report's game was played in (start year), if known. */
  reportSeason: number | null;
  /** The groups of the coachee row the coach is observing now. */
  groups: string;
  /** The season of that row (start year). */
  season: number;
}): boolean {
  if (String(args.secondBesuch ?? '').trim().toUpperCase() === 'Y') return true;
  if (!isNewSrGroup(args.groups) && !isPromotionGroup(args.groups)) return false;
  return args.reportSeason !== null && args.reportSeason >= args.season - 1;
}
