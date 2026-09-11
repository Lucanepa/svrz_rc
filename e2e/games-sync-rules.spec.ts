import { test, expect } from '@playwright/test';
import { isRowWanted, isVmMarkedRow, vmFactsPatch } from '../server/gamesSync';

// The two decisions the games import makes per VolleyManager row, tested on
// their own: whether the row is kept at all, and what a stored row the sync is
// NOT keeping gets refreshed with. The sync around them needs PocketBase and a
// VolleyManager session and cannot be run here.

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
});
