import { cn } from '../lib/utils';

/**
 * The SR-Börse marks: a sign beside a referee's name, and a line under the row
 * saying what the colour means.
 *
 * Colour is never the only carrier here. The row wash and ring say "look", the
 * flag says why in words, and the per-name chip says who — because the app
 * already has two places where a colour is the whole signal, and this is the one
 * feature where missing it costs somebody an evening in the wrong hall.
 */

export type BoerseOnGame = {
  level: string;        // 'red' | 'amber' | 'blue' | 'none'
  reason: string;
  markedSlots: string[]; // '1' | '2'
  asOf: string;
};

/** The row's wash + 1px ring.
 *
 *  This EXTENDS the app's single existing glow (an SR-Spiel that still owes its
 *  note) rather than standing a second one beside it. The comment there —
 *  "nothing else on the home screen glows, which is the whole reason this can" —
 *  stays true: only one kind of thing glows, something that wants attention.
 *
 *  Deliberately not the row TONE: date and rail already carry which list the row
 *  belongs to, and a second meaning on that channel would be unreadable. */
export function boerseRowClass(boerse?: BoerseOnGame): string {
  switch (boerse?.level) {
    case 'red':   return 'rounded-md bg-red-50/70 shadow-[0_0_0_1px_rgb(252_165_165)]';
    case 'amber': return 'rounded-md bg-amber-50/70 shadow-[0_0_0_1px_rgb(252_211_77)]';
    case 'blue':  return 'rounded-md bg-sky-50/70 shadow-[0_0_0_1px_rgb(125_211_252)]';
    default:      return '';
  }
}

/** Does this referee's slot sit in the börse? `role` is "1. SR" / "2. SR". */
export function inBoerse(boerse: BoerseOnGame | undefined, role: string | undefined): boolean {
  if (!boerse?.markedSlots?.length || !role) return false;
  const slot = role.startsWith('2') ? '2' : role.startsWith('1') ? '1' : '';
  return slot ? boerse.markedSlots.includes(slot) : false;
}

/** The mark that rides inside a referee's chip, beside Coachee and the group. */
export function BoerseChip({ lang }: { lang: 'DE' | 'EN' }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 text-[10px] font-bold uppercase tracking-wide text-red-800">
      <span aria-hidden>⚠</span>
      {lang === 'DE' ? 'In Börse' : 'In Börse'}
    </span>
  );
}

const NOTE: Record<string, { de: string; en: string }> = {
  'only-coachee-offered':   { de: 'Coachee-Einsatz in der Börse',   en: "Coachee's slot is in the Börse" },
  'both-coachees-offered':  { de: 'Beide Coachees in der Börse',    en: 'Both coachees are in the Börse' },
  'one-of-mine-remains':    { de: '1 von 2 Coachees in der Börse',  en: '1 of 2 coachees in the Börse' },
  'rc-game-coachee-offered':{ de: 'Coachee-Einsatz in der Börse',   en: "Coachee's slot is in the Börse" },
  'my-own-slot-offered':    { de: 'Dein Einsatz steht in der Börse', en: 'Your own slot is in the Börse' },
};

const FLAG: Record<string, string> = {
  red:   'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-900',
  blue:  'bg-sky-100 text-sky-900',
};

/**
 * The line under the row. Says in words what the colour means, so the colour is
 * an emphasis and never the message.
 *
 * Renders nothing at level 'none' — including when a non-coachee is in the
 * börse, which marks their name and changes nothing else.
 */
export function BoerseNote({ boerse, lang }: { boerse?: BoerseOnGame; lang: 'DE' | 'EN' }) {
  if (!boerse || boerse.level === 'none') return null;
  const words = NOTE[boerse.reason];
  if (!words) return null;
  return (
    <span className={cn('mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-snug', FLAG[boerse.level])}>
      {lang === 'DE' ? words.de : words.en}
    </span>
  );
}

/**
 * How old each upstream's data is, for a list head.
 *
 * BOTH clocks, because they fail independently and the row on screen depends on
 * each: the nightly games sync decides who is on a game at all, the hourly börse
 * poll decides whether they are trying to leave it. A fresh börse over a
 * week-old crew is a confident answer about the wrong referees.
 *
 * Each reads LAST SUCCESS, never the last attempt — a sync that has been failing
 * for a week still stamps an attempt every night, so a line built on that can
 * never fire in the failure it exists to catch.
 *
 * An absent or old stamp says so plainly, because "no warnings" and "no data"
 * must not look the same. That is not hypothetical here: three VolleyManager
 * roles answer the börse 200 with the wrong row count, one of them zero.
 */
function age(iso: string | undefined, lang: 'DE' | 'EN'): { text: string; mins: number } | null {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 60) return { text: lang === 'DE' ? `${mins} Min.` : `${mins} min`, mins };
  const hours = Math.round(mins / 60);
  if (hours < 36) return { text: `${hours} h`, mins };
  return { text: lang === 'DE' ? `${Math.round(hours / 24)} Tagen` : `${Math.round(hours / 24)} d`, mins };
}

export function SyncFreshness({ games, boerse, lang }: { games?: string; boerse?: string; lang: 'DE' | 'EN' }) {
  const de = lang === 'DE';
  const g = age(games, lang);
  const b = age(boerse, lang);
  // Each has its own patience. The games sync runs nightly, so a day is normal
  // and two is not; the börse runs hourly, so three hours already means several
  // missed runs.
  const gStale = !g || g.mins > 36 * 60;
  const bStale = !b || b.mins > 180;
  const part = (label: string, a: { text: string } | null, stale: boolean) => (
    <span className={cn('inline-flex items-center gap-1', stale ? 'font-semibold text-amber-700' : 'text-stone-400')}>
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-amber-500' : 'bg-green-600')} />
      {a ? `${label} ${de ? 'vor' : ''} ${a.text}${de ? '' : ' ago'}`.replace(/\s+/g, ' ').trim() : `${label} —`}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px]">
      {part(de ? 'Spiele' : 'Games', g, gStale)}
      {part(de ? 'Börse' : 'Börse', b, bStale)}
    </span>
  );
}
