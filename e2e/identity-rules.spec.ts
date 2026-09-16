import { test, expect } from '@playwright/test';
import {
  foldName, nameKeys, samePerson, indexPeople, resolveRcName, resolveRcRef,
  coacheeIndex, coacheeIdOnSlot, coacheeLookup, svClaimOnSlot, isMyGame, isMyRecord,
  coacheeUrlToken, resolveCoacheeToken, gameUrlToken, resolveGameToken,
} from '../src/lib/identity';
import { foldName as reExportedFoldName, coacheeIndex as reExportedCoacheeIndex } from '../src/lib/coacheeName';
import { buildCoacheeIndex, claimNamesSlot, claimNamesRow, coacheeRowNames, type SvMismatch } from '../server/coacheeIndex';
import { identityAudit, gameLabel } from '../server/identityAudit';

/**
 * The identity rules, tested without a browser — the same idiom as
 * boerse-rules.spec.ts and games-sync-rules.spec.ts.
 *
 * These are the decisions every "is this the same person / the same game"
 * question in the app is being moved onto (docs/identity-plan-2026-09-16.md
 * §2 and §3). They are pinned here on their own because the sites that call
 * them are stubbed at the network boundary in every other spec, which proves
 * a screen reacts to the answer but never that the answer was right: a coach
 * matched to a namesake's game, or a coachee row from the wrong season, looks
 * exactly like the correct case from the outside.
 */

test.describe('foldName', () => {
  test('case, accents and spacing fold away; nothing else does', () => {
    expect(foldName('  Kevin   LEÓN ')).toBe('kevin leon');
    expect(foldName('Müller')).toBe(foldName('Muller'));
    expect(foldName('Kevin León Peña')).not.toBe(foldName('Kevin Peña'));
  });

  test('coacheeName.ts still hands out the same function', () => {
    // The three importers of coacheeName.ts were not touched by the move;
    // the re-export must be the very same definition, not a copy that can
    // drift.
    expect(reExportedFoldName).toBe(foldName);
  });
});

test.describe('nameKeys', () => {
  test('both orders of a two-word name', () => {
    expect(nameKeys('Kevin León')).toEqual(['kevin leon', 'leon kevin']);
  });

  test('a one-word name gives one key, an empty one none', () => {
    expect(nameKeys('Madonna')).toEqual(['madonna']);
    expect(nameKeys('   ')).toEqual([]);
  });

  test('a name that reads the same reversed is not listed twice', () => {
    expect(nameKeys('Anna Anna')).toEqual(['anna anna']);
  });

  test('three words reverse as a whole — a middle name is not shuffled out', () => {
    expect(nameKeys('Kevin León Peña')).toEqual(['kevin leon pena', 'pena leon kevin']);
  });
});

test.describe('samePerson', () => {
  const me = { id: 'rc1', name: 'Anna Muster' };
  const roster = new Set(['rc1', 'rc2']);

  test('an equal id is a yes, whatever the name says', () => {
    expect(samePerson({ id: 'rc1', name: 'Somebody Else' }, me, roster)).toBe(true);
    expect(samePerson({ id: 'rc1', name: '' }, me, roster)).toBe(true);
  });

  test('a known, different id is a no, even with the same name', () => {
    // Two active coaches folding to one string: the id decides, the name
    // must not hand one the other's game.
    expect(samePerson({ id: 'rc2', name: 'Anna Muster' }, me, roster)).toBe(false);
  });

  test('an id nobody knows falls through to the name', () => {
    // A deleted coach's id, or one predating a data fix, would otherwise
    // strand the row forever.
    expect(samePerson({ id: 'rc-gone', name: 'Anna Muster' }, me, roster)).toBe(true);
    expect(samePerson({ id: 'rc-gone', name: 'Bea Beispiel' }, me, roster)).toBe(false);
  });

  test('with no roster loaded, any different id falls through to the name', () => {
    // The client before rcPeople has arrived must never veto an id the
    // server would let through.
    expect(samePerson({ id: 'rc2', name: 'Anna Muster' }, me)).toBe(true);
    expect(samePerson({ id: 'rc2', name: 'Bea Beispiel' }, me)).toBe(false);
  });

  test('no id on the record: folded-name equality, as before the ids existed', () => {
    expect(samePerson({ id: '', name: 'ANNA  Muster' }, me, roster)).toBe(true);
    expect(samePerson({ id: '', name: 'Bea Beispiel' }, me, roster)).toBe(false);
  });

  test('León and Leon are one person', () => {
    expect(samePerson({ id: '', name: 'Kevin Leon' }, { id: 'x', name: 'Kevin León' })).toBe(true);
  });

  test('"Nachname Vorname" is NOT the same string — the name fallback is exact', () => {
    // rcRefMatches never reversed a name and neither does this; the RC
    // roster writes one order and the stored rows copy it. Reversal is the
    // referee index's business (nameKeys), where VolleyManager forces it.
    expect(samePerson({ id: '', name: 'Muster Anna' }, me)).toBe(false);
  });

  test('a middle name does not fold away', () => {
    expect(samePerson({ id: '', name: 'Kevin León Peña' }, { id: '', name: 'Kevin Peña' })).toBe(false);
  });

  test('two empty names are nobody, not the same person', () => {
    expect(samePerson({ id: '', name: '' }, { id: '', name: '' })).toBe(false);
    expect(samePerson({ id: '', name: '  ' }, { id: 'rc1', name: '' })).toBe(false);
  });

  test('a padded id still counts', () => {
    expect(samePerson({ id: ' rc1 ', name: '' }, me, roster)).toBe(true);
  });
});

test.describe('resolveRcName — a coach\'s name back to their id', () => {
  const people = [
    { id: 'rc1', fullName: 'Anna Muster', aliases: ['Anna Muster-Keller', 'A. Muster'] },
    { id: 'rc2', fullName: 'Beat Zimmermann' },
    { id: 'rc3', fullName: 'Kevin León Peña', aliases: ['Kevin Peña'] },
  ];

  test('the name as the roster spells it, folded', () => {
    expect(resolveRcName('anna  MUSTER', people)).toBe('rc1');
    expect(resolveRcName('Beat Zimmermann', people)).toBe('rc2');
  });

  test('either order — VolleyManager and the XLSX do not agree on one', () => {
    expect(resolveRcName('Muster Anna', people)).toBe('rc1');
    expect(resolveRcName('Zimmermann Beat', people)).toBe('rc2');
  });

  test('an alias answers too, in either order', () => {
    // The maiden name, the everyday short form: the admin lists them on the
    // roster row so a report or an old game under that spelling finds her.
    expect(resolveRcName('Anna Muster-Keller', people)).toBe('rc1');
    expect(resolveRcName('Muster-Keller Anna', people)).toBe('rc1');
    expect(resolveRcName('Kevin Peña', people)).toBe('rc3');
    expect(resolveRcName('Peña Kevin', people)).toBe('rc3');
  });

  test('a middle name is not shuffled out — that is what the alias is for', () => {
    expect(resolveRcName('Peña Kevin León', people)).toBe('');
  });

  test('two coaches answering is nobody, never the first', () => {
    // The ambiguity the id exists to remove: guessing would hand one coach
    // the other's game. The caller refuses with the name instead.
    const twins = [...people, { id: 'rc4', fullName: 'Anna Muster' }];
    expect(resolveRcName('Anna Muster', twins)).toBe('');
    // ...and an alias that collides with another coach's name is the same
    // ambiguity, however it got there.
    const aliased = [...people, { id: 'rc5', fullName: 'Bea Beispiel', aliases: ['Beat Zimmermann'] }];
    expect(resolveRcName('Beat Zimmermann', aliased)).toBe('');
  });

  test('one coach answering twice is one coach', () => {
    // An alias that repeats the name the other way round is not a second
    // person.
    const doubled = [{ id: 'rc6', fullName: 'Cara Dubois', aliases: ['Dubois Cara', 'Cara Dubois'] }];
    expect(resolveRcName('Cara Dubois', doubled)).toBe('rc6');
  });

  test('nobody, or nothing asked, is an empty id', () => {
    expect(resolveRcName('Dora Niemand', people)).toBe('');
    expect(resolveRcName('   ', people)).toBe('');
    expect(resolveRcName('Anna Muster', [])).toBe('');
  });
});

test.describe('resolveRcRef — the id when it is one, else the name', () => {
  // The console asks /api/rc-overview/<id>/coachees; an older client, or a
  // typed address, asks with the name. Same coach either way.
  const people = [
    { id: 'rc1', fullName: 'Anna Muster' },
    { id: 'rc2', fullName: 'Anna  MUSTER' },
    { id: 'rc3', fullName: 'Beat Zimmermann', aliases: ['B. Zimmermann'] },
  ];

  test('the roster id lands on that coach, whatever their name', () => {
    expect(resolveRcRef('rc2', people)?.fullName).toBe('Anna  MUSTER');
    expect(resolveRcRef(' rc3 ', people)?.id).toBe('rc3');
  });

  test('a name-shaped legacy call still answers', () => {
    expect(resolveRcRef('Beat Zimmermann', people)?.id).toBe('rc3');
    expect(resolveRcRef('Zimmermann Beat', people)?.id).toBe('rc3');
    expect(resolveRcRef('B. Zimmermann', people)?.id).toBe('rc3');
  });

  test('two coaches with one folded name resolve separately by id and to nobody by name', () => {
    expect(resolveRcRef('rc1', people)?.id).toBe('rc1');
    expect(resolveRcRef('rc2', people)?.id).toBe('rc2');
    // The page then shows nothing, never both coaches' games under one
    // heading — which is what the pure name compare used to do.
    expect(resolveRcRef('Anna Muster', people)).toBeUndefined();
  });

  test('nothing, or nobody, is undefined', () => {
    expect(resolveRcRef('', people)).toBeUndefined();
    expect(resolveRcRef('Dora Niemand', people)).toBeUndefined();
  });
});

test.describe('indexPeople', () => {
  // The same referee in two seasons, an unlinked colleague, a row that
  // predates the season field, and a namesake with a different number.
  const rows = [
    { id: '90003', names: ['Kevin Peña', 'Kevin Peña', 'Peña Kevin'], season: 2026, value: 'kevin-26' },
    { id: '90003', names: ['Kevin Peña'], season: 2025, value: 'kevin-25' },
    { id: '', names: ['Bea Beispiel', 'Beispiel Bea'], season: 2026, value: 'bea-26' },
    { id: '', names: ['Old Timer'], season: null, value: 'old' },
    { id: '90009', names: ['Kevin Peña'], season: 2024, value: 'namesake-24' },
  ];
  const index = indexPeople(rows);

  test('the id wins, whatever spelling the game carries', () => {
    expect(index.find(2026, { id: '90003', name: 'Kevin León Peña de los Santos' }))
      .toEqual({ value: 'kevin-26', via: 'id' });
  });

  test('the season row of the id, not another season\'s', () => {
    expect(index.find(2025, { id: '90003', name: '' })?.value).toBe('kevin-25');
    expect(index.find(2026, { id: '90003', name: '' })?.value).toBe('kevin-26');
  });

  test('no id on the slot: the folded name, either order', () => {
    expect(index.find(2026, { id: '', name: 'Beispiel  BEA' })).toEqual({ value: 'bea-26', via: 'name' });
    expect(index.find(2026, { name: 'bea beispiel' })?.value).toBe('bea-26');
  });

  test('a row of another season never answers, by id or by name', () => {
    expect(index.find(2023, { id: '90003', name: 'Kevin Peña' })).toBeNull();
    expect(index.find(2027, { id: '', name: 'Bea Beispiel' })).toBeNull();
    expect(index.has(2027, { name: 'Bea Beispiel' })).toBe(false);
  });

  test('a seasonless row answers in every season', () => {
    expect(index.find(2026, { name: 'Old Timer' })?.value).toBe('old');
    expect(index.find(2019, { name: 'Old Timer' })?.value).toBe('old');
  });

  test('the season row beats the seasonless one', () => {
    const both = indexPeople([
      { id: '', names: ['Kevin Peña'], season: null, value: 'seasonless' },
      { id: '', names: ['Kevin Peña'], season: 2026, value: 'this-season' },
    ]);
    expect(both.find(2026, { name: 'Kevin Peña' })?.value).toBe('this-season');
    expect(both.find(2025, { name: 'Kevin Peña' })?.value).toBe('seasonless');
  });

  test('a null season is an undated fixture and matches any row', () => {
    // Today's forSeason(null) is everyone; an undated game must not lose its
    // coachees. First in input order wins.
    expect(index.find(null, { id: '90003', name: '' })?.value).toBe('kevin-26');
    expect(index.find(null, { name: 'Kevin Peña' })?.value).toBe('kevin-26');
    expect(index.has(null, { name: 'Old Timer' })).toBe(true);
  });

  test('an unknown id falls through to the name', () => {
    // The register links are not trusted enough to veto a name yet: a slot
    // whose number is on no row still finds the row by name, and the caller
    // may warn about the disagreement (identity.sv-mismatch).
    expect(index.find(2026, { id: '99999', name: 'Kevin Peña' })).toEqual({ value: 'kevin-26', via: 'name' });
  });

  test('a name hit whose row carries a different id is accepted, and says so', () => {
    expect(index.find(2024, { id: '90003', name: 'Kevin Peña' })).toEqual({ value: 'namesake-24', via: 'name' });
  });

  test('a middle name on the game does not reach the two-word row', () => {
    expect(index.find(2026, { name: 'Kevin León Peña' })).toBeNull();
  });

  test('nothing to ask with is nothing found', () => {
    expect(index.find(2026, {})).toBeNull();
    expect(index.find(2026, { id: '  ', name: ' ' })).toBeNull();
  });

  test('two same-season rows with one id: the first in input order', () => {
    const twins = indexPeople([
      { id: '1', names: ['A'], season: 2026, value: 'first' },
      { id: '1', names: ['A'], season: 2026, value: 'second' },
    ]);
    expect(twins.find(2026, { id: '1' })?.value).toBe('first');
  });
});

test.describe('the client reads the slot ids', () => {
  const one = { id: 'c1', full_name: 'Ref One', first_name: 'Ref', last_name: 'One', season: 2026, referee_id: '90001' };
  const two = { id: 'c2', full_name: 'Ref Two', season: 2026 };
  const old = { id: 'c3', full_name: 'Ref Old', season: 2025 };
  const undated = { id: 'c4', full_name: 'Ref Undated' };
  // The same two people, last season: one by number, two by name only.
  const oneLast = { id: 'c1-2025', full_name: 'One R.', season: 2025, referee_id: '90001' };
  const twoLast = { id: 'c2-2025', full_name: 'Ref Two', season: 2025 };
  const roster = coacheeLookup([one, two, old, undated, oneLast, twoLast], 2026);

  test('coacheeName.ts still hands out the same name index', () => {
    expect(reExportedCoacheeIndex).toBe(coacheeIndex);
  });

  test('the server\'s id decides, whatever the slot is called', () => {
    const game = { firstReferee: 'Zzz Nobody', secondReferee: 'Ref Two', firstCoacheeId: 'c1', secondCoacheeId: '' };
    expect(roster.idOnSlot(game, '1. SR')).toBe('c1');
    expect(roster.onSlot(game, '1. SR')).toBe(one);
    // '' is an answer — not a coachee — and the name does not overturn it.
    expect(roster.idOnSlot(game, '2. SR')).toBe('');
    expect(roster.onSlot(game, '2. SR')).toBeUndefined();
  });

  test('a row with no such field at all falls to the folded name, both orders', () => {
    const legacy = { firstReferee: 'ONE Ref', secondReferee: 'Stranger' };
    expect(roster.idOnSlot(legacy, '1. SR')).toBe('c1');
    expect(roster.idOnSlot(legacy, '2. SR')).toBe('');
    expect(coacheeIdOnSlot(legacy, '1. SR', coacheeIndex([one], 2026))).toBe('c1');
    // ...and to nobody without a legacy index to ask.
    expect(coacheeIdOnSlot(legacy, '1. SR')).toBe('');
  });

  test('an id of another season\'s row: nobody when the person has no row this season; a seasonless row is every season\'s', () => {
    expect(roster.onSlot({ firstReferee: 'Ref Old', firstCoacheeId: 'c3' }, '1. SR')).toBeUndefined();
    expect(roster.onSlot({ firstCoacheeId: 'c4' }, '1. SR')).toBe(undated);
    expect(roster.byId.has('c3')).toBe(false);
  });

  test('an id of another season\'s row is carried over to this season\'s row of the same person: by number, else by name', () => {
    // A July test game belongs to the season just ended, a past-games list
    // reaches back, an observation group keeps the row its first report
    // was filed on: the server names last season's row, the screen wants
    // this season's badge for the same person — as the name index gave it.
    expect(roster.onSlot({ firstReferee: 'Zzz Licence', firstCoacheeId: 'c1-2025' }, '1. SR')).toBe(one);
    expect(roster.idOnSlot({ firstReferee: 'Zzz Licence', firstCoacheeId: 'c1-2025' }, '1. SR')).toBe('c1');
    expect(roster.onSlot({ firstReferee: 'Ref Two', firstCoacheeId: 'c2-2025' }, '1. SR')).toBe(two);
    expect(roster.resolve({ id: 'c1-2025', name: 'One R.' })).toBe(one);
    expect(roster.resolve({ id: 'c2-2025', name: 'ref two' })).toBe(two);
    // An id the roster does not hold at all falls to the name too.
    expect(roster.resolve({ id: 'c-gone', name: 'Ref Two' })).toBe(two);
    expect(roster.resolve({ id: 'c-gone', name: 'Nobody' })).toBeUndefined();
  });

  test('a reference resolves by id when the field is present, by name only when it is not', () => {
    expect(roster.resolve({ id: 'c2', name: 'Somebody Else' })).toBe(two);
    expect(roster.resolve({ id: '', name: 'Ref Two' })).toBeUndefined();
    expect(roster.resolve({ name: 'ref two' })).toBe(two);
  });

  test('the number a submit claims is the row\'s only when it is the slot\'s own', () => {
    // The server's guard refuses any OTHER number outright (claimNamesRow
    // does not look a numbered claim up), and two thirds of stored slots
    // carry none: the row's number against such a slot was a 422 on the
    // manual upload for every linked coachee.
    expect(svClaimOnSlot({ firstRefereeId: '90001', secondRefereeId: '' }, '1. SR', one)).toBe('90001');
    expect(svClaimOnSlot({ firstRefereeId: '', secondRefereeId: '' }, '1. SR', one)).toBe('');
    expect(svClaimOnSlot({ firstRefereeId: '90009', secondRefereeId: '90001' }, '1. SR', one)).toBe('');
    expect(svClaimOnSlot({ firstRefereeId: '90009', secondRefereeId: '90001' }, '2. SR', one)).toBe('90001');
    // An unlinked row, a row nobody resolved, an API without the numbers.
    expect(svClaimOnSlot({ firstRefereeId: '90001' }, '1. SR', { ...two, referee_id: '' })).toBe('');
    expect(svClaimOnSlot({ firstRefereeId: '90001' }, '1. SR', undefined)).toBe('');
    expect(svClaimOnSlot({}, '1. SR', one)).toBe('');
  });
});

test.describe('isMyGame / isMyRecord', () => {
  const me = { rcId: 'rc1', rcName: 'Anna Muster' };
  const known = new Set(['rc1', 'rc2']);

  test('the id decides when the row has one', () => {
    expect(isMyGame({ assignedRc: 'ANNA  MÜSTER', assignedRcId: 'rc1' }, me, known)).toBe(true);
    expect(isMyGame({ assignedRc: 'Anna Muster', assignedRcId: 'rc2' }, me, known)).toBe(false);
  });

  test('an id nobody knows, or none at all, falls to the folded name', () => {
    expect(isMyGame({ assignedRc: 'Anna Muster', assignedRcId: 'rc-gone' }, me, known)).toBe(true);
    expect(isMyGame({ assignedRc: 'anna muster' }, me, known)).toBe(true);
    expect(isMyGame({ assignedRc: 'Bea Beispiel' }, me, known)).toBe(false);
    // Nobody at all is not me.
    expect(isMyGame({ assignedRc: '', assignedRcId: '' }, me, known)).toBe(false);
  });

  test('a session without an id is matched on its name', () => {
    expect(isMyGame({ assignedRc: 'Anna Muster', assignedRcId: 'rc1' }, { rcId: null, rcName: 'Anna Muster' })).toBe(true);
  });

  test('the same rule on a filed record', () => {
    expect(isMyRecord({ rc_id: 'rc1', rc_name: 'somebody' }, me, known)).toBe(true);
    expect(isMyRecord({ rc_id: 'rc2', rc_name: 'Anna Muster' }, me, known)).toBe(false);
    expect(isMyRecord({ rc_name: 'Anna Muster' }, me, known)).toBe(true);
  });
});

test.describe('coachee URL token', () => {
  const linked = { id: 'c1', referee_id: '90003', season: 2026 };
  const unlinked = { id: 'c2', referee_id: '', season: 2026 };
  const lastYear = { id: 'c3', referee_id: '90004', season: 2025 };
  const undated = { id: 'c4' };
  const roster = [linked, unlinked, lastYear, undated];

  test('emits the SV number when linked, the record id until then', () => {
    expect(coacheeUrlToken(linked)).toBe('90003');
    expect(coacheeUrlToken(unlinked)).toBe('c2');
    expect(coacheeUrlToken({ id: 'c9', referee_id: '  ' })).toBe('c9');
    expect(coacheeUrlToken({ id: 'c9' })).toBe('c9');
  });

  test('resolves the SV in the season on screen', () => {
    expect(resolveCoacheeToken('90003', roster, 2026)).toEqual({ row: linked, otherSeason: false });
  });

  test('resolves the record id — the permanent second shape', () => {
    expect(resolveCoacheeToken('c1', roster, 2026)?.row).toBe(linked);
    expect(resolveCoacheeToken('c2', roster, 2026)?.row).toBe(unlinked);
    expect(resolveCoacheeToken('c4', roster, 2026)?.row).toBe(undated);
  });

  test('a row of last season only is reported as such, not as missing', () => {
    expect(resolveCoacheeToken('90004', roster, 2026)).toEqual({ row: lastYear, otherSeason: true });
    expect(resolveCoacheeToken('c3', roster, 2026)).toEqual({ row: lastYear, otherSeason: true });
  });

  test('with rows in both seasons the season on screen wins', () => {
    const now = { id: 'c5', referee_id: '90005', season: 2026 };
    const then = { id: 'c6', referee_id: '90005', season: 2025 };
    expect(resolveCoacheeToken('90005', [then, now], 2026)?.row).toBe(now);
    expect(resolveCoacheeToken('90005', [then, now], 2025)?.row).toBe(then);
  });

  test('tokens are compared trimmed, never by shape', () => {
    expect(resolveCoacheeToken(' 90003 ', roster, 2026)?.row).toBe(linked);
    // An all-digit record id is still a record id.
    const digits = { id: '123456789012345', referee_id: '', season: 2026 };
    expect(resolveCoacheeToken('123456789012345', [digits], 2026)?.row).toBe(digits);
  });

  test('nothing, blank or unknown', () => {
    expect(resolveCoacheeToken('', roster, 2026)).toBeNull();
    expect(resolveCoacheeToken('nobody', roster, 2026)).toBeNull();
  });
});

test.describe('game URL token', () => {
  const season = 2026;
  const g1 = { id: 'g1', matchNo: '2345678', date: '2026-10-03T18:00:00Z' };
  const g2 = { id: 'g2', matchNo: '2345679', date: '2026-10-04T18:00:00Z' };
  const manual = { id: 'gm', matchNo: 'TEST-20260916-a1b2', isManual: true, date: '2026-10-05T18:00:00Z' };
  const blank = { id: 'gb', matchNo: '', date: '2026-10-06T18:00:00Z' };
  const list = [g1, g2, manual, blank];

  test('a unique number is the token; a manual game and a blank number keep the record id', () => {
    expect(gameUrlToken(g1, list)).toBe('2345678');
    expect(gameUrlToken(manual, list)).toBe('gm');
    expect(gameUrlToken(blank, list)).toBe('gb');
  });

  test('two eligible games with one number: the record id, for both', () => {
    const twin = { id: 'g3', matchNo: '2345678', date: '2025-10-03T18:00:00Z' };
    expect(gameUrlToken(g1, [...list, twin])).toBe('g1');
    expect(gameUrlToken(twin, [...list, twin])).toBe('g3');
  });

  test('a game that left the list keeps the record id', () => {
    // The number would resolve to nothing — or, worse, to another game
    // carrying it — so it is not emitted for a game the list no longer holds.
    expect(gameUrlToken({ id: 'gone', matchNo: '2345678' }, list)).toBe('gone');
  });

  test('resolves by number, then by record id', () => {
    expect(resolveGameToken('2345678', list, season)).toBe(g1);
    expect(resolveGameToken('g2', list, season)).toBe(g2);
    expect(resolveGameToken('gm', list, season)).toBe(manual);
    // A typed /form/TEST-…/1sr is just a number and resolves when unique.
    expect(resolveGameToken('TEST-20260916-a1b2', list, season)).toBe(manual);
  });

  test('a number reused across seasons opens the game of the season on screen', () => {
    const old = { id: 'g-old', matchNo: '2345678', date: '2025-10-03T18:00:00Z' };
    expect(resolveGameToken('2345678', [old, g1], 2026)).toBe(g1);
    expect(resolveGameToken('2345678', [old, g1], 2025)).toBe(old);
  });

  test('with no hit in season, the first of the list — newest, as the API sorts it', () => {
    // The caller's own season guard then refuses it with the usual notice;
    // what matters here is that the answer is deterministic.
    const older = { id: 'g-older', matchNo: '2345678', date: '2023-10-03T18:00:00Z' };
    const old = { id: 'g-old', matchNo: '2345678', date: '2024-10-03T18:00:00Z' };
    expect(resolveGameToken('2345678', [old, older], 2026)).toBe(old);
  });

  test('trimmed, blank and unknown', () => {
    expect(resolveGameToken(' 2345678 ', list, season)).toBe(g1);
    expect(resolveGameToken('', list, season)).toBeUndefined();
    expect(resolveGameToken('9999999', list, season)).toBeUndefined();
  });

  test('a token that is both a number and a record id: the number wins', () => {
    // Nothing prevents a record id from looking like a number; the number
    // tier is asked first so both phones agree on what the address means.
    const oddId = { id: '2345678', matchNo: '7654321', date: '2026-10-03T18:00:00Z' };
    expect(resolveGameToken('2345678', [oddId, g1], season)).toBe(g1);
  });
});

test.describe('buildCoacheeIndex', () => {
  // The live case, 16.09.2026: VolleyManager prints the licence name, the
  // coaching sheet the everyday one, and no spelling is common to both.
  const kevin = { id: 'c-kevin', full_name: 'Kevin Peña', first_name: 'Kevin', last_name: 'Peña', referee_id: '90003', season: 2026 };
  const kevinLastYear = { ...kevin, id: 'c-kevin-25', season: 2025 };
  const bea = { id: 'c-bea', full_name: 'Bea Beispiel', first_name: 'Bea', last_name: 'Beispiel', referee_id: '', season: 2026 };
  const oldTimer = { id: 'c-old', full_name: 'Old Timer', referee_id: '', season: null };
  const namesake = { id: 'c-namesake', full_name: 'Kevin Peña', referee_id: '90009', season: 2024 };
  const register = [
    { sv_number: '90003', first_name: 'Kevin León', last_name: 'Peña de los Santos', full_name: 'Kevin León Peña de los Santos' },
    { sv_number: '90004', first_name: 'Bea', last_name: 'Beispiel', full_name: 'Bea Beispiel' },
    // Two licences under one name: the register tier must answer nothing.
    { sv_number: '90010', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
    { sv_number: '90011', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
  ];
  const rows = [bea, kevin, kevinLastYear, namesake, oldTimer];
  const mismatches: SvMismatch[] = [];
  const index = buildCoacheeIndex(rows, register, (m) => mismatches.push(m));

  test('the number on both sides: matched whatever the convocation spells', () => {
    expect(index.find(2026, { sv: '90003', name: 'Kevin León Peña de los Santos' }))
      .toEqual({ row: kevin, via: 'sv' });
  });

  test('the number on the game, an unlinked row: the name decides', () => {
    // Bea's row carries no number yet; her game does. Nothing to compare the
    // number with, so the fold answers — as it did before the numbers existed.
    expect(index.find(2026, { sv: '90004', name: 'Bea Beispiel' })).toEqual({ row: bea, via: 'name' });
    expect(index.find(2026, { sv: '90004', name: 'Beispiel Bea' })).toEqual({ row: bea, via: 'name' });
  });

  test('no number on the game, the register spells the licence name: the register tier', () => {
    // The whole point: "Kevin León Peña de los Santos" (VolleyManager, no
    // number on the slot) reaches the "Kevin Peña" row through the licence.
    expect(index.find(2026, { name: 'Kevin León Peña de los Santos' })).toEqual({ row: kevin, via: 'register' });
    expect(index.find(2026, { name: 'Peña de los Santos Kevin León' })).toEqual({ row: kevin, via: 'register' });
  });

  test('a register name two licences share resolves to no number', () => {
    const max = { id: 'c-max', full_name: 'Max Muster', referee_id: '90010', season: 2026 };
    const withMax = buildCoacheeIndex([...rows, max], register);
    // The name tier still finds the row — by its spelling, not its number.
    expect(withMax.find(2026, { name: 'Max Muster' })).toEqual({ row: max, via: 'name' });
    expect(withMax.find(2026, { name: 'Muster Max' })).toEqual({ row: max, via: 'name' });
  });

  test('the register is only asked for a slot without a number', () => {
    // A number on the slot that no row carries: the register would also say
    // 90003 for this name, but the sv tier has already asked and missed.
    expect(index.find(2026, { sv: '99999', name: 'Kevin León Peña de los Santos' })).toEqual({ row: null, via: 'none' });
  });

  test('a row of another season never answers, by number or by name', () => {
    expect(index.find(2023, { sv: '90003', name: 'Kevin Peña' })).toEqual({ row: null, via: 'none' });
    expect(index.find(2027, { name: 'Bea Beispiel' })).toEqual({ row: null, via: 'none' });
    expect(index.has(2027, { name: 'Bea Beispiel' })).toBe(false);
  });

  test('the row of the game\'s season, then a seasonless one', () => {
    expect(index.find(2025, { sv: '90003' })?.row).toBe(kevinLastYear);
    expect(index.find(2026, { sv: '90003' })?.row).toBe(kevin);
    expect(index.find(2019, { name: 'Old Timer' })?.row).toBe(oldTimer);
  });

  test('a null game season is an undated fixture and matches any row', () => {
    expect(index.find(null, { sv: '90003' })?.row).toBe(kevin);
    expect(index.find(null, { name: 'Kevin Peña' })?.row).toBe(kevin);
    expect(index.has(null, { name: 'Old Timer' })).toBe(true);
  });

  test('a name hit whose row carries another number is accepted, via name, and reported', () => {
    mismatches.length = 0;
    expect(index.find(2024, { sv: '90003', name: 'Kevin Peña', matchNo: '2345678' }))
      .toEqual({ row: namesake, via: 'name' });
    expect(mismatches).toEqual([{ matchNo: '2345678', name: 'Kevin Peña', gameSv: '90003', rowSv: '90009' }]);
  });

  test('no report when either side has no number', () => {
    mismatches.length = 0;
    index.find(2026, { sv: '90004', name: 'Bea Beispiel', matchNo: '1' });
    index.find(2026, { name: 'Kevin Peña', matchNo: '2' });
    expect(mismatches).toEqual([]);
  });

  test('an empty register is the old name index with the number in front', () => {
    const bare = buildCoacheeIndex(rows, []);
    expect(bare.find(2026, { sv: '90003', name: 'whoever' })?.via).toBe('sv');
    expect(bare.find(2026, { name: 'Kevin León Peña de los Santos' })).toEqual({ row: null, via: 'none' });
    expect(bare.find(2026, { name: 'Peña Kevin' })?.via).toBe('name');
  });

  test('nothing to ask with is nothing found', () => {
    expect(index.find(2026, {})).toEqual({ row: null, via: 'none' });
    expect(index.find(2026, { sv: ' ', name: '' })).toEqual({ row: null, via: 'none' });
  });

  test('two same-season rows with one number: the first in roster order', () => {
    const twins = buildCoacheeIndex([
      { id: 'a', full_name: 'A Person', referee_id: '1', season: 2026 },
      { id: 'b', full_name: 'B Person', referee_id: '1', season: 2026 },
    ], []);
    expect(twins.find(2026, { sv: '1' })?.row.id).toBe('a');
  });

  test('size counts distinct spellings, for the diagnostics', () => {
    expect(buildCoacheeIndex([kevin, kevinLastYear], []).size).toBe(2); // "kevin pena", "pena kevin"
  });

  test('coacheeRowNames folds nothing and lists every column the schemas ever carried', () => {
    expect(coacheeRowNames({ full_name: 'Kevin Peña', name: 'K. Peña', first_name: 'Kevin', last_name: 'Peña' }))
      .toEqual(['Kevin Peña', 'K. Peña', 'Kevin Peña', 'Peña Kevin']);
    expect(coacheeRowNames({ vorname: 'Bea', nachname: 'Beispiel' })).toEqual(['Bea Beispiel', 'Beispiel Bea']);
    expect(coacheeRowNames({})).toEqual([]);
  });
});

test.describe('findOrNewest — the submit\'s and the reminder\'s lookup', () => {
  // Rita was renamed on this season's sheet, and the register link did not
  // reach the new spelling: her 2026 row carries no number, her 2025 row
  // does. The game names her by the new spelling and carries her number.
  const rita26 = { id: 'r26', full_name: 'Rita Zwahlen-Meier', referee_id: '', season: 2026 };
  const rita25 = { id: 'r25', full_name: 'Rita Zwahlen', referee_id: '90003', season: 2025 };
  const rita24 = { id: 'r24', full_name: 'Rita Zwahlen', referee_id: '90003', season: 2024 };
  const undated = { id: 'u', full_name: 'Ulla Undatiert', referee_id: '', season: null };
  const index = buildCoacheeIndex([rita24, rita25, rita26, undated], []);

  test('the game\'s own season is asked completely before any other season', () => {
    // The number is linked on last season's row only; the name resolves
    // this season's row — the one every list matched the game to. The
    // report is filed there, not on last season's row.
    expect(index.findOrNewest(2026, { sv: '90003', name: 'Rita Zwahlen-Meier' })).toEqual({ row: rita26, via: 'name' });
  });

  test('with nothing in the season, the other seasons answer newest first', () => {
    // A referee carried over without a re-import: a slightly stale row
    // still beats no recipient, and the newest one is the least stale.
    expect(index.findOrNewest(2027, { sv: '90003', name: 'Rita Zwahlen' })).toEqual({ row: rita25, via: 'sv' });
    expect(index.findOrNewest(2027, { name: 'Zwahlen Rita' })).toEqual({ row: rita25, via: 'name' });
  });

  test('a seasonless row is this season\'s row, and answers before last season\'s', () => {
    // The lists read a seasonless row as every season's; the row they show
    // a game under is the row the report goes on — not a newer seasoned
    // row the lists would never have matched the game to.
    const seasonless = { id: 's', full_name: 'Kevin Peña', referee_id: '', season: null };
    const last = { id: 'l', full_name: 'Kevin Peña', referee_id: '', season: 2025 };
    const both = buildCoacheeIndex([last, seasonless], []);
    expect(both.findOrNewest(2026, { name: 'Kevin Peña' })?.row).toBe(seasonless);
    expect(both.findOrNewest(2025, { name: 'Kevin Peña' })?.row).toBe(last);
  });

  test('a game with no season takes the newest row there is', () => {
    expect(index.findOrNewest(null, { name: 'Rita Zwahlen' })?.row).toBe(rita25);
    expect(index.findOrNewest(null, { name: 'Ulla Undatiert' })?.row).toBe(undated);
  });

  test('with no seasoned row at all, the any-season answer', () => {
    const bare = buildCoacheeIndex([undated], []);
    expect(bare.findOrNewest(2026, { name: 'Ulla Undatiert' })?.row).toBe(undated);
    expect(bare.findOrNewest(null, { name: 'Ulla Undatiert' })?.row).toBe(undated);
  });

  test('nobody is nobody in every season', () => {
    expect(index.findOrNewest(2026, { sv: '1', name: 'Nie Da' })).toEqual({ row: null, via: 'none' });
    expect(index.findOrNewest(null, {})).toEqual({ row: null, via: 'none' });
  });
});

test.describe('the guard\'s second look (claimNamesRow)', () => {
  // The manual upload dialog names the coachee as the sheet spells them; the
  // slot prints the licence name. No fold makes the two meet.
  const kevin = { id: 'c-kevin', full_name: 'Kevin Peña', referee_id: '90003', season: 2026 };
  const bea = { id: 'c-bea', full_name: 'Bea Beispiel', referee_id: '', season: 2026 };
  const register = [
    { sv_number: '90003', first_name: 'Kevin León', last_name: 'Peña de los Santos', full_name: 'Kevin León Peña de los Santos' },
  ];
  const index = buildCoacheeIndex([bea, kevin], register);
  const licence = { name: 'Kevin León Peña de los Santos', sv: '90003', matchNo: '1' };

  test('the everyday name on the claim, the licence name on the slot: one row', () => {
    expect(claimNamesSlot({ name: 'Kevin Peña', sv: '' }, licence)).toBe(false);
    expect(claimNamesRow(index, 2026, { name: 'Kevin Peña', sv: '' }, licence)).toBe(true);
    // The slot without a number still reaches the row through the register.
    expect(claimNamesRow(index, 2026, { name: 'Peña Kevin', sv: '' }, { ...licence, sv: '' })).toBe(true);
  });

  test('another coachee is another row', () => {
    expect(claimNamesRow(index, 2026, { name: 'Bea Beispiel', sv: '' }, licence)).toBe(false);
  });

  test('a claim carrying a number, or no name, is not looked up', () => {
    expect(claimNamesRow(index, 2026, { name: 'Kevin Peña', sv: '90009' }, licence)).toBe(false);
    expect(claimNamesRow(index, 2026, { name: '', sv: '' }, licence)).toBe(false);
  });

  test('a slot nobody resolves, or a claim nobody resolves, is refused', () => {
    expect(claimNamesRow(index, 2026, { name: 'Kevin Peña', sv: '' }, { name: 'Gast Ohne Akte', sv: '' })).toBe(false);
    expect(claimNamesRow(index, 2026, { name: 'Nie Da', sv: '' }, licence)).toBe(false);
  });
});

test.describe('the submit guard (claimNamesSlot)', () => {
  const slot = { name: 'Kevin León', sv: '90003' };

  test('the claimed name in either order, accents folded', () => {
    expect(claimNamesSlot({ name: 'Leon Kevin', sv: '' }, slot)).toBe(true);
    expect(claimNamesSlot({ name: 'kevin leon', sv: '' }, slot)).toBe(true);
  });

  test('a different person is refused', () => {
    expect(claimNamesSlot({ name: 'Bea Beispiel', sv: '' }, slot)).toBe(false);
  });

  test('the slot\'s number on the claim passes, whatever the name field says', () => {
    expect(claimNamesSlot({ name: 'Kevin Peña', sv: '90003' }, slot)).toBe(true);
    expect(claimNamesSlot({ name: '', sv: '90003' }, slot)).toBe(true);
  });

  test('another number on the claim does not, unless the names agree', () => {
    expect(claimNamesSlot({ name: 'Kevin Peña', sv: '90009' }, slot)).toBe(false);
    expect(claimNamesSlot({ name: 'Kevin León', sv: '90009' }, slot)).toBe(true);
  });

  test('a slot without a number is a name comparison only', () => {
    expect(claimNamesSlot({ name: 'Bea Beispiel', sv: '90003' }, { name: 'Kevin León', sv: '' })).toBe(false);
    expect(claimNamesSlot({ name: 'León Kevin', sv: '' }, { name: 'Kevin León', sv: '' })).toBe(true);
  });

  test('nothing to compare lets the submit through to the checks that do', () => {
    expect(claimNamesSlot({ name: '', sv: '' }, slot)).toBe(true);
    expect(claimNamesSlot({ name: 'Anyone', sv: '' }, { name: '', sv: '' })).toBe(true);
  });
});

// ── The identity audit (server/identityAudit.ts) ─────────────────────
// What the "Datenqualität" card lists: every place a name still decides.
// The classifier is pure and reuses the app's own lookups (registerCandidates,
// buildCoacheeIndex, resolveRcName), so what it reports is what the lists do.

test.describe('identityAudit — the classifier', () => {
  const register = [
    { id: 'r1', sv_number: '90003', first_name: 'Rita', last_name: 'Zwahlen', full_name: 'Rita Zwahlen' },
    { id: 'r2', sv_number: '90004', first_name: 'Jürg Peter', last_name: 'Müller', full_name: 'Jürg Peter Müller' },
    // One name, two licences.
    { id: 'r3', sv_number: '90005', first_name: 'Doppel', last_name: 'Name', full_name: 'Doppel Name' },
    { id: 'r4', sv_number: '90006', first_name: 'Doppel', last_name: 'Name', full_name: 'Doppel Name' },
    { id: 'r5', sv_number: '90007', first_name: 'Peter', last_name: 'Pfeifer', full_name: 'Peter Pfeifer' },
  ];
  const coachees = [
    { id: 'c1', full_name: 'Rita Zwahlen', first_name: 'Rita', last_name: 'Zwahlen', season: 2026, referee_id: '90003' },
    // Unlinked, the everyday name against the licence's middle name: one
    // candidate by its words (planCoacheeLinks' word-subset rule).
    { id: 'c2', full_name: 'Jürg Müller', first_name: 'Jürg', last_name: 'Müller', season: 2026, referee_id: '' },
    { id: 'c3', full_name: 'Nie Registriert', first_name: 'Nie', last_name: 'Registriert', season: 2026, referee_id: '' },
    { id: 'c4', full_name: 'Doppel Name', first_name: 'Doppel', last_name: 'Name', season: 2026, referee_id: '' },
    // Unlinked, and the one licence the register offers is c1's already.
    { id: 'c5', full_name: 'Zwahlen Rita', first_name: 'Rita', last_name: 'Zwahlen', season: 2026, referee_id: '' },
    // Last season's rows never show under this season.
    { id: 'c6', full_name: 'Alt Saison', first_name: 'Alt', last_name: 'Saison', season: 2025, referee_id: '' },
    // Two rows of the season on one number.
    { id: 'c7', full_name: 'Peter Pfeifer', first_name: 'Peter', last_name: 'Pfeifer', season: 2026, referee_id: '90007' },
    { id: 'c8', full_name: 'Peter Pfeifer-Meier', first_name: 'Peter', last_name: 'Pfeifer-Meier', season: 2026, referee_id: '90007' },
    // The same number on last season's row is not a duplicate of this season's.
    { id: 'c9', full_name: 'Peter Pfeifer', first_name: 'Peter', last_name: 'Pfeifer', season: 2025, referee_id: '90007' },
  ];
  const games = [
    // Both slots numbered — nothing to report on either.
    { id: 'g1', match_no: '1000001', match_date: '2026-10-01T19:00:00Z', home_team: 'A', away_team: 'B', first_referee: 'Rita Zwahlen', first_referee_id: '90003', second_referee: 'Peter Pfeifer', second_referee_id: '90007', assigned_rc: 'Anna Muster', assigned_rc_id: 'rc1' },
    // 1. SR: no number, spelled like the unlinked row c2 (the register spells
    // the licence with the middle name, which no spelling matches) → name
    // tier. 2. SR: no number, nobody.
    { id: 'g2', match_no: '1000002', match_date: '2026-10-02T19:00:00Z', home_team: 'C', away_team: 'D', first_referee: 'Jürg Müller', first_referee_id: '', second_referee: 'Gast Ohne Akte', second_referee_id: '', assigned_rc: 'Anna Muster', assigned_rc_id: '' },
    // 1. SR: a number the roster does not know, the name resolves c1 → the
    // row's number contradicts the slot's. 2. SR: a number, nobody — not listed.
    { id: 'g3', match_no: '1000003', match_date: '2026-10-03T19:00:00Z', home_team: 'E', away_team: 'F', first_referee: 'Rita Zwahlen', first_referee_id: '90099', second_referee: 'Gast Mit Nummer', second_referee_id: '90098', assigned_rc: '', assigned_rc_id: '' },
    // Last season: its by-name slot is not this season's problem, but its
    // number repeats this season's g1.
    { id: 'g4', match_no: '1000001', match_date: '2025-10-01T19:00:00Z', home_team: 'G', away_team: 'H', first_referee: 'Alt Saison', first_referee_id: '', second_referee: '', second_referee_id: '', assigned_rc: 'Anna Muster', assigned_rc_id: '' },
    // No number at all — a manual game from before the default.
    { id: 'g5', match_no: '', match_date: '2026-11-11T19:00:00Z', home_team: 'Heim', away_team: 'Gast', first_referee: '', first_referee_id: '', second_referee: '', second_referee_id: '', assigned_rc: 'Gone Coach', assigned_rc_id: 'rc-gone' },
  ];
  const rcPeople = [
    { id: 'rc1', fullName: 'Anna Muster', aliases: [], svNumber: '80001', active: true },
    { id: 'rc2', fullName: 'Bea Beispiel', aliases: [], svNumber: '', active: true },
    { id: 'rc3', fullName: 'Zwei Gleich', aliases: [], svNumber: '', active: true },
    { id: 'rc4', fullName: 'Zwei Gleich', aliases: [], svNumber: '', active: false },
    { id: 'rc5', fullName: 'Weg Gezogen', aliases: [], svNumber: '', active: false },
  ];
  const feedbacks = [
    { id: 'f1', rc_id: 'rc1', rc_name: 'Anna Muster', game: 'g1', role_assessed: '1. SR', submitted_at: '2026-10-01T22:00:00Z' },
    // The id of a coach no row of the people table carries.
    { id: 'f2', rc_id: 'rc-gone', rc_name: 'Gone Coach', game: 'g1', role_assessed: '2. SR', submitted_at: '2026-10-01T22:00:00Z' },
    // Filed by a coach who has since left: the id is still known.
    { id: 'f3', rc_id: 'rc5', rc_name: 'Weg Gezogen', game: 'g2', role_assessed: '1. SR', submitted_at: '2026-10-02T22:00:00Z' },
    // Its game is gone; placed by the day it was filed — last season.
    { id: 'f4', rc_id: '', rc_name: 'Anna Muster', game: 'gone', role_assessed: '1. SR', submitted_at: '2025-12-01T22:00:00Z' },
  ];
  const rcNotes = [
    // No id, and a name two coaches answer to: migrate-rc-ids cannot fix it.
    { id: 'n1', rc_id: '', rc_name: 'Zwei Gleich', game: 'g1', season: 2026, submitted_at: '2026-10-01T22:00:00Z' },
  ];
  const presidentNotes = [
    { id: 'f1', rcId: 'rc1', rcName: 'Anna Muster', matchNo: '1000001' },
    { id: 'f9', rcId: '', rcName: 'Anna Muster', matchNo: '', teams: 'A vs B', gameDate: '2026-10-01T19:00:00Z' },
  ];
  const report = identityAudit({ season: 2026, coachees, register, games, manualIds: new Set(['g5']), feedbacks, rcNotes, presidentNotes, rcPeople });

  test('unlinked coachees, each with why and whom the register offers', () => {
    expect(report.coacheesUnlinked.map((c) => [c.id, c.reason, c.candidates.map((x) => x.sv)])).toEqual([
      ['c2', 'never-linked', ['90004']],
      ['c3', 'unmatched', []],
      ['c4', 'ambiguous', ['90005', '90006']],
      // The one candidate is c1's licence this season: a person decides.
      ['c5', 'ambiguous', ['90003']],
    ]);
    expect(report.coacheesUnlinked[0]).toMatchObject({ name: 'Jürg Müller', season: 2026, candidates: [{ sv: '90004', name: 'Jürg Peter Müller' }] });
  });

  test('two rows of one season on one number — the other season\'s row is not a third', () => {
    expect(report.duplicateSvPerSeason).toEqual([
      { sv: '90007', season: 2026, rowIds: ['c7', 'c8'], names: ['Peter Pfeifer', 'Peter Pfeifer-Meier'] },
    ]);
  });

  test('a slot whose number contradicts the row its name resolved', () => {
    expect(report.svDisagreesWithGame).toEqual([
      { coacheeId: 'c1', coacheeName: 'Rita Zwahlen', rowSv: '90003', gameId: 'g3', matchNo: '1000003', label: '#1000003', slot: '1. SR', slotSv: '90099', name: 'Rita Zwahlen' },
    ]);
  });

  test('the slots the number did not settle, this season only; numbered strangers are not listed', () => {
    expect(report.gameSlotsByName).toEqual([
      { gameId: 'g2', matchNo: '1000002', label: '#1000002', slot: '1. SR', name: 'Jürg Müller', via: 'name', coacheeId: 'c2' },
      { gameId: 'g2', matchNo: '1000002', label: '#1000002', slot: '2. SR', name: 'Gast Ohne Akte', via: 'none', coacheeId: '', registerHits: 0 },
      { gameId: 'g3', matchNo: '1000003', label: '#1000003', slot: '1. SR', name: 'Rita Zwahlen', via: 'name', coacheeId: 'c1' },
    ]);
    // g2's two slots; g4 is last season's, g5 prints nobody. The register
    // spells neither of g2's names once, so the backfill would number none.
    expect(report.gameSlotsNoSv).toBe(2);
    expect(report.gameSlotsNoSvInRegister).toBe(0);
  });

  test('a nobody the register holds is the backfill\'s, not "not in the register"; two licences under the name are said so', () => {
    // Licensed referees who are nobody's coachee: the register spells one
    // of them once (the backfill numbers that slot, and a numbered stranger
    // is not listed), the other under two licences (a person decides).
    const withGuests = identityAudit({
      season: 2026, coachees: [coachees[0]], register, manualIds: new Set(), feedbacks: [], rcNotes: [], presidentNotes: [], rcPeople,
      games: [
        { id: 'g6', match_no: '1000006', match_date: '2026-10-06T19:00:00Z', home_team: 'A', away_team: 'B', first_referee: 'Jürg Peter Müller', first_referee_id: '', second_referee: 'Doppel Name', second_referee_id: '', assigned_rc: '', assigned_rc_id: '' },
        // A blank match number is labelled by teams and day, never the record id.
        { id: 'g7', match_no: '', match_date: '2026-10-07T19:00:00Z', home_team: 'Heim', away_team: 'Gast', first_referee: 'Gast Ohne Akte', first_referee_id: '', second_referee: '', second_referee_id: '', assigned_rc: '', assigned_rc_id: '' },
      ],
    });
    expect(withGuests.gameSlotsByName).toEqual([
      { gameId: 'g6', matchNo: '1000006', label: '#1000006', slot: '2. SR', name: 'Doppel Name', via: 'none', coacheeId: '', registerHits: 2 },
      { gameId: 'g7', matchNo: '', label: 'Heim – Gast · 2026-10-07', slot: '1. SR', name: 'Gast Ohne Akte', via: 'none', coacheeId: '', registerHits: 0 },
    ]);
    expect(withGuests.gameSlotsNoSv).toBe(3);
    expect(withGuests.gameSlotsNoSvInRegister).toBe(1);
  });

  test('two unlinked rows answering to one free licence: the first is never-linked, the second ambiguous — what the link button would do', () => {
    // Classified over the same copies planCoacheeLinks writes on, in roster
    // order, so the card does not pre-fill one number on two rows.
    const twins = identityAudit({
      season: 2026, register, games: [], manualIds: new Set(), feedbacks: [], rcNotes: [], presidentNotes: [], rcPeople,
      coachees: [
        { id: 'c1', full_name: 'Rita Zwahlen', first_name: 'Rita', last_name: 'Zwahlen', season: 2026, referee_id: '' },
        { id: 'c5', full_name: 'Zwahlen Rita', first_name: 'Rita', last_name: 'Zwahlen', season: 2026, referee_id: '' },
      ],
    });
    expect(twins.coacheesUnlinked.map((c) => [c.id, c.reason])).toEqual([['c1', 'never-linked'], ['c5', 'ambiguous']]);
  });

  test('match numbers reused across seasons, and games without one, over every stored game', () => {
    expect(report.duplicateMatchNos).toEqual([{ matchNo: '1000001', gameIds: ['g1', 'g4'], seasons: [2025, 2026] }]);
    expect(report.blankMatchNo).toEqual([{ gameId: 'g5', teams: 'Heim – Gast', date: '2026-11-11T19:00:00Z' }]);
  });

  test('coach references the id does not settle: blank or unknown, and whether the migration would fix them', () => {
    expect(report.rcRefsUnresolved).toEqual([
      { source: 'games', id: 'g2', label: '#1000002', rcName: 'Anna Muster', rcId: '', reason: 'blank', resolvable: true },
      // A manual game is this season's whatever its date; its id names nobody.
      { source: 'games', id: 'g5', label: 'Heim – Gast · 2026-11-11', rcName: 'Gone Coach', rcId: 'rc-gone', reason: 'unknown', resolvable: false },
      { source: 'feedbacks', id: 'f2', label: '#1000001 · 2. SR', rcName: 'Gone Coach', rcId: 'rc-gone', reason: 'unknown', resolvable: false },
      { source: 'rc_game_notes', id: 'n1', label: '#1000001', rcName: 'Zwei Gleich', rcId: '', reason: 'blank', resolvable: false },
      { source: 'president_notes', id: 'f9', label: 'A vs B · 2026-10-01', rcName: 'Anna Muster', rcId: '', reason: 'blank', resolvable: true },
    ]);
  });

  test('a game nobody holds, a feedback by a coach who has left, and last season\'s rows are not references to fix', () => {
    const ids = report.rcRefsUnresolved.map((r) => `${r.source}:${r.id}`);
    expect(ids).not.toContain('games:g3');
    expect(ids).not.toContain('games:g4');
    expect(ids).not.toContain('feedbacks:f3');
    expect(ids).not.toContain('feedbacks:f4');
  });

  test('active coaches without their own SV number', () => {
    expect(report.rcsWithoutSv).toEqual([{ id: 'rc2', name: 'Bea Beispiel' }, { id: 'rc3', name: 'Zwei Gleich' }]);
  });

  test('another season reads its own rows', () => {
    const last = identityAudit({ season: 2025, coachees, register, games, manualIds: new Set(['g5']), feedbacks, rcNotes, presidentNotes: [], rcPeople });
    expect(last.coacheesUnlinked.map((c) => c.id)).toEqual(['c6']);
    expect(last.duplicateSvPerSeason).toEqual([]);
    expect(last.gameSlotsByName.map((s) => s.gameId)).toEqual(['g4']);
    expect(last.rcRefsUnresolved.map((r) => r.id)).toEqual(['g4', 'g5', 'f4']);
  });

  test('an empty register: every unlinked row is unmatched, nothing else changes', () => {
    const bare = identityAudit({ season: 2026, coachees, register: [], games, manualIds: new Set(), feedbacks: [], rcNotes: [], presidentNotes: [], rcPeople });
    expect(bare.coacheesUnlinked.every((c) => c.reason === 'unmatched' && c.candidates.length === 0)).toBe(true);
    expect(bare.duplicateSvPerSeason).toHaveLength(1);
  });

  test('gameLabel: the number, else teams and day — never the record id', () => {
    expect(gameLabel({ id: 'g1', match_no: '1000001', home_team: 'A', away_team: 'B' })).toBe('#1000001');
    expect(gameLabel({ id: 'g5', match_no: '', home_team: 'Heim', away_team: 'Gast', match_date: '2026-11-11T19:00:00Z' })).toBe('Heim – Gast · 2026-11-11');
    expect(gameLabel(undefined)).toBe('');
  });
});
