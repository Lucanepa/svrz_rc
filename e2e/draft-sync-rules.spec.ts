import { test, expect } from '@playwright/test';
import { planDraftSync, sameDraftContent, type ServerDraftState } from '../src/lib/draftSync';
import type { DraftRecord } from '../src/lib/formDraft';

// What one device does with its drafts once it has heard from the server —
// the rules on their own. The case that started it (Luca, 19.10.2026): both
// reports of a visit filed from the laptop, and the phone still holding its
// copies as red "Nicht gesendet" two days later.

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  const gameId = over.gameId ?? 'g1';
  const role = over.role ?? '1. SR';
  return {
    id: `rc1|${gameId}|${role}`,
    schema: 1, ownerId: 'rc1', gameId, role,
    updatedAt: 1000, status: 'editing', submissionKey: '',
    label: 'A vs B', matchNo: '406369',
    observationTarget: role === '2. SR' ? '2SR' : '1SR', resultUnlocked: false,
    coacheeId: 'c1', coacheeName: 'Ref One', coacheeLevel: 'N3',
    lang: 'DE', meta: {}, ratings: { 'q1': 'B' }, results: {},
    signature: '', rcSignature: '', tipsAndTricks: '', attachedDocs: [],
    ...over,
  };
}

const none: ServerDraftState = { drafts: [], gone: [], filed: [] };

test.describe('A report filed on another device', () => {
  test('retires this device\'s copy of it', () => {
    const phone = [draft(), draft({ role: '2. SR' })];
    const plan = planDraftSync(phone, { ...none, filed: [{ gameId: 'g1', role: '1. SR' }, { gameId: 'g1', role: '2. SR' }] });
    expect(plan.file.map((d) => d.role)).toEqual(['1. SR', '2. SR']);
    expect(plan.push).toEqual([]);
    expect(plan.adopt).toEqual([]);
  });

  test('retires only the half that was filed', () => {
    const plan = planDraftSync([draft(), draft({ role: '2. SR' })], { ...none, filed: [{ gameId: 'g1', role: '1. SR' }] });
    expect(plan.file.map((d) => d.role)).toEqual(['1. SR']);
    expect(plan.push.map((d) => d.role)).toEqual(['2. SR']);
  });

  test('wins even over an edit made here afterwards — the report is out', () => {
    const plan = planDraftSync([draft({ updatedAt: 9999 })], { ...none, filed: [{ gameId: 'g1', role: '1. SR' }], gone: [{ gameId: 'g1', role: '1. SR', at: 10 }] });
    expect(plan.file).toHaveLength(1);
  });

  test('is never adopted as work to resume', () => {
    const plan = planDraftSync([], { ...none, drafts: [draft()], filed: [{ gameId: 'g1', role: '1. SR' }] });
    expect(plan.adopt).toEqual([]);
  });
});

test.describe('A newer copy elsewhere', () => {
  test('replaces the older one here', () => {
    const laptop = draft({ updatedAt: 2000, tipsAndTricks: 'written on the laptop' });
    const plan = planDraftSync([draft({ updatedAt: 1000 })], { ...none, drafts: [laptop] });
    expect(plan.adopt).toEqual([laptop]);
    expect(plan.push).toEqual([]);
  });

  test('arrives on a device that never had it', () => {
    const laptop = draft({ gameId: 'g2' });
    expect(planDraftSync([draft()], { ...none, drafts: [draft(), laptop] }).adopt).toEqual([laptop]);
  });

  test('while an older one here is pushed up instead', () => {
    const plan = planDraftSync([draft({ updatedAt: 3000 })], { ...none, drafts: [draft({ updatedAt: 2000 })] });
    expect(plan.adopt).toEqual([]);
    expect(plan.push).toHaveLength(1);
  });

  test('the same copy on both sides is left alone', () => {
    expect(planDraftSync([draft()], { ...none, drafts: [draft()] })).toEqual({ adopt: [], file: [], remove: [], push: [] });
  });
});

test.describe('A draft discarded on another device', () => {
  test('goes here too', () => {
    const plan = planDraftSync([draft({ updatedAt: 1000 })], { ...none, gone: [{ gameId: 'g1', role: '1. SR', at: 1500 }] });
    expect(plan.remove).toHaveLength(1);
    expect(plan.push).toEqual([]);
  });

  test('stays if it was edited here after the discard, and goes back up', () => {
    const plan = planDraftSync([draft({ updatedAt: 2000 })], { ...none, gone: [{ gameId: 'g1', role: '1. SR', at: 1500 }] });
    expect(plan.remove).toEqual([]);
    expect(plan.push).toHaveLength(1);
  });

  test('a live copy parked after the tombstone settles it', () => {
    const plan = planDraftSync([draft({ updatedAt: 1000 })], {
      ...none, drafts: [draft({ updatedAt: 3000 })], gone: [{ gameId: 'g1', role: '1. SR', at: 2000 }],
    });
    expect(plan.remove).toEqual([]);
    expect(plan.adopt).toHaveLength(1);
  });
});

test.describe('What a sync never touches', () => {
  test('the game open in the form', () => {
    const plan = planDraftSync(
      [draft({ updatedAt: 1000 })],
      { drafts: [draft({ updatedAt: 2000 })], gone: [], filed: [{ gameId: 'g1', role: '1. SR' }] },
      (gameId) => gameId === 'g1',
    );
    expect(plan).toEqual({ adopt: [], file: [], remove: [], push: [] });
  });

  test('a send still in the outbox, or one already confirmed', () => {
    for (const status of ['queued', 'filed'] as const) {
      const plan = planDraftSync([draft({ status, updatedAt: 1000 })], {
        drafts: [draft({ updatedAt: 2000 })], gone: [], filed: [{ gameId: 'g1', role: '1. SR' }],
      });
      expect(plan, status).toEqual({ adopt: [], file: [], remove: [], push: [] });
    }
  });
});

test('work the server never got is pushed up', () => {
  expect(planDraftSync([draft()], none).push).toHaveLength(1);
});

test.describe('The same work', () => {
  test('rebuilt from the form, with every empty field it carries, is not an edit', () => {
    const stored = draft({ meta: { spielNr: '406369' }, results: { bemerkungen: 'gut' } });
    const rebuilt = draft({
      updatedAt: 99999, lang: 'EN',
      meta: { srName: '', spielNr: '406369', liga: '' },
      results: { highlights: '', bemerkungen: 'gut' },
    });
    expect(sameDraftContent(stored, rebuilt)).toBe(true);
  });

  test('with one mark, one word or one stroke of ink changed, is', () => {
    const stored = draft();
    expect(sameDraftContent(stored, draft({ ratings: { q1: 'C' } }))).toBe(false);
    expect(sameDraftContent(stored, draft({ tipsAndTricks: 'x' }))).toBe(false);
    expect(sameDraftContent(stored, draft({ signature: 'data:image/png;base64,AAA' }))).toBe(false);
    expect(sameDraftContent(stored, draft({ attachedDocs: ['regeln'] }))).toBe(false);
  });
});
