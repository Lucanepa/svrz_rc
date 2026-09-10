// Everything a coach might have to look up, in one place on Home.
//
// The card at the bottom of the coachee list used to be six links in a column,
// written inline in App.tsx. It has since grown past a dozen — the regulation
// the app quotes, the rulebooks, the season's letters, the tool that searches
// the rules — and a flat column of blue text says nothing about which of them
// answers the question a coach actually has in the gym. So each entry carries
// a one-line note saying what is inside, and they are grouped by the question
// they answer: how do I coach, what do the rules say, what does the season ask
// of me.
//
// External links are the upstream copy on purpose: volleyball.ch and fivb.com
// replace those PDFs when the rules change, and a copy in `public/docs/` would
// quietly go stale. What we host ourselves is what SVRZ hands out and nobody
// else publishes.
//
// Every PDF here opens in the app's own reader, which searches it — a coach
// looking up what counts as a double contact wants the paragraph, not a 7 MB
// download and a browser tab. `href` stays the canonical link, for the reader's
// "open the original" and for anyone who wants the file itself.

export type UsefulDocGroup = 'coaching' | 'rules' | 'season';

/** Picks the icon, and — for `form` — the button that downloads a blank form. */
export type UsefulDocKind = 'pdf' | 'web' | 'video' | 'form';

export type UsefulDoc = {
  id: string;
  group: UsefulDocGroup;
  kind: UsefulDocKind;
  /**
   * Absolute for anything upstream; otherwise relative to the app's base, which
   * the component prefixes. `{lang}` is replaced with `de` or `en`. Empty for
   * `form`, which is a button, not a link.
   */
  href: string;
  /** Shown small next to the note: the file type, plus a size worth knowing. */
  badge: string;
  /**
   * Where the reader gets the bytes. `path` is ours, under the app's base;
   * `proxyId` names a file the API fetches for us, because volleyball.ch and
   * fivb.com serve their PDFs without CORS and a browser may link to those but
   * not read them. A PDF with neither (the blank form) is made in the browser.
   */
  path?: string;
  proxyId?: string;
  /** Bytes, so the offline control can say what it is about to download. */
  bytes?: number;
  DE: { title: string; note: string };
  EN: { title: string; note: string };
};

export const USEFUL_DOC_GROUPS: Record<UsefulDocGroup, { DE: string; EN: string }> = {
  coaching: { DE: 'Coaching', EN: 'Coaching' },
  rules: { DE: 'Regeln', EN: 'Rules' },
  season: { DE: 'Saison & Abrechnung', EN: 'Season & claims' },
};

export const USEFUL_DOCS: UsefulDoc[] = [
  // The regulation the whole app quotes — every (i) hint cites a section of it —
  // so it leads the list.
  {
    id: 'rcWesen',
    group: 'coaching',
    kind: 'pdf',
    href: 'docs/Infoschreiben-RC-Wesen-2026-27.pdf',
    path: 'docs/Infoschreiben-RC-Wesen-2026-27.pdf',
    bytes: 414415,
    badge: 'PDF',
    DE: { title: 'Infoschreiben RC-Wesen 26/27', note: 'Das Reglement, das die App zitiert: Ablauf, Einstufung, Ziele.' },
    EN: { title: 'RC information sheet 26/27', note: 'The regulation the app quotes: procedure, ratings, targets.' },
  },
  {
    id: 'srTechnik',
    group: 'coaching',
    kind: 'pdf',
    href: 'docs/Leitfaden-SR-Technik.pdf',
    path: 'docs/Leitfaden-SR-Technik.pdf',
    bytes: 250744,
    badge: 'PDF',
    DE: { title: 'Leitfaden SR-Technik', note: 'Was ein SR vor, während und nach dem Spiel zu tun hat.' },
    EN: { title: 'Refereeing technique guide', note: 'What a referee does before, during and after the match.' },
  },
  {
    id: 'niveau',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/8/6/d/d/86dd9a07156e7501b5e74ec3e0eeeab30975bcbd/Uebersicht%20SR-Niveau%20und%20Stufe.pdf',
    proxyId: 'niveau',
    bytes: 19667,
    badge: 'PDF',
    DE: { title: 'SR-Niveau und Stufe', note: 'Welches Niveau welche Spiele leitet — die Übersicht der SVRZ.' },
    EN: { title: 'Referee levels & stages', note: 'Which level referees which matches — the SVRZ overview.' },
  },
  {
    id: 'guide',
    group: 'coaching',
    kind: 'video',
    href: '#/guide/{lang}',
    badge: 'Video',
    DE: { title: 'Video-Anleitung', note: 'Vom Spiel antippen bis zur E-Mail an den Schiedsrichter.' },
    EN: { title: 'Video guide', note: 'From tapping the game to the email the referee receives.' },
  },
  {
    id: 'emptyForm',
    group: 'coaching',
    kind: 'form',
    href: '',
    badge: 'PDF',
    DE: { title: 'Leeres Formular', note: 'Zum Ausdrucken, wenn du in der Halle auf Papier notierst.' },
    EN: { title: 'Blank form', note: 'To print, if you take your notes on paper in the gym.' },
  },
  {
    id: 'ruleChanges',
    group: 'rules',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/c/b/3/f/cb3f0be3e71e90986627eb3a02716135646b33e3/26.08.24_%C3%84nderungen-Regeln-2027-d.pdf',
    proxyId: 'rule-changes',
    bytes: 370283,
    badge: 'PDF',
    DE: { title: 'Regeländerungen ab 1.9.2026', note: 'SSK-Erläuterungen zu Aufstellung, Sichtblock und Doppelberührung.' },
    EN: { title: 'Rule changes from 1 Sep 2026', note: 'SSK notes on positions, screening and double contact.' },
  },
  {
    id: 'rulesDe',
    group: 'rules',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/1/1/7/71171e2ba8b1b649012440750a2fc2338d4a2b7d/Offizielle_Volleyball_Regeln_2025-2028_d%20-%20final%20inkl%20Deckblatt.pdf',
    proxyId: 'rules-de',
    bytes: 7309672,
    badge: 'PDF · 7 MB',
    DE: { title: 'Offizielle Volleyball-Regeln 2025–2028', note: 'Das vollständige Regelbuch auf Deutsch (volleyball.ch).' },
    EN: { title: 'Official volleyball rules 2025–2028', note: 'The complete rulebook in German (volleyball.ch).' },
  },
  {
    id: 'rulesEn',
    group: 'rules',
    kind: 'pdf',
    href: 'https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN-v05.pdf',
    proxyId: 'rules-en',
    bytes: 5178252,
    badge: 'PDF · 5 MB',
    DE: { title: 'FIVB Volleyball Rules 2025–2028', note: 'Das vollständige Regelbuch auf Englisch (fivb.com).' },
    EN: { title: 'FIVB Volleyball Rules 2025–2028', note: 'The complete rulebook in English (fivb.com).' },
  },
  {
    id: 'readvolley',
    group: 'rules',
    kind: 'web',
    href: 'https://readvolley.openvolley.app/',
    badge: 'Web-App',
    DE: { title: 'ReadVolley — Regeln nachschlagen', note: 'Regeln, Handzeichen, Diagramme und Protokolle durchsuchbar, auch offline.' },
    EN: { title: 'ReadVolley — look up a rule', note: 'Rules, hand signals, diagrams and protocols, searchable and offline.' },
  },
  {
    id: 'saisonbeginn',
    group: 'season',
    kind: 'pdf',
    href: 'docs/Infoschreiben-Saisonbeginn-2026-27.pdf',
    path: 'docs/Infoschreiben-Saisonbeginn-2026-27.pdf',
    bytes: 122747,
    badge: 'PDF',
    DE: { title: 'Infoschreiben Saisonbeginn', note: 'Aufgebote, SR-Börse, Fristen und Neues im VolleyManager.' },
    EN: { title: 'Season-start information sheet', note: 'Appointments, the referee exchange, deadlines, what is new in VolleyManager.' },
  },
  {
    id: 'doppelspiele',
    group: 'season',
    kind: 'pdf',
    href: 'docs/Abrechnung-Doppelspiele-2026.pdf',
    path: 'docs/Abrechnung-Doppelspiele-2026.pdf',
    bytes: 168884,
    badge: 'PDF',
    DE: { title: 'Abrechnung Doppelspiele', note: 'Was bei zwei Spielen hintereinander als Spielleitung und was als Spesen zählt.' },
    EN: { title: 'Claiming for back-to-back matches', note: 'What counts as a match fee and what as expenses when you referee two in a row.' },
  },
  {
    id: 'srInfo',
    group: 'season',
    kind: 'web',
    href: 'https://www.svrz.ch/ausbildung/schiedsrichter-in/informationen',
    badge: 'Web',
    DE: { title: 'SR-Informationen (svrz.ch)', note: 'Kurse, Termine und Unterlagen der Schiri-Kommission.' },
    EN: { title: 'Referee info (svrz.ch)', note: 'Courses, dates and documents from the referee commission.' },
  },
];
