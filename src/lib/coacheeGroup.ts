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
