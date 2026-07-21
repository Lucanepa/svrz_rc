// Generates src/lib/pdfFonts.ts — the two Inter subsets the PDF builder embeds.
//
// Inter is what the app renders on screen (@fontsource-variable/inter), so the
// PDF matches the form the coach filled in. Fontsource ships woff2 only and
// jsPDF needs TrueType, hence the Expo package as the TTF source.
//
// jsPDF's built-in Helvetica is WinAnsi-only, so it mangles the Latin Extended-A
// letters that turn up constantly in Swiss volleyball names (Šimić, Łukasz,
// Ferenc Kovács). jsPDF also embeds whatever font you register *whole*, into
// every PDF it writes — so a full 300 KB Inter would land in each feedback
// e-mail twice over. Subsetting to the ranges the form can actually contain
// keeps both the bundle and the attachment small.
//
// Run: node scripts/build-pdf-fonts.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (f) => `${root}node_modules/@expo-google-fonts/inter/${f}`;

const range = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)).join('');

// Everything the form can hold: the coach's prose, VolleyManager's names, and
// the punctuation phones insert on their own (smart quotes, en dash, ellipsis).
const CHARSET = [
  range(0x20, 0x7e), // Basic Latin
  range(0xa0, 0xff), // Latin-1 Supplement — German, French, Italian
  range(0x100, 0x17f), // Latin Extended-A — Croatian, Polish, Czech, Hungarian
  'ƒǄǅǆǇǈǉǊǋǌ', // Serbo-Croatian digraphs
  '–—‘’‚“”„•…‹›′″',
  '€™←↑→↓✓✔□☐',
].join('');

const WEIGHTS = [
  { file: '400Regular/Inter_400Regular.ttf', name: 'INTER_REGULAR' },
  { file: '700Bold/Inter_700Bold.ttf', name: 'INTER_BOLD' },
];

const parts = [];
for (const { file, name } of WEIGHTS) {
  const original = await readFile(src(file));
  const subset = await subsetFont(original, CHARSET, { targetFormat: 'truetype' });
  const b64 = subset.toString('base64');
  console.log(`${name}: ${original.length} B -> ${subset.length} B subset (${b64.length} B base64)`);
  parts.push(`export const ${name}_B64 =\n  '${b64}';`);
}

const header = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-pdf-fonts.mjs
//
// Inter, Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter),
// licensed under the SIL Open Font License 1.1. The copyright statement names no
// Reserved Font Name, so these subsets may keep the family name.
//
// Subset to Basic Latin + Latin-1 + Latin Extended-A + common punctuation, so
// referee names such as "Šimić" or "Łukasz" render correctly in the PDF.
`;

const out = `${root}src/lib/pdfFonts.ts`;
await writeFile(out, `${header}\n${parts.join('\n\n')}\n`);
console.log(`wrote ${out}`);
