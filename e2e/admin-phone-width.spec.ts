import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME, COACHEE } from './support/app';

/**
 * The console on a phone. Two things found on one on 13.09.2026, both of the
 * kind a desktop browser never shows: a coachee chip whose surname is one long
 * word, with "Coachee" and a group beside it, was wider than the Games list and
 * gave the whole tab a sideways scroll; and "Send confirmation code" in
 * Settings was squeezed beside its explanation into a button three lines tall.
 * Both are measured, not read off the markup: the classes looked fine.
 */

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

const LONG_WORD_COACHEE = { ...COACHEE, id: 'c2', full_name: 'Maximilian Konstantinopolitanski', groups: 'Neue SR 2025/26' };

test('the Games tab does not scroll sideways for a long-named coachee', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, LONG_WORD_COACHEE] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [
    { ...GAME, id: 'a', secondReferee: LONG_WORD_COACHEE.full_name, assignedRc: '', isRcGame: true },
    { ...GAME, id: 'b', homeTeam: 'Volley Uster D1', awayTeam: 'VBC Wetzikon D2', assignedRc: '' },
  ] }));
  await page.goto('/#/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  const chip = page.getByText(LONG_WORD_COACHEE.full_name);
  await expect(chip).toBeVisible();

  // The list is the scroll container (it caps its own height), so anything
  // wider than it shows up as a horizontal scrollbar there — and the chip is
  // the widest thing in it.
  const list = page.locator('div', { has: chip }).filter({ hasText: 'Volley Uster D1' }).last();
  const overflow = await list.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBe(0);
  const listBox = (await list.boundingBox())!;
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
});

test('"Send confirmation code" stays on one line in Settings', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/credentials', (r) => r.fulfill({ json: {
    slots: [{ slot: 'shared', username: 'Referee-Coaching', source: 'env', updatedAt: null, updatedBy: null }],
    minLength: 10,
  } }));
  await page.goto('/#/admin/settings');
  const button = page.getByRole('button', { name: /Bestätigungscode senden|Send confirmation code/ }).first();
  await expect(button).toBeVisible();
  // Line boxes of the label's text, counted from a Range over the text nodes
  // alone (the icon sits at its own height): one line, whatever the width.
  const lines = await button.evaluate((el) => {
    const tops = new Set<number>();
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) tops.add(Math.round(r.top));
    }
    return tops.size;
  });
  expect(lines).toBe(1);
});
