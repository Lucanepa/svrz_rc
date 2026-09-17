import type { ReactNode } from 'react';
import { Star, Target } from 'lucide-react';
import { cn } from '../lib/utils';
import { isSetComplete, parseResult } from '../lib/matchResult';
import { ChipLine, MarkRow, MetaChip } from './GameRow';
import { CoacheeChip, GroupChip } from './CoacheeChips';
import { BoerseChip } from './BoerseNote';

/**
 * What a game IS, drawn the same way on every list that names one.
 *
 * The marks — RC-Spiel, LD, Testspiel, Gewünscht — reach the client on four
 * shapes (the open games list, the coach's own Home summary, the SR-Spiele,
 * the calendar) and were drawn by four copies of the same chips, each a
 * little behind the others: a taken RC-Spiel wore its chip on the Games tab
 * and none on Home, an LD game wore it under a coachee's row and none on the
 * page one tap further. One component, one set of words, one tooltip each;
 * a list that adds a chip adds it here and every list has it.
 */

type Lang = 'DE' | 'EN';

/** This project has no `@types/react`, so a component rendered from `.map`
 *  declares `key` itself (see GameRow.tsx). React strips it before the
 *  component sees it. */
type Keyed = { key?: string | number };

/** The marks every game projection carries. All optional: an older API, or a
 *  list cached before a mark existed, answers without it. */
export type GameMarks = {
  isLdGame?: boolean;
  isRcGame?: boolean;
  isManual?: boolean;
  starred?: boolean;
  isRdGame?: boolean;
  vmFlagged?: boolean;
};

// Why a game carries the star: VolleyManager's RD mark, its RSV mark, or an
// admin's own hand. All three land in the one "Flagged" filter and the one
// amber chip — the RD mark used to get a filter and a chip of its own next to
// them, saying the same thing twice — so the tooltip is where the source lives.
export function starredTitle(game: { isRdGame?: boolean; vmFlagged?: boolean }, de: boolean): string {
  if (game.isRdGame) return de ? 'Im VolleyManager als RD-Spiel markiert' : 'Marked as an RD game in VolleyManager';
  if (game.vmFlagged) return de ? 'Im VolleyManager mit RSV-Markierung versehen' : 'RSV-marked in VolleyManager';
  return de ? 'Für eine Beobachtung vorgemerkt' : 'Flagged for observation';
}

/** The row's flag chips, in the one order: what the game is (LD, RC-Spiel,
 *  Testspiel), then whether somebody asked for it (Gewünscht), then — on a
 *  list about one coachee — whether it lies in their focus.
 *
 *  `omitStar` is for the console's Games tab, where the star is a button
 *  the admin presses; a chip beside it would say the same thing twice. */
export function GameFlagChips({ game, lang, focus, omitStar }: {
  game: GameMarks; lang: Lang; focus?: boolean; omitStar?: boolean;
}) {
  const de = lang === 'DE';
  return (
    <>
      {game.isLdGame && <MetaChip tone="dark">{de ? 'LD Spiel' : 'LD Game'}</MetaChip>}
      {game.isRcGame && (
        <MetaChip tone="sky" title={de ? 'Ein Referee Coach pfeift hier neben einem Coachee.' : 'A referee coach is whistling next to a coachee here.'}>
          {de ? 'RC-Spiel' : 'RC Game'}
        </MetaChip>
      )}
      {game.isManual && (
        <MetaChip tone="violet" title={de ? 'Von Hand angelegt — kein Spiel aus VolleyManager.' : 'Created by hand — not a VolleyManager fixture.'}>
          {de ? 'Testspiel' : 'Test game'}
        </MetaChip>
      )}
      {game.starred && !omitStar && (
        <MetaChip tone="amber" title={starredTitle(game, de)}>
          <Star size={10} className="fill-amber-500 text-amber-500" />{de ? 'Gewünscht' : 'Priority'}
        </MetaChip>
      )}
      {focus && (
        <MetaChip tone="emerald" title={de ? 'Liegt im Fokus dieses Coachees (Niveau-Tabelle).' : "In this coachee's focus (level table)."}>
          <Target size={10} />{de ? 'Fokus' : 'Focus'}
        </MetaChip>
      )}
    </>
  );
}

/** "This role has already been observed on this game" — the mark for a slot
 *  whose role is in `feedbackClosedRoles`. The field gated the form and the
 *  covered-referee filter for a year and was drawn nowhere, so a game
 *  already filed for the 1. SR looked as open as one nobody had watched. */
export function ObservedChip({ lang }: { lang: Lang }) {
  return (
    <span
      className="ml-1.5 inline-block align-middle whitespace-nowrap rounded border border-emerald-200 bg-emerald-50 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-800"
      title={lang === 'DE'
        ? 'Für diese Rolle wurde auf diesem Spiel bereits ein Feedback erfasst.'
        : 'A feedback has already been filed for this role on this game.'}
    >
      {lang === 'DE' ? 'beobachtet' : 'observed'}
    </span>
  );
}

/** Which of a game's roles are closed, off the field every projection
 *  carries. `role` is '1. SR' / '2. SR'. */
export function roleObserved(game: { feedbackClosedRoles?: string[] }, role: string): boolean {
  return Array.isArray(game.feedbackClosedRoles) && game.feedbackClosedRoles.includes(role);
}

/** One referee of a game: the slot, the name, and the marks under it —
 *  Coachee (with the Niveau), the group, In Börse, beobachtet, plus whatever
 *  the calling list adds (`marks`: the console's "nur Name", say).
 *
 *  A row listing only coachees could not say whether the other slot was
 *  empty or held by somebody the coach does not follow, and those are
 *  different situations at the hall; so every referee is a chip, and every
 *  coachee is marked, also when both referees are — a grey chip reads as
 *  "not a coachee", and a coach should not have to know the rule to read the
 *  row. The group — "Varia", "Beförderung?" — is what says why the evening
 *  is worth driving to, so it rides along on every coachee's chip.
 *
 *  Slot and name sit in ONE inline box with a real space between them: as
 *  two flex items they ran together into "2SRSven Fremd" in the
 *  accessibility tree, the gap drawn and not spoken. Each chip takes a line
 *  of its own (ChipLine), so the referees of one game read as a column. */
export function CrewChip({ role, name, lang, coachee, level, group, offered, observed, marks }: {
  /** '1. SR' | '2. SR' | '' — printed short, "1SR". */
  role: string;
  name: string;
  lang: Lang;
  coachee: boolean;
  /** The coachee's Niveau, "N3-2" — printed inside the Coachee mark. */
  level?: string;
  /** The group label, already translated (groupLabel). */
  group?: string;
  /** The slot is in the SR-Börse. */
  offered?: boolean;
  /** The role is already closed on the game (feedbackClosedRoles). */
  observed?: boolean;
  /** List-specific marks, drawn after the shared ones. */
  marks?: ReactNode;
} & Keyed) {
  const de = lang === 'DE';
  const short = role.startsWith('2') ? '2SR' : role.startsWith('1') ? '1SR' : '';
  // `marked` opens the MarkRow: a coachee, a group, a slot in the börse —
  // the warning needs a row to sit in even when the name carries no other
  // mark.
  const marked = coachee || !!group || !!offered || !!observed || !!marks;
  return (
    <ChipLine>
      <MetaChip
        wrap
        stack={marked}
        tone={offered ? 'boerse' : (coachee ? 'amber' : 'stone')}
        title={offered ? (de ? 'Dieser Einsatz steht in der SR-Börse' : 'This slot is in the SR-Börse') : undefined}
      >
        <span>
          {short && <span className="font-bold opacity-70">{short}&nbsp;</span>}
          {offered && <span aria-hidden>⚠&nbsp;</span>}
          {name}
        </span>
        {marked && (
          <MarkRow>
            {offered && <BoerseChip lang={lang} />}
            {coachee && <CoacheeChip level={level} />}
            <GroupChip group={group} />
            {observed && <ObservedChip lang={lang} />}
            {marks}
          </MarkRow>
        )}
      </MetaChip>
    </ChipLine>
  );
}

/**
 * The score of a played game, compact: "3:1" and the set scores after it.
 *
 * Renders nothing when there is no result yet, so callers can drop it into a
 * row unconditionally: most planned games have no score, and a row that
 * silently stays as it was is the point.
 */
export function MatchResult({ result, className }: { result?: string; className?: string }) {
  const parsed = result ? parseResult(result) : null;
  if (!parsed || (parsed.home === '' && parsed.away === '')) return null;
  // Only completed sets: a half-entered "25:" is a score nobody can read.
  const sets = parsed.sets.filter(isSetComplete).map((s) => `${s.h}:${s.a}`);
  return (
    <span className={cn('inline-flex items-baseline gap-2 tabular-nums whitespace-nowrap', className)}>
      <span className="text-sm font-bold text-stone-600">{parsed.home}:{parsed.away}</span>
      {sets.length > 0 && <span className="text-[11px] text-stone-400">{sets.join(' | ')}</span>}
    </span>
  );
}
