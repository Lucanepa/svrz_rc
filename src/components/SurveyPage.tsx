import { useEffect, useState } from 'react';
import { Loader2, Check, ShieldCheck } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getSurveySession, submitSurvey, SurveyAlreadySubmitted } from '../lib/pocketbase';
import { cn } from '../lib/utils';
import {
  DEFAULT_SURVEY_CONFIG, SURVEY_UI, normalizeSurveyConfig, optionsOf,
  t, bothLangs,
  type SurveyConfig, type SurveyLang,
} from '../lib/survey';

function tokenFromHash(): string {
  const m = window.location.hash.match(/#\/survey\/([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

type Visit = { referee: string; date: string; matchNo: string; rc: string };

export default function SurveyPage() {
  const token = tokenFromHash();
  // Kept for the submit payload's sake, not as a choice any more: the form
  // shows both languages, so there is nothing to pick. The server only uses it
  // to note "answered in English" on the notification mail, which no longer
  // means anything — a free-text answer still arrives in whatever language it
  // was written in.
  const lang: SurveyLang = 'DE';
  const [visit, setVisit] = useState<Visit | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // The questions the commission has configured. Ships with the session, so the
  // shipped defaults are only ever the fallback for an old server.
  const [form, setForm] = useState<SurveyConfig>(DEFAULT_SURVEY_CONFIG);
  const [anonymous, setAnonymous] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'done' | 'already' | 'error'>('loading');
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (!token) { setState('error'); return; }
    getSurveySession(token)
      .then((s) => {
        setVisit(s);
        // Re-normalised here, not trusted as fetched: this page can be a cached
        // build older than the config it just received.
        setForm(normalizeSurveyConfig(s.form));
        setState(s.submitted ? 'already' : 'ready');
      })
      .catch(() => setState('error'));
  }, [token]);

  const set = (id: string, value: string) => setAnswers((a) => ({ ...a, [id]: value }));

  const save = async () => {
    setState('saving');
    setSaveError(false);
    try {
      await submitSurvey(token, { lang, anonymous, answers });
      setState('done');
    } catch (e) {
      if (e instanceof SurveyAlreadySubmitted) { setState('already'); return; }
      setSaveError(true);
      setState('ready');
    }
  };

  const card = 'bg-white rounded-2xl shadow-card border border-stone-200/70';

  // German first, English under it. The pair is rendered rather than chosen:
  // see bothLangs() for why the language picker is gone.
  const Both = ({ entry, className, enClassName, block }: {
    entry: { DE?: string; EN?: string } | undefined;
    className?: string;
    enClassName?: string;
    block?: boolean;
  }) => {
    const { de, en } = bothLangs(entry);
    if (!en) return <span className={className}>{de}</span>;
    return (
      <>
        <span className={className}>{de}</span>
        {/* A separator, not a margin: a margin is invisible to anything reading
            the text, so the two languages ran together the moment they were
            copied, spoken, or asserted on. */}
        {!block && <span className="mx-1.5 text-stone-300" aria-hidden>·</span>}
        <span className={cn(block ? 'block' : '', enClassName ?? 'text-stone-500')}>{en}</span>
      </>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 flex flex-col items-center p-4">
      <div className="w-full max-w-xl mt-6 mb-10">
        <div className="flex flex-col items-center mb-5">
          <SvrzLogo className="h-9 w-auto" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-3 text-center">
            <Both entry={form.eyebrow} />
          </p>
        </div>

        {state === 'loading' && (
          <div className={`${card} py-12 flex justify-center`}><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>
        )}

        {state === 'error' && (
          <div className={`${card} p-6 text-center`}>
            <p className="text-sm font-medium text-red-600"><Both entry={SURVEY_UI.errorTitle} block enClassName="block text-stone-500 mt-1" /></p>
            <p className="text-xs text-stone-500 mt-1.5"><Both entry={SURVEY_UI.errorBody} block enClassName="block text-stone-500 mt-1" /></p>
          </div>
        )}

        {state === 'already' && (
          <div className={`${card} p-8 text-center`}>
            <div className="mx-auto w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-3"><Check className="text-stone-500" /></div>
            <p className="text-sm font-medium text-stone-800"><Both entry={SURVEY_UI.alreadyTitle} block enClassName="block text-stone-500 mt-1" /></p>
            <p className="text-xs text-stone-500 mt-1.5"><Both entry={SURVEY_UI.alreadyBody} block enClassName="block text-stone-500 mt-1" /></p>
          </div>
        )}

        {state === 'done' && (
          <div className={`${card} p-8 text-center`}>
            <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3"><Check className="text-green-600" /></div>
            <p className="text-sm font-medium text-stone-800"><Both entry={SURVEY_UI.thanksTitle} block enClassName="block text-stone-500 mt-1" /></p>
            <p className="text-xs text-stone-500 mt-1.5"><Both entry={SURVEY_UI.thanksBody} block enClassName="block text-stone-500 mt-1" /></p>
          </div>
        )}

        {(state === 'ready' || state === 'saving') && visit && (
          <div className="flex flex-col gap-4">
            <div className={`${card} p-5`}>
              <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-line">{bothLangs(form.intro).de}</p>
              {bothLangs(form.intro).en && (
                <p className="text-sm text-stone-500 leading-relaxed whitespace-pre-line mt-3 pt-3 border-t border-stone-100">{bothLangs(form.intro).en}</p>
              )}
            </div>

            {/* Prefilled from the token, read-only: these are facts the system
                already knows, so retyping them is only a chance to get them wrong. */}
            <div className={`${card} p-5`}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-3"><Both entry={SURVEY_UI.visitHeading} /></p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-stone-500"><Both entry={SURVEY_UI.fieldReferee} enClassName="text-stone-500" /></dt>
                <dd className={anonymous ? 'text-stone-300 line-through' : 'text-stone-800 font-medium'}>{visit.referee}</dd>
                <dt className="text-stone-500"><Both entry={SURVEY_UI.fieldDate} enClassName="text-stone-500" /></dt>
                <dd className="text-stone-800">{visit.date}</dd>
                <dt className="text-stone-500"><Both entry={SURVEY_UI.fieldMatchNo} enClassName="text-stone-500" /></dt>
                <dd className="text-stone-800">{visit.matchNo}</dd>
                <dt className="text-stone-500"><Both entry={SURVEY_UI.fieldRc} enClassName="text-stone-500" /></dt>
                <dd className="text-stone-800">{visit.rc}</dd>
              </dl>

              <label className="flex items-start gap-3 mt-4 pt-4 border-t border-stone-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={anonymous}
                  onChange={(e) => setAnonymous(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-stone-300 text-red-600 focus:ring-red-500"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-stone-700">
                    {anonymous && <ShieldCheck size={14} className="text-green-600" />}
                    <Both entry={anonymous ? SURVEY_UI.anonOn : SURVEY_UI.anonTitle} />
                  </span>
                  <span className="block text-xs text-stone-500 mt-0.5 leading-snug"><Both entry={SURVEY_UI.anonHelp} block enClassName="block text-stone-500 mt-0.5" /></span>
                </span>
              </label>
            </div>

            <p className="text-[11px] text-stone-400 text-center -mb-1"><Both entry={SURVEY_UI.optional} /></p>

            {form.questions.map((q) => {
              const hint = bothLangs({ DE: q.hintDE, EN: q.hintEN });
              return (
                // data-log-redact: the click logger copies the clicked
                // element's rendered text into an entry every admin can read,
                // and an option here is a <label> whose text IS the referee's
                // answer. The admin console already redacts the tab that
                // DISPLAYS these answers (and refuses admins outright); the page
                // that collects them must not leak them on the way in — least of
                // all for someone who ticked "Anonym".
                <div key={q.id} data-log-redact className={`${card} p-5`}>
                  <p className="text-sm font-medium text-stone-800 leading-snug">{bothLangs(q).de}</p>
                  {bothLangs(q).en && <p className="text-sm text-stone-500 leading-snug">{bothLangs(q).en}</p>}
                  {hint.de && <p className="text-xs text-stone-500 mt-1 leading-snug">{hint.de}</p>}
                  {hint.en && <p className="text-xs text-stone-500 leading-snug">{hint.en}</p>}
                  {q.kind === 'choice' ? (
                    <div className="flex flex-col gap-1.5 mt-3">
                      {optionsOf(q).map((o) => (
                        <label key={o.value} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="radio"
                            name={q.id}
                            checked={answers[q.id] === o.value}
                            onChange={() => set(q.id, o.value)}
                            className="h-4 w-4 border-stone-300 text-red-600 focus:ring-red-500"
                          />
                          <span className="text-sm text-stone-600 group-hover:text-stone-900"><Both entry={o} enClassName="text-stone-500" /></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <textarea
                      value={answers[q.id] ?? ''}
                      onChange={(e) => set(q.id, e.target.value)}
                      rows={3}
                      className="mt-3 w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-red-500 resize-y"
                    />
                  )}
                </div>
              );
            })}

            {saveError && <p className="text-xs text-red-600 text-center"><Both entry={SURVEY_UI.saveFailed} /></p>}

            <button
              onClick={save}
              disabled={state === 'saving'}
              className="inline-flex items-center justify-center gap-2 h-11 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:bg-stone-300"
            >
              {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check size={16} />}
              <Both entry={SURVEY_UI.submit} enClassName="text-white/70" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
