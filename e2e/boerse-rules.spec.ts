import { test, expect } from '@playwright/test';
import { boerseLevel, type BoerseSlotOffer, type BoerseView } from '../src/lib/boerseRules';

/**
 * The truth table for the SR-Börse row colours.
 *
 * This is the only part of the feature that can be checked exhaustively — the
 * rest needs VolleyManager, a PocketBase and a browser — and it is also the part
 * where being wrong is worst: a missed red costs an RC an evening in a hall
 * where their coachee is not.
 *
 * No `page` fixture, so it runs in milliseconds (the sw-reload-guard idiom).
 */

const open = (slot: string, name = 'Someone'): BoerseSlotOffer =>
  ({ slot, status: 'open', withdrawn: false, personName: name, personSv: '1' });

const view = (over: Partial<BoerseView> = {}): BoerseView => ({
  offers: [], coacheeSlots: [], mySlot: '', gameInPast: false, isManual: false, ...over,
});

test.describe('R1 — the only coachee is in the börse', () => {
  test('red', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'] }));
    expect(v.level).toBe('red');
    expect(v.reason).toBe('only-coachee-offered');
    expect(v.markedSlots).toEqual(['1']);
  });

  test('the coachee is on slot 2 and the offer is on slot 1 — not my concern', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['2'] }));
    expect(v.level).toBe('none');
    // ...but the name still carries its warning sign
    expect(v.markedSlots).toEqual(['1']);
  });
});

test.describe('R2 — two of my coachees', () => {
  test('one offered → amber, because the other still whistles', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1', '2'] }));
    expect(v.level).toBe('amber');
    expect(v.reason).toBe('one-of-mine-remains');
  });

  test('both offered → red, same as losing the only one', () => {
    const v = boerseLevel(view({ offers: [open('1'), open('2')], coacheeSlots: ['1', '2'] }));
    expect(v.level).toBe('red');
    expect(v.reason).toBe('both-coachees-offered');
    expect(v.markedSlots.sort()).toEqual(['1', '2']);
  });

  // There is no coachee-to-coach assignment in this app — `coachees.groups` is a
  // label, not an owner, and scoping is by `games.assigned_rc`. So a game with
  // one coachee is one coachee, whoever ends up observing it.
  test('a lone coachee is red whether or not anyone else is on the game', () => {
    expect(boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'] })).level).toBe('red');
    // a non-coachee alongside changes nothing
    expect(boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'] })).reason).toBe('only-coachee-offered');
  });
});

test.describe('R4 — a game I whistle myself', () => {
  test('the coachee is offered → amber, because I am in that hall anyway', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'], mySlot: '2' }));
    expect(v.level).toBe('amber');
    expect(v.reason).toBe('rc-game-coachee-offered');
  });

  test('my own slot is offered → blue, pure confirmation', () => {
    const v = boerseLevel(view({ offers: [open('2')], coacheeSlots: ['1'], mySlot: '2' }));
    expect(v.level).toBe('blue');
    expect(v.reason).toBe('my-own-slot-offered');
  });

  test('both mine and the coachee’s → amber, the observation outranks the confirmation', () => {
    const v = boerseLevel(view({ offers: [open('1'), open('2')], coacheeSlots: ['1'], mySlot: '2' }));
    expect(v.level).toBe('amber');
    expect(v.reason).toBe('rc-game-coachee-offered');
  });

  test('my own slot, and no coachee on the game at all → still blue', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: [], mySlot: '1' }));
    expect(v.level).toBe('blue');
  });
});

test.describe('what never colours a row', () => {
  test('an offer somebody already took', () => {
    const taken: BoerseSlotOffer = { slot: '1', status: 'applied', withdrawn: false, personName: 'X', personSv: '1' };
    const v = boerseLevel(view({ offers: [taken], coacheeSlots: ['1'] }));
    expect(v.level).toBe('none');
    expect(v.markedSlots).toEqual([]);
  });

  test('an offer that was withdrawn — the whole logic goes away with it', () => {
    const gone: BoerseSlotOffer = { slot: '1', status: 'open', withdrawn: true, personName: 'X', personSv: '1' };
    const v = boerseLevel(view({ offers: [gone], coacheeSlots: ['1'] }));
    expect(v.level).toBe('none');
    expect(v.markedSlots).toEqual([]);
  });

  test('VM’s third status, spelled with an underscore', () => {
    const na: BoerseSlotOffer = { slot: '1', status: 'not_applied', withdrawn: false, personName: 'X', personSv: '1' };
    expect(boerseLevel(view({ offers: [na], coacheeSlots: ['1'] })).level).toBe('none');
  });

  test('a game that has already been played', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'], gameInPast: true }));
    expect(v.level).toBe('none');
    expect(v.markedSlots).toEqual([]);
  });

  test('a manual game, whose referees VolleyManager does not dispose', () => {
    const v = boerseLevel(view({ offers: [open('1')], coacheeSlots: ['1'], isManual: true }));
    expect(v.level).toBe('none');
  });

  // Line judges are out of scope, and the reader already drops them — but if one
  // ever reached here it must not be mistaken for a head slot.
  test('a slot that is not a head slot', () => {
    const v = boerseLevel(view({ offers: [open('LR')], coacheeSlots: ['1'] }));
    expect(v.level).toBe('none');
    expect(v.markedSlots).toEqual([]);
  });
});

test.describe('the warning sign is independent of the colour', () => {
  test('a non-coachee in the börse is marked but colours nothing', () => {
    const v = boerseLevel(view({ offers: [open('2', 'Stranger')], coacheeSlots: ['1'] }));
    expect(v.level).toBe('none');
    expect(v.reason).toBe('not-my-concern');
    expect(v.markedSlots).toEqual(['2']);
  });

  test('every offered slot is marked, even when one of them decides the colour', () => {
    const v = boerseLevel(view({ offers: [open('1'), open('2')], coacheeSlots: ['1'] }));
    expect(v.markedSlots.sort()).toEqual(['1', '2']);
    expect(v.level).toBe('red');
  });
});
