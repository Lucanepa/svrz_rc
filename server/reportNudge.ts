// "Your report is still open" mails to the referee coach (RC) who holds a game.
//
// A game an RC took is finished business once every whistle role on it has its
// report sent (games.feedback_closed_roles) or was handed over. Until then the
// RC gets a nudge — pure rules here, the mail and the cron in index.ts.
//
// Schedule, counted from the end of the match: 24 h, 48 h, 5 days, and from
// day 7 on one every day. The job runs once a day, so a "step" is the day count
// that was last mailed for; a step is mailed at most once per game.

export const NUDGE_HOUR_MS = 60 * 60 * 1000;
export const NUDGE_DAY_MS = 24 * NUDGE_HOUR_MS;
/** A match is taken to be over this long after kick-off (two sets of waiting,
 *  a long five-setter, the walk back to the car). */
export const MATCH_LENGTH_MS = 2.5 * NUDGE_HOUR_MS;
/** Beyond this the game is a forgotten row, not a live duty: stop mailing. */
export const NUDGE_MAX_DAYS = 60;

/** The reminder step an open report has reached: 0 = none yet, 1 = 24 h,
 *  2 = 48 h, 5 = 5 days, 7 and up = that many days (daily). */
export function nudgeStep(ageMs: number, maxDays = NUDGE_MAX_DAYS): number {
  if (!Number.isFinite(ageMs) || ageMs < NUDGE_DAY_MS) return 0;
  const days = Math.floor(ageMs / NUDGE_DAY_MS);
  if (days > maxDays) return 0;
  if (days >= 7) return days;
  if (days >= 5) return 5;
  if (days >= 2) return 2;
  return 1;
}

/** The step to mail now, or 0 when nothing is due: the step reached must be
 *  newer than the last one mailed for this game. */
export function dueNudgeStep(ageMs: number, lastSent: number, maxDays = NUDGE_MAX_DAYS): number {
  const step = nudgeStep(ageMs, maxDays);
  return step > lastSent ? step : 0;
}

/** When the match is over, from its kick-off instant (ms), or NaN. */
export function matchEndedAt(kickoffMs: number): number {
  return kickoffMs + MATCH_LENGTH_MS;
}

/** "since 24 hours" wording for a step, German first and English under it. */
export function nudgeAgo(step: number): { de: string; en: string } {
  if (step <= 1) return { de: '24 Stunden', en: '24 hours' };
  if (step === 2) return { de: '48 Stunden', en: '48 hours' };
  if (step === 5) return { de: '5 Tagen', en: '5 days' };
  return { de: `${step} Tagen`, en: `${step} days` };
}
