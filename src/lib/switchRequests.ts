import { useSyncExternalStore } from 'react';
import { apiUrl } from './pocketbase';
import { isDemoMode } from './demo';

// Switch requests (asked 2026-10-10): a coach asks the holder of a coachee's
// LATER booking to hand the coachee over to an EARLIER game. Nothing moves
// until the holder accepts. One small store, because two places read the same
// list — the Home card that answers them, and the games list that turns
// "Tausch anfragen" into "Tausch angefragt" — and the live stream refreshes it.

export type SwitchGame = { id: string; matchNo: string; date: string; teams: string; league: string; location: string };

export type SwitchStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';

export type SwitchRequestView = {
  id: string;
  status: SwitchStatus;
  coacheeId: string;
  coacheeName: string;
  /** The earlier game the requester wants. */
  toGame: SwitchGame;
  /** The holder's later booking. */
  fromGame: SwitchGame;
  requester: string;
  requesterId: string;
  holder: string;
  holderId: string;
  expiresAt: string;
  createdAt: string;
  decidedAt: string;
  /** For `failed`: why it could not be carried out. */
  outcome: string;
};

export type SwitchLists = { incoming: SwitchRequestView[]; outgoing: SwitchRequestView[] };

const EMPTY: SwitchLists = { incoming: [], outgoing: [] };
let state: SwitchLists = EMPTY;
const listeners = new Set<() => void>();

function set(next: SwitchLists) {
  state = next;
  for (const l of listeners) l();
}

/** Both lists, re-rendering whenever they change. */
export function useSwitchRequests(): SwitchLists {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => EMPTY,
  );
}

async function errorOf(r: Response): Promise<Error> {
  const body = await r.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error || `HTTP ${r.status}`);
}

let inFlight: Promise<void> | null = null;

/** Re-read both lists. Quiet on failure: a Home without its switch card is
 *  still a Home, and the next refresh tries again. The demo makes no calls. */
export function refreshSwitchRequests(): Promise<void> {
  if (isDemoMode()) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      const r = await fetch(apiUrl('/api/switch-requests'), { credentials: 'include' });
      if (!r.ok) return;
      // Only a body of the right shape: an API older than the endpoint answers
      // something else, and a list that is not one would take Home down.
      const body = await r.json().catch(() => null) as Partial<SwitchLists> | null;
      if (body && Array.isArray(body.incoming) && Array.isArray(body.outgoing)) set({ incoming: body.incoming, outgoing: body.outgoing });
    } catch { /* offline: keep what we have */ }
    finally { inFlight = null; }
  })();
  return inFlight;
}

/** Forget everything — on sign-out, so the next coach does not see them. */
export function clearSwitchRequests() {
  set(EMPTY);
}

/** Ask the holder of the coachee's later booking to hand it over to this game. */
export async function requestSwitch(gameId: string): Promise<SwitchRequestView> {
  // The demo promises zero backend calls.
  if (isDemoMode()) throw new Error('Demo: Tauschanfragen sind hier ausgeschaltet. · Switch requests are off in the demo.');
  const r = await fetch(apiUrl('/api/switch-requests'), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId }),
  });
  if (!r.ok) throw await errorOf(r);
  const view = await r.json() as SwitchRequestView;
  void refreshSwitchRequests();
  return view;
}

/** Accept or decline (the holder), or withdraw (the requester). */
export async function answerSwitch(id: string, action: 'accept' | 'decline' | 'cancel'): Promise<SwitchRequestView> {
  if (isDemoMode()) throw new Error('Demo: Tauschanfragen sind hier ausgeschaltet. · Switch requests are off in the demo.');
  const r = await fetch(apiUrl(`/api/switch-requests/${encodeURIComponent(id)}/${action}`), {
    method: 'POST', credentials: 'include',
  });
  // Whatever the answer, the lists have moved (a failed accept closes the request too).
  void refreshSwitchRequests();
  if (!r.ok) throw await errorOf(r);
  return await r.json() as SwitchRequestView;
}

/** The pending request this coach made for a game, if any. */
export function pendingFor(lists: SwitchLists, gameId: string): SwitchRequestView | undefined {
  return lists.outgoing.find((r) => r.status === 'pending' && r.toGame.id === gameId);
}
