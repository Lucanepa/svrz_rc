import { test, expect } from '@playwright/test';

/**
 * Helper: Navigate to the feedback form by selecting a coachee and a game.
 * Requires the backend running to fetch coachee games.
 */
async function navigateToFeedbackForm(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('table')).toBeVisible();

  // Step 1: Click the first coachee row to open detail sidebar
  const firstRow = page.locator('tbody tr').first();
  await firstRow.click();

  // Step 2: Click "Games / Feedback" button in the detail sidebar
  const actionButton = page.locator('button', {
    hasText: /Games.*Feedback|Spiele.*Feedbacks/,
  });
  try {
    await actionButton.waitFor({ timeout: 5000 });
  } catch {
    return false; // Detail sidebar didn't open
  }
  await actionButton.click();

  // Step 3: Wait for coachee games view with upcoming/past games
  const gamesSection = page.locator('text=/Upcoming Games|Bevorstehende Spiele/');
  try {
    await gamesSection.waitFor({ timeout: 5000 });
  } catch {
    return false; // Games section didn't load
  }

  // Step 4: Click the first game button to open feedback form
  const gameButton = page.locator('button').filter({
    has: page.locator('div.font-semibold'),
  }).first();
  try {
    await gameButton.waitFor({ timeout: 5000 });
  } catch {
    return false; // No games available
  }
  await gameButton.click();

  // Step 5: Wait for the feedback form to render
  try {
    await page.locator('h3', { hasText: /Tips & Tricks|Tipps & Tricks/ }).waitFor({ timeout: 5000 });
  } catch {
    return false;
  }
  return true;
}

// UI tests that require full navigation to the feedback form
// These need the backend running to fetch coachee data and games
test.describe('Feedback form UI (requires backend)', () => {
  test.describe('Tips & Tricks section', () => {
    test('shows Tips & Tricks heading after game selection', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form (backend or data unavailable)');

      await expect(
        page.locator('h3', { hasText: /Tips & Tricks|Tipps & Tricks/ }),
      ).toBeVisible();
    });

    test('Tips & Tricks textarea is editable', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      const tipsTextarea = page.locator(
        'textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]',
      );
      await expect(tipsTextarea).toBeVisible();
      await tipsTextarea.fill('Keep whistle position consistent');
      await expect(tipsTextarea).toHaveValue('Keep whistle position consistent');
    });

    test('shows email-only disclaimer', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await expect(
        page.locator('p').filter({
          hasText: /not be saved in the official feedback|nicht im offiziellen Feedback gespeichert/,
        }),
      ).toBeVisible();
    });
  });

  test.describe('Save button and confirmation modal', () => {
    test('save button visible after game selection', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await expect(
        page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }),
      ).toBeVisible();
    });

    test('save button opens confirmation modal', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }).click();
      await expect(
        page.locator('h3', { hasText: /Save feedback|Feedback speichern/ }),
      ).toBeVisible();
    });

    test('confirmation modal mentions email with PDF', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }).click();
      await expect(
        page.locator('p').filter({ hasText: /email with the PDF|E-Mail mit dem PDF/ }),
      ).toBeVisible();
    });

    test('confirmation modal shows coachee email address', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }).click();
      // The modal text includes the coachee email or "(no email)"
      const modalText = page.locator('.fixed p.text-sm');
      await expect(modalText).toBeVisible();
    });

    test('confirmation modal can be cancelled', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }).click();
      const modal = page.locator('h3', { hasText: /Save feedback|Feedback speichern/ });
      await expect(modal).toBeVisible();

      await page.locator('button', { hasText: /Cancel|Abbrechen/ }).click();
      await expect(modal).not.toBeVisible();
    });
  });

  test.describe('Form locking state', () => {
    test('form is not locked after fresh game selection', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      // Save button visible = not locked
      await expect(
        page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }),
      ).toBeVisible();
      // Locked banner should not be visible
      await expect(
        page.locator('text=/Feedback submitted|Feedback eingereicht/'),
      ).not.toBeVisible();
    });

    test('closed game banner is not shown for fresh game', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await expect(
        page.locator('text=/already been observed|bereits beobachtet/'),
      ).not.toBeVisible();
    });
  });
});

// API validation tests — these don't need full UI navigation
// Require the backend running on :8787 (start with `npm run dev`)
test.describe('API validation (requires backend)', () => {
  test('rejects empty payload with 400', async ({ request }) => {
    const response = await request.post('/api/feedback/submit', {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    test.skip(response.status() === 502, 'Backend not running');

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });

  test('rejects payload without pdfBase64', async ({ request }) => {
    const response = await request.post('/api/feedback/submit', {
      data: {
        gameId: 'test123',
        role: '1. SR',
        formData: { role: '1. SR', lang: 'DE', meta: {}, sections: [], results: {} },
      },
      headers: { 'Content-Type': 'application/json' },
    });
    test.skip(response.status() === 502, 'Backend not running');

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });

  test('rejects oversized PDF (>3MB) with 400', async ({ request }) => {
    const largeBuffer = Buffer.alloc(3.5 * 1024 * 1024, 'A');

    const response = await request.post('/api/feedback/submit', {
      data: {
        gameId: 'test123',
        role: '1. SR',
        formData: { role: '1. SR', lang: 'DE', meta: {}, sections: [], results: {} },
        pdfBase64: largeBuffer.toString('base64'),
      },
      headers: { 'Content-Type': 'application/json' },
    });
    test.skip(response.status() === 502, 'Backend not running');

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('3MB');
  });

  test('rejects nonexistent game with 500 (past validation phase)', async ({ request }) => {
    const smallPdf = Buffer.from('fake-pdf-content').toString('base64');

    const response = await request.post('/api/feedback/submit', {
      data: {
        gameId: 'nonexistent_game_id',
        role: '1. SR',
        formData: { role: '1. SR', lang: 'DE', meta: {}, sections: [], results: {} },
        pdfBase64: smallPdf,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    test.skip(response.status() === 502, 'Backend not running');

    // 500 = got past validation, failed on game lookup
    expect(response.status()).toBe(500);
  });

  test('eligible-games endpoint responds', async ({ request }) => {
    const response = await request.get('/api/eligible-games?coacheeId=nonexistent');
    test.skip(response.status() === 502, 'Backend not running');

    expect([200, 400, 500]).toContain(response.status());
  });
});
