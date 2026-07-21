import type { EligibleGame, FeedbackFormData, RcOverviewEntry, rcCoachSummary } from '../types';
import type { CoacheeTargetMap } from './niveauTargets';
import * as demo from './demo';
import { isDemoMode } from './demo';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

function apiUrl(path: string): string {
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
};

export async function saveFeedbackToPocketBase(params: {
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

export function hasPocketBaseConfig(): boolean {
  return true;
}

// ── Per-RC PIN auth ───────────────────────────────────────────────────
export type AuthMe = { rc: { id: string; name: string } | null; admin: { email: string } | null; surveyReader?: boolean };

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

export async function rcLogin(email: string, password: string): Promise<{ name: string }> {
  const response = await fetch(apiUrl('/api/auth/rc/login'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error((data as { error?: string }).error || 'Login failed') as Error & { status?: number; retryAfterMs?: number };
    err.status = response.status;
    err.retryAfterMs = (data as { retryAfterMs?: number }).retryAfterMs;
    throw err;
  }
  // New identity — drop any previous user's cached responses.
  await clearApiCache();
  return response.json() as Promise<{ name: string }>;
}

export async function rcLogout(): Promise<void> {
  // Leaving the demo is a pure client action — never touch the server.
  if (isDemoMode()) { demo.disableDemo(); await clearApiCache(); return; }
  // Purge the cache even if the logout POST fails (offline), so the previous
  // RC's cached data/identity can't be served to the next person on the device.
  try { await fetch(apiUrl('/api/auth/rc/logout'), { credentials: 'include', method: 'POST' }); }
  finally { await clearApiCache(); }
}

// Forgot password, step 1: request an email OTP. The 200 body carries no signal
// (the server never reveals whether the address is registered), but the STATUS
// does — a 429 means no code was sent. Ignoring that told people "check your
// inbox" for a mail that was never going to arrive.
export async function rcForgotStart(email: string): Promise<void> {
  const r = await fetch(apiUrl('/api/auth/rc/forgot/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error((data as { error?: string }).error || 'Reset start failed') as Error & { status?: number; retryAfterMs?: number };
    err.status = r.status;
    err.retryAfterMs = (data as { retryAfterMs?: number }).retryAfterMs;
    throw err;
  }
}

// Forgot password, step 2: verify the emailed code and set the chosen password.
export async function rcForgotVerify(email: string, code: string, newPassword: string): Promise<void> {
  const r = await fetch(apiUrl('/api/auth/rc/forgot/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, newPassword }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error((data as { error?: string }).error || 'Verification failed') as Error & { status?: number; retryAfterMs?: number };
    err.status = r.status;
    err.retryAfterMs = (data as { retryAfterMs?: number }).retryAfterMs;
    throw err;
  }
}

export async function getAdminAuthStatus(): Promise<AdminAuthStatus> {
  if (isDemoMode()) return demo.getAdminAuthStatus();
  const response = await fetch(apiUrl('/api/admin/auth/status'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<AdminAuthStatus>;
}

export async function loginAdmin(payload: { email: string; password: string }): Promise<AdminAuthStatus> {
  const response = await fetch(apiUrl('/api/admin/auth/login'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json() as { email?: string };
  // Identity change — drop the previous identity's cached responses.
  await clearApiCache();
  return {
    authenticated: true,
    email: result.email || payload.email,
  };
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

export async function listRefereeCoaches() {
  const response = await fetch(apiUrl('/api/referee-coaches'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
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
export async function getIcalSubscription(lang: 'DE' | 'EN'): Promise<IcalSubscription> {
  const response = await fetch(apiUrl(`/api/ical/me?lang=${lang.toLowerCase()}`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<IcalSubscription>;
}

export async function deleteRefereeCoach(id: string) {
  const response = await fetch(apiUrl(`/api/referee-coaches/${id}`), {
    credentials: 'include',
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export type RefereeCoachPerson = {
  id: string;
  fullName: string;
};

export async function listRefereeCoachPeople(): Promise<RefereeCoachPerson[]> {
  if (isDemoMode()) return demo.listRefereeCoachPeople();
  const response = await fetch(apiUrl('/api/referee-coach-people'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RefereeCoachPerson[]>;
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

export async function syncGames(payload?: { date?: string; from?: string; to?: string }) {
  const response = await fetch(apiUrl('/api/games/sync'), {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

// ── Admin console (simple-password gate) ──────────────────────────────
export async function adminUiLogin(password: string): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/ui-login'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Login failed');
}

export type RcPerson = { id: string; first_name?: string; last_name?: string; email?: string; phone?: string; active?: boolean; has_pin?: boolean; is_admin?: boolean };

export async function generateRcPin(id: string): Promise<{ pin: string; emailed: boolean; email: string }> {
  const r = await fetch(apiUrl(`/api/admin/rc-people/${id}/pin`), { method: 'POST', credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'PIN generation failed');
  return (await r.json()) as { pin: string; emailed: boolean; email: string };
}

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
  match_date: string;   // required, ISO
  match_no?: string;
  league?: string;
  location?: string;
  home_team?: string;
  away_team?: string;
  first_referee?: string;
  second_referee?: string;
  assigned_rc?: string;
};

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
export type EmailTemplates = {
  feedback: EmailTemplate;
  reminder: EmailTemplate;
  defaults: { feedback: EmailTemplate; reminder: EmailTemplate };
  reminder_enabled: boolean;
  placeholders: string[];
};
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
export async function putEmailTemplates(payload: { feedback?: EmailTemplate; reminder?: EmailTemplate; reminder_enabled?: boolean }): Promise<void> {
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

export type ImportRow = { full_name?: string; first_name?: string; last_name?: string; email?: string; referee_level?: string; stage?: string; groups?: string; notes?: string };
export async function importCoachees(coachees: ImportRow[], season: number): Promise<{ created: number; updated: number; total: number }> {
  const r = await fetch(apiUrl('/api/coachees/import'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coachees, season }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getSettings(): Promise<{ default_season: number | null; test_mode?: boolean; groups?: string[]; coachee_targets?: CoacheeTargetMap }> {
  if (isDemoMode()) return demo.getSettings();
  const r = await fetch(apiUrl('/api/settings'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function putSettings(payload: { default_season?: number; test_mode?: boolean; groups?: string[]; coachee_targets?: CoacheeTargetMap }): Promise<void> {
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
export async function getSurveySession(token: string): Promise<{ referee: string; date: string; matchNo: string; rc: string; submitted: boolean }> {
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
export async function listSurveyResponses(): Promise<SurveyResponse[]> {
  const res = await fetch(apiUrl('/api/survey-responses'), { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load survey responses');
  return res.json();
}
