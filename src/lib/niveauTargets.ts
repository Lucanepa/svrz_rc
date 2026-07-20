// Niveau/Stufe → relevant divisions mapping.
//
// Encodes the official SVRZ table "Übersicht SR-Niveau und Stufe" (Stand 9. April 2026):
// for each referee Niveau + Stufe, the *highest* Liga that can be led, split by
// category (Herren / Damen / Junior:innen) and role (1. SR / 2. SR).
//
// We use this as the DEFAULT "which games are worth watching" filter for a coachee
// (derived from the Niveau the admin already records). It is overridable per coachee
// in the admin console (see CoacheeTarget).

export type TargetRole = '1SR' | '2SR';
export type TargetCategory = 'H' | 'D' | 'J'; // Herren / Damen / Junior:innen

export interface NiveauRule {
  category: TargetCategory;
  role: TargetRole;
  division: string; // canonical token: '1'..'5' | 'NL' | 'U23'
}

// Per-coachee target. `mode`:
//  - 'auto'   → derive relevant games from the coachee's Niveau (NIVEAU_TABLE). Default.
//  - 'all'    → no level filtering (show every game this coachee is in).
//  - 'custom' → explicit roles + leagues chosen by the admin (e.g. "1. SR in M3L").
export type CoacheeTargetMode = 'auto' | 'all' | 'custom';
export interface CoacheeTarget {
  mode: CoacheeTargetMode;
  roles?: TargetRole[];   // custom: which role(s) count (empty = any)
  leagues?: string[];     // custom: exact league values (empty = any)
}

export type CoacheeTargetMap = Record<string, CoacheeTarget>;

const H1 = (d: string): NiveauRule => ({ category: 'H', role: '1SR', division: d });
const H2 = (d: string): NiveauRule => ({ category: 'H', role: '2SR', division: d });
const D1 = (d: string): NiveauRule => ({ category: 'D', role: '1SR', division: d });
const D2 = (d: string): NiveauRule => ({ category: 'D', role: '2SR', division: d });
const J1 = (): NiveauRule => ({ category: 'J', role: '1SR', division: 'U23' });

// Highest Liga per level, transcribed from the official table.
// Key format matches the coachee level key (`${referee_level}-${stage}`), e.g. "N3-2".
export const NIVEAU_TABLE: Record<string, NiveauRule[]> = {
  // N4 — regionaler SR ohne Ausbildung zum 2. SR
  'N4-3': [D1('5'), J1()],
  'N4-2': [H1('4'), D1('4'), J1()],
  'N4-1': [H1('4'), D1('3'), J1()],
  // N3 — regionaler SR mit Ausbildung zum 2. SR
  'N3-3': [H1('4'), H2('3'), D1('3'), D2('2'), J1()],
  'N3-2': [H1('3'), H2('2'), D1('2'), D2('2'), J1()],
  'N3-1': [H1('2'), H2('2'), D1('2'), D2('1'), J1()],
  // N2 — regionaler SR für nationale Spiele 1. Liga
  'N2-2': [H1('2'), H2('1'), D1('1'), D2('1')],
  'N2-1': [H1('1'), H2('1'), D1('1'), D2('1')],
  // N1 — Nationalkader (NL-Kader, both roles/categories)
  'N1': [H1('NL'), H2('NL'), D1('NL'), D2('NL')],
};

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
  const base = (lvl || 'N4').toUpperCase();
  if (stufe) return { text: `${base}${sep}${stufe}`, tbd: false };
  if (base === 'N1') return { text: base, tbd: false };
  return { text: `${base}${sep}TBD`, tbd: true };
}

export function levelKey(refereeLevel?: string, stage?: string): string {
  const lvl = (refereeLevel || '').trim();
  if (!lvl) return '';
  const st = (stage || '').trim();
  return st ? `${lvl}-${st}` : lvl;
}

export function hasNiveauRules(key: string): boolean {
  return (NIVEAU_TABLE[key]?.length ?? 0) > 0;
}

// Parse a synced league string (e.g. "3L ♂ A", "3. Liga ♀", "DU23 1. Liga", "NLA")
// into a canonical { division, category }. `ok` is true only when we are confident
// about both — callers treat inconclusive parses as "do not prune" (fail open).
export function parseLeague(raw: string): { division: string; category: TargetCategory | ''; ok: boolean } {
  const s = (raw || '').toLowerCase();
  if (!s.trim()) return { division: '', category: '', ok: false };

  const isJunior = s.includes('u23') || s.includes('junior');
  let category: TargetCategory | '' = '';
  if (isJunior) category = 'J';
  else if (s.includes('♂') || s.includes('herren')) category = 'H';
  else if (s.includes('♀') || s.includes('damen')) category = 'D';

  let division = '';
  if (isJunior) division = 'U23';
  else if (s.includes('nl')) division = 'NL';
  else {
    const m = s.match(/[1-5]/);
    if (m) division = m[0];
  }

  const ok = !!category && !!division;
  return { division, category, ok };
}

// Should a game be KEPT (shown) for a coachee playing `role` in it?
// Returns true to keep, false to prune. Fails open (keeps) when uncertain.
export function keepGame(opts: {
  league: string;
  role: TargetRole;
  target?: CoacheeTarget;
  levelKey: string;
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
  const rules = NIVEAU_TABLE[opts.levelKey];
  if (!rules || rules.length === 0) return true; // unknown / unset level → never prune
  const parsed = parseLeague(opts.league);
  if (!parsed.ok) return true; // can't parse confidently → keep
  return rules.some((r) => r.role === opts.role && r.category === parsed.category && r.division === parsed.division);
}

// Is target filtering effectively active for this coachee? (false = shows everything)
export function isTargetActive(target: CoacheeTarget | undefined, key: string): boolean {
  const t = target ?? { mode: 'auto' };
  if (t.mode === 'all') return false;
  if (t.mode === 'custom') return (t.roles?.length ?? 0) > 0 || (t.leagues?.length ?? 0) > 0;
  return hasNiveauRules(key);
}

// Short human summary of a coachee's target, for admin badges.
export function summarizeTarget(target: CoacheeTarget | undefined, key: string, lang: 'DE' | 'EN'): string {
  const t = target ?? { mode: 'auto' };
  if (t.mode === 'all') return lang === 'DE' ? 'Alle Spiele' : 'All games';
  if (t.mode === 'custom') {
    const roles = (t.roles ?? []).map((r) => (r === '1SR' ? '1. SR' : '2. SR')).join(' / ');
    const leagues = (t.leagues ?? []).join(', ');
    const parts = [roles, leagues].filter(Boolean);
    return (lang === 'DE' ? 'Eigen: ' : 'Custom: ') + (parts.join(' · ') || (lang === 'DE' ? 'alle' : 'any'));
  }
  // auto
  if (!hasNiveauRules(key)) return lang === 'DE' ? 'Auto (kein Niveau)' : 'Auto (no level)';
  return key ? `Auto · ${key}` : 'Auto';
}
