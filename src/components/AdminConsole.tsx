import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff, Loader2, LogOut, Upload, Plus, Trash2, Pencil, Check, X, Users, ShieldCheck, Settings as SettingsIcon, FlaskConical, Languages, ChevronDown, Home } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import {
  getAdminAuthStatus, adminUiLogin, logoutAdmin,
  listCoachees, createCoachee, updateCoachee, deleteCoachee, importCoachees,
  listRcPeopleFull, createRcPerson, updateRcPerson, deleteRcPerson,
  getSettings, putSettings,
  type Coachee, type RcPerson, type ImportRow,
} from '../lib/pocketbase';

type Lang = 'DE' | 'EN';
const NOW = new Date();
const CUR_SEASON = NOW.getMonth() <= 7 ? NOW.getFullYear() - 1 : NOW.getFullYear();
const SEASONS = [CUR_SEASON, CUR_SEASON + 1, CUR_SEASON + 2];
const seasonLabel = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

// SR-Niveau & Stufe scale (svrz.ch), lowest -> highest
const STUFEN = ['N4-3', 'N4-2', 'N4-1', 'N3-3', 'N3-2', 'N3-1', 'N2-2', 'N2-1', 'N1'];
function joinStufe(level?: string, stage?: string): string { if (!level) return ''; return stage ? `${level}-${stage}` : level; }
function splitStufe(v: string): { referee_level: string; stage: string } {
  if (!v) return { referee_level: '', stage: '' };
  if (v.indexOf('-') < 0) return { referee_level: v, stage: '' };
  const [lvl, st] = v.split('-'); return { referee_level: lvl, stage: st || '' };
}

const GROUP_MAP: Record<string, string> = { 'B': 'Beförderung', 'B?': 'Beförderung?', 'RC': 'Referee Coaching', '2.SR': '2. Schiedsrichter', '2. SR': '2. Schiedsrichter', '1.SR': '1. Schiedsrichter', '1. SR': '1. Schiedsrichter', 'Neu-SR 24/25': 'Neu-Schiedsrichter 24/25', 'Neu-SR 25/26': 'Neu-Schiedsrichter 25/26' };
function mapGroups(s: string): string {
  const out: string[] = [];
  for (const p of s.split('/').map((x) => x.trim()).filter(Boolean)) { if (/^\d{2}$/.test(p) && out.length) out[out.length - 1] += '/' + p; else out.push(p); }
  return out.map((g) => GROUP_MAP[g] || g).join('/');
}

const STR = {
  DE: {
    admin: 'Admin', logout: 'Abmelden', login: 'Anmelden', adminPw: 'Admin-Passwort', wrongPw: 'Falsches Passwort',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Einstellungen', testBadge: 'Testmodus',
    importXlsx: 'xlsx importieren', importHint: (s: string) => `Import setzt die Saison ${s}. Bestehende (gleicher Name + Saison) werden aktualisiert.`,
    firstName: 'Vorname', lastName: 'Nachname', level: 'Niveau', stage: 'Stufe', group: 'Gruppe', email: 'E-Mail', phone: 'Telefon',
    add: 'Hinzufügen', count: (n: number, s: string) => `${n} Coachees · Saison ${s}`, loading: 'Lädt…',
    noCoachees: (s: string) => `Keine Coachees für ${s} — importiere eine xlsx.`,
    delCoachee: (n: string) => `Coachee „${n}" löschen?`, addRc: 'Referee Coach hinzufügen', rcCount: (n: number) => `${n} Referee Coaches`,
    noRcs: 'Keine Referee Coaches.', delRc: (n: string) => `RC „${n}" löschen?`, inactive: 'inaktiv',
    defaultSeason: 'Standard-Saison', defaultSeasonHint: 'Die Saison, in der die App standardmässig startet (für neue Nutzer).',
    save: 'Speichern', saved: 'Gespeichert ✓', testTitle: 'Test-Modus (E-Mail)',
    testHint: 'Wenn aktiv, werden keine E-Mails versendet (Feedback wird trotzdem gespeichert). Zum Live-Betrieb ausschalten.',
    testOn: 'AN — es werden keine E-Mails versendet.', testOff: 'AUS — E-Mails werden versendet.',
    noRows: 'Keine Zeilen in der Datei gefunden.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} neu, ${u} aktualisiert (von ${t}).`,
    importFail: (e: string) => `Import fehlgeschlagen: ${e}`,
    groups: 'Gruppen', groupsHint: 'Gruppen für Coachees. Mehrfachauswahl wird mit „/" verbunden.', newGroup: 'Neue Gruppe', chooseGroups: 'Gruppen wählen', toApp: 'Zur App',
  },
  EN: {
    admin: 'Admin', logout: 'Sign out', login: 'Sign in', adminPw: 'Admin password', wrongPw: 'Wrong password',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Settings', testBadge: 'Test mode',
    importXlsx: 'Import xlsx', importHint: (s: string) => `Import targets season ${s}. Existing (same name + season) are updated.`,
    firstName: 'First name', lastName: 'Last name', level: 'Level', stage: 'Stage', group: 'Group', email: 'Email', phone: 'Phone',
    add: 'Add', count: (n: number, s: string) => `${n} coachees · season ${s}`, loading: 'Loading…',
    noCoachees: (s: string) => `No coachees for ${s} — import an xlsx.`,
    delCoachee: (n: string) => `Delete coachee "${n}"?`, addRc: 'Add referee coach', rcCount: (n: number) => `${n} referee coaches`,
    noRcs: 'No referee coaches.', delRc: (n: string) => `Delete RC "${n}"?`, inactive: 'inactive',
    defaultSeason: 'Default season', defaultSeasonHint: 'The season the app opens to by default (for new users).',
    save: 'Save', saved: 'Saved ✓', testTitle: 'Test mode (email)',
    testHint: 'When on, no emails are sent (feedback is still saved). Turn off for live operation.',
    testOn: 'ON — no emails are sent.', testOff: 'OFF — emails are sent.',
    noRows: 'No rows found in the file.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} new, ${u} updated (of ${t}).`,
    importFail: (e: string) => `Import failed: ${e}`,
    groups: 'Groups', groupsHint: 'Groups for coachees. Multiple selections are joined with "/".', newGroup: 'New group', chooseGroups: 'Choose groups', toApp: 'To app',
  },
} as const;
type T = typeof STR['DE'];

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
    out.push({ first_name: first, last_name: last, full_name: `${first} ${last}`.trim(), referee_level: String(r[ci.level] ?? '').trim(), stage: String(r[ci.stage] ?? '').trim().replace(/\.0$/, ''), groups: mapGroups(String(r[ci.group] ?? '').trim()) });
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
  const [groups, setGroups] = useState<string[]>([]);
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('svrz_admin_lang') as Lang) || 'DE'; } catch { return 'DE'; }
  });
  const t = STR[lang];
  const toggleLang = () => setLang((l) => { const n = l === 'DE' ? 'EN' : 'DE'; try { localStorage.setItem('svrz_admin_lang', n); } catch { /* ignore */ } return n; });

  useEffect(() => { getAdminAuthStatus().then((s) => setAuthed(Boolean(s.authenticated))).catch(() => {}).finally(() => setChecking(false)); }, []);
  useEffect(() => { if (authed) getSettings().then((s) => { setTestMode(Boolean(s.test_mode)); setGroups(s.groups || []); }).catch(() => {}); }, [authed]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError('');
    try { await adminUiLogin(password.trim()); setAuthed(true); setPassword(''); }
    catch { setError(t.wrongPw); setPassword(''); }
    finally { setSubmitting(false); }
  };
  const logout = async () => { try { await logoutAdmin(); } catch { /* ignore */ } setAuthed(false); };

  if (checking) return <div className="min-h-screen flex items-center justify-center bg-stone-100"><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>;

  if (!authed) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
            <button onClick={toggleLang} className="absolute right-3 top-3 inline-flex items-center gap-1 text-[11px] font-semibold text-stone-400 hover:text-stone-600"><Languages size={13} />{lang}</button>
            <div className="flex flex-col items-center text-center mb-7">
              <SvrzLogo className="h-11 w-auto" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">{t.admin}</p>
            </div>
            <form onSubmit={login} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input id="admin-pw" type={showPw ? 'text' : 'password'} value={password} autoFocus disabled={submitting}
                  onChange={(e) => setPassword(e.target.value)} placeholder={t.adminPw}
                  className={`w-full pl-10 pr-10 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`} />
                <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button type="submit" disabled={!password.trim() || submitting} className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}{t.login}</button>
            </form>
          </div>
          <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">Swiss Volley Region Zürich</p>
        </div>
      </div>
    );
  }

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'coachees', label: t.coachees, icon: <Users size={15} /> },
    { id: 'rcs', label: t.rcs, icon: <ShieldCheck size={15} /> },
    { id: 'settings', label: t.settings, icon: <SettingsIcon size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 pb-16">
      <header className="bg-white border-b border-stone-200/70 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <SvrzLogo className="h-7 w-auto" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">{t.admin}</span>
          {testMode && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5"><FlaskConical size={12} /> {t.testBadge}</span>}
          <button onClick={() => { window.location.href = window.location.pathname + window.location.search; }} className="ml-auto inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Home size={14} /><span className="hidden sm:inline">{t.toApp}</span></button>
          <button onClick={toggleLang} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Languages size={14} />{lang}</button>
          <button onClick={logout} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"><LogOut size={15} /> <span className="hidden sm:inline">{t.logout}</span></button>
        </div>
        <div className="max-w-4xl mx-auto px-4 pb-3 grid grid-cols-3 gap-2">
          {tabs.map((tb) => (
            <button key={tb.id} onClick={() => setTab(tb.id)} className={`h-11 inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl transition-colors ${tab === tb.id ? 'bg-slate-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>{tb.icon}<span className="hidden sm:inline">{tb.label}</span></button>
          ))}
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 pt-5">
        {tab === 'coachees' && <CoacheesAdmin t={t} groups={groups} />}
        {tab === 'rcs' && <RcsAdmin t={t} />}
        {tab === 'settings' && <SettingsAdmin t={t} onTestMode={setTestMode} groups={groups} onGroups={setGroups} />}
      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">{children}</div>;
}

function GroupMultiSelect({ groups, value, onChange, placeholder }: { groups: string[]; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = value ? value.split('/').map((x) => x.trim()).filter(Boolean) : [];
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (g: string) => { const next = selected.includes(g) ? selected.filter((x) => x !== g) : [...selected, g]; onChange(next.join('/')); };
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${input} text-left flex items-center justify-between gap-1`}>
        <span className={selected.length ? 'text-stone-800 truncate' : 'text-stone-400'}>{selected.length ? selected.join('/') : placeholder}</span>
        <ChevronDown size={14} className="text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg p-1">
          {groups.length === 0 && <p className="px-2 py-2 text-xs text-stone-400">—</p>}
          {groups.map((g) => (
            <label key={g} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-stone-50 cursor-pointer">
              <input type="checkbox" checked={selected.includes(g)} onChange={() => toggle(g)} className="accent-red-600" />
              <span>{g}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function CoacheesAdmin({ t, groups }: { t: T; groups: string[] }) {
  const [season, setSeason] = useState(CUR_SEASON);
  const [all, setAll] = useState<Coachee[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' });

  const reload = useCallback(async () => { setLoading(true); try { setAll(await listCoachees()); } catch (e) { setNotice(String(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const rows = all.filter((c) => (typeof c.season === 'number' ? c.season === season : false)).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  const add = async () => { const full_name = `${form.first_name} ${form.last_name}`.trim(); if (!full_name) return; await createCoachee({ ...form, full_name, season } as Partial<Coachee>); setForm({ first_name: '', last_name: '', referee_level: '', stage: '', groups: '' }); await reload(); };
  const saveEdit = async (id: string) => { const full_name = `${editForm.first_name} ${editForm.last_name}`.trim(); await updateCoachee(id, { ...editForm, full_name } as Partial<Coachee>); setEditId(null); await reload(); };
  const remove = async (c: Coachee) => { if (!confirm(t.delCoachee(c.full_name))) return; await deleteCoachee(c.id); await reload(); };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setNotice('');
    try { const parsed = await parseXlsx(file); if (!parsed.length) { setNotice(t.noRows); return; } const res = await importCoachees(parsed, season); setNotice(t.importResult(seasonLabel(season), res.created, res.updated, res.total)); await reload(); }
    catch (err) { setNotice(t.importFail(String(err))); } finally { setImporting(false); e.target.value = ''; }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h2 className="text-sm font-semibold text-stone-700">{t.coachees}</h2>
          <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className="ml-auto h-9 rounded-lg border border-stone-200 bg-stone-50 text-stone-700 text-xs font-medium px-2.5">{SEASONS.map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}</select>
          <label className={`${btnPrimary} cursor-pointer ${importing ? 'opacity-60 pointer-events-none' : ''}`}>{importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}<span>{t.importXlsx}</span><input type="file" accept=".xlsx" className="hidden" onChange={onFile} /></label>
        </div>
        <p className="text-xs text-stone-400">{t.importHint(seasonLabel(season))}</p>
        {notice && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{notice}</p>}
      </Card>
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <input className={input} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <select className={input} value={joinStufe(form.referee_level, form.stage)} onChange={(e) => setForm({ ...form, ...splitStufe(e.target.value) })}>
            <option value="">{t.stage}</option>
            {STUFEN.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <GroupMultiSelect groups={groups} value={form.groups} onChange={(v) => setForm({ ...form, groups: v })} placeholder={t.chooseGroups} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? t.loading : t.count(rows.length, seasonLabel(season))}</p>
        <div className="divide-y divide-stone-100">
          {rows.map((c) => editId === c.id ? (
            <div key={c.id} className="py-2 grid grid-cols-2 sm:grid-cols-5 gap-2 items-center">
              <input className={input} value={editForm.first_name} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={input} value={editForm.last_name} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <select className={input} value={joinStufe(editForm.referee_level, editForm.stage)} onChange={(e) => setEditForm({ ...editForm, ...splitStufe(e.target.value) })}>
                <option value="">{t.stage}</option>
                {STUFEN.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <GroupMultiSelect groups={groups} value={editForm.groups} onChange={(v) => setEditForm({ ...editForm, groups: v })} placeholder={t.chooseGroups} />
              <div className="flex gap-1.5"><button onClick={() => saveEdit(c.id)} className={btnPrimary}><Check size={15} /></button><button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button></div>
            </div>
          ) : (
            <div key={c.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0"><p className="text-sm font-medium text-stone-800 truncate">{c.full_name}</p><p className="text-xs text-stone-400 truncate">{[c.referee_level, c.stage].filter(Boolean).join('-')}{c.groups ? ` · ${c.groups}` : ''}</p></div>
              <button onClick={() => { setEditId(c.id); setEditForm({ first_name: c.first_name || '', last_name: c.last_name || '', referee_level: c.referee_level || '', stage: c.stage || '', groups: c.groups || '' }); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => remove(c)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {!loading && rows.length === 0 && <p className="py-8 text-center text-sm text-stone-400">{t.noCoachees(seasonLabel(season))}</p>}
        </div>
      </Card>
    </>
  );
}

function RcsAdmin({ t }: { t: T }) {
  const [rcs, setRcs] = useState<RcPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RcPerson>({ id: '' });
  const reload = useCallback(async () => { setLoading(true); try { setRcs(await listRcPeopleFull()); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const add = async () => { if (!form.first_name && !form.last_name) return; await createRcPerson({ ...form, active: true }); setForm({ first_name: '', last_name: '', email: '', phone: '' }); await reload(); };
  const saveEdit = async (id: string) => { await updateRcPerson(id, editForm); setEditId(null); await reload(); };
  const remove = async (r: RcPerson) => { if (!confirm(t.delRc(`${r.first_name} ${r.last_name}`))) return; await deleteRcPerson(r.id); await reload(); };
  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-2">{t.addRc}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <input className={input} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input className={input} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? t.loading : t.rcCount(rcs.length)}</p>
        <div className="divide-y divide-stone-100">
          {rcs.map((r) => editId === r.id ? (
            <div key={r.id} className="py-2 grid grid-cols-2 sm:grid-cols-5 gap-2 items-center">
              <input className={input} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={input} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <input className={input} value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              <input className={input} value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              <div className="flex gap-1.5"><button onClick={() => saveEdit(r.id)} className={btnPrimary}><Check size={15} /></button><button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button></div>
            </div>
          ) : (
            <div key={r.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0"><p className="text-sm font-medium text-stone-800 truncate">{r.first_name} {r.last_name}{r.active === false ? ` · ${t.inactive}` : ''}</p><p className="text-xs text-stone-400 truncate">{r.email}{r.phone ? ` · ${r.phone}` : ''}</p></div>
              <button onClick={() => { setEditId(r.id); setEditForm(r); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => remove(r)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {!loading && rcs.length === 0 && <p className="py-8 text-center text-sm text-stone-400">{t.noRcs}</p>}
        </div>
      </Card>
    </>
  );
}

function SettingsAdmin({ t, onTestMode, groups, onGroups }: { t: T; onTestMode: (v: boolean) => void; groups: string[]; onGroups: (g: string[]) => void }) {
  const [season, setSeason] = useState<number>(CUR_SEASON);
  const [testMode, setTm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ng, setNg] = useState('');
  const [gi, setGi] = useState<number | null>(null);
  const [gv, setGv] = useState('');
  useEffect(() => { getSettings().then((s) => { if (s.default_season) setSeason(s.default_season); setTm(Boolean(s.test_mode)); onTestMode(Boolean(s.test_mode)); }).catch(() => {}).finally(() => setLoading(false)); }, [onTestMode]);
  const saveGroups = async (next: string[]) => { onGroups(next); try { await putSettings({ groups: next }); } catch { /* ignore */ } };
  const addGroup = () => { const v = ng.trim(); if (!v || groups.includes(v)) return; setNg(''); void saveGroups([...groups, v].sort()); };
  const delGroup = (i: number) => void saveGroups(groups.filter((_, idx) => idx !== i));
  const saveEditGroup = (i: number) => { const v = gv.trim(); if (v) { const next = groups.slice(); next[i] = v; void saveGroups(Array.from(new Set(next)).sort()); } setGi(null); };
  const save = async () => { await putSettings({ default_season: season }); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const toggleTest = async () => { const next = !testMode; setTm(next); onTestMode(next); try { await putSettings({ test_mode: next }); } catch { setTm(!next); onTestMode(!next); } };
  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.defaultSeason}</h2>
        <p className="text-xs text-stone-400 mb-3">{t.defaultSeasonHint}</p>
        <div className="flex items-center gap-2">
          <select value={season} disabled={loading} onChange={(e) => setSeason(Number(e.target.value))} className="h-9 rounded-lg border border-stone-300 bg-white text-sm px-3">{SEASONS.map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}</select>
          <button onClick={save} className={btnPrimary}><Check size={15} /> {t.save}</button>
          {saved && <span className="text-xs text-green-600 font-medium">{t.saved}</span>}
        </div>
      </Card>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.groups}</h2>
        <p className="text-xs text-stone-400 mb-3">{t.groupsHint}</p>
        <div className="flex gap-2 mb-3">
          <input className={input} placeholder={t.newGroup} value={ng} onChange={(e) => setNg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }} />
          <button onClick={addGroup} className={btnPrimary}><Plus size={15} /> {t.add}</button>
        </div>
        <div className="divide-y divide-stone-100">
          {groups.map((g, i) => gi === i ? (
            <div key={g} className="py-2 flex items-center gap-2">
              <input className={input} value={gv} onChange={(e) => setGv(e.target.value)} />
              <button onClick={() => saveEditGroup(i)} className={btnPrimary}><Check size={15} /></button>
              <button onClick={() => setGi(null)} className={btnGhost}><X size={14} /></button>
            </div>
          ) : (
            <div key={g} className="py-2 flex items-center gap-3">
              <span className="flex-1 text-sm text-stone-800">{g}</span>
              <button onClick={() => { setGi(i); setGv(g); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => delGroup(i)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {groups.length === 0 && <p className="py-4 text-center text-xs text-stone-400">—</p>}
        </div>
      </Card>
      <Card>
        <div className="flex items-start gap-3">
          <FlaskConical size={18} className={testMode ? 'text-amber-600 mt-0.5' : 'text-stone-400 mt-0.5'} />
          <div className="flex-1"><h2 className="text-sm font-semibold text-stone-700">{t.testTitle}</h2><p className="text-xs text-stone-400">{t.testHint}</p></div>
          <button onClick={toggleTest} disabled={loading} role="switch" aria-checked={testMode} className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors ${testMode ? 'bg-amber-500' : 'bg-stone-300'}`}><span className={`inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform mt-0.5 ${testMode ? 'translate-x-5' : 'translate-x-0.5'}`} /></button>
        </div>
        <p className={`mt-2 text-xs font-medium ${testMode ? 'text-amber-700' : 'text-green-600'}`}>{testMode ? t.testOn : t.testOff}</p>
      </Card>
    </>
  );
}
