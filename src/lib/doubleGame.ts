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
