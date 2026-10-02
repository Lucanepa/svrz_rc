import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, ExternalLink, Globe, Mail, Search, Video } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getStoredLang, type Lang } from '../lib/prefs';
import { infosLangFromPath } from '../lib/routes';
import { foldText } from '../lib/docText';
import { USEFUL_DOCS, USEFUL_DOC_GROUPS, type UsefulDoc, type UsefulDocGroup } from '../lib/usefulDocs';

/**
 * "Nützliche Infos & Dokumente", on a page anyone can open.
 *
 * Public and unauthenticated, like the guide: the link goes to referees, who
 * have no login to this app. It is a MIRROR of the card on Home, not a copy —
 * both render USEFUL_DOCS (src/lib/usefulDocs.ts), so an entry added, changed
 * or removed there shows up here with the next deploy, and nothing on this
 * page lists a document of its own.
 *
 * What it leaves out of the Home card, on purpose:
 *  - the blank form (`kind: 'form'`): it is built in the browser by the app's
 *    PDF code for a coach's observation, and means nothing to a referee;
 *  - the video guide (`kind: 'video'`), and any link into the app at all: the
 *    readers are referees, who have no login, and a door they cannot open is
 *    noise (Luca, 2026-10-02: "do not link to the app");
 *  - the in-app reader and "Save all offline": proxied PDFs go through the
 *    API, and a public page should not hand out a free fetcher. Every entry
 *    links to its canonical `href` instead — the upstream file, or ours under
 *    /docs/, which Pages serves to anyone already.
 */

const STR = {
  DE: {
    kicker: 'SVRZ · Schiedsrichterwesen',
    title: 'Nützliche Infos & Dokumente',
    lead: 'Reglemente, Regeln, Leitfäden und Kontakte für Schiedsrichter:innen im SVRZ — an einem Ort.',
    search: 'Dokumente suchen…',
    none: 'Nichts gefunden.',
  },
  EN: {
    kicker: 'SVRZ · Refereeing',
    title: 'Useful info & documents',
    lead: 'Regulations, rules, guides and contacts for referees in the SVRZ — in one place.',
    search: 'Search documents…',
    none: 'Nothing found.',
  },
} satisfies Record<Lang, Record<string, string>>;

const PUBLIC_DOCS = USEFUL_DOCS.filter((d) => d.kind !== 'form' && d.kind !== 'video');

function hrefFor(doc: UsefulDoc, code: 'de' | 'en'): string {
  return /^(https?|mailto):/i.test(doc.href)
    ? doc.href
    : `${import.meta.env.BASE_URL}${doc.href.replace('{lang}', code)}`;
}

function DocIcon({ kind }: { kind: UsefulDoc['kind'] }) {
  const Icon = kind === 'mail' ? Mail : kind === 'web' ? Globe : kind === 'video' ? Video : Download;
  return (
    <span className="h-10 w-10 shrink-0 rounded-lg bg-red-50 text-red-700 flex items-center justify-center">
      <Icon size={18} />
    </span>
  );
}

export default function InfosPage() {
  const [lang, setLang] = useState<Lang>(() =>
    infosLangFromPath(window.location.pathname)
    ?? getStoredLang()
    ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE'));
  const [query, setQuery] = useState('');
  // Open by default, unlike Home: someone following a shared link has not
  // come to click through five folds before seeing anything.
  const [closed, setClosed] = useState<Set<UsefulDocGroup>>(() => new Set());
  const t = STR[lang];
  const code = lang === 'DE' ? 'de' : 'en';

  useEffect(() => {
    document.documentElement.lang = code;
    document.title = `${t.title} · SVRZ`;
  }, [code, t.title]);

  // Not setStoredLang — same reason as the guide: reading a shared link must
  // not change the reader's own app language.
  const choose = (next: Lang) => {
    setLang(next);
    window.history.replaceState(null, '', `/infos/${next === 'DE' ? 'de' : 'en'}`);
  };

  const q = foldText(query.trim());
  const groups = useMemo(() => {
    const matches = (doc: UsefulDoc) => !q || foldText(
      [doc[lang].title, doc[lang].note, doc.badge, USEFUL_DOC_GROUPS[doc.group][lang]].join(' '),
    ).includes(q);
    return (Object.keys(USEFUL_DOC_GROUPS) as UsefulDocGroup[])
      .map((group) => ({ group, docs: PUBLIC_DOCS.filter((d) => d.group === group && matches(d)) }))
      .filter((g) => g.docs.length > 0);
  }, [q, lang]);

  const toggle = (group: UsefulDocGroup) => setClosed((prev) => {
    const next = new Set(prev);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t.kicker}</p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{t.title}</h1>
          </div>
          <div className="flex flex-col items-end gap-3 shrink-0">
            <SvrzLogo className="h-9 sm:h-11 w-auto" />
            {/* At the top, not under 70 cards (Luca, 2026-10-02). */}
            <div role="group" aria-label="Sprache / Language" className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
              {(['DE', 'EN'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => choose(l)}
                  aria-pressed={lang === l}
                  className={`h-7 px-2.5 rounded-md text-xs font-semibold transition-colors ${lang === l ? 'bg-stone-900 text-white' : 'text-stone-500 hover:text-stone-800'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </header>

        <p className="text-sm sm:text-base leading-relaxed text-stone-600 mb-6">{t.lead}</p>

        <div className="relative mb-4">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.search}
            aria-label={t.search}
            className="w-full h-11 pl-10 pr-3 rounded-xl border border-stone-200 bg-white text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40"
          />
        </div>

        <div className="rounded-2xl bg-white shadow-card border border-stone-200/70 px-4 sm:px-6 py-2">
          {groups.length === 0 && <p className="py-6 text-sm text-stone-500 text-center">{t.none}</p>}
          {groups.map(({ group, docs }) => {
            const open = !!q || !closed.has(group);
            return (
              <section key={group} className="border-b border-stone-200/70 last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggle(group)}
                  aria-expanded={open}
                  className="w-full flex items-center gap-3 py-4 text-left"
                >
                  <ChevronDown size={16} className={`text-stone-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                  <span className="flex-1 text-base font-semibold text-stone-800">{USEFUL_DOC_GROUPS[group][lang]}</span>
                  <span className="text-xs tabular-nums text-stone-400">{docs.length}</span>
                </button>
                {open && (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pb-4">
                    {docs.map((doc) => {
                      const href = hrefFor(doc, code);
                      const external = !href.startsWith('mailto:');
                      return (
                        <a
                          key={doc.id}
                          href={href}
                          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                          className="group flex gap-3 rounded-xl border border-stone-200/80 p-4 hover:border-red-700/30 hover:bg-stone-50/60 transition-colors"
                        >
                          <DocIcon kind={doc.kind} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-[15px] font-medium text-stone-900">
                              {doc[lang].title}
                              {doc.kind === 'web' && <ExternalLink size={12} className="text-stone-400 shrink-0" />}
                            </span>
                            <span className="mt-1 block text-sm leading-snug text-stone-500">{doc[lang].note}</span>
                            <span className="mt-1.5 block text-[11px] font-semibold uppercase tracking-wide text-stone-400 break-all">
                              {doc.kind === 'mail' ? doc.badge.toLowerCase() : doc.badge}
                            </span>
                          </span>
                        </a>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>


        <p className="mt-8 text-center text-[11px] text-stone-400">
          SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch
        </p>
      </div>
    </div>
  );
}
