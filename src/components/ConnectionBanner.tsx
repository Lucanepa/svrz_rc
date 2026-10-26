import { useEffect, useState, useSyncExternalStore } from 'react';
import { History, SignalLow, WifiOff } from 'lucide-react';
import { connection, type ConnectionState } from '../lib/connection';
import { getStoredLang, type Lang } from '../lib/prefs';

// The network's own voice. Every line names the connection, never the app:
// the point is that a coach in a hall with one bar of signal knows it is the
// signal, and does not report the app as broken or start the form again.
const TEXT: Record<Exclude<ConnectionState, 'ok'>, Record<Lang, string>> = {
  slow: {
    DE: 'Langsames Netz – der Server antwortet über deine Verbindung gerade kaum. Die App wartet weiter.',
    EN: 'Slow network – your connection is barely reaching the server. The app keeps waiting.',
  },
  stale: {
    DE: 'Keine Antwort über dein Netz – du siehst die zuletzt geladenen Daten.',
    EN: 'No answer over your network – showing the last-loaded data.',
  },
  unreachable: {
    DE: 'Keine Verbindung zum Server – bitte WLAN oder Mobilnetz prüfen.',
    EN: 'No connection to the server – please check Wi-Fi or mobile data.',
  },
  offline: {
    DE: 'Offline – dein Gerät hat gerade kein Netz.',
    EN: 'Offline – your device has no network right now.',
  },
};

const ICON = { slow: SignalLow, stale: History, unreachable: WifiOff, offline: WifiOff } as const;

/** How long a note stays up. It is said once, then gets out of the way: on
 *  26.10.2026 it sat over the Observe / Reminder buttons for the whole visit to
 *  a garage. Pointer-transparent or not, a button you cannot see is not one
 *  you tap. */
export const BANNER_VISIBLE_MS = 6000;

/** How long the network has to be fine again before a note already said is
 *  said again. Without it a connection that flickers would put the same note
 *  back up on every request. */
export const BANNER_REARM_MS = 30000;

export default function ConnectionBanner() {
  const state = useSyncExternalStore(
    (cb) => connection.subscribe(cb),
    () => connection.get(),
    () => 'ok' as ConnectionState,
  );
  // The notes already said and taken down: each is said once, and they all
  // come back only once the network has been fine for BANNER_REARM_MS. A
  // retry that flips "slow" and "no connection" back and forth would
  // otherwise put a note up on every flip.
  const [said, setSaid] = useState<readonly ConnectionState[]>([]);
  const done = said.includes(state);
  useEffect(() => {
    if (state === 'ok') {
      if (said.length === 0) return;
      const t = setTimeout(() => setSaid([]), BANNER_REARM_MS);
      return () => clearTimeout(t);
    }
    if (done) return;
    const t = setTimeout(() => setSaid((prev) => [...prev, state]), BANNER_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [state, said, done]);
  if (state === 'ok' || done) return null;
  const lang: Lang = getStoredLang() ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE');
  const Icon = ICON[state];
  const severe = state === 'unreachable' || state === 'offline';
  return (
    // Pointer-transparent and above the page, not in its flow: it comes and
    // goes with every slow request, and must neither shift the layout nor
    // swallow a tap meant for the header underneath.
    <div
      className="no-print fixed inset-x-0 top-0 z-[70] flex justify-center px-3 pointer-events-none"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))' }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="connection-banner"
        data-state={state}
        className={`flex max-w-md items-start gap-2 rounded-xl border px-3 py-2 text-xs font-medium shadow-md ${
          severe ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}
      >
        <Icon size={14} className="mt-px shrink-0" />
        <span>{TEXT[state][lang]}</span>
      </div>
    </div>
  );
}
