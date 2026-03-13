import { FormEvent, useEffect, useState } from 'react';
import {
  createCoachee,
  deleteCoachee,
  deleteRefereeCoach,
  listCoachees,
  listRefereeCoaches,
  syncGamesFromVolleyManager,
  updateCoachee,
} from '../lib/pocketbase';
import { COACHEE_GROUP_OPTIONS, normalizeCoacheeGroup } from '../lib/coacheeGroup';
import { RefreshCw, Trash2 } from 'lucide-react';

type Lang = 'DE' | 'EN';

const ADMIN_STRINGS = {
  DE: {
    adminManagement: 'Admin-Verwaltung',
    refresh: 'Aktualisieren',
    addEditCoachee: 'Coachee hinzufügen / bearbeiten',
    fullName: 'Vollständiger Name',
    email: 'E-Mail',
    level: 'Niveau',
    group: 'Gruppe',
    choose: 'Wählen',
    notes: 'Notizen',
    isActive: 'Aktiv',
    update: 'Aktualisieren',
    create: 'Erstellen',
    clear: 'Leeren',
    coachees: 'Coachees',
    inactive: 'Inaktiv',
    active: 'Aktiv',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    gamesAutoSync: 'Spiele Auto-Sync',
    syncFromVolleyManager: 'Mit VolleyManager API synchronisieren',
    syncHelp: 'Spiele werden automatisch aus VolleyManager über den konfigurierten Endpunkt synchronisiert.',
    refereeCoachesRecords: 'Schiedsrichter-Coaching Einträge',
    game: 'Spiel',
    role: 'Rolle',
    rc: 'RC',
    confirmDeleteCoachee: 'Diesen Coachee löschen?',
    confirmDeleteFeedback: 'Diesen Feedback-Eintrag löschen?',
    coacheeUpdated: 'Coachee aktualisiert.',
    coacheeCreated: 'Coachee erstellt.',
    coacheeDeleted: 'Coachee gelöscht.',
    feedbackDeleted: 'Feedback-Eintrag gelöscht.',
    syncedGames: 'Synchronisiert: {count} Spiele.',
  },
  EN: {
    adminManagement: 'Admin Management',
    refresh: 'Refresh',
    addEditCoachee: 'Add / Edit Coachee',
    fullName: 'Full name',
    email: 'Email',
    level: 'Level',
    group: 'Group',
    choose: 'Choose',
    notes: 'Notes',
    isActive: 'Is Active',
    update: 'Update',
    create: 'Create',
    clear: 'Clear',
    coachees: 'Coachees',
    inactive: 'Inactive',
    active: 'Active',
    edit: 'Edit',
    delete: 'Delete',
    gamesAutoSync: 'Games Auto Sync',
    syncFromVolleyManager: 'Sync from VolleyManager API',
    syncHelp: 'Games are synced automatically from VolleyManager using your configured endpoint.',
    refereeCoachesRecords: 'Referee Coaches Records',
    game: 'Game',
    role: 'Role',
    rc: 'RC',
    confirmDeleteCoachee: 'Delete this coachee?',
    confirmDeleteFeedback: 'Delete this feedback entry?',
    coacheeUpdated: 'Coachee updated.',
    coacheeCreated: 'Coachee created.',
    coacheeDeleted: 'Coachee deleted.',
    feedbackDeleted: 'Feedback entry deleted.',
    syncedGames: 'Synced {count} games.',
  },
} as const;

function localizeRuntimeError(message: string, lang: Lang): string {
  const normalized = message.trim();
  const map: Record<string, { DE: string; EN: string }> = {
    Unauthorized: { DE: 'Nicht autorisiert.', EN: 'Unauthorized.' },
    'email and password are required.': { DE: 'E-Mail und Passwort sind erforderlich.', EN: 'Email and password are required.' },
    'Invalid credentials.': { DE: 'Ungültige Anmeldedaten.', EN: 'Invalid credentials.' },
    'gameId, role and formData are required.': { DE: 'gameId, Rolle und formData sind erforderlich.', EN: 'gameId, role and formData are required.' },
    'Set VM_USERNAME and VM_PASSWORD in environment variables.': {
      DE: 'VM_USERNAME und VM_PASSWORD müssen als Umgebungsvariablen gesetzt sein.',
      EN: 'Set VM_USERNAME and VM_PASSWORD in environment variables.',
    },
  };
  return map[normalized]?.[lang] || message;
}

type Coachee = {
  id: string;
  full_name: string;
  email?: string;
  level?: string;
  group?: string;
  is_active?: boolean;
  notes?: string;
};

type RefCoach = {
  id: string;
  role_assessed?: string;
  rc_name?: string;
  submitted_at?: string;
  expand?: {
    coachee?: { full_name?: string };
    game?: { match_no?: string };
  };
};

type AdminPanelProps = {
  lang: Lang;
};

export default function AdminPanel({ lang }: AdminPanelProps) {
  const t = ADMIN_STRINGS[lang];
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [records, setRecords] = useState<RefCoach[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState({ full_name: '', email: '', level: '', group: '', is_active: true, notes: '' });

  const loadAll = async () => {
    setLoading(true);
    setMessage('');
    try {
      const [coacheesData, recordsData] = await Promise.all([listCoachees(), listRefereeCoaches()]);
      setCoachees(coacheesData);
      setRecords(recordsData);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(localizeRuntimeError(reason, lang));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const resetForm = () => {
    setEditingId('');
    setForm({ full_name: '', email: '', level: '', group: '', is_active: true, notes: '' });
  };

  const onSaveCoachee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (editingId) {
        await updateCoachee(editingId, { ...form, group: normalizeCoacheeGroup(form.group) });
        setMessage(t.coacheeUpdated);
      } else {
        await createCoachee({ ...form, group: normalizeCoacheeGroup(form.group) });
        setMessage(t.coacheeCreated);
      }
      resetForm();
      await loadAll();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(localizeRuntimeError(reason, lang));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteCoachee = async (id: string) => {
    if (!window.confirm(t.confirmDeleteCoachee)) {
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await deleteCoachee(id);
      await loadAll();
      setMessage(t.coacheeDeleted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(localizeRuntimeError(reason, lang));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteRecord = async (id: string) => {
    if (!window.confirm(t.confirmDeleteFeedback)) {
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await deleteRefereeCoach(id);
      await loadAll();
      setMessage(t.feedbackDeleted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(localizeRuntimeError(reason, lang));
    } finally {
      setLoading(false);
    }
  };

  const onSyncGames = async () => {
    setLoading(true);
    setMessage('');
    try {
      const result = await syncGamesFromVolleyManager();
      setMessage(t.syncedGames.replace('{count}', String(result.imported ?? 0)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(localizeRuntimeError(reason, lang));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg p-4 no-print">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">{t.adminManagement}</h2>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="h-10 px-3 text-sm border border-slate-700 rounded-md hover:bg-slate-800 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <span className="inline-flex items-center gap-2"><RefreshCw size={16} /> {t.refresh}</span>
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">{t.addEditCoachee}</h3>
          <form onSubmit={onSaveCoachee} className="space-y-2">
            <label className="block text-xs text-slate-300">
              {t.fullName}
              <input
                value={form.full_name}
                onChange={(e) => setForm((prev) => ({ ...prev, full_name: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
                required
              />
            </label>
            <label className="block text-xs text-slate-300">
              {t.email}
              <input
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </label>
            <label className="block text-xs text-slate-300">
              {t.level}
              <input
                value={form.level}
                onChange={(e) => setForm((prev) => ({ ...prev, level: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </label>
            <label className="block text-xs text-slate-300">
              {t.group}
              <select
                value={form.group}
                onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <option value="">{t.choose}</option>
                {COACHEE_GROUP_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-300">
              {t.notes}
              <textarea
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                className="w-full px-3 py-2 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
                rows={3}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300 pt-1">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              />
              {t.isActive}
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loading}
                className="h-10 px-4 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
              >
                {editingId ? t.update : t.create}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="h-10 px-4 border border-slate-700 hover:bg-slate-800 rounded-md text-sm transition-colors cursor-pointer"
              >
                {t.clear}
              </button>
            </div>
          </form>
        </section>

        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">{t.coachees}</h3>
          <div className="max-h-72 overflow-auto divide-y divide-slate-800">
            {coachees.map((coachee) => (
              <div key={coachee.id} className="py-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span>{coachee.full_name}</span>
                  <span
                    className={coachee.is_active === false
                      ? 'text-[10px] px-2 py-0.5 rounded bg-stone-700 text-stone-200'
                      : 'text-[10px] px-2 py-0.5 rounded bg-emerald-700/30 text-emerald-300'}
                  >
                    {coachee.is_active === false ? t.inactive : t.active}
                  </span>
                </div>
                <div className="text-xs text-slate-400">{coachee.level || '-'} | {normalizeCoacheeGroup(coachee.group) || '-'}</div>
                {coachee.notes && (
                  <div className="text-xs text-slate-500 mt-1">{coachee.notes}</div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(coachee.id);
                      setForm({
                        full_name: coachee.full_name || '',
                        email: coachee.email || '',
                        level: coachee.level || '',
                        group: normalizeCoacheeGroup(coachee.group) || '',
                        is_active: coachee.is_active !== false,
                        notes: coachee.notes || '',
                      });
                    }}
                    className="h-9 px-3 text-xs border border-slate-700 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
                  >
                    {t.edit}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteCoachee(coachee.id)}
                    className="h-9 px-3 text-xs border border-red-500/40 text-red-300 rounded-md hover:bg-red-900/30 cursor-pointer transition-colors"
                  >
                    <span className="inline-flex items-center gap-1"><Trash2 size={14} /> {t.delete}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">{t.gamesAutoSync}</h3>
          <button
            type="button"
            onClick={() => void onSyncGames()}
            disabled={loading}
            className="h-10 px-4 bg-slate-100 text-slate-900 hover:bg-white rounded-md text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
          >
            {t.syncFromVolleyManager}
          </button>
          <p className="mt-3 text-xs text-slate-400">
            {t.syncHelp}
          </p>
        </section>
      </div>

      <section className="border border-slate-800 rounded-md p-3 mt-4">
        <h3 className="font-medium mb-2">{t.refereeCoachesRecords}</h3>
        <div className="max-h-64 overflow-auto divide-y divide-slate-800">
          {records.map((record) => (
            <div key={record.id} className="py-2 flex items-center justify-between gap-3">
              <div className="text-xs">
                <div className="text-slate-100 font-medium">
                  {record.expand?.coachee?.full_name || '-'} | {t.game} {record.expand?.game?.match_no || '-'}
                </div>
                <div className="text-slate-400">
                  {t.rc}: {record.rc_name || '-'} | {t.role}: {record.role_assessed || '-'} | {record.submitted_at || '-'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onDeleteRecord(record.id)}
                className="h-9 px-3 text-xs border border-red-500/40 text-red-300 rounded-md hover:bg-red-900/30 cursor-pointer transition-colors"
              >
                <span className="inline-flex items-center gap-1"><Trash2 size={14} /> {t.delete}</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      {message && (
        <p className="mt-3 text-xs text-emerald-300" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
