/**
 * The chair's planning board (asked 2026-09-30): which coachees of the season
 * are observed, booked, or still waiting — and the games that break a rule.
 *
 * Deliberately NOT a second games list. The console's Games tab is where a
 * game is handed out, moved or released; this answers "who still needs a
 * visit, and what is off", and every line of it links into that tab. Nor does
 * it repeat the Datenqualität card: slots matched by name, unknown coach
 * references and SV-number clashes are that card's, and stay there.
 *
 * Pure: the endpoint resolves slots, the RC-Spiel test and the Börse before
 * calling it, so the rules below can be pinned without a database.
 */

import { dayKey } from '../src/lib/appTime.ts';
import { visitCount } from '../src/lib/doubleGame.ts';

export type PlanningRole = '1. SR' | '2. SR';

export type PlanningGameInput = {
  id: string;
  matchNo: string;
  /** ISO kick-off. */
  date: string;
  label: string;
  /** The holder, '' for a free game. */
  rc: string;
  /** The holder's roster id, when the row carries one — what decides that two
   *  games are one coach's double game. */
  rcId?: string;
  /** When it was taken (ISO) and by which door ('rc' | 'console'), '' when
   *  nobody recorded it — games held since before the stamp existed. */
  takenAt?: string;
  takenVia?: string;
  closedRoles: string[];
  /** Roles with a feedback row on this game. */
  feedbackRoles: string[];
  /** Each whistle slot, with the season's coachee row on it ('' for nobody). */
  slots: { role: PlanningRole; name: string; coacheeId: string }[];
  /** 4.4.10: a referee coach on the whistle next to a coachee. */
  isRcGame: boolean;
  /** Roles whose referee is offering the game in the Börse right now. */
  offeredRoles: PlanningRole[];
};

export type PlanningCoacheeInput = {
  id: string;
  name: string;
  groups: string;
  level: string;
  stage: string;
  /** Filed observations, and whether the latest one asked for another visit. */
  observed: number;
  furtherWanted: boolean;
};

export type PlanningBooking = { gameId: string; matchNo: string; date: string; label: string; rc: string; role: PlanningRole; takenAt: string; takenVia: string };

export type PlanningStatus = 'booked' | 'needs-visit' | 'further-wanted' | 'done' | 'inactive';

export type PlanningCoachee = {
  id: string;
  name: string;
  groups: string;
  level: string;
  stage: string;
  observed: number;
  furtherWanted: boolean;
  /** Held games whose report for this coachee's role has not been sent. */
  bookings: PlanningBooking[];
  /** Games still to come with this coachee on the whistle that nobody holds
   *  and that can be taken (not an RC-Spiel) — the choice a coach has left. */
  freeGames: number;
  status: PlanningStatus;
};

export type PlanningCheckKind =
  | 'rc-game-held'
  | 'double-booking'
  | 'offered-slot'
  | 'overdue'
  | 'no-coachee'
  | 'closed-mismatch';

export type PlanningCheck = {
  kind: PlanningCheckKind;
  /** The games the line is about — one, or every booking of a double. */
  games: PlanningBooking[];
  /** Who it is about: the coachee(s) concerned, '' when nobody is. */
  who: string;
  /** For closed-mismatch: which way round. */
  detail?: string;
};

export type PlanningReport = {
  season: number;
  coachees: PlanningCoachee[];
  checks: PlanningCheck[];
  totals: { coachees: number; booked: number; needsVisit: number; furtherWanted: number; done: number; checks: number };
};

const ROLES: PlanningRole[] = ['1. SR', '2. SR'];

/** The order a planner reads: the ones still waiting first, the finished and
 *  the inactive last; by name within each. */
const STATUS_ORDER: PlanningStatus[] = ['needs-visit', 'further-wanted', 'booked', 'done', 'inactive'];

export function computePlanning(input: {
  season: number;
  /** ISO — passed in, so the rules are testable at any moment. */
  now: string;
  coachees: PlanningCoacheeInput[];
  games: PlanningGameInput[];
  /** The roster's ids, for samePerson: an id nobody knows falls to the name. */
  knownRcIds?: Set<string>;
}): PlanningReport {
  const now = input.now;
  const bookings = new Map<string, PlanningBooking[]>();
  const freeGames = new Map<string, number>();
  const checks: PlanningCheck[] = [];
  const known = new Set(input.coachees.map((c) => c.id));
  const nameOf = new Map(input.coachees.map((c) => [c.id, c.name]));

  for (const g of input.games) {
    const booking = (role: PlanningRole): PlanningBooking => ({ gameId: g.id, matchNo: g.matchNo, date: g.date, label: g.label, rc: g.rc, role, takenAt: g.takenAt ?? '', takenVia: g.takenVia ?? '' });
    const onSlots = g.slots.filter((s) => s.coacheeId && known.has(s.coacheeId));
    const held = g.rc !== '';

    if (!held) {
      // A free game still to come is a choice a coach has — unless 4.4.10
      // takes it off the table.
      if (!g.isRcGame && g.date >= now) {
        for (const s of onSlots) freeGames.set(s.coacheeId, (freeGames.get(s.coacheeId) ?? 0) + 1);
      }
    } else {
      const open = onSlots.filter((s) => !g.closedRoles.includes(s.role));
      for (const s of open) {
        const list = bookings.get(s.coacheeId) ?? [];
        list.push(booking(s.role));
        bookings.set(s.coacheeId, list);
      }
      if (g.isRcGame) {
        checks.push({ kind: 'rc-game-held', games: [booking(onSlots[0]?.role ?? '1. SR')], who: onSlots.map((s) => s.name).join(', ') });
      }
      if (onSlots.length === 0) {
        // Held for nobody of this season: a referee dropped from the list, or
        // a swap in the crew since the game was taken.
        checks.push({ kind: 'no-coachee', games: [booking('1. SR')], who: g.slots.map((s) => s.name).filter(Boolean).join(', ') });
      }
      for (const s of open) {
        if (g.offeredRoles.includes(s.role)) {
          checks.push({ kind: 'offered-slot', games: [booking(s.role)], who: s.name });
        }
      }
      if (g.date < now && open.length > 0) {
        checks.push({ kind: 'overdue', games: [booking(open[0].role)], who: open.map((s) => s.name).join(', ') });
      }
    }

    // A role closed without a report behind it, or a report whose role never
    // closed: the submit's two writes disagree, held or not.
    for (const role of ROLES) {
      const closed = g.closedRoles.includes(role);
      const filed = g.feedbackRoles.includes(role);
      if (closed !== filed) {
        checks.push({
          kind: 'closed-mismatch',
          games: [booking(role)],
          who: g.slots.find((s) => s.role === role)?.name ?? '',
          detail: closed ? 'closed-without-report' : 'report-not-closed',
        });
      }
    }
  }

  // Two bookings are a double booking only when they are two visits: one
  // coach watching the same referee twice in one hall on one day is a double
  // game, planned (src/lib/doubleGame.ts).
  const rcIdOf = new Map(input.games.map((g) => [g.id, g.rcId ?? '']));
  for (const [coacheeId, list] of bookings) {
    if (list.length < 2) continue;
    const visits = visitCount(list.map((b) => ({ rc: { id: rcIdOf.get(b.gameId) ?? '', name: b.rc }, date: b.date })), input.knownRcIds);
    if (visits < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    checks.push({ kind: 'double-booking', games: list, who: nameOf.get(coacheeId) ?? '' });
  }

  const coachees: PlanningCoachee[] = input.coachees.map((c) => {
    const mine = (bookings.get(c.id) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const status: PlanningStatus = c.stage === 'inactive' ? 'inactive'
      : mine.length > 0 ? 'booked'
      : c.observed === 0 ? 'needs-visit'
      : c.furtherWanted ? 'further-wanted'
      : 'done';
    return { ...c, bookings: mine, freeGames: freeGames.get(c.id) ?? 0, status };
  });
  coachees.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name, 'de'));

  const CHECK_ORDER: PlanningCheckKind[] = ['rc-game-held', 'double-booking', 'offered-slot', 'overdue', 'no-coachee', 'closed-mismatch'];
  checks.sort((a, b) => CHECK_ORDER.indexOf(a.kind) - CHECK_ORDER.indexOf(b.kind) || a.games[0].date.localeCompare(b.games[0].date));

  const count = (s: PlanningStatus) => coachees.filter((c) => c.status === s).length;
  return {
    season: input.season,
    coachees,
    checks,
    totals: {
      coachees: coachees.length,
      booked: count('booked'),
      needsVisit: count('needs-visit'),
      furtherWanted: count('further-wanted'),
      done: count('done'),
      checks: checks.length,
    },
  };
}

/**
 * The season in numbers, for every coach (the app's Saison tab) and as the
 * header of the chair's board — the same figures on both sides, computed from
 * the same report. Aggregates only: no referee, no coach, no grade, so it is
 * safe for any signed-in coach to see.
 */
export type SeasonProgress = {
  season: number;
  coachees: { active: number; observed: number; booked: number; waiting: number; furtherWanted: number };
  /** Observations: filed reports, open bookings, and the coaches' Pensum summed. */
  visits: { done: number; planned: number; goal: number };
  /** Per month of the season, filed and booked observations by game date. */
  byMonth: { month: string; done: number; planned: number }[];
  /** Coverage per group: active coachees, and how many have been observed. */
  byGroup: { group: string; active: number; observed: number }[];
  /** The last fixture of the season on the list, and the days until it. */
  lastGameDate: string;
  daysLeft: number | null;
};

export function seasonProgress(report: PlanningReport, games: PlanningGameInput[], goal: number, now: string): SeasonProgress {
  const active = report.coachees.filter((c) => c.status !== 'inactive');
  // The Zürich month: a 23:30 kick-off on the last day is that month's game,
  // not the next one's, whatever the UTC date says.
  const monthOf = (date: string) => dayKey(date).slice(0, 7);
  const months = new Map<string, { done: number; planned: number }>();
  const bump = (month: string, key: 'done' | 'planned') => {
    if (!month) return;
    const m = months.get(month) ?? { done: 0, planned: 0 };
    m[key] += 1;
    months.set(month, m);
  };
  let done = 0;
  for (const g of games) {
    for (let i = 0; i < g.feedbackRoles.length; i += 1) { done += 1; bump(monthOf(g.date), 'done'); }
  }
  let planned = 0;
  for (const c of report.coachees) {
    for (const b of c.bookings) { planned += 1; bump(monthOf(b.date), 'planned'); }
  }
  const groups = new Map<string, { active: number; observed: number }>();
  for (const c of active) {
    const names = c.groups.split(',').map((g) => g.trim()).filter(Boolean);
    for (const name of names.length ? names : ['']) {
      const g = groups.get(name) ?? { active: 0, observed: 0 };
      g.active += 1;
      if (c.observed > 0) g.observed += 1;
      groups.set(name, g);
    }
  }
  const lastGameDate = games.reduce((last, g) => (g.date > last ? g.date : last), '');
  const left = lastGameDate ? Math.ceil((Date.parse(lastGameDate) - Date.parse(now)) / (24 * 60 * 60 * 1000)) : null;
  return {
    season: report.season,
    coachees: {
      active: active.length,
      observed: active.filter((c) => c.observed > 0).length,
      booked: active.filter((c) => c.bookings.length > 0).length,
      waiting: active.filter((c) => c.status === 'needs-visit').length,
      furtherWanted: active.filter((c) => c.status === 'further-wanted').length,
    },
    visits: { done, planned, goal },
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, ...m })),
    byGroup: [...groups.entries()].sort((a, b) => b[1].active - a[1].active || a[0].localeCompare(b[0], 'de')).map(([group, g]) => ({ group, ...g })),
    lastGameDate,
    daysLeft: left == null || !Number.isFinite(left) ? null : Math.max(0, left),
  };
}
