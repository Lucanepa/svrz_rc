// The season budget (Admin → Finance & operations) — pure, shared by the server
// (which stores the settings) and the console (which does the sums from the
// same rows the table shows). Spec: e2e/budget-rules.spec.ts.
//
// Asked for by the RC chair (2026-10-05): "I have 5000 budget, 50 games are
// visited, 50 × 60, so the rest budget is 2000". Agreed with Luca the same
// day:
//  - the budget is set per season (CHF 5500 for 2026/27) and can change;
//  - each meeting costs its attendees × its own per-attendee rate, set on the
//    meeting itself (Admin → RC-Sitzungen);
//  - extras are free lines for anything else the budget pays — none for now;
//  - the remaining budget subtracts the games already taken but not yet
//    filed as well, so it says what is really left to plan with.
//
// One rule decides what a visit costs, the same as the Vergütet column and the
// expense sheet: a coach is paid for their done games up to the season's cap.

export type BudgetExtra = { id: string; label: string; amount: number };
export type BudgetSettings = { budget: number; extras: BudgetExtra[] };

export const DEFAULT_BUDGET = 5500;
const MAX_CHF = 1_000_000;
const LABEL_MAX = 120;

const money = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CHF ? Math.round(n * 100) / 100 : null;
};
const round = (n: number) => Math.round(n * 100) / 100;

/** The stored settings (or a request body), cleaned. Never-saved is the
 *  default budget with no extras. */
export function normalizeBudget(raw: unknown): BudgetSettings {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = null; }
  }
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const extras: BudgetExtra[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(r.extras) ? r.extras : []) {
    const x = (e ?? {}) as Record<string, unknown>;
    const id = String(x.id ?? '').trim().slice(0, 40);
    const amount = money(x.amount);
    const label = String(x.label ?? '').trim().slice(0, LABEL_MAX);
    if (!id || seen.has(id) || amount == null || !label) continue;
    seen.add(id);
    extras.push({ id, label, amount });
  }
  return { budget: money(r.budget) ?? DEFAULT_BUDGET, extras };
}

/** One coach as the Übersicht table has them. */
export type BudgetRow = {
  id: string;
  done: number;
  outstanding: number;
  planned: number;
  paidAt?: string | null;
};

export type BudgetMeeting = { id: string; rate: number; attended: string[] };

export type RcCost = {
  /** Games paid: done, up to the cap — the Vergütet column. */
  paidGames: number;
  /** Games taken but not yet filed (owed or ahead) that the cap still pays. */
  upcomingGames: number;
  visits: number;
  upcomingVisits: number;
  meetings: number;
  /** What the coach can claim now: paid visits + meetings attended. */
  claim: number;
  paidOut: boolean;
};

export type BudgetSummary = {
  budget: number;
  paidGames: number;
  upcomingGames: number;
  visits: number;
  upcomingVisits: number;
  meetingAttendances: number;
  meetings: number;
  extras: number;
  /** Visits completed + meetings + extras. */
  spent: number;
  /** Budget − spent − upcoming visits: what is left to plan with. */
  remaining: number;
  /** Claims of the coaches marked Bezahlt. */
  paidOut: number;
  /** Claims not yet paid out (visits + meetings; extras are not a coach's claim). */
  owed: number;
  perRc: Record<string, RcCost>;
};

const capped = (n: number, cap: number | null) => (cap == null ? n : Math.min(n, cap));

export function computeBudget(args: {
  rows: BudgetRow[];
  cap: number | null;
  visitRate: number;
  meetings: BudgetMeeting[];
  settings: BudgetSettings;
}): BudgetSummary {
  const { rows, cap, visitRate, meetings, settings } = args;
  const perRc: Record<string, RcCost> = {};
  let paidGames = 0, upcomingGames = 0, paidOut = 0;
  for (const r of rows) {
    const done = Math.max(0, r.done | 0);
    const later = Math.max(0, (r.outstanding | 0) + (r.planned | 0));
    const paid = capped(done, cap);
    const upcoming = capped(done + later, cap) - paid;
    const meetingCost = meetings.reduce((sum, m) => sum + (m.attended.includes(r.id) ? m.rate : 0), 0);
    const visits = round(paid * visitRate);
    const claim = round(visits + meetingCost);
    perRc[r.id] = {
      paidGames: paid, upcomingGames: upcoming,
      visits, upcomingVisits: round(upcoming * visitRate),
      meetings: round(meetingCost), claim, paidOut: !!r.paidAt,
    };
    paidGames += paid;
    upcomingGames += upcoming;
    if (r.paidAt) paidOut += claim;
  }
  // Meetings are summed from the meetings, not the rows: a tick for a coach
  // no longer on the roster is still money spent.
  const meetingAttendances = meetings.reduce((n, m) => n + m.attended.length, 0);
  const meetingsTotal = round(meetings.reduce((sum, m) => sum + m.attended.length * m.rate, 0));
  const extras = round(settings.extras.reduce((sum, e) => sum + e.amount, 0));
  const visits = round(paidGames * visitRate);
  const upcomingVisits = round(upcomingGames * visitRate);
  const spent = round(visits + meetingsTotal + extras);
  return {
    budget: settings.budget,
    paidGames, upcomingGames, visits, upcomingVisits,
    meetingAttendances, meetings: meetingsTotal, extras, spent,
    remaining: round(settings.budget - spent - upcomingVisits),
    paidOut: round(paidOut),
    owed: round(visits + meetingsTotal - paidOut),
    perRc,
  };
}
