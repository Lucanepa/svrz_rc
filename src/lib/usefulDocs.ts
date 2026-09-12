// Everything a coach might have to look up, in one place on Home.
//
// The card at the bottom of the coachee list used to be six links in a column,
// written inline in App.tsx. It has since grown past a dozen — the regulation
// the app quotes, the rulebooks, the season's letters, the tool that searches
// the rules — and a flat column of blue text says nothing about which of them
// answers the question a coach actually has in the gym. So each entry carries
// a one-line note saying what is inside, and they are grouped by the question
// they answer: how do I coach, what do the rules say, what does the federation
// say, what does the season ask of me, and whom do I write to.
//
// The SVRZ entries are the ones the RSK lists for referees on svrz.ch (the
// "Informationen für SR" page, the Reglemente pages and the RSK contacts) —
// the chair offered them for the app in September 2026, so a coach can show a
// coachee what they are paid, what a promotion takes or whom to report a card
// to without leaving the gym.
//
// External links are the upstream copy on purpose: volleyball.ch, fivb.com and
// svrz.ch replace those PDFs when something changes, and a copy in
// `public/docs/` would quietly go stale. What we host ourselves is what SVRZ
// hands out by mail and nobody publishes.
//
// Every PDF here opens in the app's own reader, which searches it — a coach
// looking up what counts as a double contact wants the paragraph, not a 7 MB
// download and a browser tab. `href` stays the canonical link, for the reader's
// "open the original" and for anyone who wants the file itself.

export type UsefulDocGroup = 'coaching' | 'rules' | 'regulations' | 'season' | 'contacts';

/**
 * Picks the icon, and — for `form` — the button that downloads a blank form.
 * `mail` is a contact: the href is a mailto:, and the badge is the address.
 */
export type UsefulDocKind = 'pdf' | 'web' | 'video' | 'form' | 'mail';

export type UsefulDoc = {
  id: string;
  group: UsefulDocGroup;
  kind: UsefulDocKind;
  /**
   * Absolute for anything upstream (and `mailto:` for a contact); otherwise
   * relative to the app's base, which the component prefixes. `{lang}` is
   * replaced with `de` or `en`. Empty for `form`, which is a button, not a link.
   */
  href: string;
  /**
   * Shown small next to the note: the file type, plus a size worth knowing —
   * or, for a contact, the address itself, so it can be read out to a coachee.
   */
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
  // "Regeln" are the rules of the game; "Reglemente" are what the federation
  // decides on top of them — levels, fees, match organisation. A coach asking
  // what a double contact is and one asking what a promotion takes are not
  // looking in the same place.
  regulations: { DE: 'Reglemente', EN: 'Regulations' },
  season: { DE: 'Saison & Abrechnung', EN: 'Season & claims' },
  contacts: { DE: 'Kontakte', EN: 'Contacts' },
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
  // The RSK's own sheets for new referees — what a coach hands a coachee who
  // is whistling alone for the first time, or as 2nd referee for the first time.
  {
    id: 'kurzSr',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/e/f/b/0/efb0e24dea47d434e0d557e821dfbcd73d2b9c8d/Kurzzusammenfassung%20f%C3%BCr%20SR_2026.pdf',
    proxyId: 'kurz-sr',
    bytes: 475927,
    badge: 'PDF',
    DE: { title: 'Kurzzusammenfassung für SR', note: 'Pfiff, Zeichengebung, Blicktechnik: das Wichtigste für neue SR, die alleine pfeifen.' },
    EN: { title: 'Quick guide for referees', note: 'Whistle, signals, where to look: the essentials for new referees officiating alone.' },
  },
  {
    id: 'kurzSr2',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/9/6/4/7/96475bd5848d7f18ce9c83b68941fd4e97e842b4/Kurzzusammenfassung%20f%C3%BCr%202.SR_2026.pdf',
    proxyId: 'kurz-2sr',
    bytes: 78837,
    badge: 'PDF',
    DE: { title: 'Kurzzusammenfassung für 2. SR', note: 'Befugnisse und Aufgaben des 2. SR, wenn zu zweit gepfiffen wird.' },
    EN: { title: 'Quick guide for 2nd referees', note: 'Powers and duties of the second referee when two officiate.' },
  },
  {
    id: 'vorNach',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/f/9/0/a/f90ad1f5031f103be411e34fff4aea13d5509cbf/Spiel%20Vor-%20und%20Nachbereitung_2026.pdf',
    proxyId: 'vor-nachbereitung',
    bytes: 92445,
    badge: 'PDF',
    DE: { title: 'Spiel Vor- und Nachbereitung', note: 'Was vor der Auslosung, nach dem Schlusspfiff und danach zu tun ist.' },
    EN: { title: 'Before and after the match', note: 'What to do before the toss, after the final whistle and afterwards.' },
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
    id: 'sanktionen',
    group: 'rules',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/9/7/9/8/9798845fef96808713a25ab2c6aece8789dd921f/Sanktionen.pdf',
    proxyId: 'sanktionen',
    bytes: 123366,
    badge: 'PDF',
    DE: { title: 'Sanktionen', note: 'Verwarnung, gelbe und rote Karte: wie die Karte gegeben wird, auf dem Feld und auf der Bank.' },
    EN: { title: 'Sanctions', note: 'Warning, yellow and red card: how a card is given, on court and on the bench.' },
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
  // The regulations a referee is actually bound by. The Reglement der
  // Unparteiischen answers the question every coachee asks sooner or later —
  // what a promotion takes and how many games are compulsory — and the ROW is
  // where the match-day questions live: start times, postponements, how many
  // referees a league gets.
  {
    id: 'unparteiische',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/6/c/9/b/6c9b985a09ab5edafe4a06219e4cd737fe5ddde1/SVRZ_Reglement%20der%20Unparteiischen.pdf',
    proxyId: 'unparteiische',
    bytes: 209284,
    badge: 'PDF',
    DE: { title: 'Reglement der Unparteiischen', note: 'Niveaustufen, Beförderung, Pflichtpensum, Aufgebot und Entschädigung der SR.' },
    EN: { title: 'Regulation for officials', note: 'Levels, promotion, the compulsory quota, appointments and referee pay.' },
  },
  {
    id: 'row',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/5/e/3/a/5e3ac6df82efc003eca8bd9958f7ebda624eb1e0/SVRZ_Reglement%20f%C3%BCr%20offizielle%20Wettk%C3%A4mpfe.pdf',
    proxyId: 'row',
    bytes: 311269,
    badge: 'PDF',
    DE: { title: 'Reglement für offizielle Wettkämpfe (ROW)', note: 'Spielmodus, Spielzeiten, Verschiebungen und wie viele SR eine Liga braucht.' },
    EN: { title: 'Official competitions regulation (ROW)', note: 'Match format, start times, postponements and how many referees a league needs.' },
  },
  {
    id: 'zueriCup',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/0/6/1/a/061a1b2e822545a409d76335cb0bfb9434da8046/SVRZ%20Cup%20Reglement_25-26.pdf',
    proxyId: 'zueri-cup',
    bytes: 97505,
    badge: 'PDF',
    DE: { title: 'Reglement Züri-Cup', note: 'Teilnahme, Teamzusammensetzung und Modus des regionalen Cups.' },
    EN: { title: 'Züri-Cup regulation', note: 'Entry, team composition and format of the regional cup.' },
  },
  {
    id: 'volleyballreglement',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/0/e/9/f/0e9f8dcf5ae32a59a5fc7f9f3f3f3ea203d7ee32/Volleyballreglement_26-27_d.pdf',
    proxyId: 'volleyballreglement',
    bytes: 1278714,
    badge: 'PDF · 1 MB',
    DE: { title: 'Volleyballreglement Swiss Volley 26/27', note: 'Das nationale Reglement, auf dem die SVRZ-Reglemente aufbauen (volleyball.ch).' },
    EN: { title: 'Swiss Volley regulation 26/27', note: 'The national regulation the SVRZ regulations build on (volleyball.ch).' },
  },
  {
    id: 'reglemente',
    group: 'regulations',
    kind: 'web',
    href: 'https://www.svrz.ch/verband/reglemente-vorschriften/reglemente-svrz',
    badge: 'Web',
    DE: { title: 'Alle Reglemente (svrz.ch)', note: 'Statuten, Gebührenordnung, Rechtspflege, Meisterschaft und Nachwuchs.' },
    EN: { title: 'All regulations (svrz.ch)', note: 'Statutes, fees, disciplinary rules, championship and youth.' },
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
    id: 'srKonferenz',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/7/a/7/4/7a74c810f484d119adecec6bbf631a48304b0745/20260904-Pr%C3%A4sentation-SRV.pdf',
    proxyId: 'sr-konferenz-2026',
    bytes: 2115035,
    badge: 'PDF · 2 MB',
    DE: { title: 'Präsentation SR-Konferenz 2026', note: 'Die Folien vom 4. September: Rückblick, Ausblick und was die RSK für die Saison ankündigt.' },
    EN: { title: 'Referee conference 2026 slides', note: 'The slides from 4 September: review, outlook and what the RSK announced for the season.' },
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
  // "How much do I get for this game?" is a season question, not a regulation
  // question, so the fee schedule sits here beside the claim sheet. The proxy
  // puts a one-page summary in front of it (server/gboSummary.ts) — hence the
  // byte count is ours, not svrz.ch's, and the GBO date in that file is the one
  // to check when the DV passes a new schedule.
  {
    id: 'gbo',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/0/e/5/0/0e50e7cdd5c61ab180d07346e4052539d8573dfb/SVRZ_Geb%C3%BChrenordnung.pdf',
    proxyId: 'gbo',
    bytes: 143921,
    badge: 'PDF',
    DE: { title: 'Gebührenordnung (GBO)', note: 'Vorne eine Zusammenfassung: was ein SR pro Spiel erhält, was eine Karte das Team kostet, welche Bussen es gibt.' },
    EN: { title: 'Fee schedule (GBO)', note: 'A summary up front: what a referee gets per match, what a card costs the team, what the fines are.' },
  },
  {
    id: 'datenerfassung',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/7/c/3/0/7c3059181062b783094d64d6bfe60ed30245e101/SR-Datenerfassung_2026.pdf',
    proxyId: 'sr-datenerfassung',
    bytes: 89797,
    badge: 'PDF',
    DE: { title: 'Datenerfassung im VolleyManager', note: 'Kontaktdaten, Pensen, Dispensation und Rücktritt: bis 31. Mai zu erfassen.' },
    EN: { title: 'Data entry in VolleyManager', note: 'Contact details, quota, dispensation and retirement: to be entered by 31 May.' },
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
  // Whom to write to. The role addresses are the stable part — they follow the
  // office, not the person — so they are the title and the badge; the names
  // are as svrz.ch lists them (RSK page and "Informationen aus RSK und MKI")
  // and are the part to check when that page changes.
  {
    id: 'rsk',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:rsk@svrz.ch',
    badge: 'rsk@svrz.ch',
    DE: { title: 'Vorsitz RSK', note: 'Daniela Baumgartner — für Fragen zum SR-Wesen.' },
    EN: { title: 'RSK chair', note: 'Daniela Baumgartner — for questions about refereeing.' },
  },
  {
    id: 'koordination',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:schirikoordination@svrz.ch',
    badge: 'schirikoordination@svrz.ch',
    DE: { title: 'Schiri-Koordination / Abtausch', note: 'Jorge Bastante — SR-Abtausch und die Suche nach geeigneten Spielen.' },
    EN: { title: 'Referee coordination / swaps', note: 'Jorge Bastante — swapping games and finding suitable ones.' },
  },
  {
    id: 'gsAdmin',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:gs-admin@svrz.ch',
    badge: 'gs-admin@svrz.ch',
    DE: { title: 'Geschäftsstelle (Administration)', note: 'Marianne Bregenzer — offene Einsatzlisten und Matchblätter, Bemerkungen, Rapporte und Sanktionen.' },
    EN: { title: 'Office (administration)', note: 'Marianne Bregenzer — unfinished duty lists and scoresheets, remarks, reports and sanctions.' },
  },
  {
    id: 'coaching',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:schiricoaching@svrz.ch',
    badge: 'schiricoaching@svrz.ch',
    DE: { title: 'Vorsitz Referee Coaches', note: 'Jasmin Zimmermann — alles rund ums RC-Wesen.' },
    EN: { title: 'Referee coaches chair', note: 'Jasmin Zimmermann — anything about referee coaching.' },
  },
  {
    id: 'ausbildung',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:schiriausbildung@svrz.ch',
    badge: 'schiriausbildung@svrz.ch',
    DE: { title: 'Schiri-Ausbildung N4', note: 'Matthias Becker, Seppi Dittli — die Grundausbildung.' },
    EN: { title: 'Referee training N4', note: 'Matthias Becker, Seppi Dittli — basic training.' },
  },
  {
    id: 'weiterbildung',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:schiriweiterbildung@svrz.ch',
    badge: 'schiriweiterbildung@svrz.ch',
    DE: { title: 'Schiri-Ausbildung N3 / Linienrichter', note: 'Matthias Becker, Beat Grossenbacher — Weiterbildung zum 2. SR und Linienrichter.' },
    EN: { title: 'Referee training N3 / line judges', note: 'Matthias Becker, Beat Grossenbacher — training as 2nd referee and line judge.' },
  },
  {
    id: 'schreiber',
    group: 'contacts',
    kind: 'mail',
    href: 'mailto:schreiberausbildung@svrz.ch',
    badge: 'schreiberausbildung@svrz.ch',
    DE: { title: 'Schreiberwesen', note: 'Christine Pulver — Schreiberausbildung.' },
    EN: { title: 'Scorers', note: 'Christine Pulver — scorer training.' },
  },
];
