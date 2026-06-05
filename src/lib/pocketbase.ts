import type { EligibleGame, FeedbackFormData, RcOverviewEntry, rcCoachSummary } from '../types';

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
    throw new Error(`Failed to save feedback: ${text}`);
  }
  return response.json() as Promise<FeedbackSubmitResponse>;
}

export function hasPocketBaseConfig(): boolean {
  return true;
}

export async function getAdminAuthStatus(): Promise<AdminAuthStatus> {
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
  return {
    authenticated: true,
    email: result.email || payload.email,
  };
}

export async function logoutAdmin(): Promise<void> {
  const response = await fetch(apiUrl('/api/admin/auth/logout'), {
    credentials: 'include',
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function listCoachees(): Promise<Coachee[]> {
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
  const response = await fetch(apiUrl(`/api/coachees/${coacheeId}/games`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CoacheeGame[]>;
}

export async function listCoacheeFeedbacks(coacheeId: string): Promise<FeedbackRecord[]> {
  const response = await fetch(apiUrl(`/api/coachees/${coacheeId}/feedbacks`), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<FeedbackRecord[]>;
}

export async function loadCalendarGames(): Promise<CalendarGameStatus[]> {
  const response = await fetch(apiUrl('/api/games/calendar-status'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CalendarGameStatus[]>;
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
  const response = await fetch(apiUrl('/api/referee-coach-people'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RefereeCoachPerson[]>;
}

export async function assignRcToGame(gameId: string, assignedRc: string): Promise<void> {
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

export async function loadRcOverview(): Promise<RcOverviewEntry[]> {
  const response = await fetch(apiUrl('/api/rc-overview'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RcOverviewEntry[]>;
}

export async function loadrcCoachSummary(rcName: string): Promise<rcCoachSummary[]> {
  const response = await fetch(apiUrl(`/api/rc-overview/${encodeURIComponent(rcName)}/coachees`), { credentials: 'include' });
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

export type ImportRow = { full_name?: string; first_name?: string; last_name?: string; referee_level?: string; stage?: string; groups?: string };
export async function importCoachees(coachees: ImportRow[], season: number): Promise<{ created: number; updated: number; total: number }> {
  const r = await fetch(apiUrl('/api/coachees/import'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coachees, season }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getSettings(): Promise<{ default_season: number | null; test_mode?: boolean }> {
  const r = await fetch(apiUrl('/api/settings'), { credentials: 'include' });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function putSettings(payload: { default_season?: number; test_mode?: boolean }): Promise<void> {
  const r = await fetch(apiUrl('/api/admin/settings'), {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
}
