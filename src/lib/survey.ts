// Post-visit survey: the coachee's feedback ON the RC (the mirror image of the
// coaching feedback the RC writes about them). Ported from the SVRZ Google Form
// "Feedback zu RC-Besuch" so the answers live next to the coaching data instead
// of in a Google account, and so it can be German AND English.
//
// Two rules carried over from the original form:
//   - nothing is required ("Es gibt keine Pflichtfelder") — a half-filled
//     response is a valid response;
//   - only the RC chair reads it ("Einsicht hat nur die RC-Vorsitzende").
//
// The questions below are the DEFAULTS. Admins edit the live form in
// Admin → Fragebogen; what they save is stored in app_settings under
// `survey_config` and normalised through normalizeSurveyConfig() here, so the
// server, the survey page and the chair's response list all read one shape.

export type SurveyLang = 'DE' | 'EN';

// Answers are stored as the stable `value`, never the translated label, so a
// German and an English response to the same question aggregate as one.
export type SurveyChoice = { value: string; DE: string; EN: string };

// Admins pick a SCALE, not individual options. The values are what lands in the
// database, so letting them be edited would silently split every historical
// answer off from the new ones — an editable scale is a broken aggregate.
export type SurveyScaleId = 'yesno' | 'agreement' | 'cooperation';

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

export const SURVEY_SCALES: Record<SurveyScaleId, { DE: string; EN: string; options: SurveyChoice[] }> = {
  yesno: { DE: 'Ja / Nein', EN: 'Yes / No', options: YES_NO },
  agreement: { DE: 'Zustimmung (4 Stufen)', EN: 'Agreement (4 levels)', options: AGREEMENT },
  cooperation: { DE: 'Bewertung A–E', EN: 'Rating A–E', options: COOPERATION },
};
export const SURVEY_SCALE_IDS = Object.keys(SURVEY_SCALES) as SurveyScaleId[];

// Flat on purpose: this project's tsconfig has no `strict`, where a tagged
// union narrows badly. `scale` is meaningless for a text question and simply
// ignored — optionsOf() is the only thing that reads it.
export type SurveyQuestion = {
  id: string;
  kind: 'choice' | 'text';
  scale?: SurveyScaleId;
  DE: string;
  EN: string;
  // Shown small under the question — the original form's helper lines.
  hintDE?: string;
  hintEN?: string;
};

export function optionsOf(q: SurveyQuestion): SurveyChoice[] {
  if (q.kind !== 'choice') return [];
  return (SURVEY_SCALES[q.scale as SurveyScaleId] ?? SURVEY_SCALES.yesno).options;
}

// Questions 1–4 of the original form (name, date, match no., RC) are not here:
// the token resolves them server-side, so they arrive prefilled instead of
// being retyped — and never travel in the URL.
export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: 'punctual', kind: 'choice', scale: 'yesno',
    DE: 'Ist der RC pünktlich (H-30) erschienen?',
    EN: 'Did the RC arrive on time (H-30)?' },
  { id: 'benefited', kind: 'choice', scale: 'yesno',
    DE: 'Hast du vom Feedback profitiert?',
    EN: 'Did you benefit from the feedback?' },
  { id: 'answers', kind: 'choice', scale: 'agreement',
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
  { id: 'cooperation', kind: 'choice', scale: 'cooperation',
    DE: 'Wie hast du die Zusammenarbeit mit dem / der anderen Schiedsrichter:in empfunden?',
    EN: 'How did you find the cooperation with the other referee?' },
  { id: 'anything', kind: 'text',
    DE: 'Was du uns schon immer sagen wolltest:',
    EN: 'What you always wanted to tell us:' },
];

// Everything the page says outside the questions themselves. `eyebrow` and
// `intro` are the two an admin can rewrite (see SurveyConfig); the rest are
// mechanics — button labels, error states — and stay in code.
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

// ── The editable form ─────────────────────────────────────────────────
export type SurveyConfig = {
  eyebrow: { DE: string; EN: string };
  intro: { DE: string; EN: string };
  questions: SurveyQuestion[];
};

export const DEFAULT_SURVEY_CONFIG: SurveyConfig = {
  eyebrow: { DE: SURVEY_UI.eyebrow.DE, EN: SURVEY_UI.eyebrow.EN },
  intro: { DE: SURVEY_UI.intro.DE, EN: SURVEY_UI.intro.EN },
  questions: DEFAULT_SURVEY_QUESTIONS,
};

export const SURVEY_LIMITS = {
  questions: 40,   // the page is one long scroll; past this nobody finishes it
  label: 300,
  hint: 300,
  intro: 4000,
  id: 40,
};

// The id IS the database key an answer is stored under, so it is generated once
// and then frozen: renaming a question keeps its answers, and only deleting it
// orphans them. Kept to what the submit endpoint accepts.
const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function surveyQuestionId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'q$1')
    .slice(0, 30) || 'frage';
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_x`;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * One shape out, whatever went in. Runs on BOTH sides: the server validates a
 * save with it, and the page re-runs it on what it fetched — a stored config
 * predates every later edit to this file, so the page must never assume the
 * server's normalisation matches its own.
 *
 * Anything unusable is dropped rather than rejected: a config that fails to
 * parse must still leave the coachee with a form.
 */
export function normalizeSurveyConfig(raw: unknown): SurveyConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<SurveyConfig>;
  const pair = (v: unknown, fallback: { DE: string; EN: string }, max: number) => {
    const o = (v && typeof v === 'object' ? v : {}) as { DE?: unknown; EN?: unknown };
    const DE = str(o.DE, max);
    const EN = str(o.EN, max);
    // An empty half falls back to the other one rather than to the default: an
    // admin who rewrote the German and left the English blank meant the new
    // text, not the old one they had just replaced.
    return { DE: DE || EN || fallback.DE, EN: EN || DE || fallback.EN };
  };
  const seen = new Set<string>();
  const questions: SurveyQuestion[] = [];
  const list = Array.isArray(src.questions) ? src.questions : [];
  for (const item of list.slice(0, SURVEY_LIMITS.questions)) {
    const q = (item && typeof item === 'object' ? item : {}) as Partial<SurveyQuestion>;
    const id = str(q.id, SURVEY_LIMITS.id);
    // A duplicate id is two questions sharing one answer slot — the second
    // silently overwrites the first. Drop it instead.
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const DE = str(q.DE, SURVEY_LIMITS.label).trim();
    const EN = str(q.EN, SURVEY_LIMITS.label).trim();
    if (!DE && !EN) continue; // a question with no text is not a question
    const kind: SurveyQuestion['kind'] = q.kind === 'text' ? 'text' : 'choice';
    const hintDE = str(q.hintDE, SURVEY_LIMITS.hint).trim();
    const hintEN = str(q.hintEN, SURVEY_LIMITS.hint).trim();
    seen.add(id);
    const out: SurveyQuestion = { id, kind, DE: DE || EN, EN: EN || DE };
    if (kind === 'choice') out.scale = SURVEY_SCALES[q.scale as SurveyScaleId] ? q.scale as SurveyScaleId : 'yesno';
    if (hintDE || hintEN) { out.hintDE = hintDE || hintEN; out.hintEN = hintEN || hintDE; }
    questions.push(out);
  }
  return {
    eyebrow: pair(src.eyebrow, DEFAULT_SURVEY_CONFIG.eyebrow, SURVEY_LIMITS.label),
    intro: pair(src.intro, DEFAULT_SURVEY_CONFIG.intro, SURVEY_LIMITS.intro),
    // Nothing usable stored means a corrupt or empty record, not a deliberately
    // empty form — the API refuses to save one of those.
    questions: questions.length ? questions : DEFAULT_SURVEY_QUESTIONS,
  };
}

export function t(entry: { DE: string; EN: string }, lang: SurveyLang): string {
  return entry[lang];
}

/**
 * Both languages, German first — which is how the form is shown.
 *
 * Referees used to pick DE or EN, and the pick decided what a question said. A
 * referee whose German is shaky had to notice the toggle first, and the mail
 * that carries the link is German either way; anyone who did not notice simply
 * read a form they half understood. Showing both costs a line per question and
 * removes the choice from the reader entirely.
 *
 * A field filled in only one language returns that one — printing an empty
 * second line would look like something is missing.
 */
export function bothLangs(entry: { DE?: string; EN?: string } | undefined): { de: string; en: string } {
  const de = (entry?.DE || '').trim();
  const en = (entry?.EN || '').trim();
  // Identical in both (a name, a number, "OK") is one line, not two.
  if (!de || !en || de === en) return { de: de || en, en: '' };
  return { de, en };
}

export function questionLabel(q: SurveyQuestion, lang: SurveyLang): string {
  return lang === 'DE' ? q.DE : q.EN;
}

export function questionHint(q: SurveyQuestion, lang: SurveyLang): string | undefined {
  return lang === 'DE' ? q.hintDE : q.hintEN;
}

/** Reading a stored answer back: the label an admin/chair sees for its value. */
export function answerLabel(q: SurveyQuestion, value: string, lang: SurveyLang): string {
  if (q.kind !== 'choice') return value;
  return optionsOf(q).find((o) => o.value === value)?.[lang] ?? value;
}
