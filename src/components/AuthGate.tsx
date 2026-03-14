import React, { useState, useEffect, type ReactNode } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
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
    fetch(apiUrl('/api/auth/gate/status'), { credentials: 'include' })
      .then(r => r.json())
      .then((data: { authenticated: boolean }) => {
        setAuthed(data.authenticated);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
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

  if (checking) return null;
  if (authed) return <>{children}</>;

  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm border border-stone-200">
        <div className="flex flex-col items-center mb-6">
          <SvrzLogo className="h-12 w-auto" />
          <p className="text-sm text-stone-500 mt-3">Referee Coaching</p>
          <div className="bg-stone-100 rounded-full p-3 mt-2">
            <Lock className="h-6 w-6 text-stone-500" />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Passwort"
                autoFocus
                disabled={submitting}
                className={`w-full px-4 py-2.5 pr-10 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-red-500 ${
                  error ? 'border-red-400 bg-red-50' : 'border-stone-300'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error && (
              <p className="text-red-500 text-xs mt-1.5">{error}</p>
            )}
          </div>
          <button
            type="submit"
            disabled={!password.trim() || submitting}
            className="w-full bg-red-600 hover:bg-red-700 disabled:bg-stone-300 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            {submitting ? 'Prüfe…' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}
