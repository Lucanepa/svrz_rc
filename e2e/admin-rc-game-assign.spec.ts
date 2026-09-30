import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME_RC, RC } from './support/app';

// 4.4.10 in the console: an RC-Spiel gets a Rückmeldung from the coach on the
// whistle, never an observation — so the console cannot hand one out either.
// A game held from before the rule (asked 2026-09-30: #406292 was held since
// August) says so and can only be released.

test('an RC-Spiel cannot be assigned from the console, and a held one asks to be released', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const held = { ...GAME_RC, id: 'g-rc-held', matchNo: '406292', homeTeam: 'OTA Volley H1', assignedRc: RC.name, assignedRcId: RC.id };
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_RC, held] }));

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect(page.getByText(GAME_RC.homeTeam)).toBeVisible();

  const selects = page.locator('select').filter({ has: page.locator('option', { hasText: RC.name }) });
  // Every coach is a disabled option on the free RC-Spiel.
  const free = selects.first();
  await expect(free.locator('option', { hasText: RC.name })).toBeDisabled();

  // The held one keeps its holder, says why it is wrong, and offers "–".
  await expect(page.getByTestId('rc-game-held')).toBeVisible();
  await expect(page.getByTestId('rc-game-held')).toContainText(/4\.4\.10/);
});

test('the take endpoint refuses an RC-Spiel for the console too', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const start = server.indexOf("app.put('/api/games/:id/assign-rc'");
  const body = server.slice(start, server.indexOf('\napp.', start + 10));
  const adminBranch = body.slice(body.indexOf('} else if (!givingBack) {'), body.indexOf('const updated ='));
  expect(adminBranch).toMatch(/makeRcGameTest\(\)\)\(current\)[\s\S]*?status: 422/);
});
