const GROUP_LABELS = new Map<string, string>([
  ['neu-sr 2025/26', 'Neu-SR 2025/26'],
  ['neu-sr 25/26', 'Neu-SR 2025/26'],
  ['neu-sr 2024/25', 'Neu-SR 2024/25'],
  ['neu-sr 24/25', 'Neu-SR 2024/25'],
  ['beförderung?', 'Beförderung?'],
  ['befoerderung?', 'Beförderung?'],
  ['beförderung?', 'Beförderung?'],
  ['b?', 'Beförderung?'],
  ['rückstufung?', 'Rückstufung?'],
  ['rueckstufung?', 'Rückstufung?'],
  ['rückstufung', 'Rückstufung'],
  ['rueckstufung', 'Rückstufung'],
  ['r?', 'Rückstufung?'],
  ['befördert', 'Befördert'],
  ['beförderung', 'Befördert'],
  ['befoerdert', 'Befördert'],
  ['befoerderung', 'Befördert'],
  ['beforderung', 'Befördert'],
  ['b', 'Befördert'],
  ['rc gewünscht', 'RC Gewünscht'],
  ['rc gewuenscht', 'RC Gewünscht'],
  ['2. sr', '2. SR'],
  ['2.sr', '2. SR'],
  ['2 sr', '2. SR'],
  ['2sr', '2. SR'],
  ['varia', 'Varia'],
  ['coaching', 'Coaching'],
  ['sr-spiel', 'SR-Spiel'],
  ['sr spiel', 'SR-Spiel'],
  ['lr', 'LR'],
]);

export const COACHEE_GROUP_OPTIONS = [
  'Neu-SR 2025/26',
  'Neu-SR 2024/25',
  'Beförderung?',
  'Befördert',
  'Rückstufung?',
  'Rückstufung',
  'RC Gewünscht',
  '2. SR',
  'Varia',
  'Coaching',
  'SR-Spiel',
  'LR',
] as const;

function normalizeToken(token: string): string {
  const cleaned = token.trim();
  if (!cleaned) {
    return '';
  }
  const key = cleaned.toLowerCase().replace(/\s+/g, ' ');
  if (GROUP_LABELS.has(key)) {
    return GROUP_LABELS.get(key) as string;
  }
  return cleaned.replace(/\b\p{L}/gu, (char) => char.toUpperCase());
}

export function normalizeCoacheeGroup(value?: string): string {
  // Groups are now managed full-word values — display them verbatim.
  return (value || '').trim();
}

// Kept for backwards-compatible imports.
void normalizeToken;

// Groups are STORED in German — they travel verbatim into the filed feedback,
// which is always German — so English is a display layer and nothing else.
// Anything not listed here (a group somebody typed by hand) shows as typed.
const GROUP_EN = new Map<string, string>([
  ['beförderung?', 'Promotion?'],
  ['befördert', 'Promoted'],
  ['rückstufung?', 'Demotion?'],
  ['rückstufung', 'Demoted'],
  ['rc gewünscht', 'RC requested'],
  ['varia', 'Misc'],
  ['sr-spiel', 'SR game'],
  ['lr', 'Line judge'],
]);

/** "Neu-SR 2025/26" carries a year, so it is matched by shape, not by name. */
const NEW_SR_DE = /^neu-sr\s+(.+)$/i;

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
