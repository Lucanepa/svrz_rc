// Words for the statistics — the dashboard, the deck and the PDF read the
// same numbers and must call them the same thing. German is the commission's
// language; English follows the console's toggle.
import type { Lang } from './appTime';
import { seasonLabel } from './season';
import { groupLabel } from './coacheeGroup';
import { SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN } from '../types';
import type { StatRole } from './statistics';

export const STAT_STR = {
  DE: {
    tab: 'Statistik',
    title: 'Statistik',
    hint: 'Die Saison in Zahlen — aus den eingereichten Beobachtungen. Nur Zählungen und Durchschnitte; Bemerkungen bleiben auf dem Server.',
    season: 'Saison',
    all: 'alle',
    rc: 'Referee Coach',
    group: 'Gruppe',
    level: 'Niveau',
    role: 'Rolle',
    compare: 'Vergleich mit Vorsaison',
    export: 'Export',
    exportPptx: 'PowerPoint (.pptx)',
    exportPdf: 'PDF',
    exportHint: 'Foliensatz aus den Zahlen oben, mit den gesetzten Filtern.',
    optRcGrades: 'Folie „Noten pro Coach" (wer streng bewertet)',
    optLeagues: 'Folie „Ligen"',
    exporting: 'Wird erstellt …',
    exportFailed: 'Export fehlgeschlagen',
    loading: 'Wird geladen …',
    none: 'Keine Beobachtungen in dieser Saison.',
    nObs: (n: number) => `${n} Beob.`,
    tooFew: (n: number) => `n = ${n}`,
    prev: 'Vorsaison',
    deltaVs: (s: string) => `gegenüber ${s}`,
    // tiles
    observations: 'Beobachtungen',
    coacheesVisited: 'Coachees besucht',
    ofRoster: (n: number, total: number) => `von ${total}`,
    activeRcs: 'Aktive RC',
    pensum: 'Pensum',
    avgGrade: 'Ø Note',
    normalCase: 'C = Normalfall',
    sets: 'Sätze',
    games: (n: number) => `${n} Spiele`,
    points: 'Punkte',
    hours: (h: number) => `≈ ${h} h Halle`,
    words: 'Wörter',
    perObs: 'Ø pro Beob.',
    // blocks
    perMonth: 'Beobachtungen pro Monat',
    histogram: 'Notenverteilung',
    histogramHint: 'Jede vergebene Note, A+ bis E−',
    shareC: 'Anteil C',
    shareB: 'Anteil B oder besser',
    sections: 'Ø Note pro Abschnitt',
    criteria: 'Ø Note pro Kriterium',
    role1: '1. SR',
    role2: '2. SR',
    perRc: 'Pro Referee Coach',
    perGroup: 'Pro Gruppe',
    perLevel: 'Pro Niveau',
    perStufe: 'Pro Stufe',
    perLeague: 'Ligen',
    coverage: 'Abdeckung',
    coverageHint: 'Coachees nach Anzahl Besuche',
    visits: (k: string) => (k === '3+' ? '3+ Besuche' : k === '1' ? '1 Besuch' : `${k} Besuche`),
    outcomes: 'Beurteilungen',
    einstufung: 'Einstufung',
    motivation: 'Motivation',
    difficulty: 'Spielniveau',
    secondVisit: 'Zweiter Besuch',
    srGoal: 'SR-Ziel',
    gamesBlock: 'Spiele',
    setsPerGame: 'Sätze pro Spiel',
    deciders: 'Entscheidungssätze',
    longestGame: 'Längstes Spiel',
    hallsSeen: 'Hallen',
    teamsSeen: 'Teams',
    estHours: 'Stunden in der Halle (geschätzt)',
    writing: 'Schreiben',
    chars: 'Zeichen',
    wordsMedian: 'Median pro Beob.',
    longestRemark: 'Längste Beobachtung',
    pagesA4: 'A4-Seiten (≈ 500 Wörter)',
    filled: 'Blöcke ausgefüllt',
    highlights: 'Highlights',
    improvements: 'Verbesserungen',
    goals: 'Ziele',
    process: 'Prozess',
    filingMedian: 'Median bis Einreichung',
    days: (d: number) => (d === 1 ? '1 Tag' : `${d} Tage`),
    sameDay: 'Gleicher Tag',
    late: 'Nach 7+ Tagen',
    signedRef: 'Von SR unterschrieben',
    signedRc: 'Vom RC unterschrieben',
    language: 'Sprache',
    completeness: 'Kriterien bewertet',
    fun: 'Wussten Sie?',
    busiestDay: 'Meiste Beobachtungen an einem Tag',
    topHall: 'Meistbesuchte Halle',
    topCoachee: 'Meistbesuchter Coachee',
    topWriter: 'Meiste Wörter',
    firstLast: 'Erste / letzte Beobachtung',
    weekday: 'Wochentag',
    hour: 'Anspielzeit',
    goalCol: 'Pensum',
    planned: 'geplant',
    outstanding: 'offen',
    coacheesCol: 'Coachees',
    gamesCol: 'Spiele',
    setsCol: 'Sätze',
    wordsCol: 'Wörter',
    gradeCol: 'Ø Note',
    method: 'Zählregeln',
    methodLines: [
      'Saison = Spieldatum (Sept.–Apr.), nie das Einreichdatum. Testspiele ohne Coachee zählen nicht.',
      'Ein Spiel mit beiden SR beurteilt: zwei Beobachtungen, ein Spiel — Sätze und Punkte einmal.',
      'Noten auf der Skala E− = 1 … C = 8 … A+ = 15; ein Durchschnitt erst ab 3 Beobachtungen.',
      'Niveau und Gruppe wie auf dem Formular erfasst; ein Coachee in zwei Gruppen zählt in beiden.',
      'Wörter: Bemerkungen, Highlights, Verbesserungen und Ziele, ohne Formatierung.',
    ],
    stand: 'Stand',
    deckTitle: 'SR-Coaching — Statistik',
    deckSubtitle: (s: string) => `Saison ${s}`,
    deckNumbers: 'Die Saison in Zahlen',
    deckStrongWeak: 'Stärkste und schwächste Kriterien',
    deckStrong: 'Stärkste',
    deckWeak: 'Schwächste',
    deckLevelGroup: 'Noten nach Niveau und Gruppe',
    deckCompare: 'Im Vergleich zur Vorsaison',
    deckRcGrades: 'Noten pro Coach',
    deckRcGradesHint: 'Durchschnitt der vergebenen Noten — intern.',
    filtersLine: 'Filter',
    generated: 'Erstellt mit dem SR-Coaching-Tool',
  },
  EN: {
    tab: 'Statistics',
    title: 'Statistics',
    hint: 'The season in numbers, from the filed observations. Counts and averages only; the remarks stay on the server.',
    season: 'Season',
    all: 'all',
    rc: 'Referee Coach',
    group: 'Group',
    level: 'Level',
    role: 'Role',
    compare: 'Compare with previous season',
    export: 'Export',
    exportPptx: 'PowerPoint (.pptx)',
    exportPdf: 'PDF',
    exportHint: 'A slide deck from the numbers above, with the filters set.',
    optRcGrades: 'Slide "Grades per coach" (who grades strictly)',
    optLeagues: 'Slide "Leagues"',
    exporting: 'Building …',
    exportFailed: 'Export failed',
    loading: 'Loading …',
    none: 'No observations in this season.',
    nObs: (n: number) => `${n} obs.`,
    tooFew: (n: number) => `n = ${n}`,
    prev: 'Previous season',
    deltaVs: (s: string) => `vs. ${s}`,
    observations: 'Observations',
    coacheesVisited: 'Coachees visited',
    ofRoster: (n: number, total: number) => `of ${total}`,
    activeRcs: 'Active RCs',
    pensum: 'Goal',
    avgGrade: 'Avg. grade',
    normalCase: 'C = normal case',
    sets: 'Sets',
    games: (n: number) => `${n} games`,
    points: 'Points',
    hours: (h: number) => `≈ ${h} h in the hall`,
    words: 'Words',
    perObs: 'avg. per obs.',
    perMonth: 'Observations per month',
    histogram: 'Grade distribution',
    histogramHint: 'Every rating given, A+ to E−',
    shareC: 'Share of C',
    shareB: 'Share B or better',
    sections: 'Avg. grade per section',
    criteria: 'Avg. grade per criterion',
    role1: '1st referee',
    role2: '2nd referee',
    perRc: 'Per Referee Coach',
    perGroup: 'Per group',
    perLevel: 'Per level',
    perStufe: 'Per Stufe',
    perLeague: 'Leagues',
    coverage: 'Coverage',
    coverageHint: 'Coachees by number of visits',
    visits: (k: string) => (k === '3+' ? '3+ visits' : k === '1' ? '1 visit' : `${k} visits`),
    outcomes: 'Assessments',
    einstufung: 'Classification',
    motivation: 'Motivation',
    difficulty: 'Game difficulty',
    secondVisit: 'Second visit',
    srGoal: 'Referee goal',
    gamesBlock: 'Games',
    setsPerGame: 'Sets per game',
    deciders: 'Deciding sets',
    longestGame: 'Longest game',
    hallsSeen: 'Halls',
    teamsSeen: 'Teams',
    estHours: 'Hours in the hall (estimated)',
    writing: 'Writing',
    chars: 'Characters',
    wordsMedian: 'Median per obs.',
    longestRemark: 'Longest observation',
    pagesA4: 'A4 pages (≈ 500 words)',
    filled: 'Blocks filled',
    highlights: 'Highlights',
    improvements: 'Improvements',
    goals: 'Goals',
    process: 'Process',
    filingMedian: 'Median until filed',
    days: (d: number) => (d === 1 ? '1 day' : `${d} days`),
    sameDay: 'Same day',
    late: 'After 7+ days',
    signedRef: 'Signed by referee',
    signedRc: 'Signed by RC',
    language: 'Language',
    completeness: 'Criteria rated',
    fun: 'Did you know?',
    busiestDay: 'Most observations on one day',
    topHall: 'Most-visited hall',
    topCoachee: 'Most-observed coachee',
    topWriter: 'Most words',
    firstLast: 'First / last observation',
    weekday: 'Weekday',
    hour: 'Kick-off',
    goalCol: 'Goal',
    planned: 'planned',
    outstanding: 'open',
    coacheesCol: 'Coachees',
    gamesCol: 'Games',
    setsCol: 'Sets',
    wordsCol: 'Words',
    gradeCol: 'Avg. grade',
    method: 'Counting rules',
    methodLines: [
      'Season = game date (Sept–Apr), never the filing date. Test games without a coachee do not count.',
      'A game with both referees assessed: two observations, one game — sets and points counted once.',
      'Grades on the scale E− = 1 … C = 8 … A+ = 15; an average only from 3 observations.',
      'Level and group as recorded on the form; a coachee in two groups counts in both.',
      'Words: remarks, highlights, improvements and goals, formatting stripped.',
    ],
    stand: 'As of',
    deckTitle: 'Referee Coaching — Statistics',
    deckSubtitle: (s: string) => `Season ${s}`,
    deckNumbers: 'The season in numbers',
    deckStrongWeak: 'Strongest and weakest criteria',
    deckStrong: 'Strongest',
    deckWeak: 'Weakest',
    deckLevelGroup: 'Grades by level and group',
    deckCompare: 'Compared with the previous season',
    deckRcGrades: 'Grades per coach',
    deckRcGradesHint: 'Average of the grades given — internal.',
    filtersLine: 'Filters',
    generated: 'Generated with the SR-Coaching tool',
  },
};
export type StatStrings = typeof STAT_STR['DE'];
export const statStrings = (lang: Lang): StatStrings => STAT_STR[lang];

// ── Labels for keys the server sends ─────────────────────────────────────────
const MONTHS = {
  DE: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  EN: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
export function monthLabel(key: string, lang: Lang): string {
  const m = Number(key.split('-')[1]);
  return MONTHS[lang][m - 1] ?? key;
}
const WEEKDAYS = { DE: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], EN: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
export function weekdayKeyLabel(key: string, lang: Lang): string {
  return WEEKDAYS[lang][Number(key) - 1] ?? key;
}
export function roleLabel(role: string, lang: Lang): string {
  return role === '2SR' ? STAT_STR[lang].role2 : STAT_STR[lang].role1;
}
export function categoryLabel(key: string, lang: Lang): string {
  const de = lang === 'DE';
  if (key === 'H') return de ? 'Herren' : 'Men';
  if (key === 'D') return de ? 'Damen' : 'Women';
  if (key === 'J') return 'U23';
  return de ? 'Übrige (Cup, Nachwuchs)' : 'Other (cup, youth)';
}
export function divisionLabel(key: string, lang: Lang): string {
  if (key === 'NL') return lang === 'DE' ? 'Nationalliga' : 'National league';
  if (/^[1-5]$/.test(key)) return lang === 'DE' ? `${key}. Liga` : `${key}. league`;
  return lang === 'DE' ? 'Übrige' : 'Other';
}
export function groupKeyLabel(key: string, lang: Lang): string {
  if (!key) return lang === 'DE' ? 'ohne Gruppe' : 'no group';
  return groupLabel(key, lang) || key;
}
export function levelKeyLabel(key: string, lang: Lang): string {
  return key || (lang === 'DE' ? 'ohne Niveau' : 'no level');
}

export const OUTCOME_LABELS = {
  einstufung: {
    DE: { up: 'Beförderung', check: 'Gleich', down: 'Rückstufung' },
    EN: { up: 'Promotion', check: 'Same level', down: 'Relegation' },
  },
  motivation: {
    DE: { up: 'Hoch', check: 'In Ordnung', down: 'Tief' },
    EN: { up: 'High', check: 'In order', down: 'Low' },
  },
  spielniveau: {
    DE: { leicht: 'Leicht', normal: 'Normal', schwierig: 'Schwierig' },
    EN: { leicht: 'Easy', normal: 'Normal', schwierig: 'Hard' },
  },
  secondBesuch: {
    DE: { Y: 'Ja', N: 'Nein' },
    EN: { Y: 'Yes', N: 'No' },
  },
} as const;
export const OUTCOME_ORDER = {
  einstufung: ['up', 'check', 'down'],
  motivation: ['up', 'check', 'down'],
  spielniveau: ['leicht', 'normal', 'schwierig'],
  secondBesuch: ['Y', 'N'],
} as const;
export function outcomeLabel(kind: keyof typeof OUTCOME_LABELS, key: string, lang: Lang): string {
  const table = OUTCOME_LABELS[kind][lang] as Record<string, string>;
  return table[key] ?? key;
}
export function srGoalLabel(key: string, lang: Lang): string {
  if (key === 'Verbleib' || key === 'same_level') return lang === 'DE' ? 'Verbleib' : 'Remain';
  return key;
}

// ── The forms' own words for their sections and criteria ─────────────────────
function sectionsFor(role: StatRole, lang: Lang) {
  if (role === '2SR') return lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN;
  return lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN;
}
export function sectionTitle(role: StatRole, index: number, lang: Lang): string {
  return sectionsFor(role, lang)[index]?.title ?? `${index + 1}`;
}
export function criterionLabel(role: StatRole, id: string, lang: Lang): string {
  for (const section of sectionsFor(role, lang)) {
    const item = section.items.find((it) => it.id === id);
    if (item) return item.label;
  }
  return id;
}
export function sectionCount(role: StatRole): number {
  return sectionsFor(role, 'DE').length;
}

export const seasonName = seasonLabel;
