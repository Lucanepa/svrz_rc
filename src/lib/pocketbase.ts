import type { EligibleGame, FeedbackFormData } from '../types';

type Coachee = {
  id: string;
  full_name: string;
  email?: string;
  level?: string;
  group?: string;
  feedback_entries?: unknown[];
};

export async function loadEligibleGames(): Promise<EligibleGame[]> {
  const response = await fetch('/api/eligible-games');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load eligible games: ${text}`);
  }
  return response.json() as Promise<EligibleGame[]>;
}

export async function saveFeedbackToPocketBase(params: {
  game: EligibleGame;
  role: FeedbackFormData['role'];
  formData: FeedbackFormData;
}): Promise<void> {
  const response = await fetch('/api/feedback/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId: params.game.id,
      role: params.role,
      formData: params.formData,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to save feedback: ${text}`);
  }
}

export function hasPocketBaseConfig(): boolean {
  return true;
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

export async function deleteRefereeCoach(id: string) {
  const response = await fetch(`/api/referee-coaches/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
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
