// Post-visit survey: the coachee's feedback ON the RC (the mirror image of the
// coaching feedback the RC writes about them). Ported from the SVRZ Google Form
// "Feedback zu RC-Besuch" so the answers live next to the coaching data instead
// of in a Google account, and so it can be German AND English.
//
// Two rules carried over from the original form:
//   - nothing is required ("Es gibt keine Pflichtfelder") — a half-filled
//     response is a valid response;
//   - only the RC chair reads it ("Einsicht hat nur die RC-Vorsitzende").

export type SurveyLang = 'DE' | 'EN';

// Answers are stored as the stable `value`, never the translated label, so a
// German and an English response to the same question aggregate as one.
export type SurveyChoice = { value: string; DE: string; EN: string };

export type SurveyQuestion = {
  id: string;
  DE: string;
  EN: string;
  // Shown small under the question — the original form's helper lines.
  hintDE?: string;
  hintEN?: string;
} & ({ kind: 'choice'; options: SurveyChoice[] } | { kind: 'text' });

const YES_NO: SurveyChoice[] = [
  { value: 'yes', DE: 'Ja', EN: 'Yes' },
  { value: 'no', DE: 'Nein', EN: 'No' },
];

const AGREEMENT: SurveyChoice[] = [
  { value: '4', DE: 'trifft voll und ganz zu', EN: 'strongly agree' },
  { value: '3', DE: 'trifft eher zu', EN: 'somewhat agree' },
  { value: '2', DE: 'trifft eher nicht zu', EN: 'somewhat disagree' },
  { value: '1', DE: 'trifft nicht zu', EN: 'do not agree' },
];

// Same A–E scale the coaching form itself uses — wording kept identical to
// LEGEND in types.ts so both halves of a visit are read on one scale.
const COOPERATION: SurveyChoice[] = [
  { value: 'A', DE: 'A: Beispielhaft', EN: 'A: Exemplary' },
  { value: 'B', DE: 'B: Mehrheitlich übertroffen', EN: 'B: Mostly exceeded' },
  { value: 'C', DE: 'C: Vollumfänglich erreicht (Normalfall)', EN: 'C: Fully achieved (normal case)' },
  { value: 'D', DE: 'D: Teilweise erreicht', EN: 'D: Partially achieved' },
  { value: 'E', DE: 'E: Deutlich nicht erreicht', EN: 'E: Clearly not achieved' },
];

// Questions 1–4 of the original form (name, date, match no., RC) are not here:
// the token resolves them server-side, so they arrive prefilled instead of
// being retyped — and never travel in the URL.
export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: 'punctual', kind: 'choice', options: YES_NO,
    DE: 'Ist der RC pünktlich (H-30) erschienen?',
    EN: 'Did the RC arrive on time (H-30)?' },
  { id: 'benefited', kind: 'choice', options: YES_NO,
    DE: 'Hast du vom Feedback profitiert?',
    EN: 'Did you benefit from the feedback?' },
  { id: 'answers', kind: 'choice', options: AGREEMENT,
    DE: 'Wurden deine Fragen kompetent beantwortet?',
    EN: 'Were your questions answered competently?' },
  { id: 'answers_explain', kind: 'text',
    DE: 'Erläuterung',
    EN: 'Explanation',
    hintDE: 'Wenn du die Frage oben mit «trifft nicht zu» beantwortet hast, bitte erläutern:',
    hintEN: 'If you answered "do not agree" above, please explain:' },
  { id: 'positive', kind: 'text',
    DE: 'Was war positiv?',
    EN: 'What was positive?' },
  { id: 'missed', kind: 'text',
    DE: 'Was hast du vermisst?',
    EN: 'What did you miss?' },
  { id: 'cooperation', kind: 'choice', options: COOPERATION,
    DE: 'Wie hast du die Zusammenarbeit mit dem / der anderen Schiedsrichter:in empfunden?',
    EN: 'How did you find the cooperation with the other referee?' },
  { id: 'anything', kind: 'text',
    DE: 'Was du uns schon immer sagen wolltest:',
    EN: 'What you always wanted to tell us:' },
];

// Everything the page says outside the questions themselves.
export const SURVEY_UI = {
  eyebrow: { DE: 'Feedback zu RC-Besuch', EN: 'Feedback on RC visit' },
  intro: {
    DE: 'Liebe/r SR!\n\nWir sind sehr bemüht, euch kompetent zu unterstützen und zu fördern. Damit dies auch gut gelingt, füll bitte nach einem RC-Besuch dieses Formular aus. Es ist freiwillig, es gibt keine Pflichtfelder. Einsicht hat nur die RC-Vorsitzende. Wenn Handlungsbedarf besteht, kann die RSK miteinbezogen werden.\n\nFür deine Mithilfe sind wir sehr dankbar — wir wünschen dir eine gute Saison!',
    EN: 'Dear referee,\n\nWe work hard to support you well, and we can only do that with your input. Please fill in this form after an RC visit. It is voluntary and nothing is required. Only the RC chair can see the responses; if something needs acting on, the RSK may be brought in.\n\nThank you for your help — have a great season!',
  },
  visitHeading: { DE: 'Dein Einsatz', EN: 'Your match' },
  fieldReferee: { DE: 'Schiedsrichter:in', EN: 'Referee' },
  fieldDate: { DE: 'Datum', EN: 'Date' },
  fieldMatchNo: { DE: 'Spiel-Nr.', EN: 'Match no.' },
  // "Referee Coach" in both languages — it is what SVRZ calls the role.
  fieldRc: { DE: 'Referee Coach', EN: 'Referee Coach' },
  anonTitle: { DE: 'Anonym absenden', EN: 'Submit anonymously' },
  anonHelp: {
    DE: 'Dein Name wird nicht mitgeschickt. Spiel, Datum und RC bleiben sichtbar — sonst liesse sich die Rückmeldung nicht zuordnen.',
    EN: 'Your name is not sent. Match, date and RC stay visible — otherwise the response could not be placed at all.',
  },
  anonOn: { DE: 'Wird anonym gesendet', EN: 'Will be sent anonymously' },
  submit: { DE: 'Absenden', EN: 'Submit' },
  thanksTitle: { DE: 'Danke für deine Rückmeldung!', EN: 'Thank you for your feedback!' },
  thanksBody: { DE: 'Du kannst diese Seite jetzt schliessen.', EN: 'You can close this page now.' },
  alreadyTitle: { DE: 'Bereits ausgefüllt', EN: 'Already submitted' },
  alreadyBody: {
    DE: 'Für diesen Einsatz wurde bereits eine Rückmeldung abgegeben.',
    EN: 'A response has already been submitted for this match.',
  },
  errorTitle: { DE: 'Link ungültig oder abgelaufen', EN: 'Invalid or expired link' },
  errorBody: {
    DE: 'Bitte verwende den Link aus deiner Feedback-E-Mail.',
    EN: 'Please use the link from your feedback email.',
  },
  saveFailed: { DE: 'Konnte nicht gespeichert werden. Bitte nochmals versuchen.', EN: 'Could not save. Please try again.' },
  optional: { DE: 'Alle Fragen sind freiwillig', EN: 'All questions are optional' },
} as const;

export function t(entry: { DE: string; EN: string }, lang: SurveyLang): string {
  return entry[lang];
}

export function questionLabel(q: SurveyQuestion, lang: SurveyLang): string {
  return lang === 'DE' ? q.DE : q.EN;
}

export function questionHint(q: SurveyQuestion, lang: SurveyLang): string | undefined {
  return lang === 'DE' ? q.hintDE : q.hintEN;
}
