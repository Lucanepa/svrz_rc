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
import { RefreshCw, Trash2 } from 'lucide-react';

type Coachee = {
  id: string;
  full_name: string;
  email?: string;
  level?: string;
  group?: string;
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

export default function AdminPanel() {
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [records, setRecords] = useState<RefCoach[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState({ full_name: '', email: '', level: '', group: '' });

  const loadAll = async () => {
    setLoading(true);
    setMessage('');
    try {
      const [coacheesData, recordsData] = await Promise.all([listCoachees(), listRefereeCoaches()]);
      setCoachees(coacheesData);
      setRecords(recordsData);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const resetForm = () => {
    setEditingId('');
    setForm({ full_name: '', email: '', level: '', group: '' });
  };

  const onSaveCoachee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (editingId) {
        await updateCoachee(editingId, form);
        setMessage('Coachee updated.');
      } else {
        await createCoachee(form);
        setMessage('Coachee created.');
      }
      resetForm();
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteCoachee = async (id: string) => {
    if (!window.confirm('Delete this coachee?')) {
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await deleteCoachee(id);
      await loadAll();
      setMessage('Coachee deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteRecord = async (id: string) => {
    if (!window.confirm('Delete this feedback entry?')) {
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await deleteRefereeCoach(id);
      await loadAll();
      setMessage('Feedback entry deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const onSyncGames = async () => {
    setLoading(true);
    setMessage('');
    try {
      const result = await syncGamesFromVolleyManager();
      setMessage(`Synced ${result.imported ?? 0} games.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg p-4 no-print">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Admin Management</h2>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="h-10 px-3 text-sm border border-slate-700 rounded-md hover:bg-slate-800 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <span className="inline-flex items-center gap-2"><RefreshCw size={16} /> Refresh</span>
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">Add / Edit Coachee</h3>
          <form onSubmit={onSaveCoachee} className="space-y-2">
            <label className="block text-xs text-slate-300">
              Full name
              <input
                value={form.full_name}
                onChange={(e) => setForm((prev) => ({ ...prev, full_name: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
                required
              />
            </label>
            <label className="block text-xs text-slate-300">
              Email
              <input
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </label>
            <label className="block text-xs text-slate-300">
              Level
              <input
                value={form.level}
                onChange={(e) => setForm((prev) => ({ ...prev, level: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </label>
            <label className="block text-xs text-slate-300">
              Group
              <input
                value={form.group}
                onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value }))}
                className="h-10 w-full px-3 mt-1 bg-slate-900 border border-slate-700 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loading}
                className="h-10 px-4 bg-emerald-600 hover:bg-emerald-700 rounded-md text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
              >
                {editingId ? 'Update' : 'Create'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="h-10 px-4 border border-slate-700 hover:bg-slate-800 rounded-md text-sm transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          </form>
        </section>

        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">Coachees</h3>
          <div className="max-h-72 overflow-auto divide-y divide-slate-800">
            {coachees.map((coachee) => (
              <div key={coachee.id} className="py-2">
                <div className="text-sm font-medium">{coachee.full_name}</div>
                <div className="text-xs text-slate-400">{coachee.level || '-'} | {coachee.group || '-'}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(coachee.id);
                      setForm({
                        full_name: coachee.full_name || '',
                        email: coachee.email || '',
                        level: coachee.level || '',
                        group: coachee.group || '',
                      });
                    }}
                    className="h-9 px-3 text-xs border border-slate-700 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteCoachee(coachee.id)}
                    className="h-9 px-3 text-xs border border-red-500/40 text-red-300 rounded-md hover:bg-red-900/30 cursor-pointer transition-colors"
                  >
                    <span className="inline-flex items-center gap-1"><Trash2 size={14} /> Delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border border-slate-800 rounded-md p-3">
          <h3 className="font-medium mb-3">Games Auto Sync</h3>
          <button
            type="button"
            onClick={() => void onSyncGames()}
            disabled={loading}
            className="h-10 px-4 bg-slate-100 text-slate-900 hover:bg-white rounded-md text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
          >
            Sync from VolleyManager API
          </button>
          <p className="mt-3 text-xs text-slate-400">
            Games are synced automatically from VolleyManager using your configured endpoint.
          </p>
        </section>
      </div>

      <section className="border border-slate-800 rounded-md p-3 mt-4">
        <h3 className="font-medium mb-2">Referee Coaches Records</h3>
        <div className="max-h-64 overflow-auto divide-y divide-slate-800">
          {records.map((record) => (
            <div key={record.id} className="py-2 flex items-center justify-between gap-3">
              <div className="text-xs">
                <div className="text-slate-100 font-medium">
                  {record.expand?.coachee?.full_name || '-'} | Game {record.expand?.game?.match_no || '-'}
                </div>
                <div className="text-slate-400">
                  RC: {record.rc_name || '-'} | Role: {record.role_assessed || '-'} | {record.submitted_at || '-'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onDeleteRecord(record.id)}
                className="h-9 px-3 text-xs border border-red-500/40 text-red-300 rounded-md hover:bg-red-900/30 cursor-pointer transition-colors"
              >
                <span className="inline-flex items-center gap-1"><Trash2 size={14} /> Delete</span>
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
