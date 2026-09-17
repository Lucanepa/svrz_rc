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
  expect(SRC).toContain('manualIds: Set<string> = new Set(),\n): Map<string, RcWorkload> {');
  expect(SRC).toMatch(/if \(registerOnlyGames\.has\(String\(game\.id\)\)\) continue;[\s\S]{0,400}if \(manualIds\.has\(String\(game\.id\)\)\) continue;\n\s+if \(fbGameIds\.has\(game\.id\)\) load\.done\+\+;/);
  // Both callers hand the manual set over — the overview and the statistics.
  expect(SRC).toContain('workloadByRc(people, allGames, allFeedbacks, inSeason, new Date(), await getManualGameIds())');
  expect(SRC).toContain('workloadByRc(raw.people, raw.games, raw.feedbacks, inSeason, now, raw.manual)');
});

test('the statistics never see a Testspiel observation', () => {
  expect(SRC).toMatch(/if \(raw\.manual\.has\(String\(game\.id\)\)\) continue;\n\s+const observation = observationFromFeedback\(/);
});

test('the Spesenabrechnung lists no Testspiel — not marked, not paid, not there', () => {
  expect(SRC).toContain("if (!game || !inSeason(game) || manualIds.has(String(game.id))) continue;");
  expect(EXPENSES).not.toContain('Testspiel');
  expect(EXPENSES).not.toContain('isManual');
});

test('a report filed on a Testspiel writes nothing onto a real coachee', () => {
  expect(SRC).toContain("const onTestGame = (await getManualGameIds()).has(String(game.id));");
  expect(SRC).toContain('const countsForCoachee = !!coachee && !onTestGame;');
  expect(SRC).toContain('if (countsForCoachee && coacheeCollection) await coacheeCollection.update(coachee.id, {');
  expect(SRC).toMatch(/if \(countsForCoachee\) \{\n\s+const observation = await withCollection<AnyRecord>\(collectionCandidates\.observations/);
});
