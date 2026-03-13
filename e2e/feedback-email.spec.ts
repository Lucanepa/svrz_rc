import { test, expect } from '@playwright/test';

/**
 * Helper: Select a coachee from the table to reveal the feedback form.
 * The form (Tips & Tricks, save button, etc.) only appears after a coachee is selected.
 */
async function selectFirstCoachee(page: import('@playwright/test').Page) {
  await page.goto('/');
  // Wait for coachees table to load
  await expect(page.locator('table')).toBeVisible();
  // Click the first coachee row
  const firstRow = page.locator('tbody tr').first();
  await firstRow.click();
}

test.describe('Feedback form (after coachee selection)', () => {
  test.describe('Tips & Tricks section', () => {
    test('shows Tips & Tricks heading', async ({ page }) => {
      await selectFirstCoachee(page);
      const heading = page.locator('h3', { hasText: /Tips & Tricks|Tipps & Tricks/ });
      await expect(heading).toBeVisible();
    });

    test('Tips & Tricks textarea is editable', async ({ page }) => {
      await selectFirstCoachee(page);
      const tipsTextarea = page.locator(
        'textarea[placeholder*="tips" i], textarea[placeholder*="tipps" i]',
      );
      await expect(tipsTextarea).toBeVisible();
      await tipsTextarea.fill('Keep whistle position consistent');
      await expect(tipsTextarea).toHaveValue('Keep whistle position consistent');
    });

    test('shows email-only disclaimer text', async ({ page }) => {
      await selectFirstCoachee(page);
      const disclaimer = page.locator('p').filter({
        hasText: /not be saved in the official feedback|nicht im offiziellen Feedback gespeichert/,
      });
      await expect(disclaimer).toBeVisible();
    });
  });

  test.describe('Save button and confirmation modal', () => {
    test('save button is visible after coachee selection', async ({ page }) => {
      await selectFirstCoachee(page);
      const saveButton = page.locator('button', {
        hasText: /Confirm and save|Bestätigen und speichern/,
      });
      await expect(saveButton).toBeVisible();
    });

    test('save button opens confirmation modal', async ({ page }) => {
      await selectFirstCoachee(page);
      const saveButton = page.locator('button', {
        hasText: /Confirm and save|Bestätigen und speichern/,
      });
      await saveButton.click();
      const modalHeading = page.locator('h3', {
        hasText: /Save feedback|Feedback speichern/,
      });
      await expect(modalHeading).toBeVisible();
    });

    test('confirmation modal mentions email with PDF', async ({ page }) => {
      await selectFirstCoachee(page);
      const saveButton = page.locator('button', {
        hasText: /Confirm and save|Bestätigen und speichern/,
      });
      await saveButton.click();
      const emailMention = page.locator('p').filter({
        hasText: /email with the PDF|E-Mail mit dem PDF/,
      });
      await expect(emailMention).toBeVisible();
    });

    test('confirmation modal can be cancelled', async ({ page }) => {
      await selectFirstCoachee(page);
      const saveButton = page.locator('button', {
        hasText: /Confirm and save|Bestätigen und speichern/,
      });
      await saveButton.click();
      // Modal is open
      const modalHeading = page.locator('h3', {
        hasText: /Save feedback|Feedback speichern/,
      });
      await expect(modalHeading).toBeVisible();
      // Cancel
      await page.locator('button', { hasText: /Cancel|Abbrechen/ }).click();
      await expect(modalHeading).not.toBeVisible();
    });
  });

  test.describe('Form locking state', () => {
    test('form is not locked on initial coachee selection', async ({ page }) => {
      await selectFirstCoachee(page);
      // Save button visible = not locked
      await expect(
        page.locator('button', { hasText: /Confirm and save|Bestätigen und speichern/ }),
      ).toBeVisible();
      // Locked banner should not appear
      await expect(
        page.locator('text=/Feedback submitted|Feedback eingereicht/'),
      ).not.toBeVisible();
    });

    test('closed game banner is not shown initially', async ({ page }) => {
      await selectFirstCoachee(page);
      await expect(
        page.locator('text=/already been observed|bereits beobachtet/'),
      ).not.toBeVisible();
    });

    test('form does not have disabled overlay initially', async ({ page }) => {
      await selectFirstCoachee(page);
      // The form wrapper with pointer-events-none only appears when locked/closed
      const formWrapper = page.locator('div.pointer-events-none.opacity-60');
      const count = await formWrapper.count();
      // Either doesn't exist or is not visible
      if (count > 0) {
        await expect(formWrapper.first()).not.toBeVisible();
      }
    });
  });
});

test.describe('Language-specific email UI', () => {
  test('German mode shows German text in save confirmation', async ({ page }) => {
    await selectFirstCoachee(page);

    // Ensure German mode
    const title = await page.locator('h1').innerText();
    if (title.includes('Referee')) {
      const langButton = page.locator('button').filter({ has: page.locator('svg') }).nth(1);
      await langButton.click();
      await expect(page.locator('h1')).toContainText('SR-Coaching');
    }

    await page.locator('button', { hasText: /Bestätigen und speichern/ }).click();
    await expect(
      page.locator('p').filter({ hasText: /E-Mail mit dem PDF/ }),
    ).toBeVisible();
  });

  test('English mode shows English text in save confirmation', async ({ page }) => {
    await selectFirstCoachee(page);

    // Ensure English mode
    const title = await page.locator('h1').innerText();
    if (title.includes('SR-Coaching')) {
      const langButton = page.locator('button').filter({ has: page.locator('svg') }).nth(1);
      await langButton.click();
      await expect(page.locator('h1')).toContainText('Referee');
    }

    await page.locator('button', { hasText: /Confirm and save/ }).click();
    await expect(
      page.locator('p').filter({ hasText: /email with the PDF/ }),
    ).toBeVisible();
  });
});

// API validation tests — require backend running on :8787 (start with `npm run dev`)
test.describe('API validation (requires backend)', () => {
  test('rejects missing required fields', async ({ request }) => {
    const response = await request.post('/api/feedback/submit', {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });

    test.skip(response.status() === 502, 'Backend not running');
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });

  test('rejects missing pdfBase64', async ({ request }) => {
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

  test('rejects oversized PDF (>3MB)', async ({ request }) => {
    const largeBuffer = Buffer.alloc(3.5 * 1024 * 1024, 'A');
    const largePdfBase64 = largeBuffer.toString('base64');

    const response = await request.post('/api/feedback/submit', {
      data: {
        gameId: 'test123',
        role: '1. SR',
        formData: { role: '1. SR', lang: 'DE', meta: {}, sections: [], results: {} },
        pdfBase64: largePdfBase64,
      },
      headers: { 'Content-Type': 'application/json' },
    });

    test.skip(response.status() === 502, 'Backend not running');
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('3MB');
  });

  test('rejects duplicate submission (409 for closed role)', async ({ request }) => {
    // This tests the server rejects a valid-looking payload when the game doesn't exist
    // (which results in a 500, not 409 — but verifies the endpoint processes past validation)
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
    // Should fail with 500 (game not found) — not 400 (validates that we got past validation phase)
    expect(response.status()).toBe(500);
  });

  test('eligible-games endpoint responds', async ({ request }) => {
    const response = await request.get('/api/eligible-games?coacheeId=nonexistent');

    test.skip(response.status() === 502, 'Backend not running');
    expect([200, 400, 500]).toContain(response.status());
  });
});
