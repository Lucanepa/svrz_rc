import { useState } from 'react';
import { ArrowLeftRight, Clock } from 'lucide-react';
import { answerSwitch, useSwitchRequests, type SwitchGame, type SwitchRequestView } from '../lib/switchRequests';
import { shortDayLabel, timeLabel, dayTimeLabel } from '../lib/appTime';
import { confirmDialog, toast } from './ui';

/**
 * Home: switch requests (asked 2026-10-10). Another coach asking THIS coach to
 * hand a coachee over to an earlier game — Annehmen / Ablehnen right here — and
 * this coach's own requests: still waiting (Zurückziehen), or what became of
 * them in the last three days. Renders nothing while there is nothing to say.
 */
export default function SwitchRequestsHome({ lang, onChanged }: { lang: 'DE' | 'EN'; onChanged: () => void }) {
  const de = lang === 'DE';
  const { incoming, outgoing } = useSwitchRequests();
  const [busy, setBusy] = useState('');
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const when = (g: SwitchGame) => (g.date ? `${shortDayLabel(g.date, lang)} ${timeLabel(g.date)}`.trim() : `#${g.matchNo}`);
  const gameLine = (g: SwitchGame) => `${when(g)} · ${g.teams || `#${g.matchNo}`}`;

  const act = async (r: SwitchRequestView, action: 'accept' | 'decline' | 'cancel') => {
    if (action === 'accept') {
      const ok = await confirmDialog({
        title: de ? 'Tausch annehmen?' : 'Accept the switch?',
        message: de
          ? `${r.requester} beobachtet ${r.coacheeName} am ${when(r.toGame)}. Auf deinem Spiel am ${when(r.fromGame)} wird ${r.coacheeName} freigegeben.`
          : `${r.requester} observes ${r.coacheeName} on ${when(r.toGame)}. ${r.coacheeName} is released from your game on ${when(r.fromGame)}.`,
        confirmLabel: de ? 'Annehmen' : 'Accept',
        cancelLabel: de ? 'Abbrechen' : 'Cancel',
      });
      if (!ok) return;
    }
    setBusy(r.id);
    try {
      await answerSwitch(r.id, action);
      toast.success(action === 'accept'
        ? (de ? `${r.coacheeName} ist an ${r.requester} übergeben.` : `${r.coacheeName} handed over to ${r.requester}.`)
        : action === 'decline'
          ? (de ? 'Anfrage abgelehnt.' : 'Request declined.')
          : (de ? 'Anfrage zurückgezogen.' : 'Request withdrawn.'));
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      onChanged();
    } finally {
      setBusy('');
    }
  };

  const statusText = (r: SwitchRequestView) => {
    switch (r.status) {
      case 'pending': return de ? `Wartet auf ${r.holder} · bis ${dayTimeLabel(r.expiresAt)}` : `Waiting for ${r.holder} · until ${dayTimeLabel(r.expiresAt)}`;
      case 'accepted': return de ? `${r.holder} hat zugestimmt — das Spiel ist bei dir.` : `${r.holder} agreed — the game is yours.`;
      case 'declined': return de ? `${r.holder} hat abgelehnt.` : `${r.holder} declined.`;
      case 'cancelled': return de ? 'Von dir zurückgezogen.' : 'Withdrawn by you.';
      case 'expired': return de ? `${r.holder} hat nicht rechtzeitig geantwortet.` : `${r.holder} did not answer in time.`;
      case 'failed': return de ? `Nicht möglich: ${r.outcome}` : `Not possible: ${r.outcome}`;
    }
  };

  const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold disabled:opacity-50';

  return (
    <section data-testid="switch-requests-home" className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{de ? 'Tauschanfragen' : 'Switch requests'}</h3>
      {incoming.map((r) => (
        <div key={r.id} data-testid="switch-incoming" className="rounded-lg border border-stone-200 border-l-[3px] border-l-amber-500 bg-white px-3 py-2.5">
          <p className="flex items-start gap-1.5 text-sm text-stone-800">
            <ArrowLeftRight size={14} className="mt-0.5 shrink-0 text-amber-600" />
            <span>
              {de
                ? <><b>{r.requester}</b> möchte <b>{r.coacheeName}</b> früher beobachten.</>
                : <><b>{r.requester}</b> would like to observe <b>{r.coacheeName}</b> earlier.</>}
            </span>
          </p>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-stone-400">{de ? 'Früher' : 'Earlier'}</dt><dd className="text-stone-700">{gameLine(r.toGame)}</dd>
            <dt className="text-stone-400">{de ? 'Dein Spiel' : 'Your game'}</dt><dd className="text-stone-700">{gameLine(r.fromGame)}</dd>
          </dl>
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-stone-400">
            <Clock size={11} /> {de ? `Antwort bis ${dayTimeLabel(r.expiresAt)} — ohne Antwort bleibt alles, wie es ist.` : `Answer by ${dayTimeLabel(r.expiresAt)} — without an answer nothing changes.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" disabled={busy === r.id} onClick={() => void act(r, 'accept')} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>
              {de ? 'Annehmen' : 'Accept'}
            </button>
            <button type="button" disabled={busy === r.id} onClick={() => void act(r, 'decline')} className={`${btn} border border-stone-200 font-medium text-stone-600 hover:bg-stone-100`}>
              {de ? 'Ablehnen' : 'Decline'}
            </button>
          </div>
        </div>
      ))}
      {outgoing.map((r) => (
        <div key={r.id} data-testid="switch-outgoing" data-status={r.status} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
          <p className="text-sm text-stone-800">
            {de ? <>Tausch für <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</> : <>Switch for <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</>}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
            <p className={`text-xs ${r.status === 'accepted' ? 'text-emerald-700' : r.status === 'pending' ? 'text-stone-500' : 'text-amber-700'}`}>{statusText(r)}</p>
            {r.status === 'pending' && (
              <button type="button" disabled={busy === r.id} onClick={() => void act(r, 'cancel')} className={`${btn} border border-stone-200 font-medium text-stone-600 hover:bg-stone-100`}>
                {de ? 'Zurückziehen' : 'Withdraw'}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
