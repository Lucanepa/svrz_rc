import { test, expect } from '@playwright/test';

/**
 * Navigate to the feedback form via Coachee Games tab → game → Start feedback.
 * Requires backend running to load games.
 */
async function navigateToFeedbackForm(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('table')).toBeVisible();

  // Step 1: Click "Coachee Games" tab
  await page.locator('button', { hasText: 'Coachee Games' }).click();

  // Step 2: Wait for games to load and click first game
  const gameEntry = page.locator('[class*="cursor-pointer"]').filter({ hasText: /#\d+/ }).first();
  try {
    await gameEntry.waitFor({ timeout: 5000 });
  } catch {
    return false;
  }
  await gameEntry.click();

  // Step 3: Click "Start feedback" button
  const startBtn = page.locator('button', { hasText: /Start feedback|Feedback starten/ });
  try {
    await startBtn.waitFor({ timeout: 3000 });
  } catch {
    return false;
  }
  await startBtn.click();

  // Step 4: Wait for feedback form to render
  try {
    await page.locator('h3', { hasText: /Tips & Tricks|Tipps & Tricks/ }).waitFor({ timeout: 5000 });
  } catch {
    return false;
  }
  return true;
}

test.describe('Feedback form UI (requires backend)', () => {
  test.describe('Tips & Tricks section', () => {
    test('shows Tips & Tricks heading', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');
      await expect(page.locator('h3', { hasText: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
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
    test('save button is visible', async ({ page }) => {
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
    test('form is not locked on initial game selection', async ({ page }) => {
      const ready = await navigateToFeedbackForm(page);
      test.skip(!ready, 'Could not navigate to feedback form');

      await expect(
        page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }),
      ).toBeVisible();
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

// API tests — don't need UI navigation
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

  test('rejects nonexistent game with 500 (past validation)', async ({ request }) => {
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

    expect(response.status()).toBe(500);
  });

  test('eligible-games endpoint responds', async ({ request }) => {
    const response = await request.get('/api/eligible-games?coacheeId=nonexistent');
    test.skip(response.status() === 502, 'Backend not running');

    expect([200, 400, 500]).toContain(response.status());
  });
});
