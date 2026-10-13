import { USEFUL_DOCS, type UsefulDoc } from './usefulDocs';
import { INFOS_AUDIENCES, INFOS_AUDIENCE_ORDER, audienceOf } from './infosAudience';

/**
 * The public /infos page's folders, editable in Admin → Einstellungen (Luca,
 * 2026-10-13 — agreed on 2026-10-09 as the step after the audience layout).
 *
 * A layout is a list of sections, each with a DE and EN title and note and the
 * documents in it, in order, plus the documents left off the page. Inside a
 * section the page still folds by topic (Regeln, Reglemente, …); the order
 * here is the order within each fold.
 *
 * The code's audience table (infosAudience.ts) is the DEFAULT: with nothing
 * stored, or the API out of reach, the page looks exactly as before. And the
 * document list stays in code (usefulDocs.ts): the layout only places what is
 * there. A document added in code after a layout was saved lands in the
 * section its audience names, or the last one — never nowhere.
 *
 * One module for the server (which stores only what normalizeInfosLayout
 * returns), the page and the editor, so all three read a layout the same way.
 */

export type InfosSectionText = { title: string; note: string };
export type InfosSection = { id: string; DE: InfosSectionText; EN: InfosSectionText; docs: string[] };
export type InfosLayout = { sections: InfosSection[]; hidden: string[] };

/** What /infos shows of USEFUL_DOCS: no blank form, no video (InfosPage says why). */
export const INFOS_PUBLIC_DOCS: UsefulDoc[] = USEFUL_DOCS.filter((d) => d.kind !== 'form' && d.kind !== 'video');

export const INFOS_LIMITS = { sections: 12, title: 80, note: 300 } as const;

/** The layout the code describes: the three audiences, documents in list order. */
export function defaultInfosLayout(): InfosLayout {
  return {
    sections: INFOS_AUDIENCE_ORDER.map((a) => ({
      id: a,
      DE: { ...INFOS_AUDIENCES[a].DE },
      EN: { ...INFOS_AUDIENCES[a].EN },
      docs: INFOS_PUBLIC_DOCS.filter((d) => audienceOf(d) === a).map((d) => d.id),
    })),
    hidden: [],
  };
}

const oneLine = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Anything from storage or a request, made safe — or null when it is not a
 * layout at all. Strings are cut to one line and their limit; a document id
 * that is not a public document is dropped, and each document counts once
 * (first place wins, a section over "hidden"). A section needs a title in at
 * least one language and borrows it for the other. Section ids are kept when
 * they are sane and unique, so an unplaced document can find its audience.
 */
export function normalizeInfosLayout(raw: unknown): InfosLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const { sections: rawSections, hidden: rawHidden } = raw as { sections?: unknown; hidden?: unknown };
  if (!Array.isArray(rawSections)) return null;
  const known = new Set(INFOS_PUBLIC_DOCS.map((d) => d.id));
  const placed = new Set<string>();
  const take = (list: unknown): string[] => {
    const out: string[] = [];
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id !== 'string' || !known.has(id) || placed.has(id)) continue;
      placed.add(id);
      out.push(id);
    }
    return out;
  };
  const ids = new Set<string>();
  const sections: InfosSection[] = [];
  for (const entry of rawSections.slice(0, INFOS_LIMITS.sections)) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const text = (lang: 'DE' | 'EN'): InfosSectionText => {
      const v = (o[lang] && typeof o[lang] === 'object' ? o[lang] : {}) as Record<string, unknown>;
      return { title: oneLine(v.title, INFOS_LIMITS.title), note: oneLine(v.note, INFOS_LIMITS.note) };
    };
    const de = text('DE');
    const en = text('EN');
    if (!de.title && !en.title) continue;
    let id = oneLine(o.id, 40).replace(/[^a-z0-9-]/gi, '');
    for (let n = sections.length + 1; !id || ids.has(id); n += 1) id = `s${n}`;
    ids.add(id);
    sections.push({
      id,
      DE: { title: de.title || en.title, note: de.note },
      EN: { title: en.title || de.title, note: en.note },
      docs: take(o.docs),
    });
  }
  if (sections.length === 0) return null;
  return { sections, hidden: take(rawHidden) };
}

/**
 * Every public document placed: the layout's own order first, then any the
 * layout does not mention (added in code since it was saved) in the section
 * their audience names, or the last. Hidden ones are not in any section.
 */
export function placeInfosDocs(layout: InfosLayout): Array<{ section: InfosSection; docs: UsefulDoc[] }> {
  const byId = new Map(INFOS_PUBLIC_DOCS.map((d) => [d.id, d]));
  const mentioned = new Set([...layout.sections.flatMap((s) => s.docs), ...layout.hidden]);
  const extra = new Map<string, UsefulDoc[]>();
  for (const doc of INFOS_PUBLIC_DOCS) {
    if (mentioned.has(doc.id)) continue;
    const home = layout.sections.find((s) => s.id === audienceOf(doc)) ?? layout.sections[layout.sections.length - 1];
    extra.set(home.id, [...(extra.get(home.id) ?? []), doc]);
  }
  return layout.sections.map((section) => ({
    section,
    docs: [
      ...section.docs.map((id) => byId.get(id)).filter((d): d is UsefulDoc => !!d),
      ...(extra.get(section.id) ?? []),
    ],
  }));
}

/** The same layout with every document written into its place — what the
 *  editor edits and saves, so a document added in code is saved where it shows. */
export function settleInfosLayout(layout: InfosLayout): InfosLayout {
  return {
    sections: placeInfosDocs(layout).map(({ section, docs }) => ({ ...section, docs: docs.map((d) => d.id) })),
    hidden: [...layout.hidden],
  };
}
