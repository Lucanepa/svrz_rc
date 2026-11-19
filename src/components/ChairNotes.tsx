import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Circle, Tag as TagIcon, X } from 'lucide-react';
import { RichView } from './RichText';
import { SkeletonRows } from './Skeleton';
import { GameFlagChips } from './GameMarks';
import LevelText from './LevelText';
import { cn } from '../lib/utils';
import { dayLabel } from '../lib/appTime';
import { groupLabel } from '../lib/coacheeGroup';
import { currentSeason, seasonLabel } from '../lib/season';
import { outcomeLabel, srGoalLabel } from '../lib/statsLabels';
import { toast } from './ui';
import {
  listPresidentNotes, loadRcGameNotes, listPresidentMarks, savePresidentMark, setPresidentRead, loadPresidentOverview,
  type PresidentNote, type RcGameNote, type RefereeMark, type PresidentOverviewRow,
} from '../lib/pocketbase';

// The chair's RC-Notizen (19.11.2026). Asked for by the chair while working
// with the system: the notes in date order with the referee's level, a filter
// by motivation and Einstufung ("I see a lot of text, but no clear overview of
// which ones are highly motivated and which ones are okay as they are"), a
// tick for what she has already read, and tags of her own per referee — "a
// whiteboard for me, like next year N3 course". Every word here stays behind
// her password: the server answers these routes to her console session only.

type Lang = 'DE' | 'EN';
type Tick = '' | 'up' | 'check' | 'down';

const STR = {
  DE: {
    hint: 'Vertrauliche Notizen der Referee Coaches zu abgeschickten Feedbacks — nur hier sichtbar. Der Schiedsrichter erfährt nichts davon. Neueste Spiele zuerst.',
    tabNotes: 'Notizen',
    tabOverview: 'Übersicht pro SR',
    motivation: 'Motivation',
    einstufung: 'Einstufung',
    all: 'Alle',
    level: 'Niveau',
    group: 'Gruppe',
    tag: 'Tag',
    allLevels: 'Niveau: alle',
    allGroups: 'Gruppe: alle',
    allTags: 'Tag: alle',
    unreadOnly: 'Nur ungelesene',
    search: 'Name suchen',
    reset: 'Filter zurücksetzen',
    countOf: (total: number) => `von ${total} Notizen`,
    countUnread: 'ungelesen',
    countUp: 'Einstufung ↑',
    countWants: 'Will befördert werden',
    empty: 'Noch keine Notizen.',
    emptyFiltered: 'Keine Notiz passt zu diesen Filtern.',
    by: (author: string, rc: string) => `${author} (zu ${rc}s Beobachtung)`,
    srNotes: 'Rückmeldungen aus SR-Spielen (4.4.10)',
    srNotesHint: 'Hat ein Referee Coach neben einem Coachee gepfiffen, wird kein Feedbackformular ausgefüllt — stattdessen diese kurze Rückmeldung. Sie geht nur ans RC-Präsidium und zählt nicht ans Saisonziel.',
    srEmpty: 'Noch keine Rückmeldungen.',
    swapped: '1. und 2. SR wurden getauscht (Ziff. 7.3) — die Rollen oben sind die tatsächlich gepfiffenen. Im VolleyManager ist es noch andersherum erfasst.',
    markRead: 'Als gelesen markieren',
    read: 'Gelesen',
    unread: 'ungelesen',
    goal: 'SR-Ziel',
    wants: 'Will befördert werden',
    candidate: 'Kandidat:in nächste Saison',
    further: (role: string) => `Weiterer Besuch: Ja${role ? `, ${role === '1SR' ? '1. SR' : '2. SR'}` : ''}`,
    editTags: 'Tags',
    addTag: '+ Tag',
    tagsFor: (name: string) => `Tags für ${name}`,
    tagsHint: 'Nur du siehst diese Tags und die Notiz. Sie bleiben über die Saisons hinweg stehen.',
    ownTag: 'Eigener Tag',
    addOwn: 'Hinzufügen',
    memo: 'Deine Notiz',
    save: 'Speichern',
    cancel: 'Abbrechen',
    saved: 'Gespeichert',
    noKey: 'Diese Person ist keinem Eintrag zugeordnet.',
    suggestions: ['N3-Kurs nächste Saison', 'N2-Kurs nächste Saison', 'Beförderung prüfen', 'Prüfspiel nötig', 'Kein Besuch nächste Saison', 'Gespräch suchen', 'Kandidat:in RC'],
    season: 'Saison',
    colName: 'Name', colLevel: 'Niveau', colGroup: 'Gruppe', colVisits: 'Besuche', colLast: 'Letzter',
    colMotivation: 'Motivation', colEinstufung: 'Einstufung', colGoal: 'SR-Ziel', colTags: 'Deine Tags', colUnread: 'Ungelesen',
    overviewHint: 'Eine Zeile pro Coachee der Saison, mit dem letzten Formular. Die Filter oben gelten auch hier.',
    overviewEmpty: 'Keine Coachees passen zu diesen Filtern.',
    loadFailed: 'Konnte nicht geladen werden.',
  },
  EN: {
    hint: 'Confidential notes referee coaches wrote on feedback they have sent — visible only here. The referee is never told about them. Newest games first.',
    tabNotes: 'Notes',
    tabOverview: 'Overview per referee',
    motivation: 'Motivation',
    einstufung: 'Einstufung',
    all: 'All',
    level: 'Level',
    group: 'Group',
    tag: 'Tag',
    allLevels: 'Level: all',
    allGroups: 'Group: all',
    allTags: 'Tag: all',
    unreadOnly: 'Unread only',
    search: 'Search name',
    reset: 'Reset filters',
    countOf: (total: number) => `of ${total} notes`,
    countUnread: 'unread',
    countUp: 'Einstufung ↑',
    countWants: 'Wants promotion',
    empty: 'No notes yet.',
    emptyFiltered: 'No note matches these filters.',
    by: (author: string, rc: string) => `${author} (on ${rc}'s observation)`,
    srNotes: 'Notes from games a coach refereed (4.4.10)',
    srNotesHint: 'When a referee coach whistled next to a coachee no feedback form is filled in — this short note takes its place. It reaches the RC chair only and never counts toward a season target.',
    srEmpty: 'No notes yet.',
    swapped: '1st and 2nd referee were swapped (section 7.3) — the roles above are the ones actually whistled. VolleyManager still has it the other way round.',
    markRead: 'Mark as read',
    read: 'Read',
    unread: 'unread',
    goal: 'Goal',
    wants: 'Wants promotion',
    candidate: 'Candidate next season',
    further: (role: string) => `Further visit: yes${role ? `, ${role === '1SR' ? '1st ref' : '2nd ref'}` : ''}`,
    editTags: 'Tags',
    addTag: '+ Tag',
    tagsFor: (name: string) => `Tags for ${name}`,
    tagsHint: 'Only you see these tags and the note. They stay from season to season.',
    ownTag: 'Own tag',
    addOwn: 'Add',
    memo: 'Your note',
    save: 'Save',
    cancel: 'Cancel',
    saved: 'Saved',
    noKey: 'This person is not linked to an entry.',
    suggestions: ['N3 course next season', 'N2 course next season', 'Check promotion', 'Test game needed', 'No visit next season', 'Talk to them', 'RC candidate'],
    season: 'Season',
    colName: 'Name', colLevel: 'Level', colGroup: 'Group', colVisits: 'Visits', colLast: 'Last',
    colMotivation: 'Motivation', colEinstufung: 'Einstufung', colGoal: 'Goal', colTags: 'Your tags', colUnread: 'Unread',
    overviewHint: 'One row per coachee of the season, with the latest form. The filters above apply here too.',
    overviewEmpty: 'No coachee matches these filters.',
    loadFailed: 'Could not be loaded.',
  },
};
type S = typeof STR.DE;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The base Niveau a filter offers ("N3"), off the coachee row's level. */
const baseLevel = (level?: string) => {
  const l = (level || '').trim().toUpperCase();
  return /^N[1-5]$/.test(l) ? l : '';
};

const TICK_TONE: Record<string, string> = {
  up: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  check: 'bg-sky-50 text-sky-800 border-sky-200',
  down: 'bg-red-50 text-red-700 border-red-200',
};
const ARROW: Record<string, string> = { up: '↑', check: '✓', down: '↓' };

function Chip({ className, children, title }: { className?: string; children: ReactNode; title?: string; key?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] font-medium whitespace-nowrap', className ?? 'bg-white border-stone-200 text-stone-700')}>
      {children}
    </span>
  );
}

function TickChip({ kind, value, lang, withLabel = true }: { kind: 'motivation' | 'einstufung'; value: string; lang: Lang; withLabel?: boolean }) {
  if (!value) return null;
  const t = STR[lang];
  return (
    <Chip className={TICK_TONE[value]}>
      {withLabel ? `${kind === 'motivation' ? t.motivation : t.einstufung} ` : ''}{ARROW[value] ?? ''} {outcomeLabel(kind, value, lang)}
    </Chip>
  );
}

function LevelChip({ level, stage }: { level?: string; stage?: string }) {
  if (!level && !stage) return null;
  return (
    <span className="inline-flex items-center h-6 px-2 rounded-full bg-stone-900 text-white text-[11px] font-semibold tabular-nums">
      <LevelText level={level} stage={stage} />
    </span>
  );
}

function GroupChips({ groups, lang }: { groups?: string[]; lang: Lang }) {
  if (!groups?.length) return null;
  return <>{groups.map((g) => <Chip key={g} className="bg-violet-50 text-violet-800 border-violet-200">{groupLabel(g, lang)}</Chip>)}</>;
}

function Segmented({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: Array<[string, string]>; label: string }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500">{label}</span>
      <div role="group" aria-label={label} className="inline-flex rounded-lg border border-stone-200 overflow-hidden bg-white">
        {options.map(([v, text]) => (
          <button
            key={v || 'all'}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={cn('px-2.5 h-7 text-xs border-r border-stone-200 last:border-r-0 whitespace-nowrap', value === v ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-50')}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReadButton({ read, onToggle, t }: { read: boolean; onToggle: () => void; t: S }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={read}
      data-testid="chair-read"
      className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-medium transition-colors',
        read ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-50')}
    >
      {read ? <Check size={14} /> : <Circle size={12} />} {read ? t.read : t.markRead}
    </button>
  );
}

type Filters = { motivation: Tick; einstufung: Tick; level: string; group: string; tag: string; unreadOnly: boolean; q: string };
const NO_FILTERS: Filters = { motivation: '', einstufung: '', level: '', group: '', tag: '', unreadOnly: false, q: '' };

function matchesName(name: string, q: string): boolean {
  if (!q.trim()) return true;
  const fold = (v: string) => v.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return fold(name).includes(fold(q.trim())); // a search box, not an identity match
}

export default function ChairNotes({ lang }: { lang: Lang }) {
  const t = STR[lang];
  const [notes, setNotes] = useState<PresidentNote[] | null>(null);
  const [srNotes, setSrNotes] = useState<RcGameNote[] | null>(null);
  const [marks, setMarks] = useState<Map<string, RefereeMark>>(new Map());
  const [err, setErr] = useState('');
  const [srErr, setSrErr] = useState('');
  const [view, setView] = useState<'notes' | 'overview'>('notes');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);
  const [season, setSeason] = useState(currentSeason());
  const [overview, setOverview] = useState<PresidentOverviewRow[] | null>(null);
  const [overviewErr, setOverviewErr] = useState('');

  useEffect(() => {
    listPresidentNotes().then(setNotes).catch((e) => setErr(errText(e)));
    // Each list its own error line: neither should take the other down.
    loadRcGameNotes().then(setSrNotes).catch((e) => setSrErr(errText(e)));
    listPresidentMarks().then((rows) => setMarks(new Map(rows.map((m) => [m.key, m])))).catch(() => { /* tags only; the notes still read */ });
  }, []);

  useEffect(() => {
    if (view !== 'overview') return;
    setOverview(null);
    setOverviewErr('');
    loadPresidentOverview(season).then((r) => setOverview(r.rows)).catch((e) => setOverviewErr(errText(e)));
  }, [view, season]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const tagsOf = (key?: string) => (key ? marks.get(key)?.tags ?? [] : []);

  // What the dropdowns offer: only values that occur.
  const options = useMemo(() => {
    const levels = new Set<string>();
    const groups = new Set<string>();
    for (const n of [...(notes ?? []), ...(srNotes ?? []), ...(overview ?? [])]) {
      const l = baseLevel(n.refereeLevel); if (l) levels.add(l);
      for (const g of n.groups ?? []) groups.add(g);
    }
    const tags = new Set<string>();
    for (const m of marks.values()) for (const tg of m.tags) tags.add(tg);
    return { levels: [...levels].sort(), groups: [...groups].sort((a, b) => a.localeCompare(b, 'de-CH')), tags: [...tags].sort((a, b) => a.localeCompare(b, 'de-CH')) };
  }, [notes, srNotes, overview, marks]);

  const personMatches = (p: { refereeLevel?: string; groups?: string[]; refereeKey?: string; name: string }) =>
    (!filters.level || baseLevel(p.refereeLevel) === filters.level)
    && (!filters.group || (p.groups ?? []).includes(filters.group))
    && (!filters.tag || tagsOf(p.refereeKey).includes(filters.tag))
    && matchesName(p.name, filters.q);

  const shownNotes = (notes ?? []).filter((n) =>
    personMatches({ ...n, name: n.coacheeName })
    && (!filters.motivation || n.results?.motivation === filters.motivation)
    && (!filters.einstufung || n.results?.einstufung === filters.einstufung)
    && (!filters.unreadOnly || !n.read));
  // A 4.4.10 note has no form behind it, so no motivation and no Einstufung:
  // either filter set hides the whole list rather than pretending a match.
  const tickFilter = Boolean(filters.motivation || filters.einstufung);
  const shownSr = tickFilter ? [] : (srNotes ?? []).filter((n) =>
    personMatches({ ...n, name: n.coacheeName }) && (!filters.unreadOnly || !n.read));

  const unreadByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of [...(notes ?? []), ...(srNotes ?? [])]) if (!n.read && n.refereeKey) m.set(n.refereeKey, (m.get(n.refereeKey) ?? 0) + 1);
    return m;
  }, [notes, srNotes]);

  const toggleRead = async (kind: 'note' | 'sr', id: string, read: boolean) => {
    const apply = (value: boolean) => {
      if (kind === 'note') setNotes((rows) => rows?.map((r) => (r.id === id ? { ...r, read: value } : r)) ?? rows);
      else setSrNotes((rows) => rows?.map((r) => (r.id === id ? { ...r, read: value } : r)) ?? rows);
    };
    apply(read);
    try { await setPresidentRead(kind, id, read); }
    catch (e) { apply(!read); toast.error(errText(e), { lang }); }
  };

  const filtering = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const unreadCount = [...(notes ?? []), ...(srNotes ?? [])].filter((n) => !n.read).length;

  const tagRow = (key: string | undefined, name: string) => (
    <div className="flex flex-wrap items-center gap-1.5" data-log-redact>
      {tagsOf(key).map((tg) => <Chip key={tg} className="bg-amber-50 text-amber-900 border-amber-200">{tg}</Chip>)}
      {key && (
        <button type="button" onClick={() => setEditing({ key, name })} data-testid="chair-tags-edit"
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-dashed border-stone-300 text-[11px] font-medium text-stone-500 hover:bg-stone-50">
          <TagIcon size={11} /> {tagsOf(key).length || marks.get(key)?.memo ? t.editTags : t.addTag}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-stone-500 leading-snug">{t.hint}</p>

      <div className="flex items-center gap-1.5" role="tablist">
        {(['notes', 'overview'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
            className={cn('h-8 px-3.5 rounded-full text-sm', view === v ? 'bg-white shadow-card font-semibold text-stone-900' : 'text-stone-500 hover:text-stone-800')}>
            {v === 'notes' ? t.tabNotes : t.tabOverview}
          </button>
        ))}
      </div>

      {/* The filters: one bar for both views. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-white rounded-2xl border border-stone-200/70 p-3" data-testid="chair-filters">
        <Segmented label={t.motivation} value={filters.motivation} onChange={(v) => set('motivation', v as Tick)}
          options={[['', t.all], ['up', `↑ ${outcomeLabel('motivation', 'up', lang)}`], ['check', `✓ ${outcomeLabel('motivation', 'check', lang)}`], ['down', `↓ ${outcomeLabel('motivation', 'down', lang)}`]]} />
        <Segmented label={t.einstufung} value={filters.einstufung} onChange={(v) => set('einstufung', v as Tick)}
          options={[['', t.all], ['up', `↑ ${outcomeLabel('einstufung', 'up', lang)}`], ['check', `✓ ${outcomeLabel('einstufung', 'check', lang)}`], ['down', `↓ ${outcomeLabel('einstufung', 'down', lang)}`]]} />
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t.level} value={filters.level} onChange={(e) => set('level', e.target.value)} className="h-8 rounded-lg border border-stone-200 bg-white px-2 text-xs">
            <option value="">{t.allLevels}</option>
            {options.levels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select aria-label={t.group} value={filters.group} onChange={(e) => set('group', e.target.value)} className="h-8 rounded-lg border border-stone-200 bg-white px-2 text-xs max-w-[12rem]">
            <option value="">{t.allGroups}</option>
            {options.groups.map((g) => <option key={g} value={g}>{groupLabel(g, lang)}</option>)}
          </select>
          <select aria-label={t.tag} value={filters.tag} onChange={(e) => set('tag', e.target.value)} className="h-8 rounded-lg border border-stone-200 bg-white px-2 text-xs max-w-[12rem]" data-log-redact>
            <option value="">{t.allTags}</option>
            {options.tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
          </select>
          <input type="search" aria-label={t.search} placeholder={t.search} value={filters.q} onChange={(e) => set('q', e.target.value)}
            className="h-8 w-36 rounded-lg border border-stone-200 bg-white px-2 text-xs" />
        </div>
        {view === 'notes' && (
          <label className="inline-flex items-center gap-1.5 text-xs text-stone-700">
            <input type="checkbox" checked={filters.unreadOnly} onChange={(e) => set('unreadOnly', e.target.checked)} className="accent-[var(--color-brand)]" />
            {t.unreadOnly}
          </label>
        )}
        {filtering && (
          <button type="button" onClick={() => setFilters(NO_FILTERS)} className="text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800">{t.reset}</button>
        )}
      </div>

      {view === 'notes' ? (
        <>
          {notes && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500" data-testid="chair-counts">
              <span><b className="text-stone-800 tabular-nums">{shownNotes.length}</b> {t.countOf(notes.length)}</span>
              <span><b className="text-stone-800 tabular-nums">{unreadCount}</b> {t.countUnread}</span>
              <span>{t.countUp} <b className="text-stone-800 tabular-nums">{shownNotes.filter((n) => n.results?.einstufung === 'up').length}</b></span>
              <span>{t.countWants} <b className="text-stone-800 tabular-nums">{shownNotes.filter((n) => n.results?.wantsPromotion).length}</b></span>
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          {!notes && !err && <SkeletonRows />}
          {notes?.length === 0 && <p className="text-sm text-stone-400 py-8 text-center">{t.empty}</p>}
          {notes && notes.length > 0 && shownNotes.length === 0 && <p className="text-sm text-stone-400 py-6 text-center">{t.emptyFiltered}</p>}
          {shownNotes.map((r) => (
            <div key={r.id} data-testid="chair-note" className={cn('bg-white rounded-2xl shadow-card border p-5 flex flex-col gap-3', r.read === false ? 'border-red-200' : 'border-stone-200/70')}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {r.read === false && <span className="w-2 h-2 rounded-full bg-[var(--color-brand)]" title={t.unread} aria-label={t.unread} />}
                <span className="text-sm font-semibold text-stone-800">{r.coacheeName || '—'}</span>
                <LevelChip level={r.refereeLevel} stage={r.refereeStage} />
                <GroupChips groups={r.groups} lang={lang} />
                {r.gameDate && <span className="text-xs text-stone-400">{dayLabel(r.gameDate, { year: true }) || r.gameDate}</span>}
                {r.league && <span className="text-xs text-stone-400">{r.league}</span>}
                {/* The number the chair finds the game by in VolleyManager. */}
                {r.matchNo && <span className="text-xs tabular-nums text-stone-400">#{r.matchNo}</span>}
                {r.teams && <span className="text-xs text-stone-500 truncate">{r.teams}</span>}
                {/* Usually the same person; when they differ an admin wrote on a
                    coach's observation, and reading it as the coach's would mislead. */}
                <span className="ml-auto text-xs text-stone-500">
                  {r.authorName && r.authorName !== r.rcName ? t.by(r.authorName, r.rcName) : r.rcName}
                  {r.results?.role ? ` · ${r.results.role}` : ''}
                </span>
              </div>
              {r.results && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="chair-results">
                  <TickChip kind="motivation" value={r.results.motivation} lang={lang} />
                  <TickChip kind="einstufung" value={r.results.einstufung} lang={lang} />
                  {r.results.srZiel && <Chip>{t.goal} {srGoalLabel(r.results.srZiel, lang)}</Chip>}
                  {r.results.wantsPromotion && <Chip>{t.wants}</Chip>}
                  {r.results.wantsCandidate && <Chip>{t.candidate}</Chip>}
                  {r.results.secondBesuch === 'Y' && <Chip className="bg-sky-50 text-sky-800 border-sky-200">{t.further(r.results.secondBesuchRole)}</Chip>}
                </div>
              )}
              <div className="border-t border-stone-100" />
              {/* Confidential to the chair; the server already keeps it out of its
                  own request log, and the click logger must do the same. Rich
                  text: drawn from the restricted subset, never as raw HTML. */}
              <div data-log-redact><RichView value={r.note} className="text-sm text-stone-800" /></div>
              <div className="flex flex-wrap items-center gap-2 justify-between">
                {tagRow(r.refereeKey, r.coacheeName)}
                {typeof r.read === 'boolean' && <ReadButton read={r.read} onToggle={() => void toggleRead('note', r.id, !r.read)} t={t} />}
              </div>
            </div>
          ))}

          {!tickFilter && (
            <>
              <div className="pt-2">
                <h3 className="text-sm font-semibold text-stone-800">{t.srNotes}</h3>
                <p className="text-xs text-stone-500 leading-snug mt-1">{t.srNotesHint}</p>
              </div>
              {srErr && <p className="text-sm text-red-600">{srErr}</p>}
              {!srNotes && !srErr && <SkeletonRows />}
              {srNotes?.length === 0 && <p className="text-sm text-stone-400 py-8 text-center">{t.srEmpty}</p>}
              {srNotes && srNotes.length > 0 && shownSr.length === 0 && <p className="text-sm text-stone-400 py-6 text-center">{t.emptyFiltered}</p>}
              {shownSr.map((r) => (
                <div key={r.id} data-testid="chair-sr-note" className={cn('bg-white rounded-2xl shadow-card border p-5 flex flex-col gap-3', r.read === false ? 'border-red-200' : 'border-stone-200/70')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {r.read === false && <span className="w-2 h-2 rounded-full bg-[var(--color-brand)]" title={t.unread} aria-label={t.unread} />}
                    {/* Who was observed, and in which slot — a 4.4.10 note is always
                        about the OTHER whistle, so the roles are half the context. */}
                    <span className="text-sm font-semibold text-stone-800">{r.coacheeName || '—'}</span>
                    <LevelChip level={r.refereeLevel} stage={r.refereeStage} />
                    <GroupChips groups={r.groups} lang={lang} />
                    {r.coacheeRole && <span className="text-xs text-stone-400">{r.coacheeRole}</span>}
                    {r.gameDate && <span className="text-xs text-stone-400">{dayLabel(r.gameDate, { year: true }) || r.gameDate}</span>}
                    {r.league && <span className="text-xs text-stone-400">{r.league}</span>}
                    {r.matchNo && <span className="text-xs tabular-nums text-stone-400">#{r.matchNo}</span>}
                    {r.teams && <span className="text-xs text-stone-500 truncate">{r.teams}</span>}
                    {r.location && <span className="text-xs text-stone-400 truncate">{r.location}</span>}
                    <GameFlagChips game={{ isManual: r.isManual }} lang={lang} />
                    <span className="ml-auto text-xs text-stone-500">{r.rcName}{r.rcRole ? ` (${r.rcRole})` : ''}</span>
                  </div>
                  {/* 7.3's report, arriving with the note. It is the one thing on
                      this card that asks her to go and do something. */}
                  {r.rolesSwapped && (
                    <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">{t.swapped}</p>
                  )}
                  <p data-log-redact className="text-sm text-stone-800 whitespace-pre-wrap">{r.note}</p>
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    {tagRow(r.refereeKey, r.coacheeName)}
                    {typeof r.read === 'boolean' && <ReadButton read={r.read} onToggle={() => void toggleRead('sr', r.id, !r.read)} t={t} />}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-stone-500 leading-snug flex-1 min-w-[14rem]">{t.overviewHint}</p>
            <select aria-label={t.season} value={season} onChange={(e) => setSeason(Number(e.target.value))} className="h-8 rounded-lg border border-stone-200 bg-white px-2 text-xs">
              {[currentSeason(), currentSeason() - 1].map((s) => <option key={s} value={s}>{seasonLabel(s)}</option>)}
            </select>
          </div>
          {overviewErr && <p className="text-sm text-red-600">{overviewErr || t.loadFailed}</p>}
          {!overview && !overviewErr && <SkeletonRows />}
          {overview && (() => {
            const rows = overview.filter((r) => personMatches(r)
              && (!filters.motivation || r.lastMotivation === filters.motivation)
              && (!filters.einstufung || r.lastEinstufung === filters.einstufung));
            if (rows.length === 0) return <p className="text-sm text-stone-400 py-6 text-center">{t.overviewEmpty}</p>;
            return (
              <div className="overflow-x-auto bg-white rounded-2xl border border-stone-200/70">
                <table className="w-full text-xs min-w-[56rem]" data-testid="chair-overview">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-stone-500">
                      {[t.colName, t.colLevel, t.colGroup, t.colVisits, t.colLast, t.colMotivation, t.colEinstufung, t.colGoal, t.colTags, t.colUnread].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold border-b border-stone-100 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.coacheeId} className={cn('border-b border-stone-100 last:border-0 align-middle', !r.active && 'text-stone-400')}>
                        <td className="px-3 py-2 font-semibold text-stone-800 whitespace-nowrap">{r.name}</td>
                        <td className="px-3 py-2"><LevelChip level={r.refereeLevel} stage={r.refereeStage} /></td>
                        <td className="px-3 py-2"><div className="flex flex-wrap gap-1"><GroupChips groups={r.groups} lang={lang} /></div></td>
                        <td className="px-3 py-2 tabular-nums">{r.observations}</td>
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap text-stone-500">{r.lastDate ? dayLabel(r.lastDate, { year: true }) : '–'}</td>
                        <td className="px-3 py-2"><TickChip kind="motivation" value={r.lastMotivation} lang={lang} withLabel={false} /></td>
                        <td className="px-3 py-2"><TickChip kind="einstufung" value={r.lastEinstufung} lang={lang} withLabel={false} /></td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.lastSrZiel ? srGoalLabel(r.lastSrZiel, lang) : ''}
                          {r.wantsPromotion ? `${r.lastSrZiel ? ' · ' : ''}${t.wants}` : ''}
                        </td>
                        <td className="px-3 py-2">{tagRow(r.refereeKey, r.name)}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {unreadByKey.get(r.refereeKey) ? <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[var(--color-brand)]" />{unreadByKey.get(r.refereeKey)}</span> : '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </>
      )}

      {editing && (
        <TagEditor
          lang={lang}
          person={editing}
          current={marks.get(editing.key)}
          known={options.tags}
          onClose={() => setEditing(null)}
          onSaved={(mark) => {
            setMarks((m) => {
              const next = new Map(m);
              if (mark) next.set(mark.key, mark); else next.delete(editing.key);
              return next;
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TagEditor({ lang, person, current, known, onClose, onSaved }: {
  lang: Lang;
  person: { key: string; name: string };
  current?: RefereeMark;
  known: string[];
  onClose: () => void;
  onSaved: (mark: RefereeMark | null) => void;
}) {
  const t = STR[lang];
  const [tags, setTags] = useState<string[]>(current?.tags ?? []);
  const [memo, setMemo] = useState(current?.memo ?? '');
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const offered = [...new Set([...t.suggestions, ...known, ...tags])];
  const has = (tg: string) => tags.some((x) => x.toLocaleLowerCase('de-CH') === tg.toLocaleLowerCase('de-CH')); // identity:display — a tag label, not a name
  const toggle = (tg: string) => setTags((list) => (has(tg) ? list.filter((x) => x.toLocaleLowerCase('de-CH') !== tg.toLocaleLowerCase('de-CH')) : [...list, tg])); // identity:display — a tag label, not a name
  const addOwn = () => {
    const tg = own.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tg && !has(tg)) setTags((list) => [...list, tg]);
    setOwn('');
  };

  const save = async () => {
    setBusy(true);
    try {
      const pending = own.trim() && !has(own.trim()) ? [...tags, own.trim()] : tags;
      const mark = await savePresidentMark({ key: person.key, name: person.name, tags: pending, memo });
      toast.success(t.saved, { lang });
      onSaved(mark);
    } catch (e) {
      toast.error(errText(e), { lang });
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t.tagsFor(person.name)} data-log-redact
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-stone-900">{t.tagsFor(person.name)}</h3>
            <p className="text-xs text-stone-500 mt-0.5">{t.tagsHint}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t.cancel} className="p-1 rounded hover:bg-stone-100 text-stone-500"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {offered.map((tg) => (
            <button key={tg} type="button" aria-pressed={has(tg)} onClick={() => toggle(tg)}
              className={cn('inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-xs font-medium',
                has(tg) ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50')}>
              {has(tg) && <Check size={12} />} {tg}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={own} onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } }}
            placeholder={t.ownTag} aria-label={t.ownTag} maxLength={40}
            className="flex-1 h-9 rounded-lg border border-stone-200 px-3 text-sm" />
          <button type="button" onClick={addOwn} disabled={!own.trim()} className="h-9 px-3 rounded-lg border border-stone-200 text-sm disabled:opacity-50">{t.addOwn}</button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-stone-500">{t.memo}</span>
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} maxLength={4000}
            className="rounded-lg border border-stone-200 px-3 py-2 text-sm" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg border border-stone-200 text-sm">{t.cancel}</button>
          <button type="button" onClick={() => void save()} disabled={busy} className="h-9 px-4 rounded-lg bg-[var(--color-brand)] text-white text-sm font-semibold disabled:opacity-60">{t.save}</button>
        </div>
      </div>
    </div>
  );
}
