// What the Infoschreiben says about a field, next to the field.
//
// The regulation answers questions the form itself cannot: who fills in the
// Motivation, what "Einstufung" is an opinion about, why a Neu-SR's form may be
// half empty. All of it lived in a Word document that a coach would have to go
// and find, mid-match, on a phone. These are the same answers, one tap away.
//
// `ref` is the section each text comes from and is shown with it: a coach who
// wants the full wording then knows exactly where to look, and anyone updating
// the Infoschreiben can find every place the app quotes it.

export type InfoHintId =
  | 'scale'
  | 'matchLevel'
  | 'motivation'
  | 'rating'
  | 'secondVisit'
  | 'refGoal'
  | 'goal'
  | 'srGame';

/** `ref` is the Infoschreiben section quoted; '' for a hint about the app
 *  itself, which quotes nothing. */
export type InfoHint = { ref: string; DE: string; EN: string };

export const INFO_HINTS: Record<InfoHintId, InfoHint> = {
  scale: {
    ref: '4.4.1',
    DE: 'A: beispielhaft · B: mehrheitlich übertroffen · C: vollumfänglich erreicht (Normalfall) · D: teilweise erreicht · E: deutlich nicht erreicht.\n\n'
      + 'Die Kriterien werden je nach Gruppe anders gewichtet: bei Neu-SR zählen Pfiff, Reaktionsschnelligkeit, Rhythmus, Zeichengebung und das Erkennen von in/out und Touché; Aufstellungs- und Grundspielerfehler sind sekundär. Bei Beförderungswunsch wiegt «Auslegung und Anwendung der Regeln» deutlich schwerer.\n\n'
      + 'Das Feedback ist immer positiv zu formulieren und soll zeigen, wie sich etwas verbessern lässt.',
    EN: 'A: exemplary · B: mostly exceeded · C: fully met (the normal case) · D: partly met · E: clearly not met.\n\n'
      + 'The criteria carry different weight per group: for new referees it is the whistle, reaction speed, rhythm, signalling and reading in/out and touches that count, while rotation and positional faults are secondary. For a referee up for promotion, "interpretation and application of the rules" weighs much more heavily.\n\n'
      + 'Feedback is always to be phrased positively, and should show how to improve.',
  },
  matchLevel: {
    ref: '4.4',
    DE: 'Wie anspruchsvoll das Spiel für die Schiedsrichter war: «leicht», «normal» oder «schwierig». Das ist die Einordnung des Spiels, nicht der Leistung.',
    EN: 'How demanding the match was for the referees: easy, normal or difficult. This rates the match, not the performance.',
  },
  motivation: {
    ref: '4.4',
    DE: 'Die Motivation füllt der Schiedsrichter selbst aus — nicht der RC.',
    EN: 'The referee fills this in themselves — not the coach.',
  },
  rating: {
    ref: '4.4',
    DE: 'Die Einstufung ist die Einschätzung des RC, in Absprache mit dem Schiedsrichter.',
    EN: "The coach's own assessment, agreed with the referee.",
  },
  secondVisit: {
    ref: '4.3',
    DE: 'Ob gegen Saisonende ein zweiter Besuch nötig ist, wird mit dem Schiedsrichter abgesprochen und hier eingetragen.',
    EN: 'Whether a second visit towards the end of the season is needed is agreed with the referee and recorded here.',
  },
  refGoal: {
    ref: '4.4.3 / 4.4.8',
    DE: 'Das Ziel, das der Schiedsrichter selbst verfolgt. Mit ihm besprechen — besonders bei Neu-SR im zweiten Jahr und bei Schiedsrichtern, die seit mindestens zwei Jahren nicht besucht wurden.',
    EN: "The referee's own goal. To be discussed with them — especially with second-year new referees and with anyone not visited for two years or more.",
  },
  goal: {
    ref: '6.2',
    DE: 'Ein Pflichtmandat sind rund 10 Spiele pro Saison. Vergütet werden maximal 12 Spiele pro RC — mehr coachen ist möglich, wird aber nicht abgerechnet.',
    EN: 'A full mandate is around 10 matches a season. At most 12 per coach are reimbursed — coaching more is possible but is not claimed.',
  },
  srGame: {
    ref: '4.4.10',
    DE: 'Pfeift ein RC mit einem Schiedsrichter von der Liste zusammen, wird für diesen kein Feedbackformular ausgefüllt. Stattdessen erfasst der RC hier eine kurze Rückmeldung. Sie geht nur ans RC-Präsidium und zählt nicht ans Saisonziel.',
    EN: 'When a coach is on the whistle next to a referee from the list, no feedback form is filled in for that referee. The coach writes a short note here instead. It goes to the RC chair alone and does not count toward the season target.',
  },
};
