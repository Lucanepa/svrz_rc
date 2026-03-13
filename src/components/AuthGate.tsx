import React, { useState, useEffect, type ReactNode } from 'react';
import { Lock } from 'lucide-react';

const PASSWORD_HASH = import.meta.env.VITE_APP_PASSWORD_HASH as string | undefined;
const SESSION_KEY = 'svrz_authed';

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    // If no hash configured, skip auth entirely
    if (!PASSWORD_HASH) {
      setAuthed(true);
      setChecking(false);
      return;
    }
    // Check session
    if (sessionStorage.getItem(SESSION_KEY) === 'true') {
      setAuthed(true);
    }
    setChecking(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(false);
    const hash = await sha256(password.trim());
    if (hash === PASSWORD_HASH) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      setAuthed(true);
    } else {
      setError(true);
      setPassword('');
    }
  };

  if (checking) return null;
  if (authed) return <>{children}</>;

  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm border border-stone-200">
        <div className="flex flex-col items-center mb-6">
          <div className="text-center mb-4">
            <div className="text-red-600 font-black italic text-3xl leading-none tracking-tighter">Swiss Volley</div>
            <div className="text-[11px] font-bold text-stone-800 tracking-widest uppercase mt-1">REGION ZÜRICH</div>
          </div>
          <div className="bg-stone-100 rounded-full p-3">
            <Lock className="h-6 w-6 text-stone-500" />
          </div>
          <p className="text-sm text-stone-500 mt-3">SR-Coaching Feedback</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Passwort"
              autoFocus
              className={`w-full px-4 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-red-500 ${
                error ? 'border-red-400 bg-red-50' : 'border-stone-300'
              }`}
            />
            {error && (
              <p className="text-red-500 text-xs mt-1.5">Falsches Passwort</p>
            )}
          </div>
          <button
            type="submit"
            disabled={!password.trim()}
            className="w-full bg-red-600 hover:bg-red-700 disabled:bg-stone-300 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            Anmelden
          </button>
        </form>
      </div>
    </div>
  );
}
