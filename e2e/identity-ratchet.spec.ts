import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The identity ratchet: no new name-only match, anywhere.
 *
 * Referees, coaches and games each have an identity that survives a spelling
 * correction — the SV number, the roster id, the match number — and the app
 * is being moved onto them one site at a time (docs/identity-plan-2026-09-16.md).
 * The move is only worth anything if it does not silently undo itself: a
 * `normName(a) === normName(b)` is the easiest line in the codebase to write,
 * it works on every fixture, and it is exactly the line that matched a game
 * to a namesake and dropped "León" against "Leon".
 *
 * So this reads the repo — the same trade redirects-config.spec.ts makes —
 * and counts the idioms a name-only match is written in, per file, against a
 * pinned number. The pin is EXACT, not an upper bound: a site that goes away
 * lowers it, so the count can only ever walk down. Narrowed to comparison
 * idioms rather than every fold call, so search boxes, sort keys and the
 * import key keep moving without touching the pin; a line that folds a name
 * for display or search on purpose carries `// identity:display` and is
 * skipped. Relax to `<=` only if the second session's unrelated commits prove
 * it too noisy.
 *
 * What is counted:
 *   A  a folded name compared with === / !== — on either side of the
 *      operator, and with a call inside the fold's parentheses, because
 *      `wanted === normalizeName(asText(x))` is the same match written the
 *      other way round and a ratchet that only reads left to right lets it
 *      through
 *   B  a folded name looked up in a Set/Map/array (.has / .get / .includes)
 *   C  a lowercased string compared with === / !==
 *   D  a raw RC name compared with === (src only — the server's raw compares
 *      are the id-first helpers themselves)
 *   E  a game fetched by `match_no` without a sort — with two rows carrying
 *      one number the unsorted fetch answers whichever PocketBase feels like
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

type Idiom = 'A' | 'B' | 'C' | 'D' | 'E';
type Counts = Record<Idiom, number>;
type Hit = { idiom: Idiom; line: number; text: string };

const FOLDS = '(normalizeName|normName|foldName|personKey)';
/** A fold call's argument list: anything but parentheses, or one nested
 *  pair — `foldName(asText(x))`, `personKey(coacheeDisplayName(row))`. */
const ARGS = '(?:[^()]|\\([^()]*\\))*';

const IDIOMS: Record<Idiom, RegExp> = {
  A: new RegExp(`${FOLDS}\\(${ARGS}\\)\\s*(===|!==)|(===|!==)\\s*${FOLDS}\\(`, 'g'),
  B: new RegExp(`\\.(has|get|includes)\\(${FOLDS}\\(`, 'g'),
  C: /\.toLowerCase\(\)\s*(===|!==)/g,
  D: /(assignedRc|rc_name|rcName|\.fullName\))\s*===/g,
  E: /(getFirstListItem(<[^>]*>)?\(\s*`match_no|filter:\s*`match_no)/g,
};

/** The marker a deliberate fold-for-display carries. Anything on the line. */
const DISPLAY_TAG = 'identity:display';

const ZERO: Counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };

/** The statement a line belongs to, for idiom E's "no sort: in the same
 *  statement". Walks back to the previous line that closes something (`;`,
 *  `{`, `}`), a blank or a comment, and forward to the next `;` — enough to
 *  see an options object that puts `sort:` on the line before or after the
 *  filter. */
function statementAround(lines: string[], at: number): string {
  let from = at;
  while (from > 0) {
    const prev = lines[from - 1].trim();
    if (!prev || /^\/[/*]/.test(prev) || /^\*/.test(prev) || /[;{}]$/.test(prev)) break;
    from -= 1;
  }
  let to = at;
  while (to < lines.length - 1 && !/;\s*$/.test(lines[to])) to += 1;
  return lines.slice(from, to + 1).join('\n');
}

/** Count the idioms in one file's source. `underSrc` switches idiom D on:
 *  it is only a name-only match in the client. */
function countIdioms(source: string, underSrc: boolean): { counts: Counts; hits: Hit[] } {
  const counts: Counts = { ...ZERO };
  const hits: Hit[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (line.includes(DISPLAY_TAG)) return;
    for (const idiom of Object.keys(IDIOMS) as Idiom[]) {
      if (idiom === 'D' && !underSrc) continue;
      const found = [...line.matchAll(IDIOMS[idiom])];
      if (!found.length) continue;
      if (idiom === 'E' && /\bsort:/.test(statementAround(lines, i))) continue;
      counts[idiom] += found.length;
      hits.push({ idiom, line: i + 1, text: line.trim() });
    }
  });
  return { counts, hits };
}

function countFile(file: string): { counts: Counts; hits: Hit[] } {
  const path = join(ROOT, file);
  if (!existsSync(path)) return { counts: { ...ZERO }, hits: [] };
  return countIdioms(readFileSync(path, 'utf8'), file.startsWith('src/'));
}

const list = (dir: string, ext: string) =>
  readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`);

/** Where the name matching lives on purpose. These carry their own pins:
 *  the name tier has to be written somewhere, and this is where. */
const ALLOWED: Record<string, Counts> = {
  // samePerson's own name fallback — the rule every other site defers to.
  'src/lib/identity.ts': { ...ZERO, A: 1 },
  // The register tier: a folded slot name looked up among the licence
  // spellings; and the submit guard's folded compare of the claimed name
  // with the printed one. The sv and name tiers go through indexPeople and
  // count there.
  'server/coacheeIndex.ts': { ...ZERO, B: 2 },
  // The import-time links: the one place a name is still matched to a
  // number, once, with a report — the register under both orders
  // (planCoacheeLinks) and the person across seasons (inheritedRefereeId's
  // personKey compare, a name with no number to offer yet by definition).
  'server/dataHygiene.ts': { ...ZERO, A: 1, B: 1 },
  // personKey — the per-person forms folder, sorted folded parts.
  'server/forms.ts': { ...ZERO },
};

/** Every file the ratchet reads. */
const FILES = [
  ...list('server', '.ts'),
  'src/App.tsx',
  ...list('src/components', '.tsx'),
  ...list('src/lib', '.ts'),
].filter((f) => !(f in ALLOWED));

/** Today's numbers, measured at HEAD 417c56c plus step 2 of the plan, per
 *  OCCURRENCE — a line that compares three times is three sites (the enum
 *  check in server/index.ts is one such line), because a second compare
 *  added to an existing line is as much a new match as one on a new line. A file
 *  not listed is pinned at zero. Idiom C also fires on the enum, e-mail, key
 *  and language compares that happen to lowercase — those are counted as
 *  measured rather than tagged, so an unrelated `.toLowerCase() ===` moves
 *  the pin too.
 *
 *  server/index.ts after step 2: every coachee/referee match goes through
 *  the index, so what is left of A and B is the RC side (rcIdForName, the
 *  admin resolvers, the reminder holder, the coach-as-referee `myNames`
 *  checks) and the contact sync's own link, and E is gone — every fetch by
 *  match number is findGameByMatchNo, sorted. A was re-measured when the
 *  idiom learned to read a fold on the right of the operator and a call
 *  inside the fold (seven sites it had not been counting, all RC-side or
 *  the register contact lookup); B when `.includes(` joined it and the
 *  coachee link moved to dataHygiene.ts. */
const PINS: Record<string, Partial<Counts>> = {
  'server/index.ts': { A: 17, B: 5, C: 5 },
  'server/statistics.ts': { C: 2 },
  'src/App.tsx': { A: 11, B: 25, D: 3 },
  // Step 3 took the manual-game form's svNumberFor (a folded-name compare
  // to read a number back off the option list) — the picker now hands the
  // number over with the pick. What is left of A is the picker's own
  // exact-match line under the field.
  'src/components/AdminConsole.tsx': { A: 1, B: 2 },
  'src/components/PdfReader.tsx': { C: 1 },
  'src/lib/demo.ts': { C: 2 },
  'src/lib/routes.ts': { C: 1 },
};

const pinOf = (file: string): Counts => ({ ...ZERO, ...(PINS[file] ?? {}) });

/** The one message, with every line of the idiom that moved — which of them
 *  is the new one is for the reader; the count says only that there is one. */
function explain(file: string, idiom: Idiom, measured: number, pinned: number, hits: Hit[]): string {
  const where = hits.filter((h) => h.idiom === idiom).map((h) => `${file}:${h.line}`).join(', ') || file;
  return `new name-only identity match in ${where} — go through samePerson()/indexPeople() in src/lib/identity.ts, `
    + `or lower the pin if you removed one (idiom ${idiom}: ${measured} measured, ${pinned} pinned)`;
}

test.describe('the pins', () => {
  for (const file of FILES) {
    test(file, () => {
      const { counts, hits } = countFile(file);
      const pinned = pinOf(file);
      for (const idiom of Object.keys(IDIOMS) as Idiom[]) {
        expect(counts[idiom], explain(file, idiom, counts[idiom], pinned[idiom], hits)).toBe(pinned[idiom]);
      }
    });
  }

  test('every pinned file is one the ratchet reads', () => {
    // A typo in a key would pin nothing and fail nothing.
    for (const file of Object.keys(PINS)) expect(FILES, `${file} is pinned but not scanned`).toContain(file);
  });
});

test.describe('the allow-list', () => {
  for (const [file, pinned] of Object.entries(ALLOWED)) {
    test(file, () => {
      const { counts, hits } = countFile(file);
      for (const idiom of Object.keys(IDIOMS) as Idiom[]) {
        const where = hits.filter((h) => h.idiom === idiom).map((h) => `:${h.line}`).join(' ');
        expect(counts[idiom], `${file}${where} — the name tier lives here; update its pin on purpose (idiom ${idiom})`)
          .toBe(pinned[idiom]);
      }
    });
  }
});

/**
 * The counter checked against itself. A ratchet that quietly stopped
 * counting would pass forever, so each idiom is shown once and the escape
 * hatch is shown not to leak.
 */
test.describe('self-check', () => {
  const FIXTURE = [
    'const a = normalizeName(x) === normalizeName(y);',
    'const b = normName(g.assignedRc || \'\') !== me;',
    'if (set.has(normName(r))) {}',
    'const c = byName.get(foldName(name));',
    'const d = s.toLowerCase() === t;',
    'if (game.assignedRc === rcAuth.rcName) {}',
    'const e = record.rc_name === me;',
    'const g = await c.getFirstListItem<AnyRecord>(`match_no = "${m}"`);',
    'const h = await c.getFirstListItem(`match_no = "${m}"`, { sort: \'-match_date\' });',
    'const shown = foldName(q) === foldName(row.name); // identity:display',
    'const list = c.getList(1, 50, {',
    '  sort: \'-match_date\',',
    '  filter: `match_no = "${m}"`,',
    '});',
    'const one = c.getFirstListItem<AnyRecord>(`match_no = "${m}"`,',
    '  { sort: \'-match_date\', fields: \'second_referee\' });',
    'const unsorted = await withCollection(collectionCandidates.games, (games) =>',
    '  games.getFirstListItem<AnyRecord>(`match_no = "${escapeFilterValue(matchNo)}"`));',
    // The three shapes the first cut of the ratchet did not count: the fold
    // on the right of the operator, a call inside the fold's parentheses,
    // and a folded name looked up in an array.
    'const r = wanted === normalizeName(asText(row.full_name));',
    'if (normalizeName(personFullName(person)) === wanted) {}',
    'if (refs.includes(normName(c))) {}',
    'const same = personKey(coacheeDisplayName(row)) === key;',
  ].join('\n');

  test('each idiom counts once in a client file', () => {
    const { counts, hits } = countIdioms(FIXTURE, true);
    expect(counts).toEqual({ A: 5, B: 3, C: 1, D: 2, E: 2 });
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 18, 19, 20, 21, 22]);
  });

  test('a fold on either side of the operator is one site, and one line comparing two folds is still one', () => {
    expect(countIdioms('const r = wanted === normalizeName(x);', false).counts.A).toBe(1);
    expect(countIdioms('const r = normalizeName(x) === wanted;', false).counts.A).toBe(1);
    expect(countIdioms('const r = normalizeName(x) === normalizeName(y);', false).counts.A).toBe(1);
    expect(countIdioms('const r = foldName(asText(a.n)) !== foldName(asText(b.n));', false).counts.A).toBe(1);
  });

  test('idiom D is not counted on the server', () => {
    expect(countIdioms(FIXTURE, false).counts.D).toBe(0);
  });

  test('a line tagged identity:display does not count', () => {
    expect(countIdioms('const shown = foldName(q) === foldName(row.name); // identity:display', true).counts.A).toBe(0);
    expect(countIdioms('const shown = foldName(q) === foldName(row.name);', true).counts.A).toBe(1);
  });

  test('a match_no fetch with sort: anywhere in its statement is not counted', () => {
    // Before the filter, after it, on the same line, or on a later line of
    // the same call.
    const lines = FIXTURE.split('\n');
    const only = (from: number, to: number) => countIdioms(lines.slice(from, to).join('\n'), false).counts.E;
    expect(only(8, 9), 'sort on the same line').toBe(0);
    expect(only(10, 14), 'sort on the line before the filter').toBe(0);
    expect(only(14, 16), 'sort on the line after the filter').toBe(0);
    expect(only(16, 18), 'no sort, the fetch split over two lines').toBe(1);
  });

  test('two idioms on one line are two sites', () => {
    expect(countIdioms('x = normName(a) === normName(b) && normName(c) !== normName(d);', true).counts.A).toBe(2);
  });

  test('a fold that is not compared is not counted', () => {
    // Sort keys, search boxes and the import key fold without matching.
    expect(countIdioms('const key = `${normalizeName(full_name)}|${season}`;', false).counts).toEqual(ZERO);
    expect(countIdioms('rows.sort((a, b) => foldName(a.n).localeCompare(foldName(b.n)));', true).counts).toEqual(ZERO);
  });
});
