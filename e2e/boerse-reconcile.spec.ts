import { test, expect } from '@playwright/test';
import { planReconcile, toOfferRow, boersePollMustSkip, type BoerseOfferRow, type StoredOffer } from '../server/boerse';

/**
 * The half of the SR-Börse sync that can turn every warning off at once.
 *
 * A wrong highlight costs a phone call; a wrongly CLEARED one costs an RC an
 * evening in a hall where their coachee is not. Both guards below exist because
 * the failure they prevent has a precedent in this project: a VolleyManager role
 * drift that answered 200 with zero rows, and a nightly sync that read a short
 * page as a complete one.
 *
 * No browser, no network, no PocketBase — the sw-reload-guard idiom.
 */

const offer = (id: string, over: Partial<BoerseOfferRow> = {}): BoerseOfferRow => ({
  vm_offer_id: id, match_no: '406907', game_starts_at: '2026-09-15T18:15:00.000000+00:00',
  referee_position: 'head-one', slot: '1', status: 'open',
  slot_person_name: 'Sarah Arrenbrecht', slot_person_sv: '103767', slot_person_vm_id: 'p1',
  submitted_by_name: 'Sarah Arrenbrecht', submitted_by_sv: '103767', submitting_type: 'referee',
  submitted_at: '2026-08-23T09:30:45.000000+00:00',
  applied_by_name: '', applied_by_sv: '', applied_at: '',
  join_via: 'position+sv', raw: {}, ...over,
});

const stored = (id: string, vmId: string, over: Partial<StoredOffer> = {}): StoredOffer =>
  ({ id, vm_offer_id: vmId, status: 'open', withdrawn_at: '', ...over });

test.describe('planning what the börse sync writes', () => {
  test('creates what is new and updates what it already holds', () => {
    const plan = planReconcile({
      fetched: [offer('a'), offer('b')],
      stored: [stored('row-a', 'a')],
      emptyStreak: 0,
    });
    expect(plan.creates.map((c) => c.vm_offer_id)).toEqual(['b']);
    expect(plan.updates.map((u) => u.id)).toEqual(['row-a']);
    expect(plan.withdraws).toEqual([]);
    expect(plan.blocked).toBe('');
  });

  test('an offer that stopped appearing is withdrawn', () => {
    const plan = planReconcile({
      fetched: [offer('a')],
      stored: [stored('row-a', 'a'), stored('row-gone', 'gone')],
      emptyStreak: 0,
    });
    expect(plan.withdraws).toEqual(['row-gone']);
  });

  test('an already-withdrawn row is not withdrawn twice', () => {
    const plan = planReconcile({
      fetched: [],
      stored: [stored('row-old', 'old', { withdrawn_at: '2026-09-01T00:00:00Z' })],
      emptyStreak: 0,
    });
    expect(plan.withdraws).toEqual([]);
    expect(plan.blocked).toBe('');
  });

  // The role drift that answers 200 with zero rows is indistinguishable from a
  // genuinely empty board in a single response. One zero must not clear it.
  test('one empty answer does not clear the board', () => {
    const plan = planReconcile({
      fetched: [],
      stored: [stored('row-a', 'a')],
      emptyStreak: 0,
    });
    expect(plan.withdraws).toEqual([]);
    expect(plan.blocked).toContain('second run');
  });

  test('two empty answers in a row do clear it', () => {
    const plan = planReconcile({
      fetched: [],
      stored: [stored('row-a', 'a')],
      emptyStreak: 2,
    });
    expect(plan.withdraws).toEqual(['row-a']);
    expect(plan.blocked).toBe('');
  });

  test('a mass all-clear is refused rather than applied quietly', () => {
    const live = Array.from({ length: 20 }, (_, i) => stored(`row-${i}`, `v${i}`));
    const plan = planReconcile({ fetched: [offer('v0')], stored: live, emptyStreak: 0 });
    expect(plan.withdraws).toEqual([]);
    expect(plan.blocked).toContain('mass all-clear');
    // ...but what it DID see is still recorded, so the run is not wasted
    expect(plan.updates).toHaveLength(1);
  });

  test('a small number of withdrawals is normal and goes through', () => {
    const live = Array.from({ length: 20 }, (_, i) => stored(`row-${i}`, `v${i}`));
    const fetched = live.slice(0, 18).map((s) => offer(s.vm_offer_id));
    const plan = planReconcile({ fetched, stored: live, emptyStreak: 0 });
    expect(plan.withdraws).toEqual(['row-18', 'row-19']);
    expect(plan.blocked).toBe('');
  });
});

test.describe('reading one VolleyManager row', () => {
  const vmRow = (position: string, convocations: unknown[], status = 'open') => ({
    __identity: 'offer-1',
    status,
    refereePosition: position,
    submittedByPerson: { displayName: 'Jorge Bastante', associationId: 1 },
    submittingType: 'association',
    refereeGame: { game: { number: 406907, startingDateTime: '2026-09-15T18:15:00.000000+00:00' }, refereeConvocations: convocations },
  });

  // The whole feature rests on this join, and `submittedByPerson` is a decoy:
  // the association files on referees' behalf constantly.
  test('the slot owner is the convocation at the offered position, not the submitter', () => {
    const row = toOfferRow(vmRow('head-two', [
      { refereePosition: 'head-one', indoorAssociationReferee: { indoorReferee: { person: { displayName: 'Wrong Person', associationId: 111 } } } },
      { refereePosition: 'head-two', indoorAssociationReferee: { indoorReferee: { person: { displayName: 'Right Person', associationId: 222 } } } },
    ]));
    expect(row?.slot_person_name).toBe('Right Person');
    expect(row?.slot_person_sv).toBe('222');
    expect(row?.slot).toBe('2');
    expect(row?.join_via).toBe('position+sv');
  });

  test('an open offer with nobody convoked is an unstaffed game, not a dumped one', () => {
    const row = toOfferRow(vmRow('head-one', []));
    expect(row?.slot_person_name).toBe('');
    expect(row?.join_via).toBe('unstaffed');
  });

  test('line-judge and standby offers are ignored outright', () => {
    expect(toOfferRow(vmRow('linesman-one', []))).toBeNull();
    expect(toOfferRow(vmRow('standby-head', []))).toBeNull();
  });

  test("VM spells this one status with an underscore, and it survives the trip", () => {
    const row = toOfferRow(vmRow('head-one', [], 'not_applied'));
    expect(row?.status).toBe('not_applied');
  });
});

// The fetch reads back to a cutoff (LOOKBACK_DAYS) and stops. An offer whose
// game has fallen behind it was never looked at, so its absence is not a
// withdrawal — and counted as one, it tripped the mass all-clear guard, which
// then stayed tripped hour after hour because a blocked run stamps nothing.
test.describe('offers that aged out of the window', () => {
  const cutoff = '2026-09-20T10:00:00.000Z';
  const old = (i: number) => stored(`row-old-${i}`, `old-${i}`, { game_starts_at: '2026-09-19 18:00:00.000Z' });
  const fresh = (i: number) => stored(`row-new-${i}`, `new-${i}`, { game_starts_at: '2026-09-25 18:00:00.000Z' });

  test('are expired, not withdrawn, and do not trip the guard', () => {
    // 10 live, 6 aged out together (a weekend cluster after a missed poll).
    const plan = planReconcile({
      fetched: [0, 1, 2, 3].map((i) => offer(`new-${i}`)),
      stored: [...[0, 1, 2, 3, 4, 5].map(old), ...[0, 1, 2, 3].map(fresh)],
      emptyStreak: 0,
      cutoff,
    });
    expect(plan.blocked).toBe('');
    expect(plan.withdraws).toEqual([]);
    expect(plan.expires.sort()).toEqual([0, 1, 2, 3, 4, 5].map((i) => `row-old-${i}`).sort());
  });

  test('a real withdrawal inside the window still goes through beside them', () => {
    const plan = planReconcile({
      fetched: [0, 1, 2].map((i) => offer(`new-${i}`)),
      stored: [...[0, 1, 2, 3, 4, 5].map(old), ...[0, 1, 2, 3].map(fresh)],
      emptyStreak: 0,
      cutoff,
    });
    expect(plan.withdraws).toEqual(['row-new-3']);
    expect(plan.expires).toHaveLength(6);
    expect(plan.blocked).toBe('');
  });

  test('the guard still holds for offers the poll could have seen', () => {
    const plan = planReconcile({
      fetched: [offer('new-0')],
      stored: [...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(fresh), old(0)],
      emptyStreak: 0,
      cutoff,
    });
    expect(plan.withdraws).toEqual([]);
    expect(plan.blocked).toContain('refusing');
    // Ageing is decided on the date alone, so it goes ahead even when blocked.
    expect(plan.expires).toEqual(['row-old-0']);
  });

  test('without a cutoff (or a date) nothing is expired — the old behaviour', () => {
    const plan = planReconcile({ fetched: [offer('a')], stored: [stored('row-a', 'a'), stored('row-b', 'b')], emptyStreak: 0 });
    expect(plan.expires).toEqual([]);
    expect(plan.withdraws).toEqual(['row-b']);
  });

  test('one empty answer still holds the live board, but aged rows expire', () => {
    const plan = planReconcile({ fetched: [], stored: [old(0), fresh(0)], emptyStreak: 0, cutoff });
    expect(plan.withdraws).toEqual([]);
    expect(plan.expires).toEqual(['row-old-0']);
    expect(plan.blocked).toContain('second run');
  });
});

// wiedisync owns 04:00–04:59 UTC on the shared account. Every automatic run
// stands down in it — the startup run too, which used to ignore the skip.
test.describe('the 04:00 UTC hour', () => {
  test('automatic runs skip it, a manual run does not', () => {
    const inHour = new Date('2026-01-12T04:00:30Z');
    expect(boersePollMustSkip('cron', inHour)).toBe(true);
    expect(boersePollMustSkip('startup', inHour)).toBe(true);
    expect(boersePollMustSkip('startup', new Date('2026-07-12T04:59:59Z'))).toBe(true);
    expect(boersePollMustSkip('manual', inHour)).toBe(false);
  });
  test('the hours either side are open', () => {
    expect(boersePollMustSkip('startup', new Date('2026-01-12T03:59:59Z'))).toBe(false);
    expect(boersePollMustSkip('cron', new Date('2026-01-12T05:00:00Z'))).toBe(false);
  });
});
