// The vocabulary the DATABASE actually speaks. Every live row was written by the
// xlsx import (AdminConsole's GROUP_MAP), so its spellings are the real ones:
// "Beförderung", "2. Schiedsrichter", "Neu-Schiedsrichter 26/27". This list used
// to offer "Befördert", "2. SR" and "Neu-SR 2025/26" alongside them — same
// concepts, different strings — and the picker unions it with the groups in use,
// so a coach was shown BOTH spellings and either click was accepted. Picking the
// unused one splits a cohort in two for good.
//
// The season-shaped group is deliberately absent: the union supplies the current
// cohort ("Neu-Schiedsrichter 26/27") on its own, so no year is maintained here
// and none can go stale.
export const COACHEE_GROUP_OPTIONS = [
  'Beförderung?',
  'Beförderung',
  'Rückstufung?',
  'Rückstufung',
  'RC Gewünscht',
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
  // "Beförderung" and "Rückstufung" are nouns — the cohort being watched with a
  // view to moving them, not people it has already happened to. Reading them as
  // participles said the opposite: a coachee up for promotion was labelled
  // "Promoted" beside their unchanged Niveau. "Befördert" IS the participle, and
  // legacy rows still carry it.
  ['beförderung?', 'Promotion?'],
  ['beförderung', 'Promotion'],
  ['befördert', 'Promoted'],
  ['rückstufung?', 'Demotion?'],
  ['rückstufung', 'Demotion'],
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
