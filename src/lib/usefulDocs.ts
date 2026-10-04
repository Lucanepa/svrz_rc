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

export type UsefulDocGroup = 'coaching' | 'training' | 'rules' | 'regulations' | 'national' | 'season' | 'contacts';

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
  training: { DE: 'Ausbildung & Leitfäden', EN: 'Training & guides' },
  rules: { DE: 'Regeln', EN: 'Rules' },
  // "Regeln" are the rules of the game; "Reglemente" are what the federation
  // decides on top of them — levels, fees, match organisation. A coach asking
  // what a double contact is and one asking what a promotion takes are not
  // looking in the same place.
  regulations: { DE: 'Reglemente', EN: 'Regulations' },
  // Swiss Volley's own documents for NLA, NLB and 1. Liga and the national
  // referee panel — kept apart so the regional sheets are not buried in them.
  national: { DE: 'Nationale Ligen & Kader', EN: 'National leagues & panel' },
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
    bytes: 132932,
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
  // The two match protocols: what the referees and the teams do at each minute
  // mark from H-60 to the first whistle. Swiss Volley writes both; the RSK
  // adopted the regional one for Zürich from 2023/24 with a single deviation
  // the sheet itself does not show — position sheets are due at H-4, not H-12
  // (svrz.ch → Reglemente) — so the note carries it, or a coach marks a
  // referee down for following the paper.
  {
    id: 'spielprotokollRegional',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/f/b/b/a/fbba891628ab5c4cae3a0783b4d480de2712e05f/Spielprotokoll%20regional%20Version%2001.07.2023_D.pdf',
    proxyId: 'spielprotokoll-regional',
    bytes: 91712,
    badge: 'PDF',
    DE: { title: 'Spielprotokoll Regional- und Juniorenligen', note: 'Der offizielle Ablauf vor dem Spiel, H-60 bis Anpfiff. In Zürich mit einer Abweichung: Positionsblätter bis H-4 statt H-12.' },
    EN: { title: 'Regional & junior league match protocol', note: 'The official pre-match procedure, H-60 to the first whistle. Zürich applies one deviation: position sheets by H-4 instead of H-12.' },
  },
  // The national leagues' one (Anhang 1 to the Volleyballreglement): a 1L,
  // NLB or NLA game runs on this, presentation, set breaks and the 10-minute
  // break included.
  {
    id: 'spielprotokoll',
    group: 'coaching',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/0/0/7/9/007906b62accd1615aaf268a200d69cb1cdeb9ba/Spielprotokoll%20NL_d.pdf',
    proxyId: 'spielprotokoll-nl',
    bytes: 228342,
    badge: 'PDF',
    DE: { title: 'Spielprotokoll Nationale Ligen', note: 'Der offizielle Ablauf vor dem Spiel in NLA, NLB und 1. Liga — von H-60 bis zum Anpfiff, Minute für Minute.' },
    EN: { title: 'National league match protocol', note: 'The official pre-match procedure for NLA, NLB and 1st league — from H-60 to the first whistle, minute by minute.' },
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
    href: 'guide/{lang}',
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
    id: 'srOhneAusbildung',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/9/c/8/a/9c8a886669e3f93370dcccaaaeef1b895dcd2294/Leitfaden%20SR%20ohne%20Ausbildung%20SVRZ_2026.pdf',
    proxyId: 'sr-ohne-ausbildung',
    bytes: 72218,
    badge: 'PDF',
    DE: { title: 'Leitfaden SR ohne SVRZ-Ausbildung', note: 'Für SR, die aus einem anderen Regionalverband oder dem Ausland zur SVRZ wechseln: Anlaufstelle und Ablauf.' },
    EN: { title: 'Guide for referees trained elsewhere', note: 'For referees moving to SVRZ from another region or from abroad: whom to contact and what happens next.' },
  },
  {
    id: 'srN4',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/3/5/e/d/35ed997ea5a294ccd0ace1e71504c93f755d2922/Leitfaden%20SR-Grundausbildung%20N4_2026.pdf',
    proxyId: 'sr-n4',
    bytes: 71133,
    badge: 'PDF',
    DE: { title: 'Leitfaden SR-Grundausbildung N4', note: 'Voraussetzungen, Ablauf und Prüfung der Grundausbildung zum N4-SR.' },
    EN: { title: 'Basic referee course N4 guide', note: 'Requirements, course structure and exam for becoming an N4 referee.' },
  },
  {
    id: 'erGbo',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/5/2/9/d/529d3bceeb82b16df032b72dd4767f83c792625b/Auszug%20ER%20und%20GBO_2026-27.pdf',
    proxyId: 'auszug-er-gbo',
    bytes: 83738,
    badge: 'PDF',
    DE: { title: 'Auszug ER und GBO für SR', note: 'Die SR-Artikel aus Ergänzungsreglement und Gebührenordnung: Pflichtpensum, Aufgebot, Bussen.' },
    EN: { title: 'ER and GBO extract for referees', note: 'The referee articles from the supplementary regulation and fee schedule: quota, appointments, fines.' },
  },
  {
    id: 'srN3',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/f/1/2/5/f1252d4f22119385c820e58aaf296d6df1247352/Leitfaden%20SR-Weiterbildung%20N3_2026.pdf',
    proxyId: 'sr-n3',
    bytes: 50463,
    badge: 'PDF',
    DE: { title: 'Leitfaden SR-Weiterbildung N3', note: 'Voraussetzungen und Ablauf der Weiterbildung zum N3-SR (2. SR).' },
    EN: { title: 'Referee course N3 guide', note: 'Requirements and course for the N3 (second referee) level.' },
  },
  {
    id: 'lrWeiterbildung',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/4/d/2/4/4d245df9d9a80c45f459b4c3a219f377b0481320/Leitfaden%20LR-Weiterbildung_2026.pdf',
    proxyId: 'lr-weiterbildung',
    bytes: 47866,
    badge: 'PDF',
    DE: { title: 'Leitfaden LR-Weiterbildung', note: 'Voraussetzungen und Ablauf der Weiterbildung zum Linienrichter.' },
    EN: { title: 'Line judge course guide', note: 'Requirements and course for becoming a line judge.' },
  },
  {
    id: 'jsr',
    group: 'training',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/9/9/8/7/9987240d30d900521df005704e16aac03e1245b6/Leitfaden%20JSR_2026.pdf',
    proxyId: 'jsr',
    bytes: 345361,
    badge: 'PDF',
    DE: { title: 'Leitfaden Jugend-SR (JSR)', note: 'Der Einführungskurs für Spieler:innen, die Spiele ohne offizielle SR leiten.' },
    EN: { title: 'Youth referee (JSR) guide', note: 'The introductory course for players who run matches without official referees.' },
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
  // Yves Kälin's slides from the Zentralkurs 2026: not a rule change but a
  // stricter reading of 9.2.2, with the indicators a referee whistles on. The
  // ZK hands its slides out, it does not publish them, so the file is ours —
  // the chair asked for it on 4 Oct 2026 with Yves's consent to publish.
  {
    id: 'zkRegel922',
    group: 'rules',
    kind: 'pdf',
    href: 'docs/ZK2026-Regel-9.2.2.pdf',
    path: 'docs/ZK2026-Regel-9.2.2.pdf',
    bytes: 831720,
    badge: 'PDF',
    DE: { title: 'Regel 9.2.2: gehaltene und geworfene Angriffsbälle', note: 'Erklärung vom Zentralkurs 2026: striktere Anwendung, Indikatoren, beidhändige Angriffe.' },
    EN: { title: 'Rule 9.2.2: held and thrown attack hits', note: 'Explainer from the 2026 central course: stricter application, indicators, two-handed attacks.' },
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
    id: 'zm',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/b/e/3/b/be3b0f05238243789d957a61e99ff1dc0ed7182d/SVRZ-ZM_25-26.pdf',
    proxyId: 'zm',
    bytes: 239418,
    badge: 'PDF',
    DE: { title: 'Reglement Züri Meisterschaft (ZM)', note: 'Spielbetrieb, Ligen, Auf- und Abstieg der regionalen Meisterschaft.' },
    EN: { title: 'Züri championship regulation (ZM)', note: 'Play, leagues, promotion and relegation in the regional championship.' },
  },
  {
    id: 'rechtspflege',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/6/7/2/e/672e4a745bfedca124b92a36e9a925007f685afd/SVRZ_Rechtspflegeordnung.pdf',
    proxyId: 'rechtspflege',
    bytes: 161089,
    badge: 'PDF',
    DE: { title: 'Rechtspflegeordnung', note: 'Wer über Proteste, Rekurse und Sanktionen entscheidet, und mit welchen Fristen.' },
    EN: { title: 'Disciplinary procedure', note: 'Who decides protests, appeals and sanctions, and the deadlines that apply.' },
  },
  {
    id: 'geschaeftsreglement',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/e/e/5/3/ee531759f00570db0d3379679c571f6200524101/SVRZ_Gesch%C3%A4ftsreglement.pdf',
    proxyId: 'geschaeftsreglement',
    bytes: 239825,
    badge: 'PDF',
    DE: { title: 'Geschäftsreglement', note: 'Organe, Kommissionen und Zuständigkeiten der SVRZ — auch der RSK.' },
    EN: { title: 'Rules of procedure', note: 'Bodies, commissions and who is responsible for what in the SVRZ — the RSK included.' },
  },
  {
    id: 'statuten',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/e/d/7/7/ed775e0ae049fe6156e639c1004449980a63d1f9/26-07-08%20SVRZ%20Statuten%20signiert.pdf',
    proxyId: 'statuten',
    bytes: 7221992,
    badge: 'PDF · 7 MB',
    DE: { title: 'Statuten SVRZ', note: 'Die Statuten der Swiss Volley Region Zürich, Fassung vom 8. Juli 2026.' },
    EN: { title: 'SVRZ statutes', note: 'The statutes of Swiss Volley Region Zürich, version of 8 July 2026.' },
  },
  {
    id: 'nsmQuali',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/e/6/0/2/e60237dbc14332135468954a647046f0c1a25697/Reglement%20zur%20regionalen%20N-SM%20Qualifikation.pdf',
    proxyId: 'nsm-quali',
    bytes: 191610,
    badge: 'PDF',
    DE: { title: 'Reglement N-SM Qualifikation', note: 'Die regionale Qualifikation zur Nachwuchs-Schweizermeisterschaft.' },
    EN: { title: 'Youth championship qualifier regulation', note: 'The regional qualifier for the Swiss youth championship.' },
  },
  {
    id: 'beach',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/3/0/8/2/3082c9d7e9e9a588d5f60911277b9867be7c5623/Beachvolleyballreglement.pdf',
    proxyId: 'beach',
    bytes: 172684,
    badge: 'PDF',
    DE: { title: 'Beachvolleyballreglement', note: 'Turniere, Kategorien und Wertung im Beachvolleyball der Region Zürich.' },
    EN: { title: 'Beach volleyball regulation', note: 'Tournaments, categories and ranking in beach volleyball in the Zürich region.' },
  },
  {
    id: 'srReglementSv',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/b/0/7/5/b0758228ba8e922773d4f786099a32771fc8d601/06.1%20d_Schiedsrichterreglement_01.06.2026.pdf',
    proxyId: 'sr-reglement-sv',
    bytes: 160423,
    badge: 'PDF',
    DE: { title: 'Reglement Schiedsrichterwesen (Swiss Volley)', note: 'Das nationale SR-Reglement vom 1. Juni 2026: Niveaus, Kader, Pflichten (volleyball.ch).' },
    EN: { title: 'Swiss Volley referee regulation', note: 'The national referee regulation of 1 June 2026: levels, panels, duties (volleyball.ch).' },
  },
  {
    id: 'vrMarkup',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/0/3/1/7031c86e0ed9dd2f0caa662241c3f199a27ac776/Volleyballreglement_26-27_d_markup.pdf',
    proxyId: 'volleyballreglement-markup',
    bytes: 1280920,
    badge: 'PDF · 1 MB',
    DE: { title: 'Volleyballreglement 26/27 mit Änderungen', note: 'Dasselbe Reglement mit markierten Änderungen gegenüber dem Vorjahr (volleyball.ch).' },
    EN: { title: 'Swiss Volley regulation 26/27, changes marked', note: 'The same regulation with this year’s changes marked (volleyball.ch).' },
  },
  {
    id: 'las',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/9/4/8/e/948e263207635d2b41854e1debf7e52d9f14ca9f/LAS-Bestimmungen_VR_ab%202024-25_d.pdf',
    proxyId: 'las-bestimmungen',
    bytes: 62188,
    badge: 'PDF',
    DE: { title: 'LAS-Bestimmungen', note: 'Lokal ausgebildete Spieler:innen: wer als LAS gilt und wie viele auf dem Feld stehen müssen.' },
    EN: { title: 'Locally trained player (LAS) rules', note: 'Who counts as a locally trained player and how many must be on court.' },
  },
  {
    id: 'mkiKleidung',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/a/9/5/8/a958e873fc9742d7c03d5d560424ed1240b4fc01/MKI_Spielerkleidung-Zusatzbekleidung-d_2015.pdf',
    proxyId: 'mki-zusatzbekleidung',
    bytes: 1144658,
    badge: 'PDF · 1 MB',
    DE: { title: 'Spielerkleidung: Zusatzbekleidung', note: 'Was an Ärmlingen, Unterziehhosen, Strümpfen usw. erlaubt ist — die MKI-Richtlinie.' },
    EN: { title: 'Player kit: extra clothing', note: 'What sleeves, undershorts, socks and the like are allowed — the MKI guideline.' },
  },
  {
    id: 'svRechtspflege',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/5/3/3/3/53338204cafe47eb4b934a3e5d64fb50ca5bf4b8/02.4%20Rechtspflegeordnung%20DE_gender.pdf',
    proxyId: 'rechtspflege-sv',
    bytes: 211679,
    badge: 'PDF',
    DE: { title: 'Rechtspflegeordnung Swiss Volley', note: 'Proteste, Rekurse und Disziplinarverfahren auf nationaler Ebene (volleyball.ch).' },
    EN: { title: 'Swiss Volley disciplinary procedure', note: 'Protests, appeals and disciplinary proceedings at national level (volleyball.ch).' },
  },
  {
    id: 'svStatuten',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/1/8/7/e/187eb31e82f3b48fe9b58a90a8eaea1af8e1c806/251129%20Statuten_D%20gender.pdf',
    proxyId: 'statuten-sv',
    bytes: 331966,
    badge: 'PDF',
    DE: { title: 'Statuten Swiss Volley', note: 'Die Statuten des nationalen Verbands, Ausgabe vom 29. November 2025.' },
    EN: { title: 'Swiss Volley statutes', note: 'The statutes of the national federation, edition of 29 November 2025.' },
  },
  {
    id: 'svBeach',
    group: 'regulations',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/5/9/a/8/59a8b7aeadc8fd49db67b9881582a6328499b77f/Beachvolleyball%20Reglement_2025_d.pdf',
    proxyId: 'beach-sv',
    bytes: 545201,
    badge: 'PDF',
    DE: { title: 'Beachvolleyball-Reglement Swiss Volley', note: 'Das nationale Reglement der offiziellen Wettspiele im Beachvolleyball.' },
    EN: { title: 'Swiss Volley beach volleyball regulation', note: 'The national regulation for official beach volleyball competitions.' },
  },
  {
    id: 'kaderWeisungen',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/0/a/c/70ac6385a6c94c7fbec129885a437fd1b6e595ee/SSK-St%C3%A4ndigeWsgSRNatKader_2026_d.pdf',
    proxyId: 'kader-weisungen',
    bytes: 213686,
    badge: 'PDF',
    DE: { title: 'Ständige Weisungen SR nationales Kader', note: 'Was die SSK von Kader-SR verlangt: Aufgebot, Auftreten, Abläufe.' },
    EN: { title: 'Standing instructions, national referee panel', note: 'What the SSK expects of national-panel referees: appointments, conduct, procedures.' },
  },
  {
    id: 'kaderNiveaus',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/b/e/7/7be77985abef29d4131cc301abffd596324136d6/Richtlinie%20der%20Niveaustufen%20SSK_Final_2024_DE.pdf',
    proxyId: 'kader-niveaus',
    bytes: 29544,
    badge: 'PDF',
    DE: { title: 'Niveaustufen im nationalen Kader', note: 'Die SSK-Richtlinie zu den Stufen 1–3 innerhalb von Niveau 1.' },
    EN: { title: 'Levels within the national panel', note: 'The SSK guideline on grades 1–3 within level 1.' },
  },
  {
    id: 'kaderFactsheet',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/d/3/5/0/d3500edae94bc0f88e5b2ce4554f725e262aa9ff/26.07.16_FINAL_Factsheet%20Neue%20Mitglieder%20Nationales%20Kader.pdf',
    proxyId: 'kader-factsheet',
    bytes: 212547,
    badge: 'PDF',
    DE: { title: 'Factsheet neue Kader-SR', note: 'Das Wichtigste für neue Mitglieder im nationalen SR-Kader.' },
    EN: { title: 'Factsheet for new national-panel referees', note: 'The essentials for new members of the national referee panel.' },
  },
  {
    id: 'kaderVertrauensperson',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/3/4/5/6/3456f9e35fff721d57086b3fd1725285ba2f23a4/26.02.18_Pflichtenheft_Vertrauensperson_Kader-SR_d_FINAL.pdf',
    proxyId: 'kader-vertrauensperson',
    bytes: 205280,
    badge: 'PDF',
    DE: { title: 'Vertrauensperson für SR', note: 'Die unabhängige Ansprechperson für persönliche oder SR-bezogene Anliegen.' },
    EN: { title: 'Referees’ confidential contact', note: 'The independent contact person for personal or refereeing concerns.' },
  },
  {
    id: 'gameManagement',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/e/3/b/9/e3b9acdf6acd549fbc0489815e27c2107b2ec418/Game-Management_Leitfaden-Spielvorbereitung_d_Stand_2026.pdf',
    proxyId: 'game-management',
    bytes: 799047,
    badge: 'PDF',
    DE: { title: 'Game Management: Spielvorbereitung', note: 'Der Leitfaden für Kader-SR: Spielvorbereitung und Protokoll in den nationalen Ligen.' },
    EN: { title: 'Game management: match preparation', note: 'The national-panel guide to match preparation and protocol.' },
  },
  {
    id: 'benchApp',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/0/e/4/2/0e42fdbd810208f08c1d613cae257e5a6c036de3/Leitfaden_Bench-Application-Management_d_Version-2025-10.pdf',
    proxyId: 'bench-app',
    bytes: 1767857,
    badge: 'PDF · 2 MB',
    DE: { title: 'Leitfaden Bench Application (NLA)', note: 'Die Bench App in NLA-Spielen, Schritt für Schritt.' },
    EN: { title: 'Bench Application guide (NLA)', note: 'Using the Bench App in NLA matches, step by step.' },
  },
  {
    id: 'escorerF',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/1/f/f/c/1ffc8fb8b1baeb1e5b84d24c47529eeeadfae514/eScorer_Refs_RD_Frauen.pdf',
    proxyId: 'escorer-frauen',
    bytes: 240681,
    badge: 'PDF',
    DE: { title: 'Zugelassene eScorer NLA/NLB Frauen', note: 'Wer pro Verein das eScoresheet führen darf, Meisterschaft und Cup.' },
    EN: { title: 'Approved eScorers NLA/NLB women', note: 'Who may run the eScoresheet for each club, championship and cup.' },
  },
  {
    id: 'escorerM',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/1/d/7/0/1d704c667945b1b7fbf3a40e7d45988c442c7298/eScorer_Refs_RD_M%C3%A4nner.pdf',
    proxyId: 'escorer-maenner',
    bytes: 199927,
    badge: 'PDF',
    DE: { title: 'Zugelassene eScorer NLA/NLB Männer', note: 'Wer pro Verein das eScoresheet führen darf, Meisterschaft und Cup.' },
    EN: { title: 'Approved eScorers NLA/NLB men', note: 'Who may run the eScoresheet for each club, championship and cup.' },
  },
  {
    id: 'hallenrapportNla',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/7/8/8/7788053b2ccf0d136f722f98f45b3bc1201340e9/d_NLA_Rapport_Sporthalle_und_Spielorganisation_2026.pdf',
    proxyId: 'hallenrapport-nla',
    bytes: 261162,
    badge: 'PDF',
    DE: { title: 'Hallenrapport NLA', note: 'Das Formular zu Halle und Spielorganisation, das der SR nach dem Spiel ausfüllt.' },
    EN: { title: 'Venue report NLA', note: 'The venue and match-organisation form the referee fills in after the match.' },
  },
  {
    id: 'hallenrapportNlb',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/d/f/8/7df858c1c67fa4b03ac8637ff4d506b5b0fd72cb/d_NLB_Rapport_Sporthalle_und_Spielorganisation_2026.pdf',
    proxyId: 'hallenrapport-nlb',
    bytes: 191271,
    badge: 'PDF',
    DE: { title: 'Hallenrapport NLB', note: 'Das Formular zu Halle und Spielorganisation, das der SR nach dem Spiel ausfüllt.' },
    EN: { title: 'Venue report NLB', note: 'The venue and match-organisation form the referee fills in after the match.' },
  },
  {
    id: 'nlbEinBall',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/2/8/e/9/28e941d18131482f88d060c05c2e396f2d3aa86a/260629_Hallenliste_NLB_Spiel_mit_1_Ball.pdf',
    proxyId: 'nlb-ein-ball',
    bytes: 84655,
    badge: 'PDF',
    DE: { title: 'NLB-Hallen: Spiel mit 1 Ball', note: 'In welchen Hallen die NLB 26/27 mit nur einem Ball gespielt werden darf.' },
    EN: { title: 'NLB venues: one-ball play', note: 'The venues where NLB matches in 26/27 may be played with a single ball.' },
  },
  {
    id: 'modusNl',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/2/a/0/f/2a0f8854cfbfa93fd0413762dce31d4a83decfa6/260428_Modus2026_27.pdf',
    proxyId: 'modus-nl',
    bytes: 565189,
    badge: 'PDF',
    DE: { title: 'Modus nationale Ligen & Cup 26/27', note: 'Spielmodus von NLA, NLB, 1. Liga und Mobiliar Volley Cup.' },
    EN: { title: 'Format of national leagues & cup 26/27', note: 'Format of NLA, NLB, 1st league and the Mobiliar Volley Cup.' },
  },
  {
    id: 'nummernNla',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/c/b/2/9/cb29fd3536c1c0988769f8868115b1f7d12fd671/Gruppen-_und_Nummernzuteilung_26_27_NLA.pdf',
    proxyId: 'nummern-nla',
    bytes: 160476,
    badge: 'PDF',
    DE: { title: 'Gruppen & Nummern NLA 26/27', note: 'Gruppen- und Nummernzuteilung der NLA-Teams.' },
    EN: { title: 'Groups & numbers NLA 26/27', note: 'Group and number allocation of the NLA teams.' },
  },
  {
    id: 'nummernNlb',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/a/f/6/a/af6a78a52946f9a5b549bd0a55640518136f2c51/Gruppen-_und_Nummernzuteilung_26_27_NLB.pdf',
    proxyId: 'nummern-nlb',
    bytes: 164096,
    badge: 'PDF',
    DE: { title: 'Gruppen & Nummern NLB 26/27', note: 'Gruppen- und Nummernzuteilung der NLB-Teams.' },
    EN: { title: 'Groups & numbers NLB 26/27', note: 'Group and number allocation of the NLB teams.' },
  },
  {
    id: 'nummern1lm',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/3/5/f/9/35f9d7ac6f4e77c2caf32b2caa73baac7a5292ca/Gruppen-_und_Nummernzuteilung_26_27_1LM.pdf',
    proxyId: 'nummern-1lm',
    bytes: 177269,
    badge: 'PDF',
    DE: { title: 'Gruppen & Nummern 1. Liga Männer', note: 'Gruppen- und Nummernzuteilung der 1. Liga Männer 26/27.' },
    EN: { title: 'Groups & numbers 1st league men', note: 'Group and number allocation of the 1st league men, 26/27.' },
  },
  {
    id: 'nummern1lf',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/e/3/c/0/e3c0e4298d4ce95fc6255fd0127fc90017f78727/Gruppen-_und_Nummernzuteilung_26_27_1LF.pdf',
    proxyId: 'nummern-1lf',
    bytes: 176246,
    badge: 'PDF',
    DE: { title: 'Gruppen & Nummern 1. Liga Frauen', note: 'Gruppen- und Nummernzuteilung der 1. Liga Frauen 26/27.' },
    EN: { title: 'Groups & numbers 1st league women', note: 'Group and number allocation of the 1st league women, 26/27.' },
  },
  {
    id: 'nsmSr',
    group: 'national',
    kind: 'pdf',
    href: 'https://www.volleyball.ch/_Resources/Persistent/0/b/4/5/0b45053e3bf940acf2e5ac02a33f42ae31be35d4/2027_NSM_Schiedsrichter.pdf',
    proxyId: 'nsm-sr',
    bytes: 396882,
    badge: 'PDF',
    DE: { title: 'Nachwuchs-SM: Anforderungen an SR', note: 'Welche SR an den Nachwuchs-Schweizermeisterschaften 26/27 pfeifen (Empfehlung der SSK).' },
    EN: { title: 'Youth championships: referee requirements', note: 'Which referees officiate at the 26/27 Swiss youth championships (SSK recommendation).' },
  },
  {
    id: 'spesen1l',
    group: 'national',
    kind: 'web',
    href: 'https://www.volleyball.ch/_Resources/Persistent/5/f/6/d/5f6df68a597dcb8443edf2b869cbea13b480ff1c/Spesenformular%20SR%201L%20%28MS%20und%20Cup%29%2019%2C20.xls',
    badge: 'Excel',
    DE: { title: 'Spesenformular SR 1. Liga', note: 'Für Meisterschaft und Mobiliar Volley Cup (Excel).' },
    EN: { title: 'Expense form, referee 1st league', note: 'For championship and Mobiliar Volley Cup (Excel).' },
  },
  {
    id: 'spesenNl',
    group: 'national',
    kind: 'web',
    href: 'https://www.volleyball.ch/_Resources/Persistent/7/5/c/9/75c9a339988afed2ccb22bdd7108d9bdc713279f/Spesenformular%20SR%20NLA%2C%20NLB%20%28Cup%29%2019%2C20.xls',
    badge: 'Excel',
    DE: { title: 'Spesenformular SR NLA/NLB (Cup)', note: 'Für Cupspiele in NLA und NLB (Excel).' },
    EN: { title: 'Expense form, referee NLA/NLB (cup)', note: 'For NLA and NLB cup matches (Excel).' },
  },
  {
    id: 'spesenLr',
    group: 'national',
    kind: 'web',
    href: 'https://www.volleyball.ch/_Resources/Persistent/f/2/f/3/f2f32ba8916e36806a63ee71a22e8e6bf74974b4/Spesenformular%20LR%20%28Cup%29%20neu%2019%2C20.xls',
    badge: 'Excel',
    DE: { title: 'Spesenformular LR (Cup)', note: 'Für Linienrichter im Mobiliar Volley Cup (Excel).' },
    EN: { title: 'Expense form, line judge (cup)', note: 'For line judges in the Mobiliar Volley Cup (Excel).' },
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
    id: 'srKonferenzProtokoll',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/b/9/f/4/b9f4416a5e856bfc857d537e59ce1ae2a702f8f4/Protokoll%20SR-Konferenz%202026.pdf',
    proxyId: 'sr-konferenz-2026-protokoll',
    bytes: 298112,
    badge: 'PDF',
    DE: { title: 'Protokoll SR-Konferenz 2026', note: 'Was am 4. September besprochen und beschlossen wurde.' },
    EN: { title: 'Referee conference 2026 minutes', note: 'What was discussed and decided on 4 September.' },
  },
  {
    id: 'srKonferenzEinladung',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/a/7/6/2/a7624fd0a3946a8332d35b719e961a80e94f6bc4/SR-Konferenz_Einladung%202026.pdf',
    proxyId: 'sr-konferenz-2026-einladung',
    bytes: 75551,
    badge: 'PDF',
    DE: { title: 'Einladung SR-Konferenz 2026', note: 'Die Einladung mit Traktanden zur Konferenz vom 4. September.' },
    EN: { title: 'Referee conference 2026 invitation', note: 'The invitation and agenda for the 4 September conference.' },
  },
  {
    id: 'gruppen2627',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/c/a/4/b/ca4b34674f5dc91ebcdcca168b0b46dee8fe3600/Gruppeneinteilung_2627_1.pdf',
    proxyId: 'gruppen-2627',
    bytes: 140141,
    badge: 'PDF',
    DE: { title: 'Liga- und Gruppeneinteilung 26/27', note: 'Alle regionalen Ligen und Gruppen der Saison, inkl. U23, mit Auf- und Abstieg.' },
    EN: { title: 'League and group allocation 26/27', note: 'Every regional league and group of the season, U23 included, with promotion and relegation.' },
  },
  {
    id: 'rasterFrauen',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/4/0/c/4/40c453ab37ce41c7e5cb957cc8e6f09e8ba5fe5b/Spielplanraster_Frauen_Saison26-27.pdf',
    proxyId: 'raster-frauen',
    bytes: 242064,
    badge: 'PDF',
    DE: { title: 'Spielplanraster Frauen 26/27', note: 'Die Spielrunden der regionalen Frauenligen.' },
    EN: { title: 'Fixture grid women 26/27', note: 'The rounds of the regional women’s leagues.' },
  },
  {
    id: 'rasterMaenner',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/2/0/a/8/20a82851e68aa7cb4783db258a9b2b0182689e85/Spielplanraster_M%C3%A4nner_Saison26-27.pdf',
    proxyId: 'raster-maenner',
    bytes: 229284,
    badge: 'PDF',
    DE: { title: 'Spielplanraster Männer 26/27', note: 'Die Spielrunden der regionalen Männerligen.' },
    EN: { title: 'Fixture grid men 26/27', note: 'The rounds of the regional men’s leagues.' },
  },
  {
    id: 'rasterU23',
    group: 'season',
    kind: 'pdf',
    href: 'https://www.svrz.ch/_Resources/Persistent/4/b/3/c/4b3ccf055019856f661cfa2fc47cda02f131ea03/Spielplanraster_U23_Saison26-27.pdf',
    proxyId: 'raster-u23',
    bytes: 224828,
    badge: 'PDF',
    DE: { title: 'Spielplanraster U23 26/27', note: 'Die Spielrunden der U23-Ligen.' },
    EN: { title: 'Fixture grid U23 26/27', note: 'The rounds of the U23 leagues.' },
  },
  {
    id: 'doppelEinsaetze',
    group: 'season',
    kind: 'web',
    href: 'https://www.svrz.ch/_Resources/Persistent/b/0/4/9/b0497b0c615e404892a7bbb216645220a3c8405a/SVRZ-MK_SpiPlaSitz-Vorgaben.xlsx',
    badge: 'Excel',
    DE: { title: 'Raster für doppelte SR-Einsätze', note: 'Die Vorgabe der MK, wie Spiele am Wochenende für Doppeleinsätze angesetzt werden (Excel).' },
    EN: { title: 'Grid for back-to-back referee duties', note: 'The championship commission’s rule for scheduling weekend matches so referees can do two (Excel).' },
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

// ---------------------------------------------------------------------------
// Enclosures
// ---------------------------------------------------------------------------
//
// A coach can send any of these along with the report: "you should read the
// official protocol" is a sentence that lands better with the protocol in the
// same mail. What qualifies is every PDF we can lay hands on ourselves — a file
// of ours under public/docs, or one the API proxies. The blank form is built in
// the browser, the web links and the contacts are not files, and a video is not
// something anybody wants in their inbox.

/** The documents a report can carry as enclosures, in catalogue order. */
export const ATTACHABLE_DOCS: UsefulDoc[] = USEFUL_DOCS.filter(
  (doc) => doc.kind === 'pdf' && !!(doc.path || doc.proxyId),
);

export function attachableDoc(id: string): UsefulDoc | undefined {
  return ATTACHABLE_DOCS.find((doc) => doc.id === id);
}

/**
 * How much may ride along, in bytes of PDF. The two rulebooks together are
 * 12.5 MB, and a mailbox that refuses anything over 10 MB — still common with
 * club and employer hosts — would bounce the whole report, grades and all,
 * over a document the referee can also open from the app. Ten megabytes lets
 * one rulebook through, or every sheet on the list at once; not both books.
 * The server measures the real bytes against the same number.
 */
export const ATTACH_BUDGET_BYTES = 10_000_000; // decimal, like the badges' "7 MB"

/** The catalogue's size for these ids — what the picker shows and adds up. */
export function attachedBytes(ids: readonly string[]): number {
  return ids.reduce((total, id) => total + (attachableDoc(id)?.bytes ?? 0), 0);
}

/**
 * A list of ids as anything may have stored it — a draft from an older build,
 * a file off a disk, a request body — reduced to the ids this build can
 * enclose, each once, in catalogue order. Anything else is dropped without a
 * word, the way an unknown criterion id is: the coach's choice among the
 * documents that still exist is preserved, and the ones that do not can no
 * longer be sent anyway.
 */
export function normalizeAttachedDocs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((v): v is string => typeof v === 'string'));
  return ATTACHABLE_DOCS.filter((doc) => wanted.has(doc.id)).map((doc) => doc.id);
}
