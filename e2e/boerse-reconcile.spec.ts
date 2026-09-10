import { test, expect } from '@playwright/test';
import { planReconcile, toOfferRow, type BoerseOfferRow, type StoredOffer } from '../server/boerse';

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
