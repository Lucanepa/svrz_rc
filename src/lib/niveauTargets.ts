// Niveau/Stufe → relevant leagues mapping.
//
// Encodes the official SVRZ table "Übersicht SR-Niveau und Stufe" (Stand 9. April 2026):
// per Niveau + Stufe, which leagues count as a game worth watching, split by
// category (Herren / Damen / U23) and role (1. SR / 2. SR).
//
// A cell is a SET, not a single league. The paper says "DU23 2. + 3. Liga" for
// N4 Stufe 3 and "HU23 + DU23 1. Liga" for N3 Stufe 2 — one value per cell could
// not express either. It is also why there is no "…and everything below" rule:
// what the cell lists is what counts, and the admin console edits the cells.
//
// This is the DEFAULT "which games are worth watching" filter for a coachee
// (derived from the Niveau the admin already records). Two things override it:
// the whole table can be edited in Admin → Niveau (stored in app_settings), and
// a single coachee can be given their own target (see CoacheeTarget).

export type TargetRole = '1SR' | '2SR';
export type TargetCategory = 'H' | 'D' | 'J'; // Herren / Damen / Junior:innen

// Columns of the official table. Junior:innen appear as 1. SR only and are split
// by gender the way the paper writes them: HU23 = Männer, DU23 = Frauen.
export type NiveauColumn = 'H1' | 'H2' | 'D1' | 'D2' | 'JH' | 'JD';
export const NIVEAU_COLUMNS: NiveauColumn[] = ['H1', 'H2', 'D1', 'D2', 'JH', 'JD'];

// What a column can hold. U23 runs 1.–3. Liga (VolleyManager calls the same
// thing "1.–3. Stärkeklasse") and has no Nationalliga.
export const ADULT_DIVISIONS = ['NL', '1', '2', '3', '4', '5'] as const;
export const U23_DIVISIONS = ['1', '2', '3'] as const;
export function divisionsFor(column: NiveauColumn): string[] {
  return column === 'JH' || column === 'JD' ? [...U23_DIVISIONS] : [...ADULT_DIVISIONS];
}

export type NiveauRow = Record<NiveauColumn, string[]>;
export type NiveauMatrix = Record<string, NiveauRow>;

// Per-coachee target. `mode`:
//  - 'auto'   → derive relevant games from the coachee's Niveau (the matrix). Default.
//  - 'all'    → no level filtering (show every game this coachee is in).
//  - 'custom' → explicit roles + leagues chosen by the admin (e.g. "1. SR in M3L").
export type CoacheeTargetMode = 'auto' | 'all' | 'custom';
export interface CoacheeTarget {
  mode: CoacheeTargetMode;
  roles?: TargetRole[];   // custom: which role(s) count (empty = any)
  leagues?: string[];     // custom: exact league values (empty = any)
}

export type CoacheeTargetMap = Record<string, CoacheeTarget>;

// The nine rows of the official table, in the order it prints them. Fixed: they
// are the SVRZ's own, and the console edits cells, never rows.
export const NIVEAU_LEVELS = ['N4-3', 'N4-2', 'N4-1', 'N3-3', 'N3-2', 'N3-1', 'N2-2', 'N2-1', 'N1'] as const;

const row = (H1: string[], H2: string[], D1: string[], D2: string[], JH: string[], JD: string[]): NiveauRow =>
  ({ H1, H2, D1, D2, JH, JD });

// Transcribed from the official table. An empty cell is an "x" on the paper.
export const NIVEAU_TABLE: NiveauMatrix = {
  // N4 — regionaler SR ohne Ausbildung zum 2. SR
  'N4-3': row([], [], ['5'], [], [], ['2', '3']),
  'N4-2': row(['4'], [], ['4'], [], [], ['2', '3']),
  'N4-1': row(['4'], [], ['3'], [], [], ['1']),
  // N3 — regionaler SR mit Ausbildung zum 2. SR
  'N3-3': row(['4'], ['3'], ['3'], ['2'], [], ['1']),
  'N3-2': row(['3'], ['2'], ['2'], ['2'], ['1'], ['1']),
  'N3-1': row(['2'], ['2'], ['2'], ['1'], ['1'], ['1']),
  // N2 — regionaler SR für nationale Spiele 1. Liga (no U23 on the paper)
  'N2-2': row(['2'], ['1'], ['1'], ['1'], [], []),
  'N2-1': row(['1'], ['1'], ['1'], ['1'], [], []),
  // N1 — Nationalkader (NL-Kader, both roles/categories)
  'N1': row(['NL'], ['NL'], ['NL'], ['NL'], [], []),
};

export function emptyNiveauRow(): NiveauRow {
  return row([], [], [], [], [], []);
}

/** Keep a cell's leagues in the order the column offers them, unique, and drop
 *  anything that is not a league this column knows. */
function cleanCell(value: unknown, column: NiveauColumn): string[] {
  const wanted = Array.isArray(value) ? value.map((v) => String(v).trim()) : [];
  return divisionsFor(column).filter((d) => wanted.includes(d));
}

/** Sanitize whatever came out of app_settings into a matrix. Unknown level keys
 *  and unknown leagues are dropped rather than trusted: a malformed entry must
 *  cost nothing more than that cell. */
export function normalizeNiveauMatrix(raw: unknown): NiveauMatrix {
  const out: NiveauMatrix = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of NIVEAU_LEVELS) {
    const stored = (raw as Record<string, unknown>)[key];
    if (!stored || typeof stored !== 'object') continue;
    const cells = stored as Record<string, unknown>;
    const next = emptyNiveauRow();
    for (const column of NIVEAU_COLUMNS) next[column] = cleanCell(cells[column], column);
    out[key] = next;
  }
  return out;
}

/** The table in force: the official one, with the admin's edits laid over it.
 *  A missing or empty override means "as published". */
export function resolveNiveauTable(stored?: NiveauMatrix | null): NiveauMatrix {
  const overrides = normalizeNiveauMatrix(stored);
  const out: NiveauMatrix = {};
  for (const key of NIVEAU_LEVELS) out[key] = overrides[key] ?? NIVEAU_TABLE[key];
  return out;
}

export function sameNiveauRow(a: NiveauRow, b: NiveauRow): boolean {
  return NIVEAU_COLUMNS.every((c) => a[c].length === b[c].length && a[c].every((v, i) => b[c][i] === v));
}

/** Only what differs from the official table is worth storing — that way a
 *  future correction to the published table reaches every untouched row. */
export function niveauOverrides(table: NiveauMatrix): NiveauMatrix {
  const out: NiveauMatrix = {};
  for (const key of NIVEAU_LEVELS) {
    const cur = table[key];
    if (cur && !sameNiveauRow(cur, NIVEAU_TABLE[key])) out[key] = cur;
  }
  return out;
}

// Display form of a coachee's Niveau/Stufe ("N4-2").
// New referees have no Stufe yet (stage holds the 'active' placeholder) and may
// even lack a Niveau: assume N4 and mark the unknown part as TBD. A Niveau that
// isn't N1–N5 (e.g. "ITA" for a Quereinsteiger) can't be mapped at all → plain
// TBD. N1 has no Stufen, so it never gets a suffix.
export function levelDisplay(refereeLevel?: string, stage?: string, sep = '-'): { text: string; tbd: boolean } {
  const lvl = (refereeLevel || '').trim();
  const st = (stage || '').trim();
  const stufe = /^\d+$/.test(st) ? st : '';
  if (lvl && !/^N[1-5]$/i.test(lvl)) return { text: 'TBD', tbd: true };
  // No Niveau at all → never fabricate certainty, even if a Stufe is present.
  if (!lvl) return { text: `N4${sep}TBD`, tbd: true };
  const base = lvl.toUpperCase();
  if (stufe) return { text: `${base}${sep}${stufe}`, tbd: false };
  if (base === 'N1') return { text: base, tbd: false };
  return { text: `${base}${sep}TBD`, tbd: true };
}

export function levelKey(refereeLevel?: string, stage?: string): string {
  const lvl = (refereeLevel || '').trim();
  if (!lvl) return '';
  const st = (stage || '').trim();
  // stage also carries the 'active'/'inactive' placeholder — only a numeric
  // Stufe belongs in the key (e.g. levelKey('N1','active') must be 'N1').
  return /^\d+$/.test(st) ? `${lvl}-${st}` : lvl;
}

export function hasNiveauRules(key: string, table: NiveauMatrix = NIVEAU_TABLE): boolean {
  const r = table[key];
  return !!r && NIVEAU_COLUMNS.some((c) => r[c].length > 0);
}

export interface ParsedLeague {
  category: TargetCategory | '';
  /** For U23 games: which of the two junior columns the game belongs to. */
  juniorColumn: 'JH' | 'JD' | '';
  division: string; // canonical token: '1'..'5' | 'NL'
  ok: boolean;
}

/** Parse a synced league string (e.g. "3L ♂ A", "3. Liga ♀", "NLA", "DU23 1. Liga")
 *  into a canonical category + division. `ok` is true only when we are confident
 *  about both — callers treat inconclusive parses as "do not prune" (fail open).
 *
 *  U23 needs both a gender and a league to be usable, and the sync only started
 *  supplying them with the group-name change; a bare "U23" (what older rows
 *  carry) is deliberately inconclusive, so those games stay visible. */
export function parseLeague(raw: string): ParsedLeague {
  const s = (raw || '').toLowerCase();
  const miss: ParsedLeague = { category: '', juniorColumn: '', division: '', ok: false };
  if (!s.trim()) return miss;

  const male = /♂|herren|männer|maenner/.test(s);
  const female = /♀|damen|frauen/.test(s);

  // Cup, qualification and finals rounds are not league play, and the junior
  // categories below U23 have no row in the official table at all. Their names
  // also carry digits a league parse would misread — "Finalissima U16 ♀" read
  // as Damen 1. Liga, which is how an N2 coachee's U16 final ended up counting
  // as a 1.-Liga observation. Inconclusive on purpose: shown, never pruned.
  if (/cup|quali|finalissima|playoff|play-off/.test(s) || /u\s?1[0-9]|u\s?2[02]/.test(s)) return miss;

  if (s.includes('u23') || s.includes('junior')) {
    // Drop the U23 token BEFORE looking for a digit — the "2" in "MU23" would
    // otherwise read as 2. Liga.
    const rest = s.replace(/[mdwfh]?u\s?23/g, ' ').replace(/junior\S*/g, ' ');
    const hit = rest.match(/[1-3]/);
    const prefix = s.match(/([mdwfh])u\s?23/);
    const short = prefix ? prefix[1] : '';
    const isMale = male || short === 'm' || short === 'h';
    const isFemale = female || short === 'd' || short === 'w' || short === 'f';
    const juniorColumn = isMale ? 'JH' : isFemale ? 'JD' : '';
    if (!juniorColumn || !hit) return { category: 'J', juniorColumn, division: hit ? hit[0] : '', ok: false };
    return { category: 'J', juniorColumn, division: hit[0], ok: true };
  }

  const category: TargetCategory | '' = male ? 'H' : female ? 'D' : '';
  let division = '';
  if (s.includes('nl')) division = 'NL';
  else {
    const m = s.match(/[1-5]/);
    if (m) division = m[0];
  }
  return { category, juniorColumn: '', division, ok: !!category && !!division };
}

/** Which cell of the table decides this game, or null when none can. U23 counts
 *  as 1. SR only — that is how the official table lists it. */
export function columnFor(parsed: ParsedLeague, role: TargetRole): NiveauColumn | null {
  if (parsed.category === 'J') {
    if (!parsed.juniorColumn || role !== '1SR') return null;
    return parsed.juniorColumn;
  }
  if (parsed.category === 'H') return role === '1SR' ? 'H1' : 'H2';
  if (parsed.category === 'D') return role === '1SR' ? 'D1' : 'D2';
  return null;
}

// Should a game be KEPT (shown) for a coachee playing `role` in it?
// Returns true to keep, false to prune. Fails open (keeps) when uncertain.
export function keepGame(opts: {
  league: string;
  role: TargetRole;
  target?: CoacheeTarget;
  levelKey: string;
  table?: NiveauMatrix;
}): boolean {
  const target = opts.target ?? { mode: 'auto' };

  if (target.mode === 'all') return true;

  if (target.mode === 'custom') {
    const roles = target.roles ?? [];
    if (roles.length > 0 && !roles.includes(opts.role)) return false;
    const leagues = target.leagues ?? [];
    if (leagues.length === 0) return true;
    // Custom leagues are exact real values picked by the admin → exact match.
    return leagues.includes(opts.league || '');
  }

  // auto: derive from the coachee's Niveau.
  const table = opts.table ?? NIVEAU_TABLE;
  if (!hasNiveauRules(opts.levelKey, table)) return true; // unknown / unset level → never prune
  const parsed = parseLeague(opts.league);
  if (!parsed.ok) return true; // can't parse confidently → keep
  const column = columnFor(parsed, opts.role);
  if (!column) return false;
  return table[opts.levelKey][column].includes(parsed.division);
}

// Is target filtering effectively active for this coachee? (false = shows everything)
export function isTargetActive(target: CoacheeTarget | undefined, key: string, table: NiveauMatrix = NIVEAU_TABLE): boolean {
  const t = target ?? { mode: 'auto' };
  if (t.mode === 'all') return false;
  if (t.mode === 'custom') return (t.roles?.length ?? 0) > 0 || (t.leagues?.length ?? 0) > 0;
  return hasNiveauRules(key, table);
}

// Short human summary of a coachee's target, for admin badges.
export function summarizeTarget(target: CoacheeTarget | undefined, key: string, lang: 'DE' | 'EN', table: NiveauMatrix = NIVEAU_TABLE): string {
  const t = target ?? { mode: 'auto' };
  if (t.mode === 'all') return lang === 'DE' ? 'Alle Spiele' : 'All games';
  if (t.mode === 'custom') {
    const roles = (t.roles ?? []).map((r) => (r === '1SR' ? '1. SR' : '2. SR')).join(' / ');
    const leagues = (t.leagues ?? []).join(', ');
    const parts = [roles, leagues].filter(Boolean);
    return (lang === 'DE' ? 'Eigen: ' : 'Custom: ') + (parts.join(' · ') || (lang === 'DE' ? 'alle' : 'any'));
  }
  // auto
  if (!hasNiveauRules(key, table)) return lang === 'DE' ? 'Auto (kein Niveau)' : 'Auto (no level)';
  return key ? `Auto · ${key}` : 'Auto';
}

/** One cell as text, e.g. "4L" or "2L + 3L" or "—". */
export function cellLabel(values: string[]): string {
  if (!values.length) return '—';
  return values.map((v) => (v === 'NL' ? 'NL' : `${v}L`)).join(' + ');
}
