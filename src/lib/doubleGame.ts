// A double game: one coach, two games, one Zürich day — one trip.
//
// "One open booking per coachee" (2026-09-30) was written against two coaches
// planning the same referee. It also caught the opposite case, which is a plan
// and not a duplicate: a coach who drives to one hall for the afternoon and
// watches the same referee twice, once as 1. SR at 14:00 and once as 2. SR at
// 17:00 (Alexandra, Adliswil, 21.11.2026). The board flagged that as a double
// booking and the take guard would have refused the second game. Asked
// 2026-10-07: the same coach on the same day is one visit.
//
// Both halves come from the rules already in force: the coach by
// `samePerson` (the id decides, the folded name only for a row without one —
// see identity.ts), the day by the Zürich calendar (`dayKey`), never the UTC
// slice of the ISO string. Shared by the planning board (server/planning.ts),
// the take guard (server/index.ts) and the greyed take button (App.tsx), so
// none of the three can disagree about what a double game is.

import { dayKey } from './appTime';
import { samePerson, type PersonRef } from './identity';

export type HeldGameRef = { rc: PersonRef; date: string };

/** Are these two held games one visit — the same coach, the same Zürich day? */
export function sameVisit(a: HeldGameRef, b: HeldGameRef, knownIds?: Set<string>): boolean {
  const day = dayKey(a.date);
  return day !== '' && day === dayKey(b.date) && samePerson(a.rc, b.rc, knownIds);
}

/** How many separate visits a coachee's open bookings make. Two bookings
 *  that are one double game count once; it takes a second coach, or a second
 *  day, to make a double booking. */
export function visitCount(bookings: HeldGameRef[], knownIds?: Set<string>): number {
  const visits: HeldGameRef[] = [];
  for (const b of bookings) {
    if (!visits.some((v) => sameVisit(v, b, knownIds))) visits.push(b);
  }
  return visits.length;
}

/**
 * The coachees a coach already watches on the Zürich day of `date`: every
 * coachee on a game they hold that day. A game that day adds no trip for
 * them, so none of their bookings — not this game's twin, nor one on another
 * day — rules it out (asked 2026-10-14: Luca held 16:00 with both referees,
 * took the same pair at 13:30 in that hall, and the guard still counted the
 * pair's bookings on 20.10 and 26.11 against it). The take guard and the
 * take button both ask this, so they cannot disagree about the trip.
 */
export function tripCoachees(
  held: Array<HeldGameRef & { coacheeIds: string[] }>,
  me: PersonRef,
  date: string,
  knownIds?: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const g of held) {
    if (!sameVisit(g, { rc: me, date }, knownIds)) continue;
    for (const id of g.coacheeIds) if (id) out.add(id);
  }
  return out;
}
