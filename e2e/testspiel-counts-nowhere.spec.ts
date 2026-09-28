import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Testspiel — a game created by hand in the console — is for walking the
// flow through. Until 17.09.2026 it still counted: as "done" on Home, in the
// season's statistics, on the Spesenabrechnung (marked, but paid), and, with a
// real coachee standing on it, as an observation on that coachee. The
// commission's answer was "absolutely no": the report and the mail go out and
// nothing else is written or counted, wherever the game shows up. These pins
// name the four places that rule lives.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');
const EXPENSES = readFileSync(join(HERE, '..', 'server', 'expenses.ts'), 'utf8');

test('the Home counters skip a Testspiel, whoever stands on it', () => {
  // One rule decides done/outstanding/planned for the overview, the
  // statistics and the Spesenabrechnung alike (rcWorkloadRule, expenses.ts).
  expect(EXPENSES).toContain('if (!args.inSeason(g) || manualIds.has(id)) return false;');
  expect(SRC).toContain('rcWorkloadRule({ games: allGames, feedbacks: allFeedbacks, inSeason, now, manualIds, hasCoacheeSlot })');
  // Both callers hand the manual set over — the overview and the statistics.
  expect(SRC).toContain('workloadByRc(people, allGames, allFeedbacks, inSeason, new Date(), await getManualGameIds(), await makeCoacheeSlotTest())');
  expect(SRC).toContain('workloadByRc(raw.people, raw.games, raw.feedbacks, inSeason, now, raw.manual, raw.hasCoacheeSlot)');
});

test('the statistics never see a Testspiel observation', () => {
  expect(SRC).toMatch(/if \(raw\.manual\.has\(String\(game\.id\)\)\) continue;\n\s+const observation = observationFromFeedback\(/);
});

test('the Spesenabrechnung lists no Testspiel — not marked, not paid, not there', () => {
  expect(SRC).toContain("if (!game || !inSeason(game) || manualIds.has(String(game.id))) continue;");
  // The sheet has no Testspiel branch of its own: the only mention is the
  // rule's comment saying it counts nowhere.
  const code = EXPENSES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toContain('Testspiel');
  expect(code).not.toContain('isManual');
});

test('a report filed on a Testspiel writes nothing onto a real coachee', () => {
  expect(SRC).toContain("const onTestGame = (await getManualGameIds()).has(String(game.id));");
  expect(SRC).toContain('const countsForCoachee = !!coachee && !onTestGame;');
  expect(SRC).toContain('if (countsForCoachee && coacheeCollection) await coacheeCollection.update(coachee.id, {');
  // The observation — the row a season's target counts — is written only
  // under that flag. Its body grew a branch (a reopened report rewrites the
  // observation it already wrote rather than adding a second), so what is
  // pinned here is the gate, not the shape inside it.
  const guarded = SRC.slice(SRC.indexOf('if (countsForCoachee) {'), SRC.indexOf('// Upload the filed document'));
  expect(guarded).toContain('collectionCandidates.observations');
  expect(guarded).toContain('collection.create(observationPayload)');
  expect(SRC.indexOf('collection.create(observationPayload)')).toBeGreaterThan(SRC.indexOf('if (countsForCoachee) {'));
});
