import { useState, type ChangeEvent } from 'react';
import { CalendarDays, Check, Clock, Loader2, Pencil, Plus, Trash2, Users, Video, X } from 'lucide-react';
import { confirmDialog, toast } from './ui';
import {
  createRcMeeting, deleteRcMeeting, updateRcMeeting,
  type RcMeeting, type RcMeetingDraft,
} from '../lib/pocketbase';

/**
 * Admin → Übersicht → RC-Sitzungen: the commission's meetings, each a row of
 * its own — date, time, video-call link, notes and what attending pays (a
 * line on each attendee's expense sheet). Every coach sees the upcoming ones
 * on Home and in their calendar feed. Who attended is ticked per coach in the
 * table above. Several per season (Luca, 2026-10-05: "+ Add RC meeting in
 * case we do more").
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    title: 'RC-Sitzungen',
    hint: 'Erscheinen bei allen Referee Coaches auf der Startseite und im Kalender-Abo. Wer teilgenommen hat, hakst du oben pro Coach ab — das gibt eine Zeile auf der Spesenabrechnung.',
    add: 'RC-Sitzung hinzufügen',
    none: 'Für diese Saison ist noch keine RC-Sitzung erfasst.',
    fTitle: 'Titel', fDate: 'Datum', fStart: 'Beginn', fEnd: 'Ende', fLink: 'Videocall-Link (optional)',
    fNotes: 'Notizen / Traktanden (optional)', fRate: 'Ansatz pro Teilnahme (CHF)',
    linkHint: 'https://… — Teams, Zoom, Meet',
    save: 'Speichern', cancel: 'Abbrechen', edit: 'Bearbeiten', del: 'Löschen',
    saved: 'RC-Sitzung gespeichert.', deleted: 'RC-Sitzung gelöscht.',
    needDate: 'Bitte ein Datum wählen.',
    badLink: 'Der Link muss mit https:// beginnen.',
    delTitle: (d: string) => `RC-Sitzung vom ${d} löschen?`,
    delBody: (n: number) => n > 0
      ? `${n} Coach${n === 1 ? '' : 'es'} ${n === 1 ? 'ist' : 'sind'} als Teilnehmer:in erfasst — die Zeile verschwindet von ${n === 1 ? 'seiner/ihrer' : 'ihren'} Spesenabrechnung${n === 1 ? '' : 'en'}.`
      : 'Sie verschwindet von der Startseite und aus dem Kalender aller Coaches.',
    attended: (n: number) => `${n} teilgenommen`,
    noTime: 'ohne Uhrzeit',
    defaultTitle: 'RC-Sitzung',
  },
  EN: {
    title: 'RC meetings',
    hint: 'Shown to every referee coach on Home and in their calendar feed. Tick who attended per coach above — that puts a line on their expense sheet.',
    add: 'Add RC meeting',
    none: 'No RC meeting recorded for this season yet.',
    fTitle: 'Title', fDate: 'Date', fStart: 'Start', fEnd: 'End', fLink: 'Video-call link (optional)',
    fNotes: 'Notes / agenda (optional)', fRate: 'Rate per attendee (CHF)',
    linkHint: 'https://… — Teams, Zoom, Meet',
    save: 'Save', cancel: 'Cancel', edit: 'Edit', del: 'Delete',
    saved: 'RC meeting saved.', deleted: 'RC meeting deleted.',
    needDate: 'Please pick a date.',
    badLink: 'The link must start with https://.',
    delTitle: (d: string) => `Delete the RC meeting of ${d}?`,
    delBody: (n: number) => n > 0
      ? `${n} coach${n === 1 ? ' is' : 'es are'} recorded as attending — the line disappears from their expense sheet${n === 1 ? '' : 's'}.`
      : 'It disappears from every coach’s Home and calendar.',
    attended: (n: number) => `${n} attended`,
    noTime: 'no time set',
    defaultTitle: 'RC meeting',
  },
};

const input = 'h-9 px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors';

export const fmtMeetingDate = (iso: string, lang: Lang, weekday = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  if (!weekday) return `${m[3]}.${m[2]}.${m[1]}`;
  // A wall-clock date: formatted in UTC so no zone can move it a day.
  return new Intl.DateTimeFormat(lang === 'DE' ? 'de-CH' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
};

type Form = { title: string; date: string; start: string; end: string; link: string; notes: string; rate: string };

const formOf = (m: RcMeeting | null, defaultTitle: string): Form => m
  ? { title: m.title, date: m.date, start: m.start, end: m.end, link: m.link, notes: m.notes, rate: String(m.rate) }
  : { title: defaultTitle, date: '', start: '19:00', end: '', link: '', notes: '', rate: '60' };

export default function RcMeetingsAdmin({ lang, meetings, onMeetings, loading }: {
  lang: Lang;
  meetings: RcMeeting[];
  onMeetings: (next: RcMeeting[]) => void;
  loading: boolean;
}) {
  const t = STR[lang];
  // 'new' for the add form, a meeting id for an open edit, null for none.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(formOf(null, t.defaultTitle));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = (m: RcMeeting | null) => { setForm(formOf(m, t.defaultTitle)); setEditing(m ? m.id : 'new'); setErr(''); };
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { setErr(t.needDate); return; }
    if (form.link.trim() && !/^https:\/\//i.test(form.link.trim())) { setErr(t.badLink); return; }
    const rate = Number(form.rate);
    const draft: RcMeetingDraft = {
      title: form.title.trim() || t.defaultTitle, date: form.date, start: form.start, end: form.end,
      link: form.link.trim(), notes: form.notes, rate: Number.isFinite(rate) && rate >= 0 ? rate : 60,
    };
    setBusy(true); setErr('');
    try {
      const saved = editing === 'new' ? await createRcMeeting(draft) : await updateRcMeeting(editing!, draft);
      const rest = meetings.filter((m) => m.id !== saved.id);
      onMeetings([...rest, saved].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)));
      setEditing(null);
      toast.success(t.saved, { lang });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (m: RcMeeting) => {
    if (!(await confirmDialog({ title: t.delTitle(fmtMeetingDate(m.date, lang)), message: t.delBody(m.attended.length), confirmLabel: t.del, tone: 'danger', lang }))) return;
    setBusy(true); setErr('');
    try {
      await deleteRcMeeting(m.id);
      onMeetings(meetings.filter((x) => x.id !== m.id));
      setEditing(null);
      toast.success(t.deleted, { lang });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const editor = (m: RcMeeting | null) => (
    <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3 sm:p-4 space-y-3" data-testid="rc-meeting-form">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-stone-500 flex-1 min-w-[12rem]">
          <span className="block mb-0.5">{t.fTitle}</span>
          <input className={`${input} w-full`} value={form.title} onChange={set('title')} maxLength={120} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.fDate}</span>
          <input type="date" className={input} value={form.date} onChange={set('date')} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.fStart}</span>
          <input type="time" className={input} value={form.start} onChange={set('start')} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.fEnd}</span>
          <input type="time" className={input} value={form.end} onChange={set('end')} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.fRate}</span>
          <input type="number" min={0} step="0.05" inputMode="decimal" className={`${input} w-24`} value={form.rate} onChange={set('rate')} />
        </label>
      </div>
      <label className="block text-xs text-stone-500">
        <span className="block mb-0.5">{t.fLink}</span>
        <input type="url" inputMode="url" className={`${input} w-full`} placeholder={t.linkHint} value={form.link} onChange={set('link')} />
      </label>
      <label className="block text-xs text-stone-500">
        <span className="block mb-0.5">{t.fNotes}</span>
        <textarea rows={4} className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500" value={form.notes} onChange={set('notes')} maxLength={4000} />
      </label>
      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t.save}
        </button>
        <button type="button" className={btnGhost} disabled={busy} onClick={() => setEditing(null)}><X size={13} /> {t.cancel}</button>
        {m && (
          <button type="button" className={`${btnGhost} ml-auto text-red-700 border-red-200 hover:bg-red-50`} disabled={busy} onClick={() => void remove(m)}>
            <Trash2 size={13} /> {t.del}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div data-testid="rc-meetings-admin" className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-stone-700">{t.title}</h2>
        {editing !== 'new' && (
          <button type="button" className={btnGhost} disabled={loading} onClick={() => open(null)}>
            <Plus size={13} /> {t.add}
          </button>
        )}
      </div>
      <p className="text-xs text-stone-400 mb-3">{t.hint}</p>

      <div className="space-y-2">
        {editing === 'new' && editor(null)}
        {meetings.length === 0 && editing !== 'new' && <p className="text-sm text-stone-400">{t.none}</p>}
        {meetings.map((m) => (editing === m.id ? <div key={m.id}>{editor(m)}</div> : (
          <div key={m.id} data-testid="rc-meeting-row" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-stone-200 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-stone-800">{m.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                <span className="inline-flex items-center gap-1"><CalendarDays size={12} /> {fmtMeetingDate(m.date, lang, true)}</span>
                <span className="inline-flex items-center gap-1"><Clock size={12} /> {m.start ? `${m.start}${m.end ? `–${m.end}` : ''}` : t.noTime}</span>
                {m.link && <span className="inline-flex items-center gap-1"><Video size={12} /> {new URL(m.link).hostname}</span>}
                <span className="inline-flex items-center gap-1"><Users size={12} /> {t.attended(m.attended.length)}</span>
                <span>CHF {m.rate.toFixed(2)}</span>
              </p>
              {m.notes && <p className="mt-1 text-xs text-stone-500 whitespace-pre-line line-clamp-3">{m.notes}</p>}
            </div>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => open(m)}><Pencil size={13} /> {t.edit}</button>
          </div>
        )))}
      </div>
    </div>
  );
}
