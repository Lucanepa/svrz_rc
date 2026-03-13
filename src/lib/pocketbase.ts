import type { EligibleGame, FeedbackFormData, RcOverviewEntry, RcCoacheeSummary } from '../types';

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
  const response = await fetch('/api/eligible-games');
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
  const response = await fetch('/api/feedback/submit', {
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
  const response = await fetch('/api/admin/auth/status');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<AdminAuthStatus>;
}

export async function loginAdmin(payload: { email: string; password: string }): Promise<AdminAuthStatus> {
  const response = await fetch('/api/admin/auth/login', {
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
  const response = await fetch('/api/admin/auth/logout', {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function listCoachees(): Promise<Coachee[]> {
  const response = await fetch('/api/coachees');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<Coachee[]>;
}

export async function createCoachee(payload: Partial<Coachee>) {
  const response = await fetch('/api/coachees', {
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
  const response = await fetch(`/api/coachees/${id}`, {
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
  const response = await fetch(`/api/coachees/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function listRefereeCoaches() {
  const response = await fetch('/api/referee-coaches');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function listCoacheeGames(coacheeId: string): Promise<CoacheeGame[]> {
  const response = await fetch(`/api/coachees/${coacheeId}/games`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CoacheeGame[]>;
}

export async function listCoacheeFeedbacks(coacheeId: string): Promise<FeedbackRecord[]> {
  const response = await fetch(`/api/coachees/${coacheeId}/feedbacks`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<FeedbackRecord[]>;
}

export async function loadCalendarGames(): Promise<CalendarGameStatus[]> {
  const response = await fetch('/api/games/calendar-status');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<CalendarGameStatus[]>;
}

export async function deleteRefereeCoach(id: string) {
  const response = await fetch(`/api/referee-coaches/${id}`, {
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
  const response = await fetch('/api/referee-coach-people');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RefereeCoachPerson[]>;
}

export async function assignRcToGame(gameId: string, assignedRc: string): Promise<void> {
  const response = await fetch(`/api/games/${gameId}/assign-rc`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignedRc }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function loadRcOverview(): Promise<RcOverviewEntry[]> {
  const response = await fetch('/api/rc-overview');
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RcOverviewEntry[]>;
}

export async function loadRcCoacheeSummary(rcName: string): Promise<RcCoacheeSummary[]> {
  const response = await fetch(`/api/rc-overview/${encodeURIComponent(rcName)}/coachees`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<RcCoacheeSummary[]>;
}

export async function syncGamesFromVolleyManager(payload?: { date?: string; from?: string; to?: string }) {
  const response = await fetch('/api/games/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}
