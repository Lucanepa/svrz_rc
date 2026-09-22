import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, signOpenPad, GAME } from './support/app';

/**
 * The coach signs the VISIT, not one of its forms.
 *
 * A game taken for both referees is two reports and one coach. Asked to sign
 * twice, a coach signs twice — the same hand, the same evening, on a pad, for
 * no reason. So the coach's signature reaches the other role's form the moment
 * it is placed, whichever way the two forms are being filled: held together in
 * "Beide", or one after the other with the role switch.
 *
 * The REFEREE's signature is the opposite case and must never travel: it is
 * one person acknowledging the discussion about themselves, and carried over
 * it would satisfy the mandatory-signature gate with somebody else's ink.
 */

const GAME_2SR = { ...GAME, secondReferee: 'Ref Two' };

const rcSig = (page: Page) => page.getByAltText(/^(Referee Coach signature|Unterschrift Referee Coach)$/);
const refereeSig = (page: Page) => page.getByAltText(/^(Referee signature|Unterschrift Schiedsrichter)$/);
/** The two pads sit side by side as they print: referee first, coach second. */
const signAs = async (page: Page, who: 'referee' | 'rc') => {
  await page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).nth(who === 'referee' ? 0 : 1).click();
  await signOpenPad(page);
};
const targetButton = (page: Page, name: RegExp) =>
  page.getByRole('group', { name: /Observation for|Beobachtung f/ }).getByRole('button', { name });

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_2SR] }));
  await page.goto('/');
  await openFeedbackForm(page);
});

test('in a "Beide" visit the coach signs once, and only the coach\'s ink travels', async ({ page }) => {
  await targetButton(page, /^(Both|Beide)$/).click();
  await signAs(page, 'referee');
  await signAs(page, 'rc');
  await expect(rcSig(page)).toBeVisible();
  await expect(refereeSig(page)).toBeVisible();

  await page.getByRole('button', { name: /^(Switch to|Wechseln zu) 2\. SR$/ }).click();
  await expect(rcSig(page)).toBeVisible();
  // The other referee has not acknowledged anything yet, and their form must
  // not say they have.
  await expect(refereeSig(page)).toHaveCount(0);
});

test('the same holds when the two forms are filled one after the other', async ({ page }) => {
  await signAs(page, 'rc');
  await expect(rcSig(page)).toBeVisible();

  await targetButton(page, /^2SR/).click();
  await expect(rcSig(page)).toBeVisible();
  await expect(refereeSig(page)).toHaveCount(0);

  // And back, still signed: the switch carries it both ways.
  await targetButton(page, /^1SR/).click();
  await expect(rcSig(page)).toBeVisible();
});
