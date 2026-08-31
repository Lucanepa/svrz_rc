import { cn } from '../lib/utils';

const CHIP = 'ml-1.5 inline-block align-middle whitespace-nowrap rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-800 border border-amber-200';

/** "This referee is one of yours." The highlight — solid amber — in a crew
 *  where somebody is NOT a coachee and the two need telling apart. */
export function CoacheeChip() {
  return <span className={cn(CHIP, 'bg-amber-100')}>Coachee</span>;
}

/** The coachee's group, wherever a referee is named: "Varia", "Beförderung?",
 *  "Neu-Schiedsrichter 26/27". It is what says why an evening is worth the
 *  drive, so it belongs on every list a game is read off — the coach's Home,
 *  the games list, the admin console — and not only in the one that had it.
 *
 *  Paler than the Coachee mark beside it: information rather than a highlight.
 *  Its own chip rather than more words inside that mark, and nowrap, because
 *  the column is a phone wide and a single long chip broke across two lines
 *  mid-badge, drawing what looked like two half-chips.
 *
 *  Pass the label [[groupLabel]] produced — this draws it, it does not
 *  translate it. Nothing is drawn for a coachee in no group.
 */
export function GroupChip({ group }: { group?: string }) {
  if (!group) return null;
  return <span className={cn(CHIP, 'bg-amber-50')}>{group}</span>;
}
