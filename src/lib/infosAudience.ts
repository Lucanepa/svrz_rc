import type { UsefulDoc } from './usefulDocs';

/**
 * Who each document on the public /infos page is for, most useful first
 * (Luca, 2026-10-09): what a NEW referee needs for their first games, then
 * what every REGIONAL referee needs, then the rest — Swiss Volley's own
 * regulations and the national leagues and panel, which matter little to
 * someone whistling 3. Liga (LAS rules are the example he gave).
 *
 * Only the public page sorts by this. Inside the app the same documents keep
 * their topic grouping: the coaches use them for coaching, not as a referee
 * finding their way in.
 *
 * A plain table, not a field on UsefulDoc, because it is the seed of the
 * admin-editable folders that come next — the layout will move to the server
 * and this becomes its default. Every public document must be listed here:
 * e2e/infos-audience.spec.ts fails on one that is not, so adding a document
 * means deciding who it is for.
 */
export type InfosAudience = 'new' | 'regional' | 'all';

export const INFOS_AUDIENCES: Record<InfosAudience, { DE: { title: string; note: string }; EN: { title: string; note: string } }> = {
  new: {
    DE: { title: 'Neu als Schiedsrichter:in', note: 'Das Wichtigste für die ersten Spiele: Abläufe, Regeln, Ausbildung und wen du fragen kannst.' },
    EN: { title: 'New referees', note: 'The essentials for your first matches: procedures, rules, training and whom to ask.' },
  },
  regional: {
    DE: { title: 'Regionale Schiedsrichter:innen', note: 'Reglemente, Saison, Entschädigung und Weiterbildung in der SVRZ.' },
    EN: { title: 'Regional referees', note: 'Regulations, the season, pay and further training in the SVRZ.' },
  },
  all: {
    DE: { title: 'Alle Schiedsrichter:innen · nationale Stufe', note: 'Swiss Volley, nationale Ligen und Kader — vor allem für SR, die national pfeifen.' },
    EN: { title: 'All referees · national level', note: 'Swiss Volley, the national leagues and the panel — mostly for referees officiating nationally.' },
  },
};

export const INFOS_AUDIENCE_ORDER: InfosAudience[] = ['new', 'regional', 'all'];

export const INFOS_AUDIENCE_OF: Record<string, InfosAudience> = {
  // New referees: how a match runs, the rules, the first course, whom to ask.
  rcWesen: 'new',
  srTechnik: 'new',
  kurzSr: 'new',
  kurzSr2: 'new',
  vorNach: 'new',
  spielprotokollRegional: 'new',
  niveau: 'new',
  srOhneAusbildung: 'new',
  srN4: 'new',
  jsr: 'new',
  ruleChanges: 'new',
  zkRegel922: 'new',
  sanktionen: 'new',
  rulesDe: 'new',
  rulesEn: 'new',
  readvolley: 'new',
  koordination: 'new',
  coaching: 'new',
  ausbildung: 'new',

  // Regional referees: the SVRZ's own regulations, the season, pay, next steps.
  erGbo: 'regional',
  srN3: 'regional',
  lrWeiterbildung: 'regional',
  unparteiische: 'regional',
  row: 'regional',
  zueriCup: 'regional',
  zm: 'regional',
  rechtspflege: 'regional',
  geschaeftsreglement: 'regional',
  statuten: 'regional',
  nsmQuali: 'regional',
  beach: 'regional',
  mkiKleidung: 'regional',
  saisonbeginn: 'regional',
  srKonferenz: 'regional',
  srKonferenzProtokoll: 'regional',
  srKonferenzEinladung: 'regional',
  doppelspiele: 'regional',
  gbo: 'regional',
  datenerfassung: 'regional',
  gruppen2627: 'regional',
  rasterFrauen: 'regional',
  rasterMaenner: 'regional',
  rasterU23: 'regional',
  doppelEinsaetze: 'regional',
  srInfo: 'regional',
  rsk: 'regional',
  gsAdmin: 'regional',
  weiterbildung: 'regional',
  schreiber: 'regional',

  // Everyone, but mostly national: Swiss Volley's regulations, leagues, panel.
  spielprotokoll: 'all',
  volleyballreglement: 'all',
  vrMarkup: 'all',
  srReglementSv: 'all',
  las: 'all',
  svRechtspflege: 'all',
  svStatuten: 'all',
  svBeach: 'all',
  kaderWeisungen: 'all',
  kaderNiveaus: 'all',
  kaderFactsheet: 'all',
  kaderVertrauensperson: 'all',
  gameManagement: 'all',
  benchApp: 'all',
  escorerF: 'all',
  escorerM: 'all',
  hallenrapportNla: 'all',
  hallenrapportNlb: 'all',
  nlbEinBall: 'all',
  modusNl: 'all',
  nummernNla: 'all',
  nummernNlb: 'all',
  nummern1lm: 'all',
  nummern1lf: 'all',
  nsmSr: 'all',
  spesen1l: 'all',
  spesenNl: 'all',
  spesenLr: 'all',
};

/** A document nobody sorted yet lands last rather than vanishing. */
export function audienceOf(doc: UsefulDoc): InfosAudience {
  return INFOS_AUDIENCE_OF[doc.id] ?? 'all';
}
