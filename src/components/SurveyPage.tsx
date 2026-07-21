import { useEffect, useState } from 'react';
import { Loader2, Check, ShieldCheck } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getSurveySession, submitSurvey, SurveyAlreadySubmitted } from '../lib/pocketbase';
import {
  SURVEY_QUESTIONS, SURVEY_UI, t, questionLabel, questionHint,
  type SurveyLang,
} from '../lib/survey';

function tokenFromHash(): string {
  const m = window.location.hash.match(/#\/survey\/([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

type Visit = { referee: string; date: string; matchNo: string; rc: string };

export default function SurveyPage() {
  const token = tokenFromHash();
  const [lang, setLang] = useState<SurveyLang>('DE');
  const [visit, setVisit] = useState<Visit | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [anonymous, setAnonymous] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'done' | 'already' | 'error'>('loading');
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (!token) { setState('error'); return; }
    getSurveySession(token)
      .then((s) => { setVisit(s); setState(s.submitted ? 'already' : 'ready'); })
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 flex flex-col items-center p-4">
      <div className="w-full max-w-xl mt-6 mb-10">
        <div className="flex flex-col items-center mb-5">
          <SvrzLogo className="h-9 w-auto" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-3">
            {t(SURVEY_UI.eyebrow, lang)}
          </p>
        </div>

        {/* Language is a real choice here, not a guess from the browser: the mail
            that carried this link is German, but plenty of SVRZ referees aren't. */}
        <div className="flex justify-center gap-1 mb-4">
          {(['DE', 'EN'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`h-8 px-4 rounded-full text-xs font-semibold transition-colors ${
                lang === l ? 'bg-red-600 text-white' : 'bg-white text-stone-500 border border-stone-200 hover:bg-stone-50'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {state === 'loading' && (
          <div className={`${card} py-12 flex justify-center`}><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>
        )}

        {state === 'error' && (
          <div className={`${card} p-6 text-center`}>
            <p className="text-sm font-medium text-red-600">{t(SURVEY_UI.errorTitle, lang)}</p>
            <p className="text-xs text-stone-400 mt-1.5">{t(SURVEY_UI.errorBody, lang)}</p>
          </div>
        )}

        {state === 'already' && (
          <div className={`${card} p-8 text-center`}>
            <div className="mx-auto w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-3"><Check className="text-stone-500" /></div>
            <p className="text-sm font-medium text-stone-800">{t(SURVEY_UI.alreadyTitle, lang)}</p>
            <p className="text-xs text-stone-400 mt-1.5">{t(SURVEY_UI.alreadyBody, lang)}</p>
          </div>
        )}

        {state === 'done' && (
          <div className={`${card} p-8 text-center`}>
            <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3"><Check className="text-green-600" /></div>
            <p className="text-sm font-medium text-stone-800">{t(SURVEY_UI.thanksTitle, lang)}</p>
            <p className="text-xs text-stone-400 mt-1.5">{t(SURVEY_UI.thanksBody, lang)}</p>
          </div>
        )}

        {(state === 'ready' || state === 'saving') && visit && (
          <div className="flex flex-col gap-4">
            <div className={`${card} p-5`}>
              <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-line">{t(SURVEY_UI.intro, lang)}</p>
            </div>

            {/* Prefilled from the token, read-only: these are facts the system
                already knows, so retyping them is only a chance to get them wrong. */}
            <div className={`${card} p-5`}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-3">{t(SURVEY_UI.visitHeading, lang)}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-stone-400">{t(SURVEY_UI.fieldReferee, lang)}</dt>
                <dd className={anonymous ? 'text-stone-300 line-through' : 'text-stone-800 font-medium'}>{visit.referee}</dd>
                <dt className="text-stone-400">{t(SURVEY_UI.fieldDate, lang)}</dt>
                <dd className="text-stone-800">{visit.date}</dd>
                <dt className="text-stone-400">{t(SURVEY_UI.fieldMatchNo, lang)}</dt>
                <dd className="text-stone-800">{visit.matchNo}</dd>
                <dt className="text-stone-400">{t(SURVEY_UI.fieldRc, lang)}</dt>
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
                    {anonymous ? t(SURVEY_UI.anonOn, lang) : t(SURVEY_UI.anonTitle, lang)}
                  </span>
                  <span className="block text-xs text-stone-400 mt-0.5 leading-snug">{t(SURVEY_UI.anonHelp, lang)}</span>
                </span>
              </label>
            </div>

            <p className="text-[11px] text-stone-400 text-center -mb-1">{t(SURVEY_UI.optional, lang)}</p>

            {SURVEY_QUESTIONS.map((q) => {
              const hint = questionHint(q, lang);
              return (
                <div key={q.id} className={`${card} p-5`}>
                  <p className="text-sm font-medium text-stone-800 leading-snug">{questionLabel(q, lang)}</p>
                  {hint && <p className="text-xs text-stone-400 mt-1 leading-snug">{hint}</p>}
                  {q.kind === 'choice' ? (
                    <div className="flex flex-col gap-1.5 mt-3">
                      {q.options.map((o) => (
                        <label key={o.value} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="radio"
                            name={q.id}
                            checked={answers[q.id] === o.value}
                            onChange={() => set(q.id, o.value)}
                            className="h-4 w-4 border-stone-300 text-red-600 focus:ring-red-500"
                          />
                          <span className="text-sm text-stone-600 group-hover:text-stone-900">{o[lang]}</span>
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

            {saveError && <p className="text-xs text-red-600 text-center">{t(SURVEY_UI.saveFailed, lang)}</p>}

            <button
              onClick={save}
              disabled={state === 'saving'}
              className="inline-flex items-center justify-center gap-2 h-11 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:bg-stone-300"
            >
              {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check size={16} />}
              {t(SURVEY_UI.submit, lang)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
