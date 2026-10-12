import { useState } from 'react';
import { ArrowLeftRight, ChevronRight, Clock } from 'lucide-react';
import { answerSwitch, isOpenRequest, useSwitchRequests, type SwitchGame, type SwitchRequestView } from '../lib/switchRequests';
import { shortDayLabel, timeLabel, dayTimeLabel } from '../lib/appTime';
import { confirmDialog, toast } from './ui';

/**
 * Switch requests (asked 2026-10-10), in two places since 12.10.2026:
 *
 * - Home (default export): only what is still OPEN — another coach asking THIS
 *   coach to hand a coachee over to an earlier game (Annehmen / Ablehnen right
 *   here), and this coach's own requests still waiting (Zurückziehen). Renders
 *   nothing while there is nothing open. Luca: "in home only pending".
 * - The Tausch tab (SwitchRequestsTab): the same open ones first, then every
 *   request the coach was part of that has been decided, on either side.
 */

type Lang = 'DE' | 'EN';
type Action = 'accept' | 'decline' | 'cancel';
/** tsconfig has no `strict`, and without it a function component's props do
 *  not take `key` — same idiom as GameRow.tsx. */
type Keyed = { key?: string | number };

const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold disabled:opacity-50';

function useLabels(lang: Lang) {
  const when = (g: SwitchGame) => (g.date ? `${shortDayLabel(g.date, lang)} ${timeLabel(g.date)}`.trim() : `#${g.matchNo}`);
  const gameLine = (g: SwitchGame) => `${when(g)} · ${g.teams || `#${g.matchNo}`}`;
  return { when, gameLine };
}

/** Answer or withdraw, with the confirm each one asks first. */
function useAct(lang: Lang, onChanged: () => void) {
  const de = lang === 'DE';
  const { when } = useLabels(lang);
  const [busy, setBusy] = useState('');
  const act = async (r: SwitchRequestView, action: Action) => {
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
    if (action === 'cancel') {
      // The holder hears of it by mail (12.10.2026) — asked first, the same
      // question the games list's "Tausch angefragt" asks.
      const ok = await confirmDialog({
        title: de ? 'Anfrage zurückziehen?' : 'Withdraw the request?',
        message: de
          ? `${r.holder} beobachtet ${r.coacheeName} dann wie geplant und bekommt eine E-Mail, dass du die Anfrage zurückgezogen hast.`
          : `${r.holder} then observes ${r.coacheeName} as planned and is told by e-mail that you withdrew the request.`,
        confirmLabel: de ? 'Zurückziehen' : 'Withdraw',
        cancelLabel: de ? 'Behalten' : 'Keep it',
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
  return { busy, act };
}

/** The open requests, split by side. An admin session is on both sides of
 *  every request, so one already answerable is not listed again as "own". */
function useOpen() {
  const { incoming, outgoing } = useSwitchRequests();
  const now = Date.now();
  const toAnswer = incoming.filter((r) => isOpenRequest(r, now));
  const answerable = new Set(toAnswer.map((r) => r.id));
  const waiting = outgoing.filter((r) => isOpenRequest(r, now) && !answerable.has(r.id));
  return { incoming, outgoing, toAnswer, waiting };
}

function IncomingCard({ r, lang, busy, act }: Keyed & { r: SwitchRequestView; lang: Lang; busy: string; act: (r: SwitchRequestView, a: Action) => void }) {
  const de = lang === 'DE';
  const { gameLine } = useLabels(lang);
  return (
    <div data-testid="switch-incoming" className="rounded-lg border border-stone-200 border-l-[3px] border-l-amber-500 bg-white px-3 py-2.5">
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
  );
}

/** One of this coach's own requests, as the requester. */
function OutgoingRow({ r, lang, busy, act }: Keyed & { r: SwitchRequestView; lang: Lang; busy: string; act: (r: SwitchRequestView, a: Action) => void }) {
  const de = lang === 'DE';
  const { gameLine } = useLabels(lang);
  const open = isOpenRequest(r);
  const statusText = () => {
    switch (r.status) {
      case 'pending': return de ? `Wartet auf ${r.holder} · bis ${dayTimeLabel(r.expiresAt)}` : `Waiting for ${r.holder} · until ${dayTimeLabel(r.expiresAt)}`;
      case 'accepted': return de ? `${r.holder} hat zugestimmt — das Spiel ist bei dir.` : `${r.holder} agreed — the game is yours.`;
      case 'declined': return de ? `${r.holder} hat abgelehnt.` : `${r.holder} declined.`;
      case 'cancelled': return de ? 'Von dir zurückgezogen.' : 'Withdrawn by you.';
      case 'expired': return de ? `${r.holder} hat nicht rechtzeitig geantwortet.` : `${r.holder} did not answer in time.`;
      case 'failed': return de ? `Nicht möglich: ${r.outcome}` : `Not possible: ${r.outcome}`;
    }
  };
  return (
    <div data-testid="switch-outgoing" data-status={r.status} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
      <p className="text-sm text-stone-800">
        {de ? <>Tausch für <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</> : <>Switch for <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</>}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs ${r.status === 'accepted' ? 'text-emerald-700' : open ? 'text-stone-500' : 'text-amber-700'}`}>{statusText()}</p>
        {open && (
          <button type="button" disabled={busy === r.id} onClick={() => void act(r, 'cancel')} className={`${btn} border border-stone-200 font-medium text-stone-600 hover:bg-stone-100`}>
            {de ? 'Zurückziehen' : 'Withdraw'}
          </button>
        )}
      </div>
    </div>
  );
}

/** A request another coach made of this one, once it is decided. */
function AnsweredRow({ r, lang }: Keyed & { r: SwitchRequestView; lang: Lang }) {
  const de = lang === 'DE';
  const { when, gameLine } = useLabels(lang);
  const statusText = () => {
    switch (r.status) {
      case 'accepted': return de ? `Angenommen — ${r.requester} beobachtet ${r.coacheeName} am ${when(r.toGame)}.` : `Accepted — ${r.requester} observes ${r.coacheeName} on ${when(r.toGame)}.`;
      case 'declined': return de ? `Abgelehnt — du beobachtest ${r.coacheeName} wie geplant.` : `Declined — you observe ${r.coacheeName} as planned.`;
      case 'cancelled': return de ? `Von ${r.requester} zurückgezogen.` : `Withdrawn by ${r.requester}.`;
      case 'expired': return de ? 'Nicht rechtzeitig beantwortet — verfallen.' : 'Not answered in time — lapsed.';
      case 'failed': return de ? `Nicht möglich: ${r.outcome}` : `Not possible: ${r.outcome}`;
      default: return '';
    }
  };
  return (
    <div data-testid="switch-answered" data-status={r.status} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
      <p className="text-sm text-stone-800">
        {de
          ? <><b>{r.requester}</b> fragte nach <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</>
          : <><b>{r.requester}</b> asked for <b>{r.coacheeName}</b>: {gameLine(r.toGame)}</>}
      </p>
      <p className={`mt-0.5 text-xs ${r.status === 'accepted' ? 'text-emerald-700' : 'text-stone-500'}`}>{statusText()}</p>
    </div>
  );
}

/** Home: the open requests only. */
export default function SwitchRequestsHome({ lang, onChanged, onShowAll }: { lang: Lang; onChanged: () => void; onShowAll?: () => void }) {
  const de = lang === 'DE';
  const { toAnswer, waiting } = useOpen();
  const { busy, act } = useAct(lang, onChanged);
  if (toAnswer.length === 0 && waiting.length === 0) return null;
  return (
    <section data-testid="switch-requests-home" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{de ? 'Offene Tauschanfragen' : 'Open switch requests'}</h3>
        {onShowAll && (
          <button type="button" onClick={onShowAll} className="inline-flex items-center gap-0.5 text-[11px] font-medium text-stone-500 hover:text-stone-800">
            {de ? 'Alle' : 'All'} <ChevronRight size={12} />
          </button>
        )}
      </div>
      {toAnswer.map((r) => <IncomingCard key={r.id} r={r} lang={lang} busy={busy} act={act} />)}
      {waiting.map((r) => <OutgoingRow key={r.id} r={r} lang={lang} busy={busy} act={act} />)}
    </section>
  );
}

/** The Tausch tab: open first, then everything decided, newest first. */
export function SwitchRequestsTab({ lang, onChanged }: { lang: Lang; onChanged: () => void }) {
  const de = lang === 'DE';
  const { incoming, outgoing, toAnswer, waiting } = useOpen();
  const { busy, act } = useAct(lang, onChanged);
  const now = Date.now();
  const open = new Set([...toAnswer, ...waiting].map((r) => r.id));
  // Decided on either side, once each (an admin session is on both).
  const seen = new Set<string>();
  const done: Array<{ r: SwitchRequestView; mine: boolean }> = [];
  for (const r of outgoing) if (!open.has(r.id) && !isOpenRequest(r, now) && !seen.has(r.id)) { seen.add(r.id); done.push({ r, mine: true }); }
  for (const r of incoming) if (!open.has(r.id) && !isOpenRequest(r, now) && !seen.has(r.id)) { seen.add(r.id); done.push({ r, mine: false }); }
  const stamp = (r: SwitchRequestView) => Date.parse(r.decidedAt || r.createdAt) || 0;
  done.sort((a, b) => stamp(b.r) - stamp(a.r));

  const heading = 'text-[11px] font-semibold uppercase tracking-wide text-stone-400';
  return (
    <section data-testid="switch-requests-tab" className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-stone-900">{de ? 'Tauschanfragen' : 'Switch requests'}</h2>
        <p className="mt-1 text-sm text-stone-500">
          {de
            ? 'Hat ein anderer Coach einen Coachee erst auf einem späteren Spiel gebucht, steht auf dem früheren Spiel „Tausch anfragen". Der andere Coach bekommt eine E-Mail und muss zustimmen; ohne Antwort verfällt die Anfrage nach 48 Stunden, spätestens 3 Stunden vor dem Spiel.'
            : 'When another coach has booked a coachee only on a later game, the earlier game offers "Request switch". The other coach is mailed and has to agree; without an answer the request lapses after 48 hours, at the latest 3 hours before the game.'}
        </p>
      </div>
      {toAnswer.length > 0 && (
        <div className="space-y-2">
          <h3 className={heading}>{de ? 'Wartet auf deine Antwort' : 'Waiting for your answer'}</h3>
          {toAnswer.map((r) => <IncomingCard key={r.id} r={r} lang={lang} busy={busy} act={act} />)}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="space-y-2">
          <h3 className={heading}>{de ? 'Deine offenen Anfragen' : 'Your open requests'}</h3>
          {waiting.map((r) => <OutgoingRow key={r.id} r={r} lang={lang} busy={busy} act={act} />)}
        </div>
      )}
      {done.length > 0 && (
        <div className="space-y-2">
          <h3 className={heading}>{de ? 'Erledigt' : 'Decided'}</h3>
          {done.map(({ r, mine }) => (mine
            ? <OutgoingRow key={r.id} r={r} lang={lang} busy={busy} act={act} />
            : <AnsweredRow key={r.id} r={r} lang={lang} />))}
        </div>
      )}
      {toAnswer.length === 0 && waiting.length === 0 && done.length === 0 && (
        <p data-testid="switch-requests-empty" className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-400">
          {de ? 'Noch keine Tauschanfragen.' : 'No switch requests yet.'}
        </p>
      )}
    </section>
  );
}
