import type { EligibleGame, FeedbackFormData, RcMandateMap, RcOverviewEntry, rcCoachSummary } from '../types';
import type { CoacheeTargetMap, NiveauMatrix } from './niveauTargets';
import { normalizeSurveyConfig, type SurveyConfig } from './survey';
import * as demo from './demo';
import { isDemoMode } from './demo';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

export function apiUrl(path: string): string {
  // Keep local dev behavior (`/api/...`) when no explicit API base is configured.
  if (!API_BASE_URL) return path;
  const normalizedBase = API_BASE_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export type CoacheeObservationStatus = {
  count: number;
  hasNoObservation: boolean;
  hasFurtherObservationNeeded: boolean;
  hasCompletedObservation: boolean;
  needsObservation: boolean;
  latestObservationAt: string;
};

export type Coachee = {
  id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  referee_level?: string;
  stage?: string;
  groups?: string;
  season?: number;
  notes?: string;
  /** The SV-Nr. of the referee this coachee is, once the register import has
   *  linked them. Empty for a coachee whose name answered to two referees. */
  referee_id?: string;
  last_feedback_at?: string;
  feedback_entries?: unknown[];
  observations_count?: number;
  observation_status?: CoacheeObservationStatus;
};

export type CoacheeGame = EligibleGame & {
  firstLineJudge?: string;
  secondLineJudge?: string;
  assignedRoles: string[];
};

export type FeedbackRecord = {
  id: string;
  role_assessed?: FeedbackFormData['role'];
  rc_name?: string;
  submitted_at?: string;
  feedback_json?: FeedbackFormData;
  game?: string;
  coachee?: string;
  expand?: {
    game?: {
      id?: string;
      match_no?: string;
      league?: string;
      match_date?: string;
      location?: string;
      home_team?: string;
      away_team?: string;
      first_referee?: string;
      second_referee?: string;
    };
  };
};

export type CalendarGameStatus = {
  id: string;
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  status: 'outstanding' | 'completed' | 'none';
  hasOutstanding: boolean;
  hasCompleted: boolean;
};

export type AdminAuthStatus = {
  authenticated: boolean;
  email: string;
  /** Which credential opened it — decides which half of the console shows. */
  role?: 'admin' | 'president' | null;
};

export async function loadEligibleGames(): Promise<EligibleGame[]> {
  if (isDemoMode()) return demo.loadEligibleGames();
  const response = await fetch(apiUrl('/api/eligible-games'), { credentials: 'include' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load eligible games: ${text}`);
  }
  return response.json() as Promise<EligibleGame[]>;
}

export type FeedbackSubmitResponse = {
  id: string;
  emailSent: boolean;
  emailError?: string;
  emailWarning?: string;
  /**
   * The role could not be closed on the game. The report IS filed and sent, but
   * the game still looks unobserved: another report can be filed and mailed for
   * the same role, and a score typed into this one was dropped. The server has
   * always computed this; nothing read it, so the coach saw an ordinary success.
   */
  closureFailed?: boolean;
};

export async function saveFeedbackToPocketBase(params: {
  /** See OutboxPayload.submissionKey — replay-stable, absent when online. */
  submissionKey?: string;
  gameId: string;
  role: FeedbackFormData['role'];
  formData: FeedbackFormData;
  pdfBase64: string;
  pdfFilename: string;
  tipsAndTricks: string;
}): Promise<FeedbackSubmitResponse> {
  if (isDemoMode()) return demo.saveFeedbackToPocketBase(params);
  const response = await fetch(apiUrl('/api/feedback/submit'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      submissionKey: params.submissionKey,
      gameId: params.gameId,
      role: params.role,
      formData: params.formData,
      pdfBase64: params.pdfBase64,
      pdfFilename: params.pdfFilename,
      tipsAndTricks: params.tipsAndTricks,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    // Mark that the request reached the server (a real HTTP error, not a
    // network failure) so the outbox can tell "retry when online" from
    // "the server rejected this".
    const err = new Error(`Failed to save feedback: ${text}`) as Error & { status?: number; reachedServer?: boolean };
    err.status = response.status;
    err.reachedServer = true;
    throw err;
  }
  return response.json() as Promise<FeedbackSubmitResponse>;
}

// The API base is baked in at build time and the app has no unconfigured mode
// any more, so this is always true. Kept as the single place any future
// "backend not configured" state would be decided.
export function hasPocketBaseConfig(): boolean {
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────
export type AuthMe = {
  rc: { id: string; name: string } | null;
  admin: { email: string } | null;
  /** Reads the chair's private channel — a console session, not an app one. */
  surveyReader?: boolean;
  /** Signed in to the app (there is only the team credential now). */
  shared?: boolean;
  /** Draw the #/admin shortcut for this session. Cosmetic — never a permission. */
  adminShortcut?: boolean;
  /** Signed in, but no RC named yet — show the picker, not the login screen. */
  needsIdentity?: boolean;
};

/** A name the picker can offer. */
export type RcRosterEntry = { id: string; fullName: string };

// Purge the offline API response cache (see vite.config.ts runtimeCaching). Must
// run on every identity change — login AND logout — so cached authenticated data
// (auth/me, coachees, feedback history) from one RC is never served to another
// on a shared device, and a logged-out session isn't served offline as authed.
export async function clearApiCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete('svrz-api-get');
  } catch { /* cache API unavailable — nothing to clear */ }
}

export async function getAuthMe(): Promise<AuthMe> {
  if (isDemoMode()) return demo.getAuthMe();
  const response = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<AuthMe>;
}

// Set when a logout could not reach the server. The session is a signed
// httpOnly cookie with a 30-day life that only the server can clear, so an
// offline "Abmelden" on a shared tablet left the next person one reload away
// from the previous coach's account. The flag survives the reload, blocks the
// session probe, and retries the real logout as soon as there is a network.
const PENDING_LOGOUT_KEY = 'svrz_pending_logout';

export function hasPendingLogout(): boolean {
  try { return localStorage.getItem(PENDING_LOGOUT_KEY) === '1'; } catch { return false; }
}
function setPendingLogout(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_LOGOUT_KEY, '1');
    else localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch { /* private mode — the in-flight logout below is all we have */ }
}

/** Retry a logout that never reached the server. Safe to call at any time. */
export async function settlePendingLogout(): Promise<void> {
  if (!hasPendingLogout()) return;
  try {
    const response = await fetch(apiUrl('/api/auth/rc/logout'), { credentials: 'include', method: 'POST' });
    if (response.ok) setPendingLogout(false);
  } catch { /* still offline — stay logged out locally and try again later */ }
}

export async function rcLogout(): Promise<void> {
  // Leaving the demo is a pure client action — never touch the server.
  if (isDemoMode()) { demo.disableDemo(); await clearApiCache(); return; }
  // Purge the cache even if the logout POST fails (offline), so the previous
  // RC's cached data/identity can't be served to the next person on the device.
  setPendingLogout(true);
  try {
    const response = await fetch(apiUrl('/api/auth/rc/logout'), { credentials: 'include', method: 'POST' });
    if (response.ok) setPendingLogout(false);
  } catch { /* offline: the flag keeps the session shut until it can be revoked */ }
  finally { await clearApiCache(); }
}

// The everyday login: one username and password for the whole team. What comes
// back is a session with no identity on it — the caller must follow up with the
// picker and identifyAsRc() before the app can load anything.
export async function sharedLogin(username: string, password: string): Promise<void> {
  const response = await fetch(apiUrl('/api/auth/shared/login'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw await apiError(response, 'Login failed');
  // A fresh cookie retires whatever session the pending-logout flag was
  // guarding, and the next person's data must not come out of the previous
  // one's cache.
  setPendingLogout(false);
  await clearApiCache();
}

/** The names the picker offers. Needs a session — any session. */
export async function listRcRoster(): Promise<RcRosterEntry[]> {
  const response = await fetch(apiUrl('/api/auth/rc/roster'), { credentials: 'include' });
  if (!response.ok) throw await apiError(response, 'Could not load the RC list');
  return response.json() as Promise<RcRosterEntry[]>;
}

// Names the RC behind a shared session. Also the "switch RC" path, so it clears
// the response cache too: the previous coach's coachees and feedback history are
// in there, and serving them to the next one is the whole failure this avoids.
export async function identifyAsRc(rcId: string): Promise<{ id: string; name: string }> {
  const response = await fetch(apiUrl('/api/auth/rc/identify'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rcId }),
  });
  if (!response.ok) throw await apiError(response, 'Could not set the RC');
  await clearApiCache();
  return (await response.json() as { rc: { id: string; name: string } }).rc;
}

/** The API's error body turned into an Error the gate can render. */
async function apiError(response: Response, fallback: string): Promise<Error & { status?: number; retryAfterMs?: number }> {
  const data = await response.json().catch(() => ({})) as { error?: string; retryAfterMs?: number };
  const err = new Error(data.error || fallback) as Error & { status?: number; retryAfterMs?: number };
  err.status = response.status;
  err.retryAfterMs = data.retryAfterMs;
  return err;
}

export type GamesSyncStatus = {
  status: { at: string; ok: boolean; imported?: number; totalFetched?: number; error?: string } | null;
  newestGame: string;
  cron: string;
};

/** What the nightly VolleyManager import last did. Admin console only. */
export async function getGamesSyncStatus(): Promise<GamesSyncStatus> {
  const r = await fetch(apiUrl('/api/admin/games/sync-status'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<GamesSyncStatus>;
}

export async function getAdminAuthStatus(): Promise<AdminAuthStatus> {
  if (isDemoMode()) return demo.getAdminAuthStatus();
  const response = await fetch(apiUrl('/api/admin/auth/status'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<AdminAuthStatus>;
}

export async function logoutAdmin(): Promise<void> {
  await clearApiCache();
  const response = await fetch(apiUrl('/api/admin/auth/logout'), {
    credentials: 'include',
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function listCoachees(): Promise<Coachee[]> {
  if (isDemoMode()) return demo.listCoachees();
  const response = await fetch(apiUrl('/api/coachees'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<Coachee[]>;
}

export async function createCoachee(payload: Partial<Coachee>) {
  const response = await fetch(apiUrl('/api/coachees'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function updateCoachee(id: string, payload: Partial<Coachee>) {
  if (isDemoMode()) return demo.updateCoachee(id, payload);
  const response = await fetch(apiUrl(`/api/coachees/${id}`), {
    credentials: 'include',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function deleteCoachee(id: string) {
  const response = await fetch(apiUrl(`/api/coachees/${id}`), {
    credentials: 'include',
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function listCoacheeGames(coacheeId: string): Promise<CoacheeGame[]> {
  if (isDemoMode()) return demo.listCoacheeGames(coacheeId);
  const response = await fetch(apiUrl(`/api/coachees/${coacheeId}/games`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CoacheeGame[]>;
}

export async function listCoacheeFeedbacks(coacheeId: string): Promise<FeedbackRecord[]> {
  if (isDemoMode()) return demo.listCoacheeFeedbacks(coacheeId);
  const response = await fetch(apiUrl(`/api/coachees/${coacheeId}/feedbacks`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<FeedbackRecord[]>;
}

// ---- Private notes to the RC president ----
// Written by the coach on a feedback they have already filed; readable only by
// the coach who wrote it and the RC president. Never part of feedback_json, so
// it cannot reach the coachee's PDF or email.
export type PresidentNote = {
  id: string; note: string; gameId: string; teams: string; league: string;
  gameDate: string; coacheeName: string; rcName: string;
  /** Who wrote the note; differs from rcName when an admin wrote it. */
  authorName?: string;
  updatedAt: string;
};

export async function getPresidentNote(feedbackId: string): Promise<{ note: string }> {
  if (isDemoMode()) return demo.getPresidentNote();
  const r = await fetch(apiUrl(`/api/feedback/${encodeURIComponent(feedbackId)}/president-note`), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function savePresidentNote(feedbackId: string, note: string): Promise<void> {
  if (isDemoMode()) return demo.savePresidentNote();
  const r = await fetch(apiUrl(`/api/feedback/${encodeURIComponent(feedbackId)}/president-note`), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function listPresidentNotes(): Promise<PresidentNote[]> {
  const r = await fetch(apiUrl('/api/president-notes'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function loadCalendarGames(): Promise<CalendarGameStatus[]> {
  if (isDemoMode()) return demo.loadCalendarGames();
  const response = await fetch(apiUrl('/api/games/calendar-status'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CalendarGameStatus[]>;
}

export type IcalSubscription = {
  name: string;
  count: number;
  url: string;
  webcalUrl: string;
  downloadUrl: string;
};

// The feed lives on the API host, not on the app host, and its token is minted
// per RC — so the URLs are handed out by the server rather than assembled here.
// No demo branch: the demo makes zero backend calls, and a subscription link
// that resolves to nothing would be worse than not offering one.
// `rotate` mints a new token, which stops every calendar already subscribed to
// the old URL from resolving. That is the point: it is the only way to take a
// leaked feed link back, short of deactivating the coach.
export async function getIcalSubscription(lang: 'DE' | 'EN', rotate = false): Promise<IcalSubscription> {
  const response = await fetch(
    apiUrl(`/api/ical/me?lang=${lang.toLowerCase()}${rotate ? '&rotate=1' : ''}`),
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<IcalSubscription>;
}

export type RefereeCoachPerson = {
  id: string;
  fullName: string;
  // The endpoint has always sent it; the picker in the manual-game form is the
  // first caller that shows it, so a test game can be aimed at an address
  // whose inbox you can actually open.
  email?: string;
};

export async function listRefereeCoachPeople(): Promise<RefereeCoachPerson[]> {
  if (isDemoMode()) return demo.listRefereeCoachPeople();
  const response = await fetch(apiUrl('/api/referee-coach-people'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RefereeCoachPerson[]>;
}

/** Send the day-before reminder for one game now.
 *
 *  The unattended job runs at 10:00 the day before and only when the commission
 *  has switched it on; this is the coach saying "send it now" for a game they
 *  hold. Same template and same recipients, and it stamps the job's own dedupe
 *  key so tomorrow's run does not send it twice. */
export async function sendGameReminder(gameId: string): Promise<{ sent: number; suppressed: boolean; recipients: string[] }> {
  const r = await fetch(apiUrl(`/api/games/${gameId}/reminder`), { method: 'POST', credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not send the reminder');
  return r.json();
}

export async function assignRcToGame(gameId: string, assignedRc: string): Promise<void> {
  if (isDemoMode()) return demo.assignRcToGame(gameId, assignedRc);
  const response = await fetch(apiUrl(`/api/games/${gameId}/assign-rc`), {
    credentials: 'include',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignedRc }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

// Admin-only: highlight (or un-highlight) a game as one we want observed.
export async function setGameStarred(gameId: string, starred: boolean): Promise<void> {
  if (isDemoMode()) return demo.setGameStarred(gameId, starred);
  const r = await fetch(apiUrl(`/api/admin/games/${gameId}/star`), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred }),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function loadRcOverview(season?: number): Promise<RcOverviewEntry[]> {
  if (isDemoMode()) return demo.loadRcOverview();
  const qs = season != null ? `?season=${season}` : '';
  const response = await fetch(apiUrl(`/api/rc-overview${qs}`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RcOverviewEntry[]>;
}

export async function loadrcCoachSummary(rcName: string, season?: number): Promise<rcCoachSummary[]> {
  if (isDemoMode()) return demo.loadrcCoachSummary(rcName);
  const qs = season != null ? `?season=${season}` : '';
  const response = await fetch(apiUrl(`/api/rc-overview/${encodeURIComponent(rcName)}/coachees${qs}`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<rcCoachSummary[]>;
}

export type GamesSyncResult = { imported: number; renamed?: number; totalFetched: number; from: string; to: string };

export async function syncGames(payload?: { date?: string; from?: string; to?: string }): Promise<GamesSyncResult> {
  const response = await fetch(apiUrl('/api/games/sync'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    // The API answers {error} — reading the body as text put the raw JSON on
    // screen, braces and all, for the one reader who needs the sentence inside.
    throw new Error((await response.json().catch(() => ({}))).error || 'Could not sync games');
  }
  return response.json() as Promise<GamesSyncResult>;
}

// ── Admin console (simple-password gate) ──────────────────────────────
// One form, two credentials: the answer says which one was typed, because that
// decides whether the console opens on the admin tabs or the chair's two.
export async function adminUiLogin(username: string, password: string): Promise<'admin' | 'president'> {
  const r = await fetch(apiUrl('/api/admin/ui-login'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Login failed');
  return ((await r.json().catch(() => ({}))) as { role?: 'admin' | 'president' }).role || 'admin';
}

export type RcPerson = { id: string; first_name?: string; last_name?: string; email?: string; phone?: string; active?: boolean };


export async function listRcPeopleFull(): Promise<RcPerson[]> {
  const r = await fetch(apiUrl('/api/admin/rc-people'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function createRcPerson(p: Partial<RcPerson>) {
  const r = await fetch(apiUrl('/api/admin/rc-people'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function updateRcPerson(id: string, p: Partial<RcPerson>) {
  const r = await fetch(apiUrl(`/api/admin/rc-people/${id}`), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function deleteRcPerson(id: string) {
  const r = await fetch(apiUrl(`/api/admin/rc-people/${id}`), { method: 'DELETE', credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
}

// ── Manual games (admin) ──────────────────────────────────────────────
// For fixtures VolleyManager doesn't carry, and for throwaway games used to
// test the whole observation → PDF → e-mail flow against real infrastructure.
export type NewGame = {
  match_date: string;   // required: a bare YYYY-MM-DD
  /** HH:MM, read as Swiss wall-clock time by the server. Defaults to 20:00. */
  match_time?: string;
  match_no?: string;
  league?: string;
  location?: string;
  home_team?: string;
  away_team?: string;
  first_referee?: string;
  second_referee?: string;
  // The SV-Nr. behind each name, when it was picked off the roster rather than
  // typed. The server checks it against the roster before storing it.
  first_referee_id?: string;
  second_referee_id?: string;
  assigned_rc?: string;
};

// ── The referee roster ────────────────────────────────────────────────
// Every licensed referee, keyed by SV-Nr. — the Swiss Volley number. Coachees
// are a subset: a referee who is not one can stand on a game, but the feedback
// for them has no recipient, which is why the pickers say so.
//
// `id` is empty for a row that came from the VolleyManager fallback, which the
// server serves until the XLSX has been imported once — that list knows names
// and addresses but no numbers.
export type RosterReferee = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  level?: string;
  stage?: string;
  lrLevel?: string;
  association?: string;
  licenseActive?: boolean;
};
export type RefereeRoster = {
  source?: 'roster' | 'volleymanager';
  at?: string;
  people: RosterReferee[];
  error?: string;
};

export async function listReferees(): Promise<RefereeRoster> {
  const r = await fetch(apiUrl('/api/admin/referees'), { credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load the referee list');
  const d = (await r.json()) as Partial<RefereeRoster>;
  return { source: d.source, at: d.at, error: d.error, people: Array.isArray(d.people) ? d.people : [] };
}

// The SVRZ "Schiedsrichter verwalten" export, parsed in the browser and sent as
// rows. Upserted on sv_number, never on a name.
export type RefereeImportRow = {
  sv_number: string;
  first_name: string;
  last_name: string;
  full_name?: string;
  email?: string;
  phone?: string;
  gender?: string;
  level?: string;
  stage?: string;
  lr_level?: string;
  license_association?: string;
  license_active?: boolean;
  retired?: boolean;
  dispensed?: boolean;
  language?: string;
};
export type RefereeImportResult = {
  created: number; updated: number; skipped: number; total: number;
  // The second half of the import: coachee rows that now carry their SV-Nr.
  linked: number; alreadyLinked: number;
  unmatched: string[];
  // Coachees whose name answers to more than one referee. Nothing is written
  // for them — guessing puts one person's report in another's inbox.
  ambiguousNames: string[];
};

export async function importReferees(referees: RefereeImportRow[]): Promise<RefereeImportResult> {
  const r = await fetch(apiUrl('/api/admin/referees/import'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ referees }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Import failed');
  return r.json();
}

export async function createGame(game: NewGame): Promise<{ id: string; match_no?: string }> {
  const r = await fetch(apiUrl('/api/admin/games'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(game),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not create game');
  return r.json();
}

export async function deleteGame(id: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/admin/games/${id}`), { method: 'DELETE', credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not delete game');
}

export type ContactSyncResult = {
  refereesFetched: number; coachees: number; updated: number;
  alreadySet: number; notFound: number; missing: string[];
  // Names VolleyManager holds for more than one referee. Nothing is written for
  // these — guessing would put one person's report in another's inbox.
  ambiguous?: string[];
};

export async function syncCoacheeContacts(season: number, overwrite = false): Promise<ContactSyncResult> {
  const r = await fetch(apiUrl('/api/admin/coachees/sync-contacts'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ season, overwrite }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not sync contacts');
  return r.json();
}

export type ManualGame = { id: string; match_no: string; league: string; match_date: string; home_team: string; away_team: string; assigned_rc: string };

export async function listManualGames(q = ''): Promise<ManualGame[]> {
  const r = await fetch(apiUrl(`/api/admin/games/manual${q ? `?q=${encodeURIComponent(q)}` : ''}`), { credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load games');
  return r.json();
}

// ── Editable email templates (admin) ──────────────────────────────────
export type EmailTemplate = { subject: string; heading: string; intro: string; outro: string };
export type EmailTemplateKind = 'feedback' | 'reminder' | 'survey';
export type EmailTemplates = {
  feedback: EmailTemplate;
  reminder: EmailTemplate;
  survey: EmailTemplate;
  defaults: Record<EmailTemplateKind, EmailTemplate>;
  reminder_enabled: boolean;
  // Per kind — the survey notification knows nothing about halls or leagues.
  // A plain array is the pre-3-templates shape, which a cached response can
  // still be; read it as "the same list for every kind".
  placeholders: Record<string, string[]> | string[];
  // What the server will actually substitute, including the English aliases it
  // does not advertise. Absent on an older server — then the advertised list is
  // all we know.
  accepted?: Record<string, string[]>;
};

export function placeholdersFor(t: EmailTemplates, kind: EmailTemplateKind): string[] {
  if (Array.isArray(t.placeholders)) return t.placeholders;
  return t.placeholders?.[kind] ?? [];
}

/** The names that render — used to decide what to warn about, which is a
 *  different question from what to offer. */
export function acceptedPlaceholdersFor(t: EmailTemplates, kind: EmailTemplateKind): string[] {
  return t.accepted?.[kind] ?? placeholdersFor(t, kind);
}
export type ReminderPreview = {
  enabled: boolean;
  testMode: boolean;
  reminders: Array<{ gameId: string; role: string; to: string; cc: string[]; subject: string; text: string; coachee: string; rc: string; match: string }>;
};

export async function getEmailTemplates(): Promise<EmailTemplates> {
  const r = await fetch(apiUrl('/api/admin/email-templates'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function putEmailTemplates(payload: Partial<Record<EmailTemplateKind, EmailTemplate>> & { reminder_enabled?: boolean }): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/email-templates'), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed');
}
export async function getReminderPreview(): Promise<ReminderPreview> {
  const r = await fetch(apiUrl('/api/admin/reminders/preview'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Activity log (admin) ──────────────────────────────────────────────
export type LogEntry = {
  seq: number;
  t: string;
  lvl: 'debug' | 'info' | 'warn' | 'error';
  src: 'server' | 'client';
  evt: string;
  msg?: string;
  reqId?: string;
  sid?: string;
  did?: string;
  ip?: string;
  user?: string;
  data?: Record<string, unknown>;
};
export type LogSession = { sid: string; did?: string; user?: string; first: string; last: string; count: number; errors: number; ua?: string };
export type LogQuery = { limit?: number; since?: number; level?: string; src?: string; q?: string; sid?: string; evt?: string };

export async function getAdminLogs(opts: LogQuery = {}): Promise<{ entries: LogEntry[]; total: number; lastSeq: number; stats: { size: number; max: number; fileSink: boolean; dir: string } }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const r = await fetch(apiUrl(`/api/admin/logs?${qs}`), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getAdminLogSessions(): Promise<LogSession[]> {
  const r = await fetch(apiUrl('/api/admin/logs/sessions'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json() as { sessions: LogSession[] }).sessions;
}

export type ImportRow = { full_name?: string; first_name?: string; last_name?: string; email?: string; phone?: string; referee_level?: string; stage?: string; groups?: string; notes?: string };
export async function importCoachees(coachees: ImportRow[], season: number): Promise<{ created: number; updated: number; total: number }> {
  const r = await fetch(apiUrl('/api/coachees/import'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coachees, season }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// default_goal: observations a full mandate owes per season. rc_mandates lists
// the RCs (by RC person id) on a half mandate; everyone else is on a full one.
export type Settings = {
  default_season: number | null;
  test_mode?: boolean;
  groups?: string[];
  coachee_targets?: CoacheeTargetMap;
  rc_mandates?: RcMandateMap;
  default_goal?: number | null;
  // Only the rows an admin changed; everything else follows the official table
  // shipped in niveauTargets.ts.
  niveau_table?: NiveauMatrix;
};
export async function getSettings(): Promise<Settings> {
  if (isDemoMode()) return demo.getSettings();
  const r = await fetch(apiUrl('/api/settings'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function putSettings(payload: { default_season?: number; test_mode?: boolean; groups?: string[]; coachee_targets?: CoacheeTargetMap; rc_mandates?: RcMandateMap; default_goal?: number; niveau_table?: NiveauMatrix }): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/settings'), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
}


// ---- Signature sessions ----
export async function startSignature(context: string, signer?: string): Promise<{ slug: string }> {
  if (isDemoMode()) return demo.startSignature();
  const res = await fetch(apiUrl('/api/signature/start'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ context, signer }) });
  if (!res.ok) throw new Error('Could not start signature');
  return res.json();
}
export async function getSignatureSession(slug: string): Promise<{ context: string; signer: string; signed: boolean; data: string }> {
  if (isDemoMode()) return demo.getSignatureSession();
  const res = await fetch(apiUrl(`/api/signature/${encodeURIComponent(slug)}`));
  if (!res.ok) throw new Error('Signature not found');
  return res.json();
}
export async function submitSignatureSession(slug: string, data: string, signer?: string): Promise<void> {
  if (isDemoMode()) return demo.submitSignatureSession();
  const res = await fetch(apiUrl(`/api/signature/${encodeURIComponent(slug)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, signer }) });
  if (!res.ok) throw new Error('Could not save signature');
}

// ---- Post-visit survey (coachee's feedback on the RC) ----
// No demo branch: #/survey/<token> mounts its own root, which the demo never
// reaches, and a token only exists once a real feedback mail has gone out.
export async function getSurveySession(token: string): Promise<{ referee: string; date: string; matchNo: string; rc: string; submitted: boolean; form?: SurveyConfig }> {
  const res = await fetch(apiUrl(`/api/survey/${encodeURIComponent(token)}`));
  if (!res.ok) throw new Error('Survey not found');
  return res.json();
}
// The survey GET is served by the offline API cache like every other /api GET,
// so a returning coachee can be shown a form the server already considers
// answered. Distinguish that from a real failure instead of telling them to
// "try again" at something that will never succeed.
export class SurveyAlreadySubmitted extends Error {}
export async function submitSurvey(token: string, payload: { lang: string; anonymous: boolean; answers: Record<string, string> }): Promise<void> {
  const res = await fetch(apiUrl(`/api/survey/${encodeURIComponent(token)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.status === 409) throw new SurveyAlreadySubmitted('Survey already submitted');
  if (!res.ok) throw new Error('Could not save survey');
}
export type SurveyResponse = {
  id: string; referee: string; anonymous: boolean; date: string; matchNo: string;
  rc: string; lang: string; submittedAt: string; answers: Record<string, string>;
};
export async function listSurveyResponses(): Promise<{ form: SurveyConfig; responses: SurveyResponse[] }> {
  // ?form=1 asks for the questionnaire alongside the answers; an API that
  // predates it ignores the parameter and returns the bare array, handled below.
  const res = await fetch(apiUrl('/api/survey-responses?form=1'), { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load survey responses');
  const raw = await res.json();
  // A bare array is the shape before the form travelled along, which an offline
  // cache can still hand back.
  if (Array.isArray(raw)) return { form: normalizeSurveyConfig(null), responses: raw };
  return { form: normalizeSurveyConfig(raw?.form), responses: Array.isArray(raw?.responses) ? raw.responses : [] };
}

// ── The survey form itself (admin) ────────────────────────────────────
// Reading is admin-gated, so the chair's response list gets its labels from the
// copy that rides along with each response request instead.
export async function getSurveyConfig(): Promise<{ config: SurveyConfig; defaults: SurveyConfig }> {
  const r = await fetch(apiUrl('/api/admin/survey-config'), { credentials: 'include' });
  if (!r.ok) throw await apiError(r, 'Could not load the questionnaire');
  const raw = await r.json();
  return { config: normalizeSurveyConfig(raw?.config), defaults: normalizeSurveyConfig(raw?.defaults) };
}

export async function putSurveyConfig(config: SurveyConfig): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/survey-config'), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
  });
  if (!r.ok) throw await apiError(r, 'Save failed');
}

// Which RCs see the #/admin shortcut in their toolbar. Cosmetic only: the name
// on a session is picked, not proven, so this cannot gate anything.
export async function getAdminShortcutRcs(): Promise<string[]> {
  const r = await fetch(apiUrl('/api/admin/shortcut-rcs'), { credentials: 'include' });
  if (!r.ok) throw await apiError(r, 'Could not load the list');
  return (await r.json() as { rcIds: string[] }).rcIds ?? [];
}

export async function setAdminShortcutRcs(rcIds: string[]): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/shortcut-rcs'), {
    credentials: 'include', method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rcIds }),
  });
  if (!r.ok) throw await apiError(r, 'Could not save the list');
}

// ── Credentials (admin console) ───────────────────────────────────────
export type CredentialSlotInfo = {
  slot: 'shared' | 'admin' | 'president';
  username: string;
  source: 'db' | 'env' | 'unset';
  updatedAt: string | null;
  updatedBy: string | null;
};

export async function getCredentials(): Promise<{ slots: CredentialSlotInfo[]; minLength: number }> {
  const r = await fetch(apiUrl('/api/admin/credentials'), { credentials: 'include' });
  if (!r.ok) throw await apiError(r, 'Could not load the credentials');
  return r.json() as Promise<{ slots: CredentialSlotInfo[]; minLength: number }>;
}

// Step one of a password change: the server mails a code and tells us, in
// masked form, where it went — so the person changing it can tell at a glance
// whether they are going to receive it.
export async function requestCredentialCode(slot: string): Promise<{ sentTo: string }> {
  const r = await fetch(apiUrl('/api/admin/credentials/challenge'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot }),
  });
  if (!r.ok) throw await apiError(r, 'Could not send the confirmation code');
  return r.json() as Promise<{ sentTo: string }>;
}

// Step two. `feedsRevoked` comes back true when the team password moved, which
// also invalidates every calendar subscription URL — worth saying out loud,
// because coaches will need a new link.
export async function setCredential(
  slot: string, username: string, password: string, code: string,
): Promise<{ feedsRevoked?: boolean }> {
  const r = await fetch(apiUrl('/api/admin/credentials'), {
    credentials: 'include',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot, username, password, code }),
  });
  if (!r.ok) throw await apiError(r, 'Could not save the password');
  return r.json() as Promise<{ feedsRevoked?: boolean }>;
}
