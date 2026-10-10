// Switching an observation to an earlier game (asked 2026-10-10): a coach who
// finds an EARLIER game of a coachee somebody else has already booked — most
// useful for a new referee, who should hear from a coach soon — asks the
// holder to hand the coachee over. Nothing moves until the holder accepts.
//
// The rules a request lives by, kept out of index.ts so they can be tested
// without a database. The endpoints resolve the games and bookings first.
import { samePerson, type PersonRef } from '../src/lib/identity.ts';

/** How long the holder has to answer. */
export const SWITCH_ANSWER_HOURS = 48;
/** A request closes this long before the earlier game: an answer that lands
 *  while the requester is already parking at the hall is no answer. */
export const SWITCH_CLOSE_BEFORE_KICKOFF_HOURS = 3;
/** Shorter than this left to answer, and it is not worth asking. */
export const SWITCH_MIN_WINDOW_MINUTES = 30;

const HOUR = 60 * 60 * 1000;

/** When a request made now for a game kicking off at `kickoff` lapses, or
 *  null when the window left is too short to ask at all. */
export function switchExpiry(now: string, kickoff: string): string | null {
  const n = Date.parse(now);
  const k = Date.parse(kickoff);
  if (!Number.isFinite(n) || !Number.isFinite(k)) return null;
  const end = Math.min(n + SWITCH_ANSWER_HOURS * HOUR, k - SWITCH_CLOSE_BEFORE_KICKOFF_HOURS * HOUR);
  return end - n >= SWITCH_MIN_WINDOW_MINUTES * 60 * 1000 ? new Date(end).toISOString() : null;
}

/** A coachee on the wanted game, and their open booking elsewhere if any. */
export type SlotBooking = {
  coacheeId: string;
  name: string;
  booking: null | { gameId: string; matchNo: string; date: string; rc: string; rcId: string };
};

/** Flat on purpose: tsconfig runs without `strict`, so a union tagged by a
 *  boolean does not narrow. `reason` is '' exactly when `ok`.
 *  no-coachee: nobody on the game to observe. free: a coachee on it has no
 *  booking — the game can simply be taken. own: every booking is the asker's
 *  own (give it back instead). not-earlier: the game is not before the booked
 *  one, so a switch would not bring the observation forward. */
export type SwitchPick = {
  ok: boolean;
  reason: '' | 'no-coachee' | 'free' | 'own' | 'not-earlier';
  coacheeId: string;
  name: string;
  booking: SlotBooking['booking'];
};

/** Which coachee a request for this game is about: one whose booking is by
 *  another coach, on a LATER game. The first such slot — one handover is
 *  enough, since a game with one unbooked coachee on it can be taken. */
export function pickSwitch(o: { gameDate: string; slots: SlotBooking[]; requester: PersonRef; knownIds?: Set<string> }): SwitchPick {
  const no = (reason: SwitchPick['reason']): SwitchPick => ({ ok: false, reason, coacheeId: '', name: '', booking: null });
  if (o.slots.length === 0) return no('no-coachee');
  if (o.slots.some((s) => !s.booking)) return no('free');
  const at = Date.parse(o.gameDate);
  const others = o.slots.filter((s) => !samePerson({ id: s.booking!.rcId, name: s.booking!.rc }, o.requester, o.knownIds));
  if (others.length === 0) return no('own');
  const later = others.find((s) => Date.parse(s.booking!.date) > at);
  if (!later) return no('not-earlier');
  return { ok: true, reason: '', coacheeId: later.coacheeId, name: later.name, booking: later.booking };
}

export type SwitchStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';

/** Still waiting for an answer: pending and not past its expiry. */
export function switchOpen(r: { status: string; expires_at: string }, now: string): boolean {
  return r.status === 'pending' && Date.parse(r.expires_at) > Date.parse(now);
}

/** What accepting does to the holder's later game: released when the
 *  handed-over coachee was the only one left to observe there, kept (for
 *  the other coachee) with this one marked handed over otherwise. */
export function switchSettlement(otherOpenCoachees: number): 'release' | 'hand-over' {
  return otherOpenCoachees > 0 ? 'hand-over' : 'release';
}

/** One coachee handed over from a held game to an earlier one. Stored on the
 *  later game (games.handed_over), so the holder keeps the game for the
 *  other coachee without that coachee's role counting as a second booking. */
export type HandOver = { coacheeId: string; toGameId: string; toRc: string; toRcId: string; at: string; requestId: string };

/** The coachee row ids a game has handed over, from its stored column. */
export function handedOverIds(game: Record<string, unknown>): Set<string> {
  const raw = game.handed_over;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((h) => String((h as HandOver)?.coacheeId ?? '')).filter(Boolean));
}
