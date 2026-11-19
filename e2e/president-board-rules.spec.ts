import { test, expect } from '@playwright/test';
import { fullEarlierReport } from '../server/priorReports';
import { noteResults, refereeKeyOf, readRef, isReadRef, sanitizeTags, isEmptyMark, byGameDateDesc, TAGS_MAX } from '../server/presidentBoard';

// The rules under the chair's working layer (19.11.2026), without a database:
// what a card shows of the form, whose tags a card carries, the read tick's
// key, how tags are cleaned, and the order she reads in.

const fold = (v: unknown) => String(v ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');

test('a card shows the ticks the coach set, and nothing when the form has none', () => {
  const r = noteResults({
    role_assessed: '1. SR',
    feedback_json: { results: { motivation: 'up', einstufung: 'check', srZiel: '2L', secondBesuch: 'y', secondBesuchRole: '1SR', wantsPromotion: 'Y', wantsCandidate: '' } },
  });
  expect(r).toEqual({
    role: '1. SR', motivation: 'up', einstufung: 'check', spielniveau: '', srZiel: '2L',
    secondBesuch: 'Y', secondBesuchRole: '1SR', wantsPromotion: true, wantsCandidate: false,
  });
  expect(noteResults(null).motivation).toBe('');
  expect(noteResults({ feedback_json: null }).wantsPromotion).toBe(false);
});

test('tags belong to the SV number, else to the folded name — never one read as the other', () => {
  expect(refereeKeyOf({ referee_id: '123456', full_name: 'Lea Brunner' }, fold)).toBe('sv:123456');
  // The same person spelled with and without the accent is one key.
  expect(refereeKeyOf({ full_name: 'Léa  Brünner' }, fold)).toBe(refereeKeyOf({ full_name: 'lea brunner' }, fold));
  expect(refereeKeyOf({ full_name: 'Lea Brunner' }, fold)).toBe('name:lea brunner');
  expect(refereeKeyOf(null, fold)).toBe('');
});

test("the read tick's key says which list and which note, and nothing else passes", () => {
  expect(readRef('note', 'abc123')).toBe('fb:abc123');
  expect(readRef('sr', 'n9')).toBe('gn:n9');
  expect(isReadRef('fb:abc123')).toBe(true);
  expect(isReadRef('gn:n9')).toBe(true);
  for (const bad of ['', 'abc', 'xx:abc', 'fb:', 'fb:a"b', `fb:${'a'.repeat(31)}`, 5, null]) expect(isReadRef(bad), String(bad)).toBe(false);
});

test('tags are trimmed, single-spaced, capped, and one per spelling', () => {
  expect(sanitizeTags(['  N3-Kurs   nächste Saison ', 'n3-kurs nächste saison', '', 'Gespräch suchen', 42])).toEqual(['N3-Kurs nächste Saison', 'Gespräch suchen', '42']);
  expect(sanitizeTags(['x'.repeat(60)])[0]).toHaveLength(40);
  expect(sanitizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(TAGS_MAX);
  expect(sanitizeTags('N3')).toEqual([]);
  expect(isEmptyMark({ tags: [], memo: '  ' })).toBe(true);
  expect(isEmptyMark({ tags: ['a'], memo: '' })).toBe(false);
  expect(isEmptyMark({ tags: [], memo: 'x' })).toBe(false);
});

test('newest game first, a note without a game date last, ties by the newest note', () => {
  const rows = [
    { id: 'a', gameDate: '2026-10-01T18:00:00.000000+00:00', updatedAt: '2026-10-02' },
    { id: 'b', gameDate: '', updatedAt: '2026-11-30' },
    { id: 'c', gameDate: '2026-11-15T11:00:00.000000+00:00', updatedAt: '2026-11-16' },
    { id: 'd', gameDate: '2026-11-15T19:00:00.000000+00:00', updatedAt: '2026-11-18' },
  ];
  expect([...rows].sort(byGameDateDesc).map((r) => r.id)).toEqual(['d', 'c', 'a', 'b']);
});

// How much of an earlier report the next coach reads (server/priorReports.ts).
test('the full earlier form after a further visit was asked for, or for Neu-SR / Beförderung within two seasons', () => {
  const at = { season: 2026 };
  // "Weiterer Besuch: Ja" opens it, whatever the group and however old.
  expect(fullEarlierReport({ ...at, secondBesuch: 'Y', reportSeason: 2022, groups: 'Varia' })).toBe(true);
  // The followed cohorts: this season and the last.
  for (const groups of ['Neu-Schiedsrichter 26/27', 'Neu-Schiedsrichter 25/26', 'Beförderung?', 'Beförderung', 'Varia/Beförderung?']) {
    expect(fullEarlierReport({ ...at, secondBesuch: 'N', reportSeason: 2026, groups }), groups).toBe(true);
    expect(fullEarlierReport({ ...at, secondBesuch: 'N', reportSeason: 2025, groups }), groups).toBe(true);
    expect(fullEarlierReport({ ...at, secondBesuch: 'N', reportSeason: 2024, groups }), groups).toBe(false);
  }
  // Varia three years on: goals only.
  expect(fullEarlierReport({ ...at, secondBesuch: 'N', reportSeason: 2023, groups: 'Varia' })).toBe(false);
  expect(fullEarlierReport({ ...at, secondBesuch: '', reportSeason: 2026, groups: 'Varia' })).toBe(false);
  expect(fullEarlierReport({ ...at, secondBesuch: 'N', reportSeason: null, groups: 'Beförderung' })).toBe(false);
});
