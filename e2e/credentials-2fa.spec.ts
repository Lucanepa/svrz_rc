import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * Changing a password in the console costs a code that arrives by e-mail.
 * What is worth pinning here is the ORDER: the fields that set a password do
 * not exist until a code has been asked for. An admin session is enough to read
 * which usernames are live; it is deliberately not enough to change one, and a
 * form that let you type the new password first and only checked the code on
 * submit would quietly make the second factor optional to the eye.
 */

const SLOTS = {
  slots: [
    { slot: 'shared', username: 'Referee-Coaching', source: 'db', updatedAt: '2026-08-26T09:00:00Z', updatedBy: 'admin' },
    { slot: 'admin', username: 'admin', source: 'env', updatedAt: null, updatedBy: null },
    { slot: 'president', username: 'praesidium', source: 'unset', updatedAt: null, updatedBy: null },
  ],
  minLength: 10,
};

// Held in constants rather than inline: a quoted literal next to `password:` is
// what the gitleaks pre-commit hook exists to stop.
const NEW_PW = 'not-a-real-password';
const CODE = '123456';

async function openCredentials(page: import('@playwright/test').Page) {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/credentials', (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: SLOTS });
    return r.fulfill({ json: { ok: true, slot: 'admin', username: 'admin' } });
  });
  await page.goto('/#/admin/settings');
}

test('a password cannot be typed before a code has been asked for', async ({ page }) => {
  await openCredentials(page);

  // The card is on screen…
  await expect(page.getByText(/Team-Login \(App\)|Team login \(app\)/)).toBeVisible();
  // …and every slot offers to send a code, not a password box.
  await expect(page.getByRole('button', { name: /Bestätigungscode senden|Send confirmation code/ })).toHaveCount(3);
  await expect(page.getByPlaceholder(/Neues Passwort|New password/)).toHaveCount(0);
  await expect(page.getByPlaceholder(/6-stelliger Code|6-digit code/)).toHaveCount(0);
});

test('asking for a code says where it went, and only then opens the fields', async ({ page }) => {
  await openCredentials(page);
  await page.route('**/api/admin/credentials/challenge', (r) =>
    r.fulfill({ json: { ok: true, sentTo: 'j••••@example.com', expiresInMs: 600000 } }));

  await page.getByRole('button', { name: /Bestätigungscode senden|Send confirmation code/ }).first().click();

  // The masked address is the point: an admin who cannot read that mailbox
  // learns it here rather than after typing a new password.
  await expect(page.getByText(/j••••@example\.com/)).toBeVisible();
  await expect(page.getByPlaceholder(/Neues Passwort|New password/)).toBeVisible();
  await expect(page.getByPlaceholder(/6-stelliger Code|6-digit code/)).toBeVisible();
  // Exactly one slot opens — the code the server issued is bound to that door.
  await expect(page.getByPlaceholder(/6-stelliger Code|6-digit code/)).toHaveCount(1);
});

test('the code travels with the change, and a short one cannot be sent', async ({ page }) => {
  let put: Record<string, unknown> | null = null;
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/credentials/challenge', (r) =>
    r.fulfill({ json: { ok: true, sentTo: 'j••••@example.com', expiresInMs: 600000 } }));
  await page.route('**/api/admin/credentials', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: SLOTS });
    put = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, slot: 'shared', username: 'Referee-Coaching', feedsRevoked: true } });
  });
  await page.goto('/#/admin/settings');

  await page.getByRole('button', { name: /Bestätigungscode senden|Send confirmation code/ }).first().click();
  const save = page.getByRole('button', { name: /Passwort setzen|Set password/ });
  const code = page.getByPlaceholder(/6-stelliger Code|6-digit code/);

  await page.getByPlaceholder(/Neues Passwort|New password/).fill(NEW_PW);
  // A password alone is not enough to submit — nor is a half-typed code.
  await expect(save).toBeDisabled();
  await code.fill('123');
  await expect(save).toBeDisabled();
  await code.fill(CODE);
  await expect(save).toBeEnabled();

  await save.click();
  await expect.poll(() => put).not.toBeNull();
  expect(put).toMatchObject({ slot: 'shared', password: NEW_PW, code: CODE });

  // Rotating the team password invalidates every calendar subscription, and the
  // admin is told so — coaches have to be sent a fresh link.
  await expect(page.getByText(/Kalender-Abos|calendar subscription/)).toBeVisible();
});
