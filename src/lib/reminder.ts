// When the unattended reminder for a game has already had its chance.
//
// The server mails the referees of every taken game at 10:00 Zürich the day
// before (REMINDER_CRON in server/index.ts). A coach who takes a game after
// that instant — tomorrow's game at lunchtime, tonight's game on the way to
// the gym — is taking one the job has already looked past: nothing will tell
// the referee a coach is coming unless the coach does it now. This is the rule
// the "take game" flow asks before it decides whether to say so.

import { dayKey, instantOf, shiftDayKey, zonedParts, type Moment } from './appTime';

/** The hour (Zürich) the daily reminder goes out — mirrors REMINDER_CRON's default. */
export const REMINDER_HOUR = 10;

/** The instant the daily job would have reminded for this game, or null for a
 *  date it cannot read. */
export function reminderDeadlineOf(gameDate: Moment): number | null {
  const eve = shiftDayKey(dayKey(gameDate), -1);
  if (!eve) return null;
  // A zone-less wall clock reads as Zürich in instantOf — which is the job's own zone.
  return instantOf(`${eve}T${String(REMINDER_HOUR).padStart(2, '0')}:00`);
}

/** True while the daily reminder for this game is behind us and the game is
 *  still ahead: the window in which taking it must carry its own mail.
 *
 *  A game already whistled is out — taking one after the fact is bookkeeping,
 *  and a "reminder" for it would be nonsense in the referee's inbox. */
export function takenAfterReminder(gameDate: Moment, now: number = Date.now()): boolean {
  const deadline = reminderDeadlineOf(gameDate);
  if (deadline === null || now < deadline) return false;
  const parts = zonedParts(gameDate);
  // A bare date has no whistle to be after: the whole day still counts as ahead.
  const kickoff = parts.timed ? instantOf(gameDate) : instantOf(`${shiftDayKey(dayKey(gameDate), 1)}T00:00`);
  return kickoff !== null && now < kickoff;
}
