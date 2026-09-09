// Every clock in this app is a Swiss one.
//
// A fixture starts at 20:45 in a gym in Zürich. That is true for the coach
// reading the list on the tram, for the one reading it from Greece, and for the
// PDF filed afterwards — so the app must never render a match through the
// device's own timezone. It did: `DateRail` and the form's date field used
// `getHours()`/`getDate()`, which in EEST turned every kick-off into 21:45 and
// would have pushed a late Saturday game onto Sunday. That wrong time was then
// carried into `meta.datum`, and from there into the filed report and the mail.
//
// The server already had this rule (`zonedParts` in server/index.ts, for the
// mail templates, because the container runs UTC). This is the same rule for
// the browser, and the reason both exist is the same: the reader's clock is not
// the fixture's clock.
//
// The stored value arrives in three shapes — the same three `icalMoment` knows:
//   • "2026-09-21 18:45:00.000Z" / ISO with an offset — a real instant,
//     converted into Zürich wall time;
//   • "2026-09-21T20:45" / "2026-09-21 20:45:00" — no zone, so it already IS
//     the wall time and is taken digit for digit (converting it would be
//     inventing an offset);
//   • "2026-09-21" — a date with no clock at all: a date, and no time shown.

export const APP_TZ = 'Europe/Zurich';

export type Lang = 'DE' | 'EN';

/** Anything a caller might hold: an ISO string, a Date, or epoch milliseconds. */
export type Moment = string | Date | number | null | undefined;

export type ZonedParts = {
  valid: boolean;
  /** False for a bare date — there is no kick-off time to show. */
  timed: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const INVALID: ZonedParts = { valid: false, timed: false, year: 0, month: 0, day: 0, hour: 0, minute: 0 };

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TZ,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function fromInstant(date: Date): ZonedParts {
  if (Number.isNaN(date.getTime())) return INVALID;
  const parts = partsFormatter.formatToParts(date);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const hour = at('hour');
  return {
    valid: true,
    timed: true,
    year: at('year'), month: at('month'), day: at('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: hour === 24 ? 0 : hour,
    minute: at('minute'),
  };
}

/** The Zürich wall clock of a stored value, whatever shape it arrived in.
 *
 *  Takes epoch milliseconds too, and never throws on a shape it did not expect:
 *  these calls sit inside render, where a TypeError is not a wrong time on
 *  screen but a blank page. (It was: `draftSavedAt` is a number, and calling
 *  `.trim()` on it took the whole feedback form down with it.) */
export function zonedParts(value: Moment): ZonedParts {
  if (value instanceof Date) return fromInstant(value);
  if (typeof value === 'number') return Number.isFinite(value) ? fromInstant(new Date(value)) : INVALID;
  if (typeof value !== 'string') return INVALID;
  const text = value.trim();
  if (!text) return INVALID;

  const dateOnly = DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    return { valid: true, timed: false, year: +dateOnly[1], month: +dateOnly[2], day: +dateOnly[3], hour: 0, minute: 0 };
  }

  if (!HAS_ZONE_RE.test(text)) {
    const wall = WALL_CLOCK_RE.exec(text);
    // No zone marker: these digits ARE the Zürich wall clock. Handing them to
    // `new Date()` would read them in the device's zone and shift them.
    if (wall) {
      return { valid: true, timed: true, year: +wall[1], month: +wall[2], day: +wall[3], hour: +wall[4], minute: +wall[5] };
    }
  }

  // PocketBase hands back "2026-09-21 18:45:00.000Z"; the T keeps that off the
  // engine's lenient fallback parser.
  return fromInstant(new Date(text.replace(' ', 'T')));
}

const pad = (n: number) => String(n).padStart(2, '0');
const localeOf = (lang: Lang) => (lang === 'DE' ? 'de-CH' : 'en-GB');

/** "Di" / "Tue" — the weekday of the Zürich day, in the reader's language. */
export function weekdayLabel(value: Moment, lang: Lang): string {
  const p = zonedParts(value);
  if (!p.valid) return '';
  // Formatted as a UTC instant built from the Zürich parts, so the weekday can
  // never be dragged across midnight by the device's zone.
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).toLocaleDateString(localeOf(lang), { weekday: 'short', timeZone: 'UTC' });
}

/** "21.09." — Swiss order, day first, and never the browser's idea of it. */
export function dayLabel(value: Moment, opts: { year?: boolean } = {}): string {
  const p = zonedParts(value);
  if (!p.valid) return '';
  return `${pad(p.day)}.${pad(p.month)}.${opts.year ? p.year : ''}`;
}

/** "20:45", or '' when the value carries no clock. */
export function timeLabel(value: Moment): string {
  const p = zonedParts(value);
  return p.valid && p.timed ? `${pad(p.hour)}:${pad(p.minute)}` : '';
}

/** "Di 21.09." — the date shorthand the dashboard rows use. */
export function shortDayLabel(value: Moment, lang: Lang): string {
  const p = zonedParts(value);
  if (!p.valid) return '';
  return `${weekdayLabel(value, lang)} ${pad(p.day)}.${pad(p.month)}.`;
}

/** "21.09.2026 20:45" — the long form the filed PDF and the mails show. */
export function dayTimeLabel(value: Moment): string {
  const p = zonedParts(value);
  if (!p.valid) return '';
  const date = `${pad(p.day)}.${pad(p.month)}.${p.year}`;
  return p.timed ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date;
}

/** "20:45" or "20:45:00" for a log line — Zürich, like the alert mails. */
export function clockLabel(value: Moment, opts: { seconds?: boolean } = {}): string {
  const p = zonedParts(value);
  if (!p.valid) return '';
  const base = `${pad(p.hour)}:${pad(p.minute)}`;
  if (!opts.seconds) return base;
  const asDate = value instanceof Date ? value
    : typeof value === 'number' ? new Date(value)
    : new Date(String(value).replace(' ', 'T'));
  const seconds = asDate.getSeconds();
  return `${base}:${pad(Number.isNaN(seconds) ? 0 : seconds)}`;
}

/** `YYYY-MM-DD` of the Zürich day — the key a calendar cell is filed under. */
export function dayKey(value: Moment): string {
  const p = zonedParts(value);
  return p.valid ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : '';
}

/** Today, in Zürich — which is not the reader's today everywhere. */
export function todayKey(): string {
  return dayKey(new Date());
}
