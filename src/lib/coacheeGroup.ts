// The vocabulary the DATABASE actually speaks. Every live row was written by the
// xlsx import (AdminConsole's GROUP_MAP), so its spellings are the real ones:
// "Beförderung", "Referee Coaching", "2. Schiedsrichter", "Neu-Schiedsrichter
// 26/27". This list used to offer "Befördert", "2. SR" and "Neu-SR 2025/26"
// alongside them — same concepts, different strings — and the picker unions it
// with the groups in use, so a coach was shown BOTH spellings and either click
// was accepted. Picking the unused one splits a cohort in two for good.
//
// "RC Gewünscht" was the last one left doing that: the import writes "Referee
// Coaching" for the XLSX's `RC`, so every real row said one thing while the
// picker offered the other. It stays translated below, because rows a coach
// created by clicking it still exist.
//
// The season-shaped group is deliberately absent: the union supplies the current
// cohort ("Neu-Schiedsrichter 26/27") on its own, so no year is maintained here
// and none can go stale.
export const COACHEE_GROUP_OPTIONS = [
  'Beförderung?',
  'Beförderung',
  'Rückstufung?',
  'Rückstufung',
  'Referee Coaching',
  '2. Schiedsrichter',
  'Varia',
  'Coaching',
  'SR-Spiel',
  'LR',
] as const;

export function normalizeCoacheeGroup(value?: string): string {
  // Groups are now managed full-word values — display them verbatim.
  return (value || '').trim();
}

// Groups are STORED in German — they travel verbatim into the filed feedback,
// which is always German — so English is a display layer and nothing else.
// Anything not listed here (a group somebody typed by hand) shows as typed.
// Keyed on what is IN the database, not on what this file once wished were. The
// four spellings the import writes went untranslated for as long as they have
// existed, so half of an English reader's badges were in German. The older
// spellings stay listed: legacy rows still carry them and must not regress.
const GROUP_EN = new Map<string, string>([
  // Which of the pair means "already happened" is not a question about German
  // nouns — it is settled by the XLSX the rows come from and by the Infoschreiben
  // that defines its codes. GROUP_MAP turns `B` into "Beförderung" and `B?` into
  // "Beförderung?", and Infoschreiben 4.4.4/4.4.5 read: B? = "SR ist für eine
  // Beförderung zu besuchen", B = "SR wurde in der vergangenen Saison befördert".
  // So the bare noun is the participle's cohort and takes "Promoted"; the
  // question mark is the one still to be decided. This pair was the other way
  // round, which told an English reader the opposite of the SVRZ's own table.
  ['beförderung?', 'Promotion?'],
  ['beförderung', 'Promoted'],
  ['befördert', 'Promoted'],
  ['rückstufung?', 'Demotion?'],
  ['rückstufung', 'Demoted'],
  // Both spellings of Infoschreiben 4.4.6 "RC gewünscht": what the import writes
  // and what the picker used to offer beside it.
  ['referee coaching', 'RC requested'],
  ['rc gewünscht', 'RC requested'],
  ['1. schiedsrichter', '1st referee'],
  ['2. schiedsrichter', '2nd referee'],
  ['2. sr', '2nd referee'],
  ['varia', 'Misc'],
  ['sr-spiel', 'SR game'],
  ['lr', 'Line judge'],
]);

/** "Neu-Schiedsrichter 26/27" carries a year, so it is matched by shape, not by
 *  name. Both spellings: the import writes the long one, older rows the short. */
const NEW_SR_DE = /^neu-(?:sr|schiedsrichter)\s+(.+)$/i;

/** Is this coachee in their FIRST season? Infoschreiben 4.4.2 calls that cohort
 *  "Neu-SR <Saison>", and 4.1 gives it the only deadline in the document: the
 *  visit belongs in one of their first three games. Matched by shape, like the
 *  label above — the year moves every season and must not be hard-coded here.
 *
 *  4.4.3's second-year cohort carries the same prefix with an older year, so a
 *  caller that needs to tell the two apart compares the season in the name; for
 *  the deadline both are "Neu-SR" and only the current one is still inside it. */
export function isNewSrGroup(groups?: string): boolean {
  return splitCoacheeGroups(groups).some((g) => NEW_SR_DE.test(g));
}

/** Split a groups field into its individual groups. A bare 2- or 4-digit part
 *  is the tail of a season ("Neu-SR 2025/26"), not a group of its own. */
export function splitCoacheeGroups(value?: string): string[] {
  const out: string[] = [];
  for (const part of (value || '').split(/[/,]/).map((s) => s.trim()).filter(Boolean)) {
    if (/^\d{2}(\d{2})?$/.test(part) && out.length) out[out.length - 1] += `/${part}`;
    else out.push(part);
  }
  return out;
}

/** Display label for a coachee's group(s), translated when the app is in EN. */
export function groupLabel(value: string | undefined, lang: string): string {
  const groups = splitCoacheeGroups(value);
  if (lang === 'DE') return groups.join(' / ');
  return groups
    .map((g) => {
      const newSr = NEW_SR_DE.exec(g);
      if (newSr) return `New SR ${newSr[1]}`;
      return GROUP_EN.get(g.toLowerCase()) ?? g;
    })
    .join(' / ');
}
