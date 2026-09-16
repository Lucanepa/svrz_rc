import { test, expect } from '@playwright/test';
import { isRowWanted, isVmMarkedRow, vmFactsPatch, mergeIncomingGame } from '../server/gamesSync';

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
