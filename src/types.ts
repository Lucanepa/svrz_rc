export interface MetaData {
  spielNr: string;
  liga: string;
  datum: string;
  ort: string;
  mannschaften: string;
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
}

export const LEGEND = {
  DE: "A: Beispielhaft | B: Mehrheitlich übertroffen | C: Vollumfänglich erreicht (Normalfall) | D: Teilweise erreicht | E: Deutlich nicht erreicht",
  EN: "A: Exemplary | B: Mostly exceeded | C: Fully achieved (normal case) | D: Partially achieved | E: Clearly not achieved"
};

export const SR_ZIEL_OPTIONS = ['4L', '3L', '2L', '1L', 'NL', 'Verbleib'];

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
    title: 'Match Preparation / Formalities',
    items: [
      { id: '1sr-prep-1', label: 'Punctuality, Correct Clothing, Complete Equipment', rating: '' },
      { id: '1sr-prep-2', label: 'Checks: Net, IDs, Match Balls, Uniforms, Match Sheet', rating: '' },
      { id: '1sr-prep-3', label: 'Briefing with Scorer and 2nd Referee (Division of Tasks)', rating: '' },
      { id: '1sr-prep-4', label: 'Adherence to Match Protocol, Toss', rating: '' },
    ],
  },
  {
    title: 'Referee Technique',
    items: [
      { id: '1sr-tech-1', label: 'Whistle (Volume, Distinction between Fault Whistle or Game Interruption)', rating: '' },
      { id: '1sr-tech-2', label: 'Hand Signals (Clarity, Correctness, Tempo)', rating: '' },
      { id: '1sr-tech-3', label: 'Speed of Reaction, Rhythm: Whistle – Gather Information - Decision', rating: '' },
      { id: '1sr-tech-4', label: 'Eye Technique (During Play, at Fault Whistle, Before Service, Before/After TO)', rating: '' },
      { id: '1sr-tech-5', label: 'Cooperation with 2nd Referee / Scorer', rating: '' },
    ],
  },
  {
    title: 'Interpretation and Application of the Rules',
    items: [
      { id: '1sr-rule-1', label: 'Assessment of Technical Ball Contact (Double, Held Ball): Appropriateness / Uniformity / Consistency', rating: '' },
      { id: '1sr-rule-2', label: 'Assessment of General Ball Contact (In/Out, Touch, Non Passé): Appropriateness / Uniformity / Consistency', rating: '' },
      { id: '1sr-rule-3', label: 'Assessment of Play at the Net (Block, Reaching Over, Penetration, Net Touch,...)', rating: '' },
      { id: '1sr-rule-4', label: 'Handling of Game Interruptions (Time Out, Substitutions, Injuries)', rating: '' },
      { id: '1sr-rule-5', label: 'Line-up / Positions (Basic Player Faults)', rating: '' },
    ],
  },
  {
    title: 'Overall Match Management',
    items: [
      { id: '1sr-lead-1', label: 'Interactions with Teams / Crisis Management', rating: '' },
      { id: '1sr-lead-2', label: 'Handling of Misconduct, Delays (Sanctions)', rating: '' },
      { id: '1sr-lead-3', label: 'General Handling of Teams / Order', rating: '' },
    ],
  },
  {
    title: 'Personality and Appearance',
    items: [
      { id: '1sr-pers-1', label: 'Presentation / Concentration / Sovereignty', rating: '' },
      { id: '1sr-pers-2', label: 'Feeling for the Game / Credibility / Acceptance', rating: '' },
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
      { id: '2sr-prep-1', label: 'Punctuality, Correct Clothing, Complete Equipment', rating: '' },
      { id: '2sr-prep-2', label: 'Checks: Net, IDs, Match Balls, Uniforms, Match Sheet', rating: '' },
      { id: '2sr-prep-3', label: 'Briefing with Scorer and 1st Referee (Division of Tasks)', rating: '' },
      { id: '2sr-prep-4', label: 'Adherence to Match Protocol, Toss', rating: '' },
    ],
  },
  {
    title: 'Referee Technique',
    items: [
      { id: '2sr-tech-1', label: 'Whistle (Volume, Distinction between Fault Whistle or Game Interruption)', rating: '' },
      { id: '2sr-tech-2', label: 'Hand Signals (Clarity, Correctness, Sequence/Order)', rating: '' },
      { id: '2sr-tech-3', label: 'Movement Paths (Lateral, Forward/Backward, Position at Fault Whistle, Basic Position)', rating: '' },
      { id: '2sr-tech-4', label: 'Speed of Reaction (at Whistle and Movement Paths)', rating: '' },
      { id: '2sr-tech-5', label: 'Eye Technique (During Play, at Fault Whistle, Between Whistle for Start and End of Rally)', rating: '' },
      { id: '2sr-tech-6', label: 'Support / Cooperation with 1st Referee', rating: '' },
      { id: '2sr-tech-7', label: 'Cooperation with Scorer', rating: '' },
    ],
  },
  {
    title: 'Interpretation and Application of the Rules',
    items: [
      { id: '2sr-rule-1', label: 'Line-up / Positions (Basic Player Faults)', rating: '' },
      { id: '2sr-rule-2', label: 'Assessment of Play at the Net (Net Touch, Penetration)', rating: '' },
      { id: '2sr-rule-3', label: 'Handling of Game Interruptions (Time Out, Substitutions)', rating: '' },
    ],
  },
  {
    title: 'Interactions with Teams / Crisis Management',
    items: [
      { id: '2sr-lead-1', label: 'Handling of Misconduct, Delays', rating: '' },
      { id: '2sr-lead-2', label: 'General Handling of Teams / Order', rating: '' },
    ],
  },
  {
    title: 'Personality and Appearance',
    items: [
      { id: '2sr-pers-1', label: 'Presentation / Concentration / Sovereignty', rating: '' },
      { id: '2sr-pers-2', label: 'Feeling for the Game / Credibility / Acceptance', rating: '' },
    ],
  },
];

export const INITIAL_DATA: FeedbackFormData = {
  role: '1. SR',
  lang: 'DE',
  meta: {
    spielNr: '',
    liga: '',
    datum: new Date().toISOString().split('T')[0],
    ort: '',
    mannschaften: '',
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
    srZiel: '',
    spielniveau: '',
    secondBesuch: '',
  },
};
