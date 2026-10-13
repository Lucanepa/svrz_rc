import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Loader2, Plus, RotateCcw, Save, Search, Trash2, Undo2 } from 'lucide-react';
import { confirmDialog, toast } from './ui';
import { foldText } from '../lib/docText';
import { USEFUL_DOC_GROUPS, type UsefulDoc } from '../lib/usefulDocs';
import {
  INFOS_LIMITS, INFOS_PUBLIC_DOCS, defaultInfosLayout, settleInfosLayout,
  type InfosLayout, type InfosSection,
} from '../lib/infosLayout';
import { getInfosLayout, resetInfosLayout, saveInfosLayout } from '../lib/pocketbase';

/**
 * Admin → Einstellungen: the public /infos page's sections (Luca, 2026-10-13,
 * the step agreed on 2026-10-09). Rename a section in both languages, reorder
 * the sections, add one, move a document into another section or off the page,
 * and change a document's place within its section. Nothing here adds or
 * edits a document — those stay in src/lib/usefulDocs.ts.
 *
 * The editor works on the layout with every document written into its place
 * (settleInfosLayout), so what is saved is what the page shows. "Standard"
 * goes back to the code's audience table.
 */

type Lang = 'DE' | 'EN';
const HIDDEN = '__hidden';

const STR = {
  DE: {
    title: 'Öffentliche Seite /infos — Abschnitte',
    hint: 'Welche Abschnitte /infos zeigt, in welcher Reihenfolge, und welche Dokumente darin stehen. Innerhalb eines Abschnitts ordnet die Seite weiter nach Thema. Die Dokumente selbst kommen aus dem Code.',
    open: 'Seite öffnen',
    stateDefault: 'Standard aus dem Code',
    stateSaved: (when: string) => `Angepasst · gespeichert ${when}`,
    filter: 'Dokument suchen…',
    section: (n: number) => `Abschnitt ${n}`,
    titleDe: 'Titel (DE)', titleEn: 'Titel (EN)', noteDe: 'Notiz (DE)', noteEn: 'Notiz (EN)',
    up: 'Nach oben', down: 'Nach unten',
    remove: 'Abschnitt entfernen',
    removeBlocked: 'Zuerst die Dokumente in einen anderen Abschnitt verschieben',
    docs: (n: number) => `${n} Dokument${n === 1 ? '' : 'e'}`,
    moveTo: 'Verschieben nach',
    hiddenOption: 'Nicht auf /infos zeigen',
    hiddenTitle: 'Nicht auf /infos',
    hiddenNone: 'Alle Dokumente sind auf der Seite.',
    add: 'Abschnitt hinzufügen',
    newTitle: 'Neuer Abschnitt',
    save: 'Speichern',
    saved: 'Gespeichert — /infos zeigt die neue Einteilung.',
    discard: 'Verwerfen',
    reset: 'Standard wiederherstellen',
    resetTitle: 'Zurück zum Standard?',
    resetBody: 'Die gespeicherte Einteilung wird gelöscht; /infos zeigt wieder die drei Abschnitte aus dem Code.',
    resetDone: 'Standard wiederhergestellt.',
    needTitle: 'Jeder Abschnitt braucht einen Titel.',
    loadFailed: 'Die gespeicherte Einteilung konnte nicht geladen werden.',
  },
  EN: {
    title: 'Public page /infos — sections',
    hint: 'Which sections /infos shows, in which order, and which documents are in them. Within a section the page still groups by topic. The documents themselves come from the code.',
    open: 'Open page',
    stateDefault: 'Default from the code',
    stateSaved: (when: string) => `Customised · saved ${when}`,
    filter: 'Find a document…',
    section: (n: number) => `Section ${n}`,
    titleDe: 'Title (DE)', titleEn: 'Title (EN)', noteDe: 'Note (DE)', noteEn: 'Note (EN)',
    up: 'Move up', down: 'Move down',
    remove: 'Remove section',
    removeBlocked: 'Move its documents to another section first',
    docs: (n: number) => `${n} document${n === 1 ? '' : 's'}`,
    moveTo: 'Move to',
    hiddenOption: 'Do not show on /infos',
    hiddenTitle: 'Not on /infos',
    hiddenNone: 'Every document is on the page.',
    add: 'Add a section',
    newTitle: 'New section',
    save: 'Save',
    saved: 'Saved — /infos shows the new layout.',
    discard: 'Discard',
    reset: 'Restore the default',
    resetTitle: 'Back to the default?',
    resetBody: 'The saved layout is deleted; /infos shows the three sections from the code again.',
    resetDone: 'Default restored.',
    needTitle: 'Every section needs a title.',
    loadFailed: 'The saved layout could not be loaded.',
  },
};

const card = 'bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 transition-colors';
const btnIcon = 'inline-flex items-center justify-center h-7 w-7 rounded-md text-stone-500 hover:bg-stone-100 disabled:opacity-30 transition-colors';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const field = 'h-8 w-full px-2.5 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500';

const DOC_BY_ID = new Map(INFOS_PUBLIC_DOCS.map((d) => [d.id, d]));

/** "2026-10-13 14:40:00.000Z" (the record layer's stamp) → 13.10.2026 16:40, Zurich. */
function savedLabel(stamp: string): string {
  const d = new Date(stamp.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

const swap = <T,>(list: T[], i: number, j: number): T[] => {
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** `active`: the Einstellungen tab is mounted hidden; nothing is fetched until it is opened. */
export default function InfosLayoutAdmin({ lang, active }: { lang: Lang; active: boolean }) {
  const t = STR[lang];
  const [stored, setStored] = useState<{ layout: InfosLayout | null; updatedAt: string } | null>(null);
  const [draft, setDraft] = useState<InfosLayout | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');

  const baseline = useMemo(() => (stored ? settleInfosLayout(stored.layout ?? defaultInfosLayout()) : null), [stored]);
  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    if (!active || stored) return undefined;
    let alive = true;
    getInfosLayout()
      .then((r) => { if (alive) setStored(r); })
      .catch(() => { if (alive) { setStored({ layout: null, updatedAt: '' }); toast.error(t.loadFailed, { lang }); } });
    return () => { alive = false; };
  }, [active, stored, t.loadFailed, lang]);
  useEffect(() => { if (baseline) setDraft(baseline); }, [baseline]);

  const q = foldText(query.trim());
  const shows = (doc: UsefulDoc) => !q || foldText(`${doc.DE.title} ${doc.EN.title} ${doc.badge}`).includes(q);

  if (!draft) {
    return (
      <div data-testid="infos-layout-admin" className={card}>
        <h2 className="text-sm font-semibold text-stone-700">{t.title}</h2>
        <Loader2 size={16} className="mt-3 animate-spin text-stone-400" />
      </div>
    );
  }

  const edit = (fn: (l: InfosLayout) => InfosLayout) => setDraft((cur) => (cur ? fn(cur) : cur));
  const editSection = (i: number, patch: (s: InfosSection) => InfosSection) =>
    edit((l) => ({ ...l, sections: l.sections.map((s, k) => (k === i ? patch(s) : s)) }));
  const moveDoc = (id: string, to: string) => edit((l) => {
    const without = { sections: l.sections.map((s) => ({ ...s, docs: s.docs.filter((d) => d !== id) })), hidden: l.hidden.filter((d) => d !== id) };
    return to === HIDDEN
      ? { ...without, hidden: [...without.hidden, id] }
      : { ...without, sections: without.sections.map((s) => (s.id === to ? { ...s, docs: [...s.docs, id] } : s)) };
  });
  const toggle = (id: string) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const addSection = () => {
    const id = `s-${Date.now().toString(36)}`;
    edit((l) => ({ ...l, sections: [...l.sections, { id, DE: { title: t.newTitle, note: '' }, EN: { title: lang === 'EN' ? t.newTitle : 'New section', note: '' }, docs: [] }] }));
    setOpen((cur) => new Set(cur).add(id));
  };

  const save = async () => {
    if (draft.sections.some((s) => !s.DE.title.trim() && !s.EN.title.trim())) { toast.error(t.needTitle, { lang }); return; }
    setBusy('save');
    try { setStored(await saveInfosLayout(draft)); toast.success(t.saved, { lang }); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e), { lang }); }
    finally { setBusy(''); }
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: t.resetTitle, message: t.resetBody, confirmLabel: t.reset, tone: 'danger', lang }))) return;
    setBusy('reset');
    try { await resetInfosLayout(); setStored({ layout: null, updatedAt: '' }); toast.success(t.resetDone, { lang }); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e), { lang }); }
    finally { setBusy(''); }
  };

  const moveSelect = (id: string, current: string) => (
    <select
      value={current}
      onChange={(e) => moveDoc(id, e.target.value)}
      aria-label={`${t.moveTo}: ${DOC_BY_ID.get(id)?.[lang].title ?? id}`}
      className="h-7 max-w-[11rem] rounded-md border border-stone-200 bg-white px-1.5 text-xs text-stone-600"
    >
      {draft.sections.map((s, k) => <option key={s.id} value={s.id}>{s[lang].title || t.section(k + 1)}</option>)}
      <option value={HIDDEN}>{t.hiddenOption}</option>
    </select>
  );

  const docRow = (id: string, current: string, actions?: ReactNode) => {
    const doc = DOC_BY_ID.get(id);
    if (!doc || !shows(doc)) return null;
    return (
      <li key={id} data-testid="infos-doc" data-doc={id} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-stone-100 last:border-b-0">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-stone-800 truncate">{doc[lang].title}</span>
          <span className="block text-[11px] text-stone-400">{USEFUL_DOC_GROUPS[doc.group][lang]} · {doc.badge}</span>
        </span>
        {actions}
        {moveSelect(id, current)}
      </li>
    );
  };

  return (
    <div data-testid="infos-layout-admin" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-stone-700">{t.title}</h2>
        <a href="/infos" target="_blank" rel="noopener noreferrer" className={btnGhost}><ExternalLink size={13} /> {t.open}</a>
      </div>
      <p className="text-xs text-stone-400 mb-2">{t.hint}</p>
      <p data-testid="infos-layout-state" className="text-xs font-medium text-stone-500 mb-3">
        {stored?.layout ? t.stateSaved(savedLabel(stored.updatedAt)) : t.stateDefault}
      </p>

      <div className="relative mb-3">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.filter} aria-label={t.filter}
          className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-700/20" />
      </div>

      <ol className="flex flex-col gap-3">
        {draft.sections.map((s, i) => {
          const isOpen = !!q || open.has(s.id);
          const text = (lng: Lang, key: 'title' | 'note', label: string, max: number) => (
            <label className="block">
              <span className="block text-[11px] font-medium text-stone-500 mb-0.5">{label}</span>
              <input value={s[lng][key]} maxLength={max} className={field}
                onChange={(e) => { const v = e.target.value; editSection(i, (x) => ({ ...x, [lng]: { ...x[lng], [key]: v } })); }} />
            </label>
          );
          return (
            <li key={s.id} data-testid="infos-section" data-section={s.id} className="rounded-xl border border-stone-200 p-3">
              <div className="flex items-center gap-1 mb-2">
                <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t.section(i + 1)}</span>
                <button type="button" className={btnIcon} disabled={i === 0} aria-label={`${t.up}: ${t.section(i + 1)}`} title={t.up}
                  onClick={() => edit((l) => ({ ...l, sections: swap(l.sections, i, i - 1) }))}><ArrowUp size={14} /></button>
                <button type="button" className={btnIcon} disabled={i === draft.sections.length - 1} aria-label={`${t.down}: ${t.section(i + 1)}`} title={t.down}
                  onClick={() => edit((l) => ({ ...l, sections: swap(l.sections, i, i + 1) }))}><ArrowDown size={14} /></button>
                <button type="button" className={btnIcon} disabled={s.docs.length > 0 || draft.sections.length === 1}
                  aria-label={`${t.remove}: ${t.section(i + 1)}`} title={s.docs.length > 0 ? t.removeBlocked : t.remove}
                  onClick={() => edit((l) => ({ ...l, sections: l.sections.filter((_, k) => k !== i) }))}><Trash2 size={14} /></button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {text('DE', 'title', t.titleDe, INFOS_LIMITS.title)}
                {text('EN', 'title', t.titleEn, INFOS_LIMITS.title)}
                {text('DE', 'note', t.noteDe, INFOS_LIMITS.note)}
                {text('EN', 'note', t.noteEn, INFOS_LIMITS.note)}
              </div>
              <button type="button" onClick={() => toggle(s.id)} aria-expanded={isOpen}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-stone-600 hover:text-stone-900">
                <ChevronDown size={13} className={`transition-transform ${isOpen ? '' : '-rotate-90'}`} /> {t.docs(s.docs.length)}
              </button>
              {isOpen && (
                <ul className="mt-1">
                  {s.docs.map((id, k) => docRow(id, s.id, (
                    <span className="flex items-center">
                      <button type="button" className={btnIcon} disabled={k === 0} aria-label={`${t.up}: ${DOC_BY_ID.get(id)?.[lang].title ?? id}`} title={t.up}
                        onClick={() => editSection(i, (x) => ({ ...x, docs: swap(x.docs, k, k - 1) }))}><ArrowUp size={13} /></button>
                      <button type="button" className={btnIcon} disabled={k === s.docs.length - 1} aria-label={`${t.down}: ${DOC_BY_ID.get(id)?.[lang].title ?? id}`} title={t.down}
                        onClick={() => editSection(i, (x) => ({ ...x, docs: swap(x.docs, k, k + 1) }))}><ArrowDown size={13} /></button>
                    </span>
                  )))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" className={`${btnGhost} mt-3`} disabled={draft.sections.length >= INFOS_LIMITS.sections} onClick={addSection}>
        <Plus size={13} /> {t.add}
      </button>

      <div data-testid="infos-hidden" className="mt-4 rounded-xl border border-dashed border-stone-300 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-1">{t.hiddenTitle} · {draft.hidden.length}</p>
        {draft.hidden.length === 0
          ? <p className="text-xs text-stone-400">{t.hiddenNone}</p>
          : <ul>{draft.hidden.map((id) => docRow(id, HIDDEN))}</ul>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} disabled={!dirty || !!busy} onClick={() => void save()}>
          {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t.save}
        </button>
        <button type="button" className={btnGhost} disabled={!dirty || !!busy} onClick={() => baseline && setDraft(baseline)}>
          <Undo2 size={13} /> {t.discard}
        </button>
        <button type="button" className={btnGhost} disabled={!stored?.layout || !!busy} onClick={() => void reset()}>
          <RotateCcw size={13} /> {t.reset}
        </button>
      </div>
    </div>
  );
}
