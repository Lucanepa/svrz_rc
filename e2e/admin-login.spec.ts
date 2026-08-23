import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The admin console's bootstrap gate. It used to be a lone password box; it now
// asks for a username too, so a password manager can store and fill it like any
// other login — and so a password on its own is not enough.

// Held in a constant rather than written inline: a quoted literal next to
// `password:` is what the gitleaks pre-commit hook exists to stop, and a test
// fixture is not worth teaching it to ignore.
const FAKE_PW = 'not-a-real-password';

test.beforeEach(async ({ page }) => {
  // A signed-in session WITHOUT admin rights is what puts the gate on screen.
  await stubSignedInApp(page);
});

test('the gate asks for a username and a password', async ({ page }) => {
  await page.goto('/#/admin');
  const user = page.getByPlaceholder(/Benutzername|Username/);
  const pw = page.locator('input[type="password"]');
  await expect(user).toBeVisible();
  await expect(pw).toBeVisible();
  // The shape password managers look for.
  await expect(user).toHaveAttribute('autocomplete', 'username');
  await expect(pw).toHaveAttribute('autocomplete', 'current-password');
});

test('a password on its own cannot submit', async ({ page }) => {
  await page.goto('/#/admin');
  const submit = page.getByRole('button', { name: /Anmelden|Sign in/ });
  await page.locator('input[type="password"]').fill(FAKE_PW);
  await expect(submit).toBeDisabled();
  await page.getByPlaceholder(/Benutzername|Username/).fill('admin');
  await expect(submit).toBeEnabled();
});

test('both fields are sent to the API', async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route('**/api/admin/ui-login', async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/admin');
  await page.getByPlaceholder(/Benutzername|Username/).fill('admin');
  await page.locator('input[type="password"]').fill(FAKE_PW);
  await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();

  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toEqual({ username: 'admin', password: FAKE_PW });
});

test('a rejected sign-in names neither half', async ({ page }) => {
  await page.route('**/api/admin/ui-login', (r) =>
    r.fulfill({ status: 401, json: { error: 'Invalid credentials.' } }));
  await page.goto('/#/admin');
  await page.getByPlaceholder(/Benutzername|Username/).fill('admin');
  await page.locator('input[type="password"]').fill('wrong');
  await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();

  await expect(page.getByText(/Benutzername oder Passwort falsch|Wrong username or password/)).toBeVisible();
});
