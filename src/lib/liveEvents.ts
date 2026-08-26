import { apiUrl } from './pocketbase';
import { isDemoMode } from './demo';
import { clientLog } from './logger';

// The other half of /api/events: the API says an assignment changed the moment
// it happens, instead of every client asking again on a timer.
//
// The poll is NOT replaced by this. A stream is the first thing a hotel WiFi, a
// corporate proxy or a backgrounded iOS tab breaks, and a coach whose stream
// died silently must not be the last to know a game is gone. So this reports
// whether it is connected, the poll slows down while it is, and everything keeps
// working if it never connects at all.

export type LiveEvent =
  | { type: 'game.assignment'; gameId: string; matchNo: string; assignedRc: string }
  | { type: 'games.synced'; imported: number; renamed: number }
  | { type: 'settings.changed'; keys: string[] };

type Listener = (event: LiveEvent) => void;
type StatusListener = (connected: boolean) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let source: EventSource | null = null;
let connected = false;
// EventSource retries by itself, tirelessly. That is right for a dropped
// connection and wrong for a refusal: a session that expired answers /api/events
// with JSON, and the browser would reopen it every few seconds for as long as
// the tab stays open. After a few failures in a row this backs off to once a
// minute, and a window coming back to the foreground tries again immediately.
let failures = 0;
let retryTimer: number | null = null;
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 60_000;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of statusListeners) listener(next);
}

function open() {
  if (source || typeof EventSource === 'undefined') return;
  // Cross-origin in production (the API is its own hostname), so the session
  // cookie only travels with credentials — CORS there already allows this origin.
  source = new EventSource(apiUrl('/api/events'), { withCredentials: true });
  source.onopen = () => {
    failures = 0;
    setConnected(true);
    clientLog.info('live.open', 'event stream open');
  };
  source.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(message.data) as LiveEvent;
    } catch {
      return; // a frame we cannot read is not worth a broken listener
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        clientLog.warn('live.listener', 'listener threw', { error: String(error) });
      }
    }
  };
  source.onerror = () => {
    // Stop claiming the stream is live, so the poll speeds back up.
    setConnected(false);
    failures += 1;
    if (failures < FAILURES_BEFORE_BACKOFF) return; // a blip: let the browser retry
    clientLog.warn('live.error', 'event stream failing, backing off', { failures });
    close();
    if (retryTimer === null && listeners.size > 0) {
      retryTimer = window.setTimeout(() => { retryTimer = null; failures = 0; open(); }, BACKOFF_MS);
    }
  };
}

function close() {
  source?.close();
  source = null;
  setConnected(false);
}

// A window coming back is the moment a suspended stream is worth retrying — the
// same moment the poll refreshes. Waiting out the backoff there would leave the
// coach on stale data for no reason.
function onWake() {
  if (document.visibilityState !== 'visible' || listeners.size === 0 || source) return;
  if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; }
  failures = 0;
  open();
}

/** Listen for pushed changes. Returns an unsubscribe. The stream is opened on
 *  the first subscriber and closed after the last one leaves. */
export function subscribeLive(listener: Listener, onStatus?: StatusListener): () => void {
  if (isDemoMode()) return () => {}; // the demo talks to no backend at all
  listeners.add(listener);
  if (onStatus) {
    statusListeners.add(onStatus);
    onStatus(connected);
  }
  open();
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onWake);
  return () => {
    listeners.delete(listener);
    if (onStatus) statusListeners.delete(onStatus);
    if (listeners.size === 0) {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; }
      close();
    }
  };
}

export function isLiveConnected(): boolean {
  return connected;
}
