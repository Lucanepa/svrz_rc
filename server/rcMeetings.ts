// RC-Sitzungen — the commission's meetings, as the server reads them. Pure, so
// the rules can be tested without a PocketBase (e2e/rc-meetings-rules.spec.ts);
// index.ts keeps the I/O: the list in app_settings, the routes, the calendar.
//
// There used to be ONE meeting: a date and a rate on the expenses card, and a
// per-season set of who attended (app_settings `expense_rates.meetingDate` /
// `.meeting`, `rc_meeting_<season>`). Luca asked (2026-10-05) for the meeting
// to have its own row, with a time, notes and a video-call link, to reach
// every coach's Home and calendar, and for more than one per season. So a
// meeting is now a record of its own, and every meeting carries its own rate
// and its own attendance.
//
// The old single meeting is not lost: while `rc_meetings` has never been
// written, it is read from the old keys (`legacyMeeting`), and the first save
// writes it into the list.

import { seasonOfGame } from './season.ts';

type Rec = Record<string, unknown>;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

export type RcMeeting = {
  id: string;
  title: string;
  /** YYYY-MM-DD, Zürich wall clock. */
  date: string;
  /** HH:MM, or '' for a meeting without a set time. */
  start: string;
  /** HH:MM, or ''. */
  end: string;
  /** A video-call link (https only), or ''. */
  link: string;
  notes: string;
  /** CHF paid to each coach who attended — a line on their expense sheet. */
  rate: number;
  /** The ids of the coaches who attended. */
  attended: string[];
};

export const DEFAULT_MEETING_TITLE = 'RC-Sitzung';
export const DEFAULT_MEETING_RATE = 60;
const TITLE_MAX = 120;
const NOTES_MAX = 4000;
const LINK_MAX = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A time as typed or stored: "19:00", "9:5" → "09:05"; '' otherwise. */
export function normalizeTime(raw: unknown): string {
  const m = /^(\d{1,2})[:.](\d{1,2})$/.exec(text(raw));
  if (!m) return '';
  const t = `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`;
  return TIME_RE.test(t) ? t : '';
}

/** Only an https link is kept. The link is a button on every coach's Home and
 *  a URL in their calendar, so `javascript:` or a bare word must never get
 *  through as one. */
export function normalizeLink(raw: unknown): string {
  const value = text(raw).slice(0, LINK_MAX);
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function money(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 100) / 100 : fallback;
}

/** One meeting from a request body or the stored list. null when it has no
 *  valid date — a meeting is first of all a day. */
export function sanitizeMeeting(raw: unknown, id: string): RcMeeting | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const date = text(r.date);
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return null;
  const start = normalizeTime(r.start);
  let end = normalizeTime(r.end);
  // An end without a start, or before it, says nothing a calendar can use.
  if (!start || (end && end <= start)) end = '';
  const attended = Array.isArray(r.attended)
    ? [...new Set(r.attended.map((v) => text(v)).filter(Boolean))]
    : [];
  return {
    id,
    title: text(r.title).slice(0, TITLE_MAX) || DEFAULT_MEETING_TITLE,
    date,
    start,
    end,
    link: normalizeLink(r.link),
    notes: String(r.notes ?? '').replace(/\r\n/g, '\n').trim().slice(0, NOTES_MAX),
    rate: money(r.rate, DEFAULT_MEETING_RATE),
    attended,
  };
}

/** The stored list; null when it has never been written (read the legacy
 *  keys then), [] when every meeting was deleted. */
export function parseMeetings(raw: unknown): RcMeeting[] | null {
  if (raw == null || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(value)) return null;
  const out: RcMeeting[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = text((entry as Rec | null)?.id);
    if (!id || seen.has(id)) continue;
    const m = sanitizeMeeting(entry, id);
    if (m) { out.push(m); seen.add(id); }
  }
  return sortMeetings(out);
}

/** The single meeting the expenses card used to hold, as a record. */
export function legacyMeeting(
  rates: { meeting?: unknown; meetingDate?: unknown },
  attended: Iterable<string>,
): RcMeeting | null {
  const date = text(rates.meetingDate);
  if (!DATE_RE.test(date)) return null;
  return sanitizeMeeting({ date, rate: rates.meeting, attended: [...attended] }, `legacy-${date}`);
}

export function sortMeetings(list: RcMeeting[]): RcMeeting[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** The season a meeting belongs to: the same September cut as every game. */
export function meetingSeason(m: Pick<RcMeeting, 'date'>): number | null {
  return seasonOfGame(`${m.date}T12:00:00Z`);
}

export function meetingsOfSeason(list: RcMeeting[], season: number): RcMeeting[] {
  return list.filter((m) => meetingSeason(m) === season);
}

/** Meetings not yet over, by Zürich wall clock: `today` is YYYY-MM-DD and
 *  `nowTime` HH:MM there. A meeting with a time stays until its end (or an
 *  hour after its start); one without a time, for its whole day. */
export function upcomingMeetings(list: RcMeeting[], today: string, nowTime: string): RcMeeting[] {
  return sortMeetings(list).filter((m) => {
    if (m.date > today) return true;
    if (m.date < today) return false;
    if (!m.start) return true;
    return nowTime < (m.end || plusMinutes(m.start, 60));
  });
}

export function plusMinutes(hhmm: string, minutes: number): string {
  const [h, mi] = hhmm.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + mi + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** What a coach is shown: no rates, no attendance list. */
export type PublicMeeting = Pick<RcMeeting, 'id' | 'title' | 'date' | 'start' | 'end' | 'link' | 'notes'>;
export function publicMeeting(m: RcMeeting): PublicMeeting {
  return { id: m.id, title: m.title, date: m.date, start: m.start, end: m.end, link: m.link, notes: m.notes };
}

/** The lines on one coach's expense sheet: the season's meetings they sat in. */
export function attendedMeetings(list: RcMeeting[], season: number, rcId: string): Array<{ date: string; title: string; rate: number }> {
  return meetingsOfSeason(sortMeetings(list), season)
    .filter((m) => m.attended.includes(rcId))
    .map((m) => ({ date: m.date, title: m.title, rate: m.rate }));
}
