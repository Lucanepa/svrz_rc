import { test, expect } from '@playwright/test';
import { isRowWanted, isVmMarkedRow, vmFactsPatch, mergeIncomingGame, boerseCrewPatch, crewChangeAction, heldGameChange, type HeldGameSide } from '../server/gamesSync';
import { readFileSync } from 'node:fs';

// The three decisions the games import makes per VolleyManager row, tested on
// their own: whether the row is kept at all, what a stored row the sync is NOT
// keeping gets refreshed with, and what a kept row is written with. The sync
// around them needs PocketBase and a VolleyManager session and cannot be run
// here.

test.describe('what the sync keeps', () => {
  test('a coachee on the row keeps it, mark or no mark', () => {
    expect(isRowWanted({ is_rd_game: false, is_rsv_game: false }, true)).toBe(true);
  });

  test("VolleyManager's RD mark keeps a row with no coachee on it", () => {
    // The whole point: an RD marks by their own criteria, and the game must
    // not depend on who happens to be a coachee to become visible.
    expect(isRowWanted({ is_rd_game: true }, false)).toBe(true);
  });

  test('so does the RSV mark', () => {
    expect(isRowWanted({ is_rsv_game: true }, false)).toBe(true);
  });

  test('a line-judge mark alone does not — it is about the linesmen', () => {
    expect(isRowWanted({ is_ld_game: true }, false)).toBe(false);
    expect(isVmMarkedRow({ is_ld_game: true })).toBe(false);
  });

  test('nothing on it, nobody on it: dropped', () => {
    expect(isRowWanted({}, false)).toBe(false);
  });
});

test.describe('what a stored, unkept row is refreshed with', () => {
  const stored = { id: 'g1', league: 'HU23 n. Liga', is_rd_game: true, is_rsv_game: false, is_ld_game: false };

  test('a mark VolleyManager took off comes off here too', () => {
    // A game that came in on its RD mark alone would otherwise stay "flagged"
    // forever: it is no longer kept, so upsertGame never sees it again.
    expect(vmFactsPatch(stored, { league: 'HU23 n. Liga', is_rd_game: false })).toEqual({ is_rd_game: false });
  });

  test('a mark VolleyManager added goes on', () => {
    expect(vmFactsPatch({ ...stored, is_rd_game: false }, { league: 'HU23 n. Liga', is_rsv_game: true }))
      .toEqual({ is_rsv_game: true });
  });

  test('the league text follows VolleyManager, as before', () => {
    expect(vmFactsPatch(stored, { league: 'U23 ♂', is_rd_game: true })).toEqual({ league: 'U23 ♂' });
  });

  test('a row that is already right costs no write', () => {
    expect(vmFactsPatch(stored, { league: 'HU23 n. Liga', is_rd_game: true })).toEqual({});
  });

  test('an empty league does not blank the stored one', () => {
    expect(vmFactsPatch(stored, { league: '', is_rd_game: true })).toEqual({});
  });

  test('names are not touched — a stale name is not this patch to fix', () => {
    const patch = vmFactsPatch(
      { ...stored, first_referee: 'Old Coachee' },
      { league: 'HU23 n. Liga', is_rd_game: true, first_referee: 'New Person' },
    );
    expect(patch).toEqual({});
  });

  test('a blank SV number is filled from the incoming row when the names fold equal', () => {
    // Two thirds of the stored games predate the number and only ever pass
    // through this patch; without this they would stay name-matched forever.
    const patch = vmFactsPatch(
      { ...stored, first_referee: 'Kevin Leon', first_referee_id: '', second_referee: 'Bea Beispiel', second_referee_id: '' },
      { league: 'HU23 n. Liga', is_rd_game: true, first_referee: 'Kevin León', first_referee_id: '90003', second_referee: 'Bea Beispiel', second_referee_id: '90004' },
    );
    expect(patch).toEqual({ first_referee_id: '90003', second_referee_id: '90004' });
  });

  test('a number is never written onto a slot whose name changed', () => {
    // A different name is a different referee; the number of one must not
    // travel with the slot to the other.
    const patch = vmFactsPatch(
      { ...stored, first_referee: 'Old Coachee', first_referee_id: '' },
      { league: 'HU23 n. Liga', is_rd_game: true, first_referee: 'New Person', first_referee_id: '90003' },
    );
    expect(patch).toEqual({});
  });

  test('a stored number is never blanked or replaced by the refresh', () => {
    const withId = { ...stored, first_referee: 'Kevin León', first_referee_id: '90003' };
    expect(vmFactsPatch(withId, { league: 'HU23 n. Liga', is_rd_game: true, first_referee: 'Kevin León', first_referee_id: '' })).toEqual({});
    expect(vmFactsPatch(withId, { league: 'HU23 n. Liga', is_rd_game: true, first_referee: 'Kevin León', first_referee_id: '90009' })).toEqual({});
  });

  test('an empty stored name earns no number', () => {
    expect(vmFactsPatch({ ...stored, first_referee: '', first_referee_id: '' }, { league: 'HU23 n. Liga', is_rd_game: true, first_referee: '', first_referee_id: '90003' })).toEqual({});
  });
});

test.describe('what a kept row is written with (mergeIncomingGame)', () => {
  const existing = {
    id: 'g1', match_no: '2345678', league: 'NLA ♂',
    first_referee: 'Kevin León', first_referee_id: '90003',
    second_referee: 'Bea Beispiel', second_referee_id: '90004',
    game_result: '3:1 (25:20 / 25:22 / 20:25 / 25:18)',
  };
  const incoming = {
    match_no: '2345678', league: 'NLA ♂',
    first_referee: 'Kevin Leon', first_referee_id: '',
    second_referee: 'Bea Beispiel', second_referee_id: '90004',
    game_result: '',
  };

  test('a blank incoming number with the same folded name keeps the stored one', () => {
    // A convocation that is only a name carries no number; dropping the one
    // an earlier sync stored would send the game back to name matching.
    expect(mergeIncomingGame(existing, incoming).first_referee_id).toBe('90003');
  });

  test('a blank incoming number with a changed name replaces it — with the blank', () => {
    // A replaced referee never inherits the previous number: that is how the
    // wrong coachee gets a report.
    const merged = mergeIncomingGame(existing, { ...incoming, first_referee: 'New Person' });
    expect(merged.first_referee).toBe('New Person');
    expect(merged.first_referee_id).toBe('');
  });

  test('a non-blank incoming number wins, equal or not', () => {
    expect(mergeIncomingGame(existing, { ...incoming, first_referee_id: '90003' }).first_referee_id).toBe('90003');
    expect(mergeIncomingGame(existing, { ...incoming, first_referee_id: '90009' }).first_referee_id).toBe('90009');
    expect(mergeIncomingGame(existing, incoming).second_referee_id).toBe('90004');
  });

  test('a missing score keeps the stored one; a published score replaces it', () => {
    expect(mergeIncomingGame(existing, incoming).game_result).toBe(existing.game_result);
    expect(mergeIncomingGame(existing, { ...incoming, game_result: '3:0 (25:1 / 25:2 / 25:3)' }).game_result).toBe('3:0 (25:1 / 25:2 / 25:3)');
    expect(mergeIncomingGame({ ...existing, game_result: '' }, incoming).game_result).toBe('');
  });

  test('everything else is the incoming row, and the stored row is not touched', () => {
    const before = { ...existing };
    const merged = mergeIncomingGame(existing, { ...incoming, league: 'NLB ♂', location: 'Halle 3' });
    expect(merged.league).toBe('NLB ♂');
    expect(merged.location).toBe('Halle 3');
    expect(merged).not.toHaveProperty('id');
    expect(existing).toEqual(before);
  });

  test('a stored number on an empty stored name is not kept', () => {
    // Nothing to say the person is the same; two empty names are nobody.
    const merged = mergeIncomingGame({ ...existing, first_referee: '' }, { ...incoming, first_referee: '' });
    expect(merged.first_referee_id).toBe('');
  });
});

test.describe('what the börse poll writes onto a whistle slot (boerseCrewPatch)', () => {
  // A coach (SV 90001) whistles slot 2 next to a coachee. The game is an
  // RC-Spiel — hidden under the coachee's row — for exactly as long as the
  // coach is on that slot.
  const game = {
    id: 'g1', match_no: '2345678',
    first_referee: 'Bea Beispiel', first_referee_id: '90004',
    second_referee: 'Coach Person', second_referee_id: '90001',
  };

  test('a row already right costs no write', () => {
    expect(boerseCrewPatch(game, [{ slot: '2', name: 'Coach Person', sv: '90001' }])).toEqual({});
  });

  test('the slot changing hands replaces the name and the number', () => {
    expect(boerseCrewPatch(game, [{ slot: '2', name: 'New Referee', sv: '90009' }]))
      .toEqual({ second_referee: 'New Referee', second_referee_id: '90009' });
  });

  test('the slot changing hands to a convocation WITHOUT a number blanks the number', () => {
    // The old rule left the number alone whenever the börse had none, so the
    // coach's number stayed on a slot they had given away — and the RC-Spiel
    // test reads the number before the name, so the game stayed hidden from
    // the coachee's row until the nightly sync.
    expect(boerseCrewPatch(game, [{ slot: '2', name: 'New Referee', sv: '' }]))
      .toEqual({ second_referee: 'New Referee', second_referee_id: '' });
  });

  test('the same person spelled differently, without a number, keeps the stored number', () => {
    // Only the spelling is corrected: the person did not change, and a
    // dropped number sends the game back to name matching.
    expect(boerseCrewPatch(game, [{ slot: '1', name: 'Béa Beispiel', sv: '' }]))
      .toEqual({ first_referee: 'Béa Beispiel' });
  });

  test('a number on the convocation always wins, equal name or not', () => {
    expect(boerseCrewPatch(game, [{ slot: '1', name: 'Bea Beispiel', sv: '90014' }])).toEqual({ first_referee_id: '90014' });
  });

  test('both slots in one pass; a convocation with no name, or on no slot, is skipped', () => {
    expect(boerseCrewPatch(game, [
      { slot: '1', name: 'Other One', sv: '90011' },
      { slot: '2', name: '', sv: '90099' },
      { slot: 'LJ', name: 'Line Judge', sv: '90098' },
    ])).toEqual({ first_referee: 'Other One', first_referee_id: '90011' });
  });
});

// A crew change that takes the last coachee off a game a coach holds (asked
// 2026-09-30: #408228 stayed booked for weeks after the Börse gave its slot to
// a referee nobody coaches). More than a week out it is released, closer it is
// kept and the coach told; only the transition counts.
test('a held game that loses its last coachee: released a week out, kept and flagged closer', () => {
  const now = '2026-10-01T10:00:00.000Z';
  const base = { held: true, now, coacheesBefore: 1, coacheesAfter: 0 };
  expect(crewChangeAction({ ...base, gameDate: '2026-11-24T19:30:00.000Z' })).toBe('release');
  expect(crewChangeAction({ ...base, gameDate: '2026-10-05T19:30:00.000Z' })).toBe('notify');
  // Exactly seven days is still "close": the coach may have planned the evening.
  expect(crewChangeAction({ ...base, gameDate: '2026-10-08T10:00:00.000Z' })).toBe('notify');
  // Already played: its report is what matters now.
  expect(crewChangeAction({ ...base, gameDate: '2026-09-28T19:30:00.000Z' })).toBe('none');
  // Nothing to do: a free game, a coachee still on it, or one that was already empty.
  expect(crewChangeAction({ ...base, held: false, gameDate: '2026-11-24T19:30:00.000Z' })).toBe('none');
  expect(crewChangeAction({ ...base, coacheesAfter: 1, gameDate: '2026-11-24T19:30:00.000Z' })).toBe('none');
  expect(crewChangeAction({ ...base, coacheesBefore: 0, gameDate: '2026-11-24T19:30:00.000Z' })).toBe('none');
});

test('both writers hand a changed held game to afterGameChange', () => {
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  // The börse poll, right after it stores a corrected crew.
  expect(server).toMatch(/crew corrected on \$\{matchNo\} from the börse[^\n]*\n\s*await afterGameChange\(game, patch, 'boerse'\)/);
  // The VolleyManager sync, when an existing game's crew, kick-off or hall moved.
  expect(server).toMatch(/\['first_referee', 'first_referee_id', 'second_referee', 'second_referee_id', 'match_date', 'location'\]/);
  expect(server).toMatch(/if \(changed\) await afterGameChange\(existing, merged, 'sync', coacheeIndex\)/);
  // The release re-reads the game under its lock and never takes it from a
  // coach who changed it meanwhile.
  const fn = server.slice(server.indexOf('async function afterGameChange'), server.indexOf('async function sendCoachNotice'));
  expect(fn).toMatch(/withGameLock\(gameId[\s\S]*?sameHolder[\s\S]*?assigned_rc: ''/);
});

// Everything else that happens to a held game reaches its coach too (asked
// 2026-10-10: "when games get moved, börse in etc there is always an email …
// also if … the other ref is an RC, so it becomes an RC game").
test.describe('what a coach is told about a game they hold', () => {
  const now = '2026-10-10T10:00:00.000Z';
  const coachee = (name: string, id: string, sv = '') => ({ name, sv, coacheeId: id, open: true });
  const referee = (name: string, sv = '') => ({ name, sv, coacheeId: '', open: true });
  const side = (o: Partial<HeldGameSide> = {}): HeldGameSide => ({
    date: '2026-10-24T15:00:00.000Z',
    location: 'Turnhalle Rämibühl, Rämistrasse 56, 8001 Zürich',
    slots: [coachee('Anna Muster', 'c1', '70001'), referee('Beat Keller', '70002')],
    rcGame: false,
    ...o,
  });
  const verdict = (before: HeldGameSide, after: HeldGameSide, held = true) => heldGameChange({ held, now, before, after });

  test('nothing changed, or nobody holds it: nothing is said', () => {
    expect(verdict(side(), side())).toEqual({ action: 'none', changes: [], purposeLost: false });
    expect(verdict(side(), side({ date: '2026-10-31T15:00:00.000Z' }), false).action).toBe('none');
  });

  test('a new kick-off is a notice and the booking stays — a second of drift is not', () => {
    const v = verdict(side(), side({ date: '2026-10-25T13:00:00.000Z' }));
    expect(v.action).toBe('notify');
    expect(v.purposeLost).toBe(false);
    expect(v.changes).toEqual([{ kind: 'moved', from: '2026-10-24T15:00:00.000Z', to: '2026-10-25T13:00:00.000Z' }]);
    expect(verdict(side(), side({ date: '2026-10-24T15:00:00+00:00' })).action).toBe('none');
  });

  test('a new hall is a notice; the same hall with its street re-spelled is not', () => {
    expect(verdict(side(), side({ location: 'Saalsporthalle, Giesshübelstrasse 41, 8045 Zürich' })).changes)
      .toEqual([{ kind: 'hall', from: 'Turnhalle Rämibühl, Rämistrasse 56, 8001 Zürich', to: 'Saalsporthalle, Giesshübelstrasse 41, 8045 Zürich' }]);
    expect(verdict(side(), side({ location: 'Turnhalle Rämibühl, Rämistr. 56, 8001 Zürich' })).action).toBe('none');
    // A hall VolleyManager only now names is not a move.
    expect(verdict(side({ location: '' }), side()).action).toBe('none');
  });

  test('one coachee swapped for another: a notice naming both, the booking stays', () => {
    const v = verdict(side(), side({ slots: [coachee('Carla Beispiel', 'c2', '70003'), referee('Beat Keller', '70002')] }));
    expect(v.action).toBe('notify');
    expect(v.changes).toEqual([
      { kind: 'coachee-left', names: ['Anna Muster'] },
      { kind: 'coachee-joined', names: ['Carla Beispiel'] },
    ]);
  });

  test('one of two coachees leaves: a notice, since the other is still there to observe', () => {
    const two = side({ slots: [coachee('Anna Muster', 'c1'), coachee('Carla Beispiel', 'c2')] });
    const v = verdict(two, side({ slots: [coachee('Anna Muster', 'c1'), referee('Dora Fremd')] }));
    expect(v).toEqual({ action: 'notify', purposeLost: false, changes: [{ kind: 'coachee-left', names: ['Carla Beispiel'] }] });
  });

  test('the last coachee leaves: released more than a week out, kept and flagged closer', () => {
    const empty = { slots: [referee('Dora Fremd'), referee('Beat Keller', '70002')] as HeldGameSide['slots'] };
    expect(verdict(side(), side(empty))).toMatchObject({ action: 'release', purposeLost: true });
    const close = { date: '2026-10-14T18:00:00.000Z' };
    expect(verdict(side(close), side({ ...close, ...empty }))).toMatchObject({ action: 'notify', purposeLost: true });
  });

  test('the other referee replaced by somebody else is told; the same person in the other name order is not', () => {
    expect(verdict(side(), side({ slots: [coachee('Anna Muster', 'c1', '70001'), referee('Erik Neu', '70009')] })).changes)
      .toEqual([{ kind: 'referee', slot: '2', from: 'Beat Keller', to: 'Erik Neu' }]);
    expect(verdict(side({ slots: [coachee('Anna Muster', 'c1'), referee('Beat Keller')] }),
      side({ slots: [coachee('Anna Muster', 'c1'), referee('Keller Beat')] })).action).toBe('none');
    // A slot merely filled is the appointments happening, not news.
    expect(verdict(side({ slots: [coachee('Anna Muster', 'c1'), referee('')] }), side()).action).toBe('none');
  });

  test('turning into an RC-Spiel is treated like losing the coachee: released a week out, kept closer', () => {
    const rc = { slots: [coachee('Anna Muster', 'c1', '70001'), referee('Rita Coach', '70100')] as HeldGameSide['slots'], rcGame: true };
    const v = verdict(side(), side(rc));
    expect(v.action).toBe('release');
    expect(v.purposeLost).toBe(true);
    expect(v.changes).toEqual([
      { kind: 'referee', slot: '2', from: 'Beat Keller', to: 'Rita Coach' },
      { kind: 'rc-game' },
    ]);
    const close = { date: '2026-10-12T18:00:00.000Z' };
    expect(verdict(side(close), side({ ...close, ...rc })).action).toBe('notify');
  });

  test('a report already sent on the coachee\'s role: their leaving is not news', () => {
    const sent = { slots: [{ ...coachee('Anna Muster', 'c1'), open: false }, referee('Beat Keller')] as HeldGameSide['slots'] };
    expect(verdict(side(sent), side({ slots: [referee('Dora Fremd'), referee('Beat Keller')] })).action).toBe('none');
  });

  test('a game already played says nothing', () => {
    const past = { date: '2026-10-03T15:00:00.000Z' };
    expect(verdict(side(past), side({ ...past, location: 'Saalsporthalle, 8045 Zürich' })).action).toBe('none');
  });
});
