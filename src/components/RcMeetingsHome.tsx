import { useEffect, useState } from 'react';
import { CalendarPlus, Clock, Video } from 'lucide-react';
import { downloadRcMeetingIcs, listUpcomingRcMeetings, type RcMeetingPublic } from '../lib/pocketbase';
import { isDemoMode } from '../lib/demo';
import { fmtMeetingDate } from './RcMeetingsAdmin';

/**
 * Home: the RC-Sitzungen not yet over, for every coach — the invitation goes
 * to the whole commission. Time, notes (the Traktanden), the video-call link
 * and "Zum Kalender" for one meeting; a coach subscribed to the calendar feed
 * has it there already. Renders nothing while there is no meeting ahead, and
 * nothing in the demo, which promises zero backend calls.
 */
export default function RcMeetingsHome({ lang }: { lang: 'DE' | 'EN' }) {
  const de = lang === 'DE';
  const [meetings, setMeetings] = useState<RcMeetingPublic[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (isDemoMode()) return;
    let live = true;
    // A Home without its meetings is still a Home: a failure here stays quiet.
    listUpcomingRcMeetings().then((m) => { if (live) setMeetings(m); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (meetings.length === 0) return null;

  const addToCalendar = async (id: string) => {
    setBusy(id);
    try { await downloadRcMeetingIcs(id); } catch { /* the button simply does nothing */ }
    finally { setBusy(''); }
  };

  return (
    <section data-testid="rc-meetings-home" className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{de ? 'RC-Sitzung' : 'RC meeting'}</h3>
      {meetings.map((m) => (
        <div key={m.id} className="rounded-lg border border-stone-200 border-l-[3px] border-l-red-600 bg-white px-3 py-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-stone-800">{m.title}</p>
              <p className="mt-0.5 inline-flex flex-wrap items-center gap-x-1.5 text-xs text-stone-500">
                <Clock size={12} />
                {fmtMeetingDate(m.date, lang, true)}
                {m.start && ` · ${m.start}${m.end ? `–${m.end}` : ''}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {m.link && (
                <a
                  href={m.link} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-red-600 px-2.5 text-xs font-semibold text-white hover:bg-red-700"
                >
                  <Video size={13} /> {de ? 'Beitreten' : 'Join'}
                </a>
              )}
              <button
                type="button" onClick={() => void addToCalendar(m.id)} disabled={busy === m.id}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50"
              >
                <CalendarPlus size={13} /> {de ? 'Zum Kalender' : 'Add to calendar'}
              </button>
            </div>
          </div>
          {m.notes && <p className="mt-2 text-sm text-stone-600 whitespace-pre-line">{m.notes}</p>}
        </div>
      ))}
    </section>
  );
}
