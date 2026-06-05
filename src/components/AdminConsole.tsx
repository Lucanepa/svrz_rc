import React, { useCallback, useEffect, useState } from 'react';
import { Lock, Eye, EyeOff, Loader2, LogOut, Upload, Plus, Trash2, Pencil, Check, X, Users, ShieldCheck, Settings as SettingsIcon, FlaskConical } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import {
  getAdminAuthStatus, adminUiLogin, logoutAdmin,
  listCoachees, createCoachee, updateCoachee, deleteCoachee, importCoachees,
  listRcPeopleFull, createRcPerson, updateRcPerson, deleteRcPerson,
  getSettings, putSettings,
  type Coachee, type RcPerson, type ImportRow,
} from '../lib/pocketbase';

const NOW = new Date();
const CUR_SEASON = NOW.getMonth() <= 7 ? NOW.getFullYear() - 1 : NOW.getFullYear();
const SEASONS = [CUR_SEASON, CUR_SEASON + 1, CUR_SEASON + 2];
const seasonLabel = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

const input = 'h-9 w-full px-3 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors';

async function parseXlsx(file: File): Promise<ImportRow[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (!rows.length) return [];
  const header = (rows[0] as unknown[]).map((h) => String(h).trim().toLowerCase());
  const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const ci = { last: col(['nachname', 'last', 'lastname']), first: col(['vorname', 'first', 'firstname']), level: col(['niveau', 'level']), stage: col(['stufe', 'stage']), group: col(['gruppe', 'group', 'groups']) };
  const out: ImportRow[] = [];
  for (const raw of rows.slice(1)) {
    const r = raw as unknown[];
    const last = String(r[ci.last] ?? '').trim();
    const first = String(r[ci.first] ?? '').trim();
    if (!first && !last) continue;
    out.push({
      first_name: first, last_name: last, full_name: `${first} ${last}`.trim(),
      referee_level: String(r[ci.level] ?? '').trim(),
      stage: String(r[ci.stage] ?? '').trim().replace(/\.0$/, ''),
      groups: String(r[ci.group] ?? '').trim(),
    });
  }
  return out;
}

export default function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<'coachees' | 'rcs' | 'settings'>('coachees');
  const [testMode, setTestMode] = useState(false);

  useEffect(() => {
    getAdminAuthStatus().then((s) => setAuthed(Boolean(s.authenticated))).catch(() => {}).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (authed) getSettings().then((s) => setTestMode(Boolean(s.test_mode))).catch(() => {});
  }, [authed]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError('');
    try { await adminUiLogin(password.trim()); setAuthed(true); setPassword(''); }
    catch { setError('Falsches Passwort'); setPassword(''); }
    finally { setSubmitting(false); }
  };
  const logout = async () => { try { await logoutAdmin(); } catch { /* ignore */ } setAuthed(false); };

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center bg-stone-100"><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>;
  }
  if (!authed) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
            <div className="flex flex-col items-center text-center mb-7">
              <SvrzLogo className="h-11 w-auto" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">Admin</p>
            </div>
            <form onSubmit={login} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input id="admin-pw" type={showPw ? 'text' : 'password'} value={password} autoFocus disabled={submitting}
                  onChange={(e) => setPassword(e.target.value)} placeholder="Admin-Passwort"
                  className={`w-full pl-10 pr-10 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`} />
                <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button type="submit" disabled={!password.trim() || submitting} className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}Anmelden
              </button>
            </form>
          </div>
          <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">Swiss Volley Region Zürich</p>
        </div>
      </div>
    );
  }

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'coachees', label: 'Coachees', icon: <Users size={15} /> },
    { id: 'rcs', label: 'Referee Coaches', icon: <ShieldCheck size={15} /> },
    { id: 'settings', label: 'Einstellungen', icon: <SettingsIcon size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 pb-16">
      <header className="bg-white border-b border-stone-200/70 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <SvrzLogo className="h-7 w-auto" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">Admin</span>
          {testMode && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5"><FlaskConical size={12} /> Testmodus</span>}
          <button onClick={logout} className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
            <LogOut size={15} /> <span className="hidden sm:inline">Abmelden</span>
          </button>
        </div>
        <div className="max-w-4xl mx-auto px-4 pb-3 grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`h-11 inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl transition-colors ${tab === t.id ? 'bg-slate-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
              {t.icon}<span className="hidden sm:inline">{t.label}</span>
            </button>
          ))}
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 pt-5">
        {tab === 'coachees' && <CoacheesAdmin />}
        {tab === 'rcs' && <RcsAdmin />}
        {tab === 'settings' && <SettingsAdmin onTestMode={setTestMode} />}
      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">{children}</div>;
}

function CoacheesAdmin() {
  const [season, setSeason] = useState(CUR_SEASON);
  const [all, setAll] = useState<Coachee[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    try { setAll(await listCoachees()); } catch (e) { setNotice(String(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const rows = all.filter((c) => (typeof c.season === 'number' ? c.season === season : false))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  const add = async () => {
    const full_name = `${form.first_name} ${form.last_name}`.trim();
    if (!full_name) return;
    await createCoachee({ ...form, full_name, season } as Partial<Coachee>);
    setForm({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' });
    await reload();
  };
  const saveEdit = async (id: string) => {
    const full_name = `${editForm.first_name} ${editForm.last_name}`.trim();
    await updateCoachee(id, { ...editForm, full_name } as Partial<Coachee>);
    setEditId(null); await reload();
  };
  const remove = async (c: Coachee) => {
    if (!confirm(`Coachee „${c.full_name}" löschen?`)) return;
    await deleteCoachee(c.id); await reload();
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setNotice('');
    try {
      const parsed = await parseXlsx(file);
      if (!parsed.length) { setNotice('Keine Zeilen in der Datei gefunden.'); return; }
      const res = await importCoachees(parsed, season);
      setNotice(`Import ${seasonLabel(season)}: ${res.created} neu, ${res.updated} aktualisiert (von ${res.total}).`);
      await reload();
    } catch (err) { setNotice(`Import fehlgeschlagen: ${err}`); }
    finally { setImporting(false); e.target.value = ''; }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h2 className="text-sm font-semibold text-stone-700">Coachees</h2>
          <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className="ml-auto h-9 rounded-lg border border-stone-200 bg-stone-50 text-stone-700 text-xs font-medium px-2.5">
            {SEASONS.map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}
          </select>
          <label className={`${btnPrimary} cursor-pointer ${importing ? 'opacity-60 pointer-events-none' : ''}`}>
            {importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            <span>xlsx importieren</span>
            <input type="file" accept=".xlsx" className="hidden" onChange={onFile} />
          </label>
        </div>
        <p className="text-xs text-stone-400">Import setzt die Saison <b>{seasonLabel(season)}</b>. Bestehende (gleicher Name + Saison) werden aktualisiert.</p>
        {notice && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{notice}</p>}
      </Card>

      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
          <input className={input} placeholder="Vorname" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder="Nachname" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input className={input} placeholder="Niveau" value={form.referee_level} onChange={(e) => setForm({ ...form, referee_level: e.target.value })} />
          <input className={input} placeholder="Stufe" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} />
          <input className={`${input} sm:col-span-1 col-span-2`} placeholder="Gruppe" value={form.groups} onChange={(e) => setForm({ ...form, groups: e.target.value })} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> Hinzufügen</button>
        </div>
      </Card>

      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? 'Lädt…' : `${rows.length} Coachees · Saison ${seasonLabel(season)}`}</p>
        <div className="divide-y divide-stone-100">
          {rows.map((c) => editId === c.id ? (
            <div key={c.id} className="py-2 grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
              <input className={input} value={editForm.first_name} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={input} value={editForm.last_name} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <input className={input} value={editForm.referee_level} onChange={(e) => setEditForm({ ...editForm, referee_level: e.target.value })} />
              <input className={input} value={editForm.stage} onChange={(e) => setEditForm({ ...editForm, stage: e.target.value })} />
              <input className={input} value={editForm.groups} onChange={(e) => setEditForm({ ...editForm, groups: e.target.value })} />
              <div className="flex gap-1.5">
                <button onClick={() => saveEdit(c.id)} className={btnPrimary}><Check size={15} /></button>
                <button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button>
              </div>
            </div>
          ) : (
            <div key={c.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-stone-800 truncate">{c.full_name}</p>
                <p className="text-xs text-stone-400 truncate">{[c.referee_level, c.stage].filter(Boolean).join('-')}{c.groups ? ` · ${c.groups}` : ''}</p>
              </div>
              <button onClick={() => { setEditId(c.id); setEditForm({ first_name: c.first_name || '', last_name: c.last_name || '', referee_level: c.referee_level || '', stage: c.stage || '', groups: c.groups || '' }); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => remove(c)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {!loading && rows.length === 0 && <p className="py-8 text-center text-sm text-stone-400">Keine Coachees für {seasonLabel(season)} — importiere eine xlsx.</p>}
        </div>
      </Card>
    </>
  );
}

function RcsAdmin() {
  const [rcs, setRcs] = useState<RcPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RcPerson>({ id: '' });

  const reload = useCallback(async () => { setLoading(true); try { setRcs(await listRcPeopleFull()); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);

  const add = async () => { if (!form.first_name && !form.last_name) return; await createRcPerson({ ...form, active: true }); setForm({ first_name: '', last_name: '', email: '', phone: '' }); await reload(); };
  const saveEdit = async (id: string) => { await updateRcPerson(id, editForm); setEditId(null); await reload(); };
  const remove = async (r: RcPerson) => { if (!confirm(`RC „${r.first_name} ${r.last_name}" löschen?`)) return; await deleteRcPerson(r.id); await reload(); };

  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-2">Referee Coach hinzufügen</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <input className={input} placeholder="Vorname" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder="Nachname" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input className={input} placeholder="E-Mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder="Telefon" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> Hinzufügen</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? 'Lädt…' : `${rcs.length} Referee Coaches`}</p>
        <div className="divide-y divide-stone-100">
          {rcs.map((r) => editId === r.id ? (
            <div key={r.id} className="py-2 grid grid-cols-2 sm:grid-cols-5 gap-2 items-center">
              <input className={input} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={input} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <input className={input} value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              <input className={input} value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              <div className="flex gap-1.5">
                <button onClick={() => saveEdit(r.id)} className={btnPrimary}><Check size={15} /></button>
                <button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button>
              </div>
            </div>
          ) : (
            <div key={r.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-stone-800 truncate">{r.first_name} {r.last_name}{r.active === false ? ' · inaktiv' : ''}</p>
                <p className="text-xs text-stone-400 truncate">{r.email}{r.phone ? ` · ${r.phone}` : ''}</p>
              </div>
              <button onClick={() => { setEditId(r.id); setEditForm(r); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => remove(r)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {!loading && rcs.length === 0 && <p className="py-8 text-center text-sm text-stone-400">Keine Referee Coaches.</p>}
        </div>
      </Card>
    </>
  );
}

function SettingsAdmin({ onTestMode }: { onTestMode: (v: boolean) => void }) {
  const [season, setSeason] = useState<number>(CUR_SEASON);
  const [testMode, setTm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSettings().then((s) => { if (s.default_season) setSeason(s.default_season); setTm(Boolean(s.test_mode)); onTestMode(Boolean(s.test_mode)); }).catch(() => {}).finally(() => setLoading(false));
  }, [onTestMode]);
  const save = async () => { await putSettings({ default_season: season }); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const toggleTest = async () => {
    const next = !testMode; setTm(next); onTestMode(next);
    try { await putSettings({ test_mode: next }); } catch { setTm(!next); onTestMode(!next); }
  };
  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">Standard-Saison</h2>
        <p className="text-xs text-stone-400 mb-3">Die Saison, in der die App standardmässig startet (für neue Nutzer).</p>
        <div className="flex items-center gap-2">
          <select value={season} disabled={loading} onChange={(e) => setSeason(Number(e.target.value))} className="h-9 rounded-lg border border-stone-300 bg-white text-sm px-3">
            {SEASONS.map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}
          </select>
          <button onClick={save} className={btnPrimary}><Check size={15} /> Speichern</button>
          {saved && <span className="text-xs text-green-600 font-medium">Gespeichert ✓</span>}
        </div>
      </Card>
      <Card>
        <div className="flex items-start gap-3">
          <FlaskConical size={18} className={testMode ? 'text-amber-600 mt-0.5' : 'text-stone-400 mt-0.5'} />
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-stone-700">Test-Modus (E-Mail)</h2>
            <p className="text-xs text-stone-400">Wenn aktiv, werden <b>keine E-Mails</b> versendet (Feedback wird trotzdem gespeichert). Zum Live-Betrieb ausschalten.</p>
          </div>
          <button onClick={toggleTest} disabled={loading} role="switch" aria-checked={testMode}
            className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors ${testMode ? 'bg-amber-500' : 'bg-stone-300'}`}>
            <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform mt-0.5 ${testMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className={`mt-2 text-xs font-medium ${testMode ? 'text-amber-700' : 'text-green-600'}`}>{testMode ? 'AN — es werden keine E-Mails versendet.' : 'AUS — E-Mails werden versendet.'}</p>
      </Card>
    </>
  );
}
