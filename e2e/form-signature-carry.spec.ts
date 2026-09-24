import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, signOpenPad, GAME } from './support/app';

/**
 * The coach signs the VISIT, not one of its forms.
 *
 * A game taken for both referees is two reports and one coach. Asked to sign
 * twice, a coach signs twice — the same hand, the same evening, on a pad, for
 * no reason. So the coach's signature reaches the other role's form the moment
 * it is placed, when the coach switches to the other referee's form.
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

test('the coach signs once for both referees, filled one after the other, and only the coach\'s ink travels', async ({ page }) => {
  await signAs(page, 'rc');
  await expect(rcSig(page)).toBeVisible();

  await targetButton(page, /^2SR/).click();
  await expect(rcSig(page)).toBeVisible();
  await expect(refereeSig(page)).toHaveCount(0);

  // And back, still signed: the switch carries it both ways.
  await targetButton(page, /^1SR/).click();
  await expect(rcSig(page)).toBeVisible();
});
