import React, { useState, useEffect, createContext, useContext, type ReactNode } from 'react';
import { Lock, Loader2, Mail, ArrowLeft } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getAuthMe, rcLogin, rcLogout, rcForgotStart, rcForgotVerify } from '../lib/pocketbase';

// Identity of the session that passed the gate. rcName/rcId are null for
// admin-only sessions (admin console login without a personal PIN).
export type RcAuth = {
  rcId: string | null;
  rcName: string | null;
  isAdminSession: boolean;
  logout: () => void;
};

const RcAuthContext = createContext<RcAuth>({ rcId: null, rcName: null, isAdminSession: false, logout: () => {} });

export function useRcAuth(): RcAuth {
  return useContext(RcAuthContext);
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rcId, setRcId] = useState<string | null>(null);
  const [rcName, setRcName] = useState<string | null>(null);
  const [isAdminSession, setIsAdminSession] = useState(false);
  // Forgot-PIN flow: 'login' → 'forgot-email' → 'forgot-code' → 'forgot-done'.
  const [mode, setMode] = useState<'login' | 'forgot-email' | 'forgot-code' | 'forgot-done'>('login');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotInfo, setForgotInfo] = useState('');

  useEffect(() => {
    // Guard the status probe with a timeout + abort so an unreachable API
    // degrades to the login screen instead of an infinite blank page.
    const timeout = setTimeout(() => setChecking(false), 6000);
    getAuthMe()
      .then((me) => {
        setRcId(me.rc?.id ?? null);
        setRcName(me.rc?.name ?? null);
        setIsAdminSession(Boolean(me.admin));
        setAuthed(Boolean(me.rc || me.admin));
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        setChecking(false);
      });
    return () => clearTimeout(timeout);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await rcLogin(email.trim(), pin.trim());
      setRcName(result.name);
      // The id isn't in the login response; fetch it so App can use it later.
      getAuthMe().then((me) => { setRcId(me.rc?.id ?? null); setIsAdminSession(Boolean(me.admin)); }).catch(() => {});
      setAuthed(true);
      return;
    } catch (err) {
      const e2 = err as Error & { status?: number; retryAfterMs?: number };
      if (e2.status === 429) {
        const secs = Math.ceil((e2.retryAfterMs || 60000) / 1000);
        setError(`Zu viele Versuche. Bitte in ${secs}s erneut probieren.`);
      } else if (e2.status === 401 || e2.status === 400) {
        setError('Falsche E-Mail oder falscher PIN');
      } else {
        setError('Verbindungsfehler. Bitte versuche es später erneut.');
      }
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  const logout = () => {
    void rcLogout().finally(() => {
      setAuthed(false);
      setRcId(null);
      setRcName(null);
      setPin('');
    });
  };

  const handleForgotStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await rcForgotStart(forgotEmail.trim());
      // Always advance — the server never reveals whether the email exists.
      setMode('forgot-code');
      setForgotInfo('Falls die E-Mail hinterlegt ist, wurde ein Bestätigungscode gesendet.');
    } catch {
      setError('Verbindungsfehler. Bitte versuche es später erneut.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await rcForgotVerify(forgotEmail.trim(), forgotCode.trim());
      setMode('forgot-done');
      setForgotInfo(result.pin
        ? `Dein neuer PIN lautet: ${result.pin}`
        : 'Ein neuer PIN wurde an deine E-Mail gesendet.');
    } catch (err) {
      const e2 = err as Error & { status?: number };
      setError(e2.status === 401 ? 'Code ungültig oder abgelaufen.' : 'Verbindungsfehler. Bitte versuche es später erneut.');
      setForgotCode('');
    } finally {
      setSubmitting(false);
    }
  };

  const backToLogin = () => {
    setMode('login');
    setError('');
    setForgotCode('');
    setForgotInfo('');
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
        <Loader2 className="h-6 w-6 animate-spin text-stone-300" />
      </div>
    );
  }
  if (authed) {
    return (
      <RcAuthContext.Provider value={{ rcId, rcName, isAdminSession, logout }}>
        {children}
      </RcAuthContext.Provider>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
          {/* Swiss Volley brand accent */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />

          <div className="flex flex-col items-center text-center mb-7">
            <SvrzLogo className="h-11 w-auto" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">
              Referee Coaching
            </p>
          </div>

          {mode === 'login' && (
            <>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="relative">
                  <label htmlFor="rc-email" className="sr-only">E-Mail</label>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                  <input
                    id="rc-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="E-Mail"
                    autoFocus
                    disabled={submitting}
                    className={`w-full pl-10 pr-4 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${
                      error ? 'border-red-400 bg-red-50' : 'border-stone-300'
                    }`}
                  />
                </div>
                <div>
                  <label htmlFor="rc-pin" className="sr-only">Persönlicher PIN</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                    <input
                      id="rc-pin"
                      type="password"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={pin}
                      onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                      placeholder="Persönlicher PIN"
                      disabled={submitting}
                      className={`w-full pl-10 pr-4 py-3 rounded-xl border text-sm tracking-[0.3em] bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${
                        error ? 'border-red-400 bg-red-50' : 'border-stone-300'
                      }`}
                    />
                  </div>
                  {error && (
                    <p className="text-red-600 text-xs mt-2 font-medium">{error}</p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!/\S+@\S+\.\S+/.test(email) || pin.trim().length !== 6 || submitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? 'Prüfe…' : 'Anmelden'}
                </button>
              </form>
              <p className="text-center text-[11px] text-stone-400 mt-5">
                <button type="button" onClick={() => { setError(''); setForgotEmail(email); setMode('forgot-email'); }} className="underline hover:text-stone-600">
                  PIN vergessen?
                </button>
                {' · '}
                <a href="#/admin" className="underline hover:text-stone-600">Admin-Login</a>
              </p>
            </>
          )}

          {mode === 'forgot-email' && (
            <form onSubmit={handleForgotStart} className="space-y-4">
              <p className="text-xs text-stone-500 text-center">Gib deine hinterlegte E-Mail ein — wir senden dir einen Bestätigungscode.</p>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type="email"
                  autoComplete="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder="E-Mail"
                  autoFocus
                  disabled={submitting}
                  className={`w-full pl-10 pr-4 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`}
                />
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={!/\S+@\S+\.\S+/.test(forgotEmail) || submitting}
                className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sende…' : 'Code senden'}
              </button>
              <button type="button" onClick={backToLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> Zurück zur Anmeldung
              </button>
            </form>
          )}

          {mode === 'forgot-code' && (
            <form onSubmit={handleForgotVerify} className="space-y-4">
              {forgotInfo && <p className="text-xs text-stone-500 text-center">{forgotInfo}</p>}
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={forgotCode}
                  onChange={e => setForgotCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-stelliger Code"
                  autoFocus
                  disabled={submitting}
                  className={`w-full pl-10 pr-4 py-3 rounded-xl border text-sm tracking-[0.3em] bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`}
                />
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={forgotCode.trim().length !== 6 || submitting}
                className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Prüfe…' : 'Neuen PIN anfordern'}
              </button>
              <button type="button" onClick={backToLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> Zurück zur Anmeldung
              </button>
            </form>
          )}

          {mode === 'forgot-done' && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-stone-700 font-medium">{forgotInfo}</p>
              <button
                type="button"
                onClick={backToLogin}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                Zur Anmeldung
              </button>
            </div>
          )}
        </div>
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">
          Swiss Volley Region Zürich
        </p>
      </div>
    </div>
  );
}
