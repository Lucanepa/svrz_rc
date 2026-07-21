// Throwaway client-side DEMO mode.
//
// When active, every data call in `pocketbase.ts` is served from the in-memory
// fixture below instead of the real backend — so a visitor can walk the whole
// app (a fake referee coach, fake coachees, fake games, a sample feedback)
// without ever touching the production database or sending a single email.
// Nothing here is persisted server-side; writes mutate the in-memory store so
// the demo feels live, and everything resets when demo mode is left.
//
// Entered via the hidden `#/demo` hash route (see main.tsx), exited via the
// normal logout (rcLogout → disableDemo). The active flag lives in
// sessionStorage: a reload keeps you in the demo, closing the tab ends it.

import { SECTIONS_1SR_DE } from '../types';
import type {
  EligibleGame,
  FeedbackFormData,
  RcOverviewEntry,
  rcCoachSummary,
  rcCoachSummaryGame,
  AssessmentSection,
} from '../types';
import type { CoacheeTargetMap } from './niveauTargets';
import type {
  AuthMe,
  AdminAuthStatus,
  Coachee,
  CoacheeGame,
  CoacheeObservationStatus,
  FeedbackRecord,
  FeedbackSubmitResponse,
  CalendarGameStatus,
  RefereeCoachPerson,
} from './pocketbase';

const DEMO_KEY = 'svrz_rc_demo';

export function isDemoMode(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function enableDemo(): void {
  try { sessionStorage.setItem(DEMO_KEY, '1'); } catch { /* storage unavailable */ }
  _store = null; // rebuild a pristine dataset on entry
}

export function disableDemo(): void {
  try { sessionStorage.removeItem(DEMO_KEY); } catch { /* storage unavailable */ }
  _store = null;
}

// ── Fixture dataset ───────────────────────────────────────────────────

const RC = { id: 'demo-rc-1', name: 'Max Muster', email: 'max.muster@example.com' };

// Mirrors the real feedback mail (server/index.ts buildFeedbackEmailText + the
// to/cc/bcc rules) so the demo can SHOW exactly what would be sent, un-sent.
const MAIL_FROM = 'SVRZ Referee Coaching <rc_coaching@volleyball.lucanepa.com>';
const COACHING_MAILBOX = 'rc_coaching@volleyball.lucanepa.com'; // real FEEDBACK_CC → BCC
// Shaped like the real post-visit survey link but with a token that was never
// minted — the demo shows the mail, it doesn't hand out a live form.
const SURVEY_URL = 'https://lucanepa.github.io/svrz_rc/#/survey/demo0000000000000000000000000000';

// Sample "Tipps & Tricks" — the free-text block an RC writes for the coachee.
// Pre-filled in the demo so the section (and the part of the feedback mail that
// carries it) is visible without the visitor having to type anything.
export const DEMO_TIPS = `Positionierung beim Angriff: Stell dich einen halben Schritt weiter vom Netz weg — du siehst die Blockhand dann früher und musst den Kopf nicht mitdrehen.

Handzeichen: Erst pfeifen, kurz absetzen, dann anzeigen. Das wirkt ruhiger und die Teams folgen dir besser.

Zusammenarbeit 2. SR: Vor dem Spiel drei Punkte abmachen (Netzberührung, Aufstellung, Time-outs) — im Satz reicht dann ein Blick.`;

// Empty outside the demo, so the same call site works in the real app.
export function demoTips(): string {
  return isDemoMode() ? DEMO_TIPS : '';
}

export type DemoEmail = {
  label: string;       // which mail this is (feedback / day-before reminder)
  from: string;
  to: string;
  cc: string[];
  bcc: string[];
  replyTo: string;
  subject: string;
  body: string;        // plain-text body, verbatim to the real mail
  surveyUrl: string;   // rendered as the mail's button, not as body text ('' = none)
  attachment: string;  // PDF filename ('' = no attachment)
  sentAt: string;
};

// Season the demo lives in (Sep–Apr). In the May–Aug offseason we use the
// upcoming season so game dates always fall inside a valid season window (the
// Games tab hides anything outside it) and "planned" games read as upcoming.
function seasonStartYear(): number {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = Jan
  if (m >= 8) return y;      // Sep–Dec → this season
  if (m <= 3) return y - 1;  // Jan–Apr → season began last year
  return y;                  // May–Aug offseason → upcoming season
}

// A date inside the demo season. monthIdx 8..11 → season start year, 0..3 → +1.
function seasonDate(monthIdx: number, day: number): string {
  const start = seasonStartYear();
  const yr = monthIdx >= 8 ? start : start + 1;
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yr}-${mm}-${dd}`;
}

type DemoGame = EligibleGame & {
  coacheeId: string;
  role: '1. SR' | '2. SR';
  // done = feedback filed · outstanding = past, still owed · planned = taken,
  // upcoming · available = not yet taken by any RC (shows in the open Games list).
  kind: 'done' | 'outstanding' | 'planned' | 'available';
};

type DemoStore = {
  coachees: Coachee[];
  games: DemoGame[];
  feedbacks: Record<string, FeedbackRecord[]>; // coacheeId → records
  siblings: RcOverviewEntry[];
  sentMail: DemoEmail[]; // emails the demo "would have sent", newest first
  feedbackSeq: number;
};

function ratedSections(overrides: Record<string, string>): AssessmentSection[] {
  return SECTIONS_1SR_DE.map((s) => ({
    ...s,
    items: s.items.map((i) => ({ ...i, rating: overrides[i.id] ?? 'C' })),
  }));
}

function makeFeedbackJson(game: DemoGame, refereeName: string, niveau: string): FeedbackFormData {
  return {
    role: '1. SR',
    lang: 'DE',
    meta: {
      spielNr: game.matchNo,
      liga: game.league,
      datum: game.date,
      ort: game.location,
      mannschaften: `${game.homeTeam} – ${game.awayTeam}`,
      ergebnis: game.game_result ?? '3:1 (25:20 / 22:25 / 25:18 / 25:22)',
      srName: refereeName,
      srNiveau: niveau,
      rc: RC.name,
      gruppe: 'RD',
    },
    sections: ratedSections({ '1sr-tech-2': 'B', '1sr-rule-1': 'D', '1sr-pers-1': 'B' }),
    results: {
      motivation: 'up',
      einstufung: 'check',
      bemerkungen: 'Solide Leitung, ruhiges Auftreten. Zusammenarbeit mit dem 2. SR gut abgestimmt.',
      highlights: 'Klare Handzeichen, gutes Krisenmanagement in Satz 3.',
      improvements: 'Beim technischen Ballkontakt (Doppelberührung) etwas konsequenter pfeifen.',
      goals: 'Nächstes Ziel: Einsätze auf 3L festigen, dann 2L anstreben.',
      srZiel: '3L',
      spielniveau: 'normal',
      secondBesuch: 'Y',
    },
    signature: '',
  };
}

function obs(partial: Partial<CoacheeObservationStatus> & { count: number }): CoacheeObservationStatus {
  return {
    count: partial.count,
    hasNoObservation: partial.hasNoObservation ?? false,
    hasFurtherObservationNeeded: partial.hasFurtherObservationNeeded ?? false,
    hasCompletedObservation: partial.hasCompletedObservation ?? false,
    needsObservation: partial.needsObservation ?? false,
    latestObservationAt: partial.latestObservationAt ?? '',
  };
}

let _store: DemoStore | null = null;

function buildStore(): DemoStore {
  // referee_level = Niveau (N1–N4), stage = Stufe (numeric). Each coachee's
  // games are set at their target Liga so they survive the "Matching only"
  // (Niveau-target) filter — see NIVEAU_TABLE in niveauTargets.ts.
  const coachees: Coachee[] = [
    {
      id: 'demo-c-anna', full_name: 'Anna Bühler', first_name: 'Anna', last_name: 'Bühler',
      email: 'anna.buehler@example.com', referee_level: 'N3', stage: '2', groups: 'RD',
      season: seasonStartYear(),
      observations_count: 1,
      last_feedback_at: `${seasonDate(9, 12)}T18:30:00Z`,
      observation_status: obs({ count: 1, hasCompletedObservation: true, hasFurtherObservationNeeded: true, needsObservation: true, latestObservationAt: `${seasonDate(9, 12)}T18:30:00Z` }),
    },
    {
      id: 'demo-c-luca', full_name: 'Luca Ferrari', first_name: 'Luca', last_name: 'Ferrari',
      email: 'luca.ferrari@example.com', referee_level: 'N3', stage: '3', groups: 'LD',
      season: seasonStartYear(),
      observations_count: 0,
      observation_status: obs({ count: 0, hasNoObservation: true, needsObservation: true }),
    },
    {
      id: 'demo-c-sofia', full_name: 'Sofia Meier', first_name: 'Sofia', last_name: 'Meier',
      email: 'sofia.meier@example.com', referee_level: 'N4', stage: '2', groups: 'RD',
      season: seasonStartYear(),
      observations_count: 0,
      observation_status: obs({ count: 0, hasNoObservation: true, needsObservation: true }),
    },
    {
      id: 'demo-c-jan', full_name: 'Jan Keller', first_name: 'Jan', last_name: 'Keller',
      email: 'jan.keller@example.com', referee_level: 'N2', stage: '1', groups: 'RD',
      season: seasonStartYear(),
      observations_count: 1,
      last_feedback_at: `${seasonDate(9, 26)}T20:00:00Z`,
      observation_status: obs({ count: 1, hasCompletedObservation: true, needsObservation: false, latestObservationAt: `${seasonDate(9, 26)}T20:00:00Z` }),
    },
    {
      id: 'demo-c-elena', full_name: 'Elena Graf', first_name: 'Elena', last_name: 'Graf',
      email: 'elena.graf@example.com', referee_level: 'N4', stage: '3', groups: 'RD',
      season: seasonStartYear(),
      observations_count: 0,
      observation_status: obs({ count: 0, hasNoObservation: true, needsObservation: true }),
    },
  ];

  const games: DemoGame[] = [
    {
      id: 'demo-g1', coacheeId: 'demo-c-anna', role: '1. SR', kind: 'done',
      matchNo: '2140301', league: '3L ♂', date: seasonDate(9, 12), location: 'Sporthalle Buchholz, Uster',
      homeTeam: 'VBC Kanti Baden', awayTeam: 'Volley Smash 05', firstReferee: 'Anna Bühler', secondReferee: 'Nina Sutter',
      // "sets | per-set points" — the format the games sync delivers, so the
      // report's set boxes are filled the way a played game really looks.
      assignedRc: RC.name, feedbackClosedRoles: ['1. SR'], game_result: '3:1 (25:20 / 22:25 / 25:18 / 25:22)',
      maps_url: 'https://maps.google.com/?q=Sporthalle+Buchholz+Uster', isRdGame: true,
    },
    {
      id: 'demo-g6', coacheeId: 'demo-c-jan', role: '1. SR', kind: 'done',
      matchNo: '2140418', league: '1L ♂', date: seasonDate(9, 26), location: 'Saalsporthalle, Zürich',
      homeTeam: 'Volley Züri Unterland', awayTeam: 'TSV Jona', firstReferee: 'Jan Keller', secondReferee: 'Marco Rossi',
      assignedRc: RC.name, feedbackClosedRoles: ['1. SR'], game_result: '3:2 (25:22 / 23:25 / 25:19 / 20:25 / 15:12)', isRdGame: true,
    },
    {
      id: 'demo-g4', coacheeId: 'demo-c-luca', role: '1. SR', kind: 'outstanding',
      matchNo: '2140355', league: '4L ♂', date: seasonDate(10, 9), location: 'Turnhalle Lindenmoos, Wallisellen',
      homeTeam: 'TV Wittenbach', awayTeam: 'VBC Kanti Schaffhausen', firstReferee: 'Luca Ferrari', secondReferee: 'Timo Weber',
      assignedRc: RC.name, game_result: '2:3 (25:21 / 19:25 / 25:23 / 22:25 / 12:15)',
    },
    {
      id: 'demo-g5', coacheeId: 'demo-c-sofia', role: '1. SR', kind: 'planned',
      matchNo: '2140502', league: '4L ♀', date: seasonDate(11, 6), location: 'Schulhaus Chriesiweg, Bülach',
      homeTeam: 'DTV Bülach', awayTeam: 'VBC Züri Unterland', firstReferee: 'Sofia Meier', secondReferee: 'Nadia Roth',
      assignedRc: RC.name,
    },
    {
      id: 'demo-g3', coacheeId: 'demo-c-luca', role: '1. SR', kind: 'planned',
      matchNo: '2140611', league: '4L ♂', date: seasonDate(0, 18), location: 'Sporthalle Grünau, Zürich',
      homeTeam: 'TSV Jona', awayTeam: 'VBC Einsiedeln', firstReferee: 'Luca Ferrari', secondReferee: 'Andrin Blaser',
      assignedRc: RC.name,
    },
    {
      id: 'demo-g2', coacheeId: 'demo-c-anna', role: '1. SR', kind: 'planned',
      matchNo: '2140702', league: '2L ♀', date: seasonDate(1, 15), location: 'Sporthalle Buchholz, Uster',
      homeTeam: 'Volley Smash 05', awayTeam: 'VBC Kanti Baden', firstReferee: 'Anna Bühler', secondReferee: 'Lea Frei',
      assignedRc: RC.name,
    },
    {
      // Not yet taken by any RC → shows in the open Games list so the
      // "Spiel übernehmen" (take game) flow is demonstrable.
      id: 'demo-g7', coacheeId: 'demo-c-elena', role: '1. SR', kind: 'available',
      matchNo: '2140805', league: '5L ♀', date: seasonDate(0, 25), location: 'Turnhalle Looren, Zürich',
      homeTeam: 'VBC Volketswil', awayTeam: 'DTV Bülach', firstReferee: 'Elena Graf', secondReferee: 'Mara Studer',
    },
  ];

  const gameById = new Map(games.map((g) => [g.id, g]));
  const mkRecord = (id: string, coacheeId: string, refereeName: string, niveau: string): FeedbackRecord => {
    const g = gameById.get(id)!;
    return {
      id: `demo-fb-${id}`,
      role_assessed: '1. SR',
      rc_name: RC.name,
      submitted_at: `${g.date}T21:00:00Z`,
      feedback_json: makeFeedbackJson(g, refereeName, niveau),
      game: g.id,
      coachee: coacheeId,
      expand: {
        game: {
          id: g.id, match_no: g.matchNo, league: g.league, match_date: g.date, location: g.location,
          home_team: g.homeTeam, away_team: g.awayTeam, first_referee: g.firstReferee, second_referee: g.secondReferee,
        },
      },
    };
  };

  const feedbacks: Record<string, FeedbackRecord[]> = {
    'demo-c-anna': [mkRecord('demo-g1', 'demo-c-anna', 'Anna Bühler', 'N3-2')],
    'demo-c-jan': [mkRecord('demo-g6', 'demo-c-jan', 'Jan Keller', 'N2-1')],
  };

  const siblings: RcOverviewEntry[] = [
    { id: 'demo-rc-2', fullName: 'Petra Frei', done: 4, outstanding: 0, planned: 2 },
    { id: 'demo-rc-3', fullName: 'Reto Widmer', done: 1, outstanding: 2, planned: 1 },
  ];

  // Admin-picked priorities: a couple of games we'd like observed.
  for (const g of games) if (g.id === 'demo-g7' || g.id === 'demo-g3') g.starred = true;
  // …plus the ones VolleyManager already marked (RD/RSV) — those flag themselves
  // and can't be un-flagged here, exactly like in the real app.
  for (const g of games) if (g.isRdGame || g.isRsvGame) { g.starred = true; g.vmFlagged = true; }

  // Seed the mailbox with both mails the system sends, so "Demo mail" shows
  // them straight away instead of only after the visitor files a feedback:
  // the day-before reminder for the next planned game, and the feedback mail
  // that went out for the observation already on file. Nothing is ever sent.
  const sentMail: DemoEmail[] = [];
  const nextPlanned = games.find((g) => g.kind === 'planned');
  const nextCoachee = nextPlanned ? coachees.find((c) => c.id === nextPlanned.coacheeId) : undefined;
  if (nextPlanned && nextCoachee) sentMail.push(buildDemoReminderEmail(nextPlanned, nextCoachee));
  const filed = games.find((g) => g.kind === 'done');
  const filedCoachee = filed ? coachees.find((c) => c.id === filed.coacheeId) : undefined;
  if (filed && filedCoachee) {
    const json = feedbacks[filedCoachee.id]?.[0]?.feedback_json;
    if (json) sentMail.push(buildDemoEmail(filed, filedCoachee, json, DEMO_TIPS));
  }

  return { coachees, games, feedbacks, siblings, sentMail, feedbackSeq: 1 };
}

// Format a YYYY-MM-DD date as dd.MM.yyyy, exactly like the server does.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// Rebuild the feedback mail the server WOULD send for this submission, so the
// demo can display it instead of sending. Mirrors buildFeedbackEmailText + the
// to (coachee) / cc (RC) / bcc (coaching mailbox) recipient rules.
function buildDemoEmail(game: DemoGame, coachee: Coachee | undefined, form: FeedbackFormData, tips: string): DemoEmail {
  const date = fmtDate(game.date);
  const rcName = form.meta?.rc || RC.name;
  let body = 'SR-Coaching Feedback\n\n';
  body += `Spiel Nr.: ${game.matchNo}\n`;
  body += `Liga: ${game.league}\n`;
  body += `Datum: ${date}\n`;
  body += `Ort: ${game.location}\n`;
  body += `Mannschaften: ${game.homeTeam} vs ${game.awayTeam}\n`;
  body += `Beurteilte Rolle: ${form.role}\n`;
  body += `Referee Coach: ${rcName}\n`;
  if (tips.trim()) body += `\n--- Tipps & Tricks ---\n${tips}\n`;
  // The URL itself stays out of the body: the real mail renders it as a button
  // in the HTML part, and a bare token URL is unreadable in a preview.
  body += `\nWir freuen uns über Ihr Feedback zum Coaching-Erlebnis:\n`;
  body += `\nDer vollständige Coaching-Feedback-Bericht ist als PDF angehängt.\n`;
  body += `Diese E-Mail wurde automatisch vom SR-Coaching-System versendet.\n`;
  return {
    label: 'Feedback-E-Mail (nach dem Spiel)',
    from: MAIL_FROM,
    to: coachee?.email || '(Coachee ohne E-Mail)',
    cc: [RC.email],
    bcc: [COACHING_MAILBOX],
    replyTo: RC.email,
    subject: `SR-Coaching Feedback – Spiel ${game.matchNo} (${date})`,
    body,
    surveyUrl: SURVEY_URL,
    attachment: `SR-Coaching_${game.matchNo}_${(coachee?.full_name || 'SR').replace(/\s+/g, '-')}.pdf`,
    sentAt: new Date().toISOString(),
  };
}

// The day-before reminder the server sends at 10:00 — same default template as
// DEFAULT_EMAIL_TEMPLATES.reminder in server/index.ts, placeholders filled.
// Seeded into the demo mailbox so the demo shows this mail too.
function buildDemoReminderEmail(game: DemoGame, coachee: Coachee): DemoEmail {
  const first = (n: string) => n.trim().split(/\s+/)[0] || '';
  const body = `Liebe/r ${first(coachee.full_name)},

bei deinem nächsten Einsatz wirst du im Rahmen unseres Schiedsrichter-Coachings begleitet: ${RC.name} ist als Coach vor Ort, um dich zu unterstützen und gemeinsam mit dir an deiner Weiterentwicklung zu arbeiten.

Einsatz-Details:

Datum: ${fmtDate(game.date)}
Zeit: 20:00
Spiel: ${game.homeTeam} – ${game.awayTeam} (${game.league})
Ort/Halle: ${game.location}

${first(RC.name)} meldet sich vor Ort kurz bei dir. Das Coaching ist keine Prüfung – im Anschluss nehmt ihr euch gemeinsam Zeit für ein Gespräch, um Stärken zu festigen und Ansatzpunkte für deine Entwicklung zu besprechen.

Bei Fragen oder falls sich am Einsatz etwas ändert, melde dich bitte rechtzeitig.

Sportliche Grüsse
${RC.name}
`;
  return {
    label: 'Erinnerung (Tag vor dem Spiel, 10:00)',
    from: MAIL_FROM,
    to: coachee.email || '',
    cc: [RC.email],
    bcc: [],
    replyTo: RC.email,
    subject: 'Coaching-Begleitung bei deinem nächsten Einsatz',
    body,
    surveyUrl: '', // the reminder goes out before the game — nothing to review yet
    attachment: '',
    sentAt: new Date().toISOString(),
  };
}

export function getSentMail(): DemoEmail[] {
  return store().sentMail.map((m) => ({ ...m }));
}

function store(): DemoStore {
  if (!_store) _store = buildStore();
  return _store;
}

const ok = <T>(v: T): Promise<T> => Promise.resolve(v);

// ── Handlers (mirror the pocketbase.ts signatures) ────────────────────

export function getAuthMe(): Promise<AuthMe> {
  return ok({ rc: { id: RC.id, name: RC.name }, admin: null });
}

export function getAdminAuthStatus(): Promise<AdminAuthStatus> {
  return ok({ authenticated: false, email: '' });
}

export function getSettings(): Promise<{ default_season: number | null; test_mode?: boolean; groups?: string[]; coachee_targets?: CoacheeTargetMap }> {
  return ok({ default_season: seasonStartYear(), test_mode: false, groups: ['RD', 'LD'], coachee_targets: {} });
}

export function listCoachees(): Promise<Coachee[]> {
  return ok(store().coachees.map((c) => ({ ...c })));
}

export function updateCoachee(id: string, payload: Partial<Coachee>): Promise<Coachee | null> {
  const c = store().coachees.find((x) => x.id === id);
  if (c) Object.assign(c, payload);
  return ok(c ? { ...c } : null);
}

function toEligible(g: DemoGame): EligibleGame {
  const { coacheeId: _c, role: _r, kind: _k, ...rest } = g;
  return { ...rest };
}

export function loadEligibleGames(): Promise<EligibleGame[]> {
  return ok(store().games.map(toEligible));
}

export function listRefereeCoachPeople(): Promise<RefereeCoachPerson[]> {
  return ok([{ id: RC.id, fullName: RC.name }, ...store().siblings.map((s) => ({ id: s.id, fullName: s.fullName }))]);
}

export function listCoacheeGames(coacheeId: string): Promise<CoacheeGame[]> {
  const games = store().games
    .filter((g) => g.coacheeId === coacheeId)
    .map((g) => ({ ...toEligible(g), assignedRoles: [g.role] as string[] }));
  return ok(games);
}

export function listCoacheeFeedbacks(coacheeId: string): Promise<FeedbackRecord[]> {
  return ok((store().feedbacks[coacheeId] ?? []).map((r) => ({ ...r })));
}

export function loadCalendarGames(): Promise<CalendarGameStatus[]> {
  return ok(store().games.map((g) => {
    const done = (g.feedbackClosedRoles?.length ?? 0) > 0;
    const status: CalendarGameStatus['status'] = done ? 'completed' : g.kind === 'outstanding' ? 'outstanding' : 'none';
    return {
      id: g.id, matchNo: g.matchNo, league: g.league, date: g.date, location: g.location,
      homeTeam: g.homeTeam, awayTeam: g.awayTeam,
      status, hasOutstanding: status === 'outstanding', hasCompleted: status === 'completed',
    };
  }));
}

function buildSummary(): rcCoachSummary[] {
  const s = store();
  const teams = (g: DemoGame) => `${g.homeTeam} – ${g.awayTeam}`;
  return s.coachees.map((c) => {
    const cg = s.games.filter((g) => g.coacheeId === c.id);
    const toGame = (g: DemoGame): rcCoachSummaryGame => ({ gameId: g.id, gameDate: g.date, league: g.league, teams: teams(g), refereeName: c.full_name });
    return {
      coacheeName: c.full_name,
      coacheeId: c.id,
      doneFeedbacks: (s.feedbacks[c.id] ?? []).map((r) => ({
        gameDate: r.expand?.game?.match_date ?? '', league: r.expand?.game?.league ?? '',
        teams: `${r.expand?.game?.home_team ?? ''} – ${r.expand?.game?.away_team ?? ''}`,
        role: r.role_assessed ?? '1. SR', submittedAt: r.submitted_at ?? '',
      })),
      outstandingGames: cg.filter((g) => g.kind === 'outstanding').map(toGame),
      plannedGames: cg.filter((g) => g.kind === 'planned').map(toGame),
    };
  });
}

export function loadRcOverview(): Promise<RcOverviewEntry[]> {
  const summary = buildSummary();
  const mine: RcOverviewEntry = {
    id: RC.id, fullName: RC.name,
    done: summary.reduce((n, cs) => n + cs.doneFeedbacks.length, 0),
    outstanding: summary.reduce((n, cs) => n + cs.outstandingGames.length, 0),
    planned: summary.reduce((n, cs) => n + cs.plannedGames.length, 0),
  };
  return ok([mine, ...store().siblings]);
}

export function loadrcCoachSummary(rcName: string): Promise<rcCoachSummary[]> {
  // Only the demo coach has detail; siblings are context-only.
  if (rcName.trim().toLowerCase() !== RC.name.toLowerCase()) return ok([]);
  return ok(buildSummary());
}

export function saveFeedbackToPocketBase(params: {
  gameId: string; role: FeedbackFormData['role']; formData: FeedbackFormData; tipsAndTricks?: string;
}): Promise<FeedbackSubmitResponse> {
  const s = store();
  const g = s.games.find((x) => x.id === params.gameId);
  if (g) {
    // Capture the email that WOULD be sent (never actually send it).
    const coachee = s.coachees.find((c) => c.id === g.coacheeId);
    s.sentMail = [buildDemoEmail(g, coachee, params.formData, params.tipsAndTricks ?? ''), ...s.sentMail];
    // Mark this role closed and record the feedback so the coachee's history,
    // the game's "done" state, and the Home/overview counters all update live.
    if (!g.feedbackClosedRoles) g.feedbackClosedRoles = [];
    if (!g.feedbackClosedRoles.includes(params.role)) g.feedbackClosedRoles.push(params.role);
    // Mirrors the API: the typed score sticks to the game, so filing the other
    // referee later starts from it instead of a blank field.
    const typedResult = params.formData.meta.ergebnis;
    if (typedResult) g.game_result = typedResult;
    g.kind = 'done';
    const submittedAt = new Date().toISOString();
    const record: FeedbackRecord = {
      id: `demo-fb-new-${s.feedbackSeq++}`,
      role_assessed: params.role, rc_name: RC.name, submitted_at: submittedAt,
      feedback_json: params.formData, game: g.id, coachee: g.coacheeId,
      expand: { game: { id: g.id, match_no: g.matchNo, league: g.league, match_date: g.date, location: g.location, home_team: g.homeTeam, away_team: g.awayTeam, first_referee: g.firstReferee, second_referee: g.secondReferee } },
    };
    s.feedbacks[g.coacheeId] = [record, ...(s.feedbacks[g.coacheeId] ?? [])];
    if (coachee) {
      coachee.last_feedback_at = submittedAt;
      coachee.observations_count = (coachee.observations_count ?? 0) + 1;
      coachee.observation_status = obs({
        count: (coachee.observation_status?.count ?? 0) + 1,
        hasCompletedObservation: true,
        needsObservation: params.formData.results.secondBesuch === 'Y',
        hasFurtherObservationNeeded: params.formData.results.secondBesuch === 'Y',
        latestObservationAt: submittedAt,
      });
    }
  }
  return ok({ id: `demo-submit-${s.feedbackSeq}`, emailSent: true });
}

export function setGameStarred(gameId: string, starred: boolean): Promise<void> {
  const g = store().games.find((x) => x.id === gameId);
  if (g && !g.vmFlagged) g.starred = starred;
  return ok(undefined);
}

export function assignRcToGame(gameId: string, assignedRc: string): Promise<void> {
  const g = store().games.find((x) => x.id === gameId);
  if (g) g.assignedRc = assignedRc || undefined;
  return ok(undefined);
}

// Signature-on-another-device isn't wired in the demo — stub so nothing hits
// the network; the coach can still complete a feedback without a signature.
export function startSignature(): Promise<{ slug: string }> {
  return ok({ slug: 'demo' });
}
export function getSignatureSession(): Promise<{ context: string; signer: string; signed: boolean; data: string }> {
  return ok({ context: '', signer: '', signed: false, data: '' });
}
export function submitSignatureSession(): Promise<void> {
  return ok(undefined);
}
