export interface MetaData {
  spielNr: string;
  liga: string;
  datum: string;
  ort: string;
  mannschaften: string;
  ergebnis: string;
  srName: string;
  srNiveau: string;
  rc: string;
  gruppe: string;
}

export interface AssessmentItem {
  id: string;
  label: string;
  rating: string;
}

export interface AssessmentSection {
  title: string;
  items: AssessmentItem[];
}

export interface Results {
  motivation: 'up' | 'check' | 'down' | '';
  einstufung: 'up' | 'check' | 'down' | '';
  bemerkungen: string;
  highlights?: string;
  improvements?: string;
  goals?: string;
  srZiel: string;
  spielniveau: 'leicht' | 'normal' | 'schwierig' | '';
  secondBesuch: 'Y' | 'N' | '';
}

export interface FeedbackFormData {
  role: '1. SR' | '2. SR';
  lang: 'DE' | 'EN';
  meta: MetaData;
  sections: AssessmentSection[];
  results: Results;
  signature?: string;
}

export interface EligibleGame {
  id: string;
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  firstReferee: string;
  secondReferee: string;
  assignedRc?: string;
  feedbackClosedRoles?: string[];
  isRdGame?: boolean;
  isLdGame?: boolean;
  isRsvGame?: boolean;
  // "We want this one observed" highlight: set by an admin (see starred_games)
  // or derived from VolleyManager's RD/RSV markings.
  starred?: boolean;
  // True when the flag comes from VolleyManager — it can't be removed here.
  vmFlagged?: boolean;
  maps_url?: string;
  game_result?: string;
}

export const LEGEND = {
  DE: "A: Beispielhaft | B: Mehrheitlich übertroffen | C: Vollumfänglich erreicht (Normalfall) | D: Teilweise erreicht | E: Deutlich nicht erreicht",
  EN: "A: Exemplary | B: Mostly exceeded | C: Fully achieved (normal case) | D: Partially achieved | E: Clearly not achieved"
};

export const SR_ZIEL_OPTIONS = ['4L', '3L', '2L', '1L', 'NL', 'Verbleib'];

// Season goal: how many observations a full mandate owes. The admin console can
// change the number; this is what applies until it does.
export const OBSERVATION_GOAL = 10;

// An RC on a half mandate owes half as many (10 → 5). Rounded up, so an odd
// season goal never leaves a half mandate below half.
export type RcMandate = 'full' | 'half';
export type RcMandateMap = Record<string, RcMandate>;
export const goalForMandate = (fullGoal: number, mandate?: RcMandate): number =>
  mandate === 'half' ? Math.ceil(fullGoal / 2) : fullGoal;

export const SECTIONS_1SR_DE: AssessmentSection[] = [
  {
    title: 'Spielvorbereitung / Formalitäten',
    items: [
      { id: '1sr-prep-1', label: 'Pünktlichkeit, korrekte Kleidung, vollständige Ausrüstung', rating: '' },
      { id: '1sr-prep-2', label: 'Kontrollen: Netz, Ausweise, Matchbälle, Dress, Matchblatt', rating: '' },
      { id: '1sr-prep-3', label: 'Absprache mit Schreiber und 2. SR (Aufgabenteilung)', rating: '' },
      { id: '1sr-prep-4', label: 'Einhaltung Spielprotokoll, Auslosung', rating: '' },
    ],
  },
  {
    title: 'SR-Technik',
    items: [
      { id: '1sr-tech-1', label: 'Pfiff (Lautstärke, Unterscheidung Fehlerpfiff oder Spielunterbrechung)', rating: '' },
      { id: '1sr-tech-2', label: 'Handzeichen (Deutlichkeit, Korrektheit, Tempo)', rating: '' },
      { id: '1sr-tech-3', label: 'Reaktionsschnelligkeit, Rhythmus: Pfiff – Informationen einholen - Entscheidung', rating: '' },
      { id: '1sr-tech-4', label: 'Blicktechnik (während Spiel, bei Fehlerpfiff, vor Service, vor/nach TO)', rating: '' },
      { id: '1sr-tech-5', label: 'Zusammenarbeit mit 2. SR / Schreiber', rating: '' },
    ],
  },
  {
    title: 'Auslegung und Anwendung der Regeln',
    items: [
      { id: '1sr-rule-1', label: 'Beurteilung technischer Ballkontakt (Doppel, gehaltener Ball): Angemessenheit / Einheitlichkeit / Konstanz', rating: '' },
      { id: '1sr-rule-2', label: 'Beurteilung allgemeiner Ballkontakt (in/out, Touché, non passé): Angemessenheit / Einheitlichkeit / Konstanz', rating: '' },
      { id: '1sr-rule-3', label: 'Beurteilung des Spiels am Netz (Block, Übergreifen, Übertritt, Netzberührung,...)', rating: '' },
      { id: '1sr-rule-4', label: 'Handhabung von Spielunterbrechungen (Time out, Auswechslungen, Verletzungen)', rating: '' },
      { id: '1sr-rule-5', label: 'Aufstellung / Positionen (Grundspielerfehler)', rating: '' },
    ],
  },
  {
    title: 'Gesamtleitung des Spiels',
    items: [
      { id: '1sr-lead-1', label: 'Interaktionen mit Mannschaften / Krisenmanagement', rating: '' },
      { id: '1sr-lead-2', label: 'Behandlung von Unkorrektheiten, Verzögerungen (Sanktionen)', rating: '' },
      { id: '1sr-lead-3', label: 'Allgemeiner Umgang mit den Mannschaften / Ordnung', rating: '' },
    ],
  },
  {
    title: 'Persönlichkeit und Auftreten',
    items: [
      { id: '1sr-pers-1', label: 'Präsentation / Konzentration / Souveränität', rating: '' },
      { id: '1sr-pers-2', label: 'Gefühl für das Spiel / Glaubwürdigkeit / Akzeptanz', rating: '' },
    ],
  },
];

export const SECTIONS_1SR_EN: AssessmentSection[] = [
  {
    title: 'Match preparation / formalities',
    items: [
      { id: '1sr-prep-1', label: 'Punctuality, correct clothing, complete equipment', rating: '' },
      { id: '1sr-prep-2', label: 'Checks: net, IDs, match balls, uniforms, match sheet', rating: '' },
      { id: '1sr-prep-3', label: 'Briefing with scorer and 2nd referee (division of tasks)', rating: '' },
      { id: '1sr-prep-4', label: 'Adherence to match protocol, coin toss', rating: '' },
    ],
  },
  {
    title: 'Referee Technique',
    items: [
      { id: '1sr-tech-1', label: 'Whistle (Volume, distinction between fault whistle or management whistle)', rating: '' },
      { id: '1sr-tech-2', label: 'Hand signals (Clarity, correctness, timing)', rating: '' },
      { id: '1sr-tech-3', label: 'Speed of reaction, rhythm: whistle – gather information – decision', rating: '' },
      { id: '1sr-tech-4', label: 'Eye technique (During play, at fault whistle, before service, before/after TO)', rating: '' },
      { id: '1sr-tech-5', label: 'Cooperation with 2nd referee / scorer', rating: '' },
    ], 
  },
  {
    title: 'Application of the Rules',
    items: [
      { id: '1sr-rule-1', label: 'Assessment of technical ball contact (double, held ball): appropriateness / uniformity / consistency', rating: '' },
      { id: '1sr-rule-2', label: 'Assessment of general ball contact (in/out, touch, non passé): appropriateness / uniformity / consistency', rating: '' },
      { id: '1sr-rule-3', label: 'Assessment of play at the net (block, reaching over, penetration, net touch,...)', rating: '' },
      { id: '1sr-rule-4', label: 'Handling of game interruptions (time out, substitutions, injuries)', rating: '' },
      { id: '1sr-rule-5', label: 'Line-up / positions (positional/rotational faults)', rating: '' },
    ],
  },
  {
    title: 'Overall game management',
    items: [
      { id: '1sr-lead-1', label: 'Interactions with teams / crisis management', rating: '' },
      { id: '1sr-lead-2', label: 'Handling of misconduct, delays (sanctions)', rating: '' },
      { id: '1sr-lead-3', label: 'General handling of teams / order', rating: '' },
    ],
  },
  {
    title: 'Personality and Appearance',
    items: [
      { id: '1sr-pers-1', label: 'Presentation / concentration / authority', rating: '' },
      { id: '1sr-pers-2', label: 'Feeling for the game / credibility / acceptance', rating: '' },
    ],
  },
];

export const SECTIONS_2SR_DE: AssessmentSection[] = [
  {
    title: 'Spielvorbereitung / Formalitäten',
    items: [
      { id: '2sr-prep-1', label: 'Pünktlichkeit, korrekte Kleidung, vollständige Ausrüstung', rating: '' },
      { id: '2sr-prep-2', label: 'Kontrollen: Netz, Ausweise, Matchbälle, Dress, Matchblatt', rating: '' },
      { id: '2sr-prep-3', label: 'Absprache mit Schreiber und 1. SR (Aufgabenteilung)', rating: '' },
      { id: '2sr-prep-4', label: 'Einhaltung Spielprotokoll, Auslosung', rating: '' },
    ],
  },
  {
    title: 'SR-Technik',
    items: [
      { id: '2sr-tech-1', label: 'Pfiff (Lautstärke, Unterscheidung Fehlerpfiff oder Spielunterbrechung)', rating: '' },
      { id: '2sr-tech-2', label: 'Handzeichen (Deutlichkeit, Korrektheit, Ablauf/Reihenfolge)', rating: '' },
      { id: '2sr-tech-3', label: 'Laufwege (seitlich, vor/zurück, Position bei Fehlerpfiff, Grundposition)', rating: '' },
      { id: '2sr-tech-4', label: 'Reaktionsschnelligkeit (bei Pfiff und Laufwegen)', rating: '' },
      { id: '2sr-tech-5', label: 'Blicktechnik (während Spiel, bei Fehlerpfiff, zwischen Ab- und Anpfiff)', rating: '' },
      { id: '2sr-tech-6', label: 'Unterstützung / Zusammenarbeit mit 1. SR', rating: '' },
      { id: '2sr-tech-7', label: 'Zusammenarbeit mit Schreiber', rating: '' },
    ],
  },
  {
    title: 'Auslegung und Anwendung der Regeln',
    items: [
      { id: '2sr-rule-1', label: 'Aufstellung / Positionen (Grundspielerfehler)', rating: '' },
      { id: '2sr-rule-2', label: 'Beurteilung des Spiels am Netz (Netzberührung, Übertritt)', rating: '' },
      { id: '2sr-rule-3', label: 'Handhabung von Spielunterbrechungen (Time out, Auswechslungen)', rating: '' },
    ],
  },
  {
    title: 'Interaktionen mit Mannschaften / Krisenmanagement',
    items: [
      { id: '2sr-lead-1', label: 'Behandlung von Unkorrektheiten, Verzögerungen', rating: '' },
      { id: '2sr-lead-2', label: 'Allgemeiner Umgang mit den Mannschaften / Ordnung', rating: '' },
    ],
  },
  {
    title: 'Persönlichkeit und Auftreten',
    items: [
      { id: '2sr-pers-1', label: 'Präsentation / Konzentration / Souveränität', rating: '' },
      { id: '2sr-pers-2', label: 'Gefühl für das Spiel / Glaubwürdigkeit / Akzeptanz', rating: '' },
    ],
  },
];

export const SECTIONS_2SR_EN: AssessmentSection[] = [
  {
    title: 'Match Preparation / Formalities',
    items: [
      { id: '2sr-prep-1', label: 'Punctuality, correct clothing, complete equipment', rating: '' },
      { id: '2sr-prep-2', label: 'Checks: net, IDs, match balls, uniforms, match sheet', rating: '' },
      { id: '2sr-prep-3', label: 'Briefing with scorer and 1st referee (division of tasks)', rating: '' },
      { id: '2sr-prep-4', label: 'Adherence to match protocol, coin toss', rating: '' },
    ],
  },
  {
    title: 'Referee Technique',
    items: [
      { id: '2sr-tech-1', label: 'Whistle (Volume, distinction between fault whistle or management whistle)', rating: '' },
      { id: '2sr-tech-2', label: 'Hand signals (Clarity, correctness, timing)', rating: '' },
      { id: '2sr-tech-3', label: 'Movement paths (lateral, forward/backward, position at fault whistle, basic position)', rating: '' },
      { id: '2sr-tech-4', label: 'Speed of reaction (at whistle and movement paths)', rating: '' },
      { id: '2sr-tech-5', label: 'Eye technique (During play, at fault whistle, between whistle for start and end of rally)', rating: '' },
      { id: '2sr-tech-6', label: 'Support / cooperation with 1st referee', rating: '' },
      { id: '2sr-tech-7', label: 'Cooperation with scorer', rating: '' },
    ],
  },
  {
    title: 'Interpretation and Application of the Rules',
    items: [
      { id: '2sr-rule-1', label: 'Line-up / positions (positional/rotational faults)', rating: '' },
      { id: '2sr-rule-2', label: 'Assessment of play at the net (net touch, penetration)', rating: '' },
      { id: '2sr-rule-3', label: 'Handling of game interruptions (time out, substitutions)', rating: '' },
    ],
  },
  {
    title: 'Interactions with teams / crisis management',
    items: [
      { id: '2sr-lead-1', label: 'Handling of misconduct, delays', rating: '' },
      { id: '2sr-lead-2', label: 'General handling of teams / order', rating: '' },
    ],
  },
  {
    title: 'Personality and Appearance',
    items: [
      { id: '2sr-pers-1', label: 'Presentation / concentration / authority', rating: '' },
      { id: '2sr-pers-2', label: 'Feeling for the game / credibility / acceptance', rating: '' },
    ],
  },
];

export interface RcOverviewEntry {
  id: string;
  fullName: string;
  done: number;
  outstanding: number;
  planned: number;
}

export interface rcCoachSummaryFeedback {
  gameDate: string;
  league: string;
  teams: string;
  role: string;
  submittedAt: string;
}

export interface rcCoachSummaryGame {
  gameId: string;
  gameDate: string;
  league: string;
  teams: string;
  refereeName: string;
  /** Assigned to the coach, but no referee on it is a coachee — so no
   *  observation can be filed and the row is not clickable. */
  noCoachee?: boolean;
}

export interface rcCoachSummary {
  coacheeName: string;
  coacheeId: string;
  doneFeedbacks: rcCoachSummaryFeedback[];
  outstandingGames: rcCoachSummaryGame[];
  plannedGames: rcCoachSummaryGame[];
}

export const INITIAL_DATA: FeedbackFormData = {
  role: '1. SR',
  lang: 'DE',
  meta: {
    spielNr: '',
    liga: '',
    datum: new Date().toISOString().split('T')[0],
    ort: '',
    mannschaften: '',
    ergebnis: '',
    srName: '',
    srNiveau: '',
    rc: '',
    gruppe: '',
  },
  sections: SECTIONS_1SR_DE,
  results: {
    motivation: '',
    einstufung: '',
    bemerkungen: '',
    highlights: '',
    improvements: '',
    goals: '',
    srZiel: '',
    spielniveau: '',
    secondBesuch: '',
  },
  signature: '',
};
