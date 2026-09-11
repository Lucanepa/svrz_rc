import type { ReactNode } from 'react';
import { MapPin } from 'lucide-react';
import { cn } from '../lib/utils';
import { zonedParts, weekdayLabel, dayLabel, timeLabel } from '../lib/appTime';

/**
 * The pieces every list of games is drawn from.
 *
 * Home, the Games tab and a coachee's own page each grew their own row, and the
 * three disagreed about everything a reader uses to scan: where the date sits,
 * whether the time is shown at all, whether the league is a word or a chip,
 * whether the two teams are labelled. Same game, same reader, three answers.
 * They are one vocabulary now — a rail on the left that always answers "when,
 * and what level", the two teams as the body, and chips for whatever a
 * particular list adds.
 *
 * Everything here is deliberately width-agnostic: the rail and the type step up
 * one notch from `sm` and stop. The app is read on a phone in a hall and on a
 * laptop at a kitchen table, and a layout that only worked on one of those is
 * how the three rows came about in the first place.
 */

/** Tone of a list — carried by the rail and the date, never by a filled box.
 *  `red` is the coach's own upcoming work, `amber` something outstanding,
 *  `sky` an SR-Spiel, `emerald` something already filed, `stone` neutral. */
export type RowTone = 'red' | 'amber' | 'sky' | 'emerald' | 'stone';

/** This project has no `@types/react`, so JSX never contributes the implicit
 *  `key` to a component's props and TypeScript rejects it on anything with a
 *  declared signature. The components below are rendered from `.map`, so they
 *  declare it themselves. React strips it before the component ever sees it. */
type Keyed = { key?: string | number };

const TONE_TEXT: Record<RowTone, string> = {
  red: 'text-red-600',
  amber: 'text-amber-700',
  sky: 'text-sky-700',
  emerald: 'text-emerald-600',
  stone: 'text-stone-700',
};

const TONE_RAIL: Record<RowTone, string> = {
  red: 'bg-red-400',
  amber: 'bg-amber-400',
  sky: 'bg-sky-500',
  emerald: 'bg-emerald-400',
  stone: 'bg-stone-200',
};

/**
 * ♂ and ♀, drawn instead of typed.
 *
 * Inter ships as unicode-range subsets and none of them covers U+2640/U+2642,
 * so the character was never set in Inter at all — the browser fell back to the
 * system font and brought that font's baseline and em-box with it. It sat below
 * the line beside its own digits, and no amount of `leading-none` can move a
 * glyph whose own font has already placed it. An inline SVG is measured in `em`
 * like every other icon in the app, so it sits where the icons sit, and it
 * carries a label a screen reader can read out — "♂" alone was silence.
 */
export function GenderMark({ mark, label }: { mark: '♂' | '♀'; label?: string }) {
  const common = {
    className: cn('inline-block h-[1em] w-[1em] align-[-0.125em]', mark === '♂' ? 'text-red-500' : 'text-pink-500'),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: 'img' as const,
    'aria-label': label ?? (mark === '♂' ? 'Herren' : 'Damen'),
  };
  return mark === '♂' ? (
    <svg {...common}>
      <circle cx="10" cy="14.5" r="5.5" />
      <path d="M14.2 10.6 20 4.8" />
      <path d="M14.6 4.4H20.4V10.2" />
    </svg>
  ) : (
    <svg {...common}>
      <circle cx="12" cy="8" r="6" />
      <path d="M12 14v7.5" />
      <path d="M8.3 18.4h7.4" />
    </svg>
  );
}

/** A league as VolleyManager writes it — "3L ♂ A" — with the gender mark drawn. */
export function LeagueLabel({ text }: { text: string }) {
  const parts = text.split(/(♂|♀)/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part === '♂' || part === '♀'
          ? <span key={i}><GenderMark mark={part} /></span>
          : <span key={i}>{part}</span>,
      )}
    </>
  );
}

/** Weekday, date, throw-in time and league — the four things that decide
 *  whether an evening is free, stacked in the order they are asked in.
 *
 *  The league belongs here rather than in the body: it is not something about
 *  the fixture you read after the teams, it is part of deciding whether the
 *  fixture is worth the drive at all, and in the body it competed with the
 *  names. The time was missing from three of the five lists entirely, which
 *  left "Di 02.02." to be looked up somewhere else before anything could be
 *  planned around it. */
export function DateRail({
  iso, tone = 'stone', league, matchNo, lang, className,
}: { iso: string; tone?: RowTone; league?: string; matchNo?: string; lang: 'DE' | 'EN'; className?: string }) {
  // Zürich, always — the fixture starts when it starts in the gym, whatever the
  // reader's device thinks the time is. See src/lib/appTime.ts.
  const parts = zonedParts(iso);
  const valid = parts.valid;
  const weekday = weekdayLabel(iso, lang);
  // Swiss dot format, day first, and never the browser's idea of it: en-GB and
  // en-US disagree about which number comes first and one of them is wrong on
  // every row.
  const date = valid ? dayLabel(iso) : (iso || '–');
  // Only when the fixture actually carries one: a bare "2026-11-09" has no
  // clock in it at all, and inventing one ("01:00", from a UTC midnight read in
  // the local zone) is worse than showing none.
  const time = timeLabel(iso);
  return (
    <div className={cn('w-14 shrink-0 text-right leading-tight sm:w-[4.5rem]', className)}>
      {weekday && (
        <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{weekday}</div>
      )}
      <div className={cn('text-sm font-bold tabular-nums tracking-tight sm:text-[15px]', TONE_TEXT[tone])}>{date}</div>
      {time && <div className="text-[11px] tabular-nums text-stone-500">{time}</div>}
      {league && (
        <div className="mt-0.5 text-[10.5px] font-medium leading-snug text-stone-500 sm:text-[11px]">
          <LeagueLabel text={league} />
        </div>
      )}
      {/* The match number lives here, not as the first chip beside the
          referees: there it was a short chip that a short referee chip
          wrapped next to, so the two referees of one game sat on different
          lines at different indents. In the rail it is with the other facts
          that identify the fixture, and the crew stacks cleanly. */}
      {matchNo && (
        <div className="mt-0.5 text-[10px] tabular-nums leading-snug text-stone-400">#{matchNo}</div>
      )}
    </div>
  );
}

/** The coloured hairline between the rail and the body. It is what tells the
 *  open rows from the settled ones inside one list, which is the whole job the
 *  old filled-and-rounded card was doing — at the cost of framing every row in
 *  the app so that none of them stood out. */
export function RowRail({ tone = 'stone' }: { tone?: RowTone }) {
  return <div className={cn('w-[2px] shrink-0 self-stretch rounded-full', TONE_RAIL[tone])} aria-hidden />;
}

/** Home over away, in that order, with no "H:"/"A:" and no rule between them.
 *
 *  The order already says who is at home; the labels and the hairline cost
 *  three line-heights on every row of every list to repeat it. Home stays
 *  semibold and away sits one step quieter underneath — the same distinction,
 *  drawn rather than captioned.
 *
 *  A string that does not split on the API's " vs " separator is left whole
 *  rather than guessed at. */
export function TeamPair({
  teams, home, away, homeAside, awayAside, className,
}: {
  teams?: string; home?: string; away?: string;
  /** Drawn at the end of that team's own line — its set points and its score.
   *  As one shared line under both names the numbers sat away from the team
   *  they belong to and had to be decoded before they said anything. */
  homeAside?: ReactNode; awayAside?: ReactNode;
  className?: string;
}) {
  let h = home;
  let a = away;
  if (h === undefined && a === undefined && teams !== undefined) {
    const parts = teams.split(' vs ');
    if (parts.length !== 2) {
      return <p className={cn('text-sm font-medium break-words text-stone-800', className)}>{teams}</p>;
    }
    [h, a] = parts;
  }
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">{h}</p>
        {homeAside}
      </div>
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-sm leading-snug break-words text-stone-600 sm:text-[15px]">{a}</p>
        {awayAside}
      </div>
    </div>
  );
}

const CHIP_TONE = {
  stone: 'bg-stone-50 border-stone-200 text-stone-600',
  me: 'bg-red-50 border-red-200 text-red-700',
  // A referee whose slot is in the SR-Börse. Its own tone rather than `me`,
  // which is also red but means "this is you" — the two appear on the same row
  // and must not read as the same fact.
  boerse: 'bg-red-50 border-red-300 font-semibold text-red-800',
  sky: 'bg-sky-50 border-sky-200 text-sky-800',
  amber: 'bg-amber-50 border-amber-300 text-amber-800',
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  dark: 'bg-stone-900 border-stone-900 text-white',
  violet: 'bg-violet-50 border-violet-300 text-violet-800',
  ghost: 'bg-transparent border-transparent text-stone-500 px-0',
} as const;

export type ChipTone = keyof typeof CHIP_TONE;

/** One fact about a game, sized so a row of them wraps as blocks instead of
 *  breaking a name in half. The old single meta line — "3L ♂ B · du 1. SR ·
 *  Livio Lustenberger 2. SR" — wrapped mid-name on a phone and put "SR" alone
 *  on the next line. */
export function MetaChip({
  tone = 'stone', title, wrap, stack, className, children,
}: { tone?: ChipTone; title?: string; wrap?: boolean; stack?: boolean; className?: string; children: ReactNode } & Keyed) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-[3px] text-[10.5px] font-semibold leading-none sm:text-[11px]',
        // A chip carrying a person's name must wrap. "Kevin León Peña de los
        // Santos" is wider than a phone on its own, and a nowrap chip would
        // push the whole row sideways rather than take a second line.
        wrap && 'whitespace-normal text-left leading-tight',
        // A chip whose children are lines, not words: the name on the first,
        // its marks (Coachee, the group) on the next. Side by side, a group
        // label pushed "Jérôme Philip Bagdasarianz" onto two lines while it
        // sat whole on the right; under the name, both stay whole.
        stack && 'flex-col items-start gap-1',
        CHIP_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The marks under a name in a stacked chip — Coachee, the group — on one
 *  line of their own. The marks carry a left margin for sitting after text
 *  inline; at the start of a line that margin is an indent, so it goes. */
export function MarkRow({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap gap-1 [&>*]:ml-0">{children}</span>;
}

/** A chip that takes a whole line of the chips row to itself, at its own
 *  width. The referees of one game read as a column — 1. SR over 2. SR, at one
 *  indent — and never side by side when both names happen to be short. */
export function ChipLine({ children }: { children: ReactNode } & Keyed) {
  return <span className="flex basis-full">{children}</span>;
}

/** A list's heading: a name on a rule, with its count on the right.
 *
 *  Sections used to be rounded, filled, bordered cards, and a row inside one was
 *  a rounded, filled, bordered card again. When everything is emphasised nothing
 *  is, and the one block that genuinely wanted an answer looked like the four
 *  that did not. */
export function SectionHead({
  icon, title, count, tone = 'stone', hint, action, className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: ReactNode;
  tone?: RowTone;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5', className)}>
      <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-800">
        {icon && <span className={cn('flex items-center', TONE_TEXT[tone])}>{icon}</span>}
        {title}
        {hint}
      </h3>
      <span className="flex shrink-0 items-center gap-2">
        {count !== undefined && count !== null && (
          <span className="text-[11px] font-semibold tabular-nums text-stone-500">{count}</span>
        )}
        {action}
      </span>
    </div>
  );
}

/** The container every list of games sits in. It owns the hairlines between
 *  rows, so a row never draws its own border and two lists can never disagree
 *  about the gap between them. */
export function GameList({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('divide-y divide-stone-200', className)}>{children}</div>;
}

export type GameRowProps = Keyed & {
  lang: 'DE' | 'EN';
  /** Which list this is — colours the date and the rail, nothing else. */
  tone?: RowTone;
  /** ISO timestamp of the throw-in. */
  date: string;
  /** "3L ♂ A", drawn under the time. */
  league?: string;
  /** VolleyManager's match number, drawn in the rail under the league. */
  matchNo?: string;
  /** Either the API's "Home vs Away" string, or the two names separately. */
  teams?: string;
  home?: string;
  away?: string;
  /** Drawn at the end of each team's own line — set points, score. */
  homeAside?: ReactNode;
  awayAside?: ReactNode;
  /** Chips under the teams — match number, roles, flags, the coachee. */
  chips?: ReactNode;
  /** The hall. Rendered as a map link, and kept OUT of the clickable region's
   *  markup contract: the row is a div with role=button precisely so this
   *  anchor is legal inside it. */
  location?: string;
  mapsUrl?: string;
  /** Anything else this particular list adds — the crew, a note preview, a
   *  warning, a result. Drawn under the chips. */
  children?: ReactNode;
  /** Top-right of the row: a chevron, a badge, a status dot. Not a control. */
  status?: ReactNode;
  /** A real control belonging to this row — "Rückmeldung", "Spiel übernehmen".
   *  Beside the row from `sm` up, and a full-width button under it on a phone,
   *  where there is no room beside anything. Always a sibling of the clickable
   *  region, never a child: a button inside a button is invalid markup. */
  action?: ReactNode;
  /** The row's own toolbar — open, reminder, give back — as labelled buttons on
   *  a line of their own under the game, at every width. As an icon column
   *  pinned to the right edge they took a fifth of a phone's width, so team
   *  names wrapped and a long coachee chip ran under the first icon; and
   *  three bare icons in a column still had to be guessed at. Same sibling
   *  rule as `action`. */
  tools?: ReactNode;
  /** Makes the row itself open something. Without it the row is inert text. */
  onOpen?: () => void;
  title?: string;
  /** Forwarded to the clickable region — the click logger reads it. */
  logRedact?: boolean;
  className?: string;
};

/**
 * One game, drawn the same way in every list in the app.
 *
 * Home, the Games tab, a coachee's page and the SR-Spiele block each used to
 * draw their own; changing "how a game looks" meant finding all of them and
 * getting all of them to agree. It is one component now — a list adds what is
 * particular to it through `chips`, `children`, `status` and `action`, and
 * everything else is settled here, once.
 */
export function GameRow({
  lang, tone = 'stone', date, league, matchNo, teams, home, away, homeAside, awayAside,
  chips, location, mapsUrl, children, status, action, tools, onOpen, title,
  logRedact, className,
}: GameRowProps) {
  const body = (
    <>
      <DateRail iso={date} tone={tone} league={league} matchNo={matchNo} lang={lang} />
      <RowRail tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <TeamPair teams={teams} home={home} away={away} homeAside={homeAside} awayAside={awayAside} className="flex-1" />
          {status && <span className="mt-0.5 flex shrink-0 items-center gap-1.5">{status}</span>}
        </div>
        {chips && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div>}
        {location && (
          <p className="mt-1 flex items-start gap-1.5 text-xs">
            <MapPin size={12} className="mt-0.5 shrink-0 text-red-400" />
            <a
              href={mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="break-words text-red-500 underline decoration-red-300 transition-colors hover:text-red-700 hover:decoration-red-500"
            >
              {location}
            </a>
          </p>
        )}
        {children}
      </div>
    </>
  );

  const interactive = 'cursor-pointer rounded-md transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60';

  return (
    // One flex line that is allowed to wrap, rather than two copies of the row.
    // `action` is drawn ONCE: it takes a full basis on a phone, so it falls to
    // its own line under the game, and an auto basis from `sm`, so it sits
    // beside it. Drawing it twice and hiding one with `sm:hidden` put two of
    // every button in the document — which is two of them for a screen reader
    // and for anything looking a control up by its name.
    <div className={cn('flex flex-wrap items-stretch py-0.5', className)}>
      {onOpen ? (
        // A div with role=button rather than a <button>: the hall inside is an
        // anchor and the row may carry its own controls, and neither is legal
        // inside a button. A key pressed ON a child is left to that child.
        <div
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
          }}
          title={title}
          data-log-redact={logRedact ? '' : undefined}
          className={cn('flex min-w-0 flex-1 basis-0 items-stretch gap-2.5 px-1.5 py-2.5 text-left sm:gap-3 sm:px-2', interactive)}
        >
          {body}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 basis-0 items-stretch gap-2.5 px-1.5 py-2.5 sm:gap-3 sm:px-2">{body}</div>
      )}
      {tools && (
        // Full width on a phone, where three labelled buttons need every
        // pixel between the gutters; indented to the body's left edge from
        // `sm`, where they sit under the teams as the row's own toolbar.
        <div className="flex basis-full items-center gap-1.5 px-1.5 pb-2.5 sm:gap-2 sm:pl-[6.625rem] sm:pr-2">
          {tools}
        </div>
      )}
      {action && (
        <div className="flex basis-full items-center pb-2 pl-[4.25rem] pr-1.5 sm:basis-auto sm:pb-0 sm:pl-2 sm:pr-2">
          {action}
        </div>
      )}
    </div>
  );
}
