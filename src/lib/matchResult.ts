// The match result travels as one string in `meta.ergebnis`, and it arrives in
// two shapes: "3:1 | 25:20, 22:25, 25:18, 25:22" is what this form writes, and
// "3:1 (25:20 / 22:25 / 25:18 / 25:22)" is what the VolleyManager sync writes —
// every one of the 925 synced games uses the second. Read both, or a synced
// game shows its set scores nowhere.

export type SetScore = { h: string; a: string };
export type ParsedResult = { home: string; away: string; sets: SetScore[] };

/**
 * First number pair is the match score; every pair after it is a set.
 * A side may be empty — a half-typed "25:" has to survive the round trip
 * through this string, or the digit disappears from the box as it is typed.
 */
export function parseResult(value: string): ParsedResult {
  const pairs = [...String(value ?? '').matchAll(/(\d{1,2})?\s*[:\-]\s*(\d{1,2})?/g)]
    .map((m) => ({ h: m[1] ?? '', a: m[2] ?? '' }))
    .filter((p) => p.h !== '' || p.a !== '');
  if (pairs.length === 0) return { home: '', away: '', sets: [] };
  const [match, ...sets] = pairs;
  // The match score is a set count, so it is one digit; the sets are points.
  return { home: match.h.slice(0, 1), away: match.a.slice(0, 1), sets };
}

export function isSetComplete(set: SetScore): boolean {
  return set.h !== '' && set.a !== '';
}

/** Who won how many sets, counting only the sets that are actually filled in. */
export function tallyFromSets(sets: SetScore[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const set of sets) {
    if (!isSetComplete(set)) continue;
    const h = Number(set.h);
    const a = Number(set.a);
    if (h > a) home += 1;
    else if (a > h) away += 1;
  }
  return { home, away };
}

/** A side needs three sets to win; some junior leagues play best-of-three. */
export function isMatchDecided(tally: { home: number; away: number }): boolean {
  return Math.max(tally.home, tally.away) >= 3;
}

export function formatResult(home: string, away: string, sets: SetScore[]): string {
  const match = (home || away) ? `${home}:${away}` : '';
  const points = sets.map((s) => (s.h || s.a) ? `${s.h}:${s.a}` : '').filter(Boolean).join(', ');
  return [match, points].filter(Boolean).join(' | ');
}

const REGULAR_SET_TARGET = 25;
const DECIDING_SET_TARGET = 15;

/**
 * Null when the result is a result a volleyball match could actually produce.
 * Best-of-5 is the normal case; several junior leagues play best-of-3, where
 * 2:0 / 2:1 is complete and the deciding set is the third.
 */
export function validateResult(value: string, lang: 'DE' | 'EN'): string | null {
  const de = lang === 'DE';
  const { home, away, sets } = parseResult(value);
  if (!home || !away) {
    return de ? 'Bitte das Ergebnis (Sätze) eintragen.' : 'Please enter the result (sets).';
  }

  const h = Number(home);
  const a = Number(away);
  const won = Math.max(h, a);
  const lost = Math.min(h, a);
  const bestOf5 = won === 3 && lost <= 2;
  const bestOf3 = won === 2 && lost <= 1;
  if (!bestOf5 && !bestOf3) {
    return de
      ? `Ergebnis ${h}:${a} ist nicht möglich: Der Sieger braucht 3 Sätze (Best-of-3: 2).`
      : `A ${h}:${a} result is not possible: the winner needs 3 sets (best-of-3: 2).`;
  }

  // Checked before the count: a set caught half-typed ("25:") would otherwise
  // be reported as one set too many, which reads like nonsense.
  const halfTyped = sets.findIndex((s) => !isSetComplete(s));
  if (halfTyped >= 0) {
    return de ? `Satz ${halfTyped + 1}: Punkte fehlen.` : `Set ${halfTyped + 1}: points are missing.`;
  }

  const played = h + a;
  if (sets.length !== played) {
    return de
      ? `Bitte alle ${played} Satzresultate eintragen (${sets.length} von ${played} erfasst).`
      : `Please enter all ${played} set scores (${sets.length} of ${played} filled in).`;
  }

  const decidingSet = bestOf5 ? 5 : 3;
  let homeSetsWon = 0;
  let awaySetsWon = 0;
  for (let i = 0; i < sets.length; i += 1) {
    const setNo = i + 1;
    const sh = Number(sets[i].h);
    const sa = Number(sets[i].a);
    if (!Number.isFinite(sh) || !Number.isFinite(sa) || sets[i].h === '' || sets[i].a === '') {
      return de ? `Satz ${setNo}: Punkte fehlen.` : `Set ${setNo}: points are missing.`;
    }
    const target = setNo === decidingSet ? DECIDING_SET_TARGET : REGULAR_SET_TARGET;
    const winner = Math.max(sh, sa);
    const loser = Math.min(sh, sa);
    if (sh === sa) {
      return de ? `Satz ${setNo} (${sh}:${sa}): ein Satz kann nicht unentschieden enden.` : `Set ${setNo} (${sh}:${sa}): a set cannot end level.`;
    }
    if (winner < target) {
      return de
        ? `Satz ${setNo} (${sh}:${sa}): der Sieger braucht mindestens ${target} Punkte.`
        : `Set ${setNo} (${sh}:${sa}): the winner needs at least ${target} points.`;
    }
    if (winner - loser < 2) {
      return de
        ? `Satz ${setNo} (${sh}:${sa}): mindestens 2 Punkte Vorsprung.`
        : `Set ${setNo} (${sh}:${sa}): a two-point lead is required.`;
    }
    // Past the target the set runs until someone leads by exactly two, so a
    // 27:20 never happened.
    if (winner > target && winner - loser > 2) {
      return de
        ? `Satz ${setNo} (${sh}:${sa}): über ${target} endet der Satz bei 2 Punkten Vorsprung.`
        : `Set ${setNo} (${sh}:${sa}): past ${target} the set ends at a two-point lead.`;
    }
    if (sh > sa) homeSetsWon += 1; else awaySetsWon += 1;
  }

  // The case that started this: 3:0 with a set the home team lost.
  if (homeSetsWon !== h || awaySetsWon !== a) {
    return de
      ? `Die Satzresultate ergeben ${homeSetsWon}:${awaySetsWon}, eingetragen ist ${h}:${a}.`
      : `The set scores add up to ${homeSetsWon}:${awaySetsWon}, but the result says ${h}:${a}.`;
  }
  return null;
}
