import React, { useState, useEffect, type ReactNode } from 'react';
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

function apiUrl(path: string): string {
  if (!API_BASE_URL) return path;
  const normalizedBase = API_BASE_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    // Guard the status probe with a timeout + abort so an unreachable API
    // degrades to the login screen instead of an infinite blank page.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    fetch(apiUrl('/api/auth/gate/status'), { credentials: 'include', signal: controller.signal })
      .then(r => r.json())
      .then((data: { authenticated: boolean }) => {
        setAuthed(Boolean(data?.authenticated));
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        setChecking(false);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl('/api/auth/gate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: password.trim() }),
      });
      if (res.ok) {
        setAuthed(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const secs = Math.ceil((data.retryAfterMs || 60000) / 1000);
        setError(`Zu viele Versuche. Bitte in ${secs}s erneut probieren.`);
      } else {
        setError('Falsches Passwort');
      }
      setPassword('');
    } catch (err) {
      console.error('[AuthGate] Login fetch failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Verbindungsfehler: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
        <Loader2 className="h-6 w-6 animate-spin text-stone-300" />
      </div>
    );
  }
  if (authed) return <>{children}</>;

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

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="gate-password" className="sr-only">Passwort</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  id="gate-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Passwort"
                  autoFocus
                  disabled={submitting}
                  className={`w-full pl-10 pr-10 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${
                    error ? 'border-red-400 bg-red-50' : 'border-stone-300'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {error && (
                <p className="text-red-600 text-xs mt-2 font-medium">{error}</p>
              )}
            </div>
            <button
              type="submit"
              disabled={!password.trim() || submitting}
              className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Prüfe…' : 'Anmelden'}
            </button>
          </form>
        </div>
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">
          Swiss Volley Region Zürich
        </p>
      </div>
    </div>
  );
}
