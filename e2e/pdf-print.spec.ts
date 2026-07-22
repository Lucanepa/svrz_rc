import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

test.describe('Print layout', () => {
  test.beforeEach(async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    // Navigate to feedback form — click first coachee row if available, otherwise stay on main view
    // The feedback form is shown when feedbackSubView === 'feedbackForm'
    // We need to get to that state; for now test the main page print rules
  });

  test('no-print elements are hidden in print media', async ({ page }) => {
    // Emulate print media
    await page.emulateMedia({ media: 'print' });

    // The toolbar (no-print) should be hidden
    const toolbar = page.locator('.no-print').first();
    await expect(toolbar).toBeHidden();
  });

  test('print background colors are preserved', async ({ page }) => {
    await page.emulateMedia({ media: 'print' });

    // Verify the print-color-adjust CSS is applied
    const body = page.locator('body');
    const printColorAdjust = await body.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.getPropertyValue('print-color-adjust') || style.getPropertyValue('-webkit-print-color-adjust');
    });
    expect(printColorAdjust).toBe('exact');
  });

  test('body has no margin/padding in print', async ({ page }) => {
    await page.emulateMedia({ media: 'print' });

    const styles = await page.locator('body').evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        margin: style.margin,
        padding: style.padding,
        width: style.width,
      };
    });
    expect(styles.margin).toBe('0px');
    expect(styles.padding).toBe('0px');
  });
});

test.describe('Feedback form structure', () => {
  test('printable area contains form header with Swiss Volley branding', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    // The printableRef div should contain the Swiss Volley logo and title
    // It's visible when feedbackSubView === 'feedbackForm'
    // On first load it should default to 'coachees' subview, so we look for the heading
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
  });

  test('form has correct grid layout for meta fields', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    // The printable container only exists in the feedback-form view. Without
    // opening it this test asserted nothing at all.
    await openFeedbackForm(page);

    const printableArea = page.locator('[class*="print:shadow-none"]');
    await expect(printableArea.first()).toBeVisible();
    const classes = await printableArea.first().getAttribute('class');
    expect(classes).toContain('print:border-none');
    expect(classes).toContain('print:p-0');
    expect(classes).toContain('print:max-w-none');
    expect(classes).toContain('print:mx-0');
  });
});

test.describe('PDF download button', () => {
  test('PDF download button is visible on desktop', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);

    const pdfButton = page.locator('button').filter({ hasText: /PDF|Download/ });
    await expect(pdfButton.first()).toBeVisible();
  });

  test('the downloaded PDF is named after the match and role', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);

    // Exercises the app's own naming, not a copy of it re-implemented here —
    // the previous version asserted on a string it had just built itself.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button').filter({ hasText: /PDF|Download/ }).first().click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^[\w.-]+-[12]SR\.pdf$/);
  });
});

test.describe('Print page generation', () => {
  test('can generate PDF from print view without errors', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    // Listen for console errors during the page lifecycle
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Emulate print media to verify no rendering errors
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(500);

    // Filter out network errors (API calls to backend that isn't running)
    const nonNetworkErrors = errors.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_'),
    );
    expect(nonNetworkErrors).toHaveLength(0);
  });

  test('page generates valid PDF with correct magic bytes', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    const cdp = await page.context().newCDPSession(page);
    const result = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });

    expect(result.data).toBeTruthy();
    expect(result.data.length).toBeGreaterThan(100);

    const buffer = Buffer.from(result.data, 'base64');
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  test('PDF MediaBox matches A4 portrait (595x842 pt)', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');

    const cdp = await page.context().newCDPSession(page);
    const result = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });

    const pdfText = Buffer.from(result.data, 'base64').toString('latin1');
    // PDF MediaBox defines the page dimensions in points (1 pt = 1/72 inch)
    // A4 = 595.28 x 841.89 pt. Chromium may round slightly.
    const mediaBoxMatch = pdfText.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    expect(mediaBoxMatch).toBeTruthy();
    if (mediaBoxMatch) {
      const width = parseFloat(mediaBoxMatch[3]);
      const height = parseFloat(mediaBoxMatch[4]);
      // A4 portrait: ~595 x ~842 points (allow small rounding tolerance)
      expect(width).toBeGreaterThan(590);
      expect(width).toBeLessThan(600);
      expect(height).toBeGreaterThan(838);
      expect(height).toBeLessThan(846);
      // Verify portrait orientation (height > width)
      expect(height).toBeGreaterThan(width);
    }
  });

  test('no content overflows the page width in print mode', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);

    // Check that no element extends beyond the viewport width
    // A4 at 96dpi ~ 794px, but we check relative to body width
    const overflowInfo = await page.evaluate(() => {
      const bodyWidth = document.body.scrollWidth;
      const viewportWidth = window.innerWidth;
      const overflowing: string[] = [];

      // Check all visible elements for horizontal overflow
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (rect.width === 0) continue;
        // Element right edge extends past viewport
        if (rect.right > viewportWidth + 5) { // 5px tolerance
          const tag = el.tagName.toLowerCase();
          const cls = el.className?.toString().slice(0, 60) || '';
          overflowing.push(`${tag}.${cls} (right: ${Math.round(rect.right)}, viewport: ${viewportWidth})`);
        }
      }
      return { bodyWidth, viewportWidth, overflowing: overflowing.slice(0, 10) };
    });

    // Body should not be wider than viewport (no horizontal scrollbar)
    expect(overflowInfo.bodyWidth).toBeLessThanOrEqual(overflowInfo.viewportWidth + 5);
    // No elements should overflow
    expect(overflowInfo.overflowing).toHaveLength(0);
  });

  test('print screenshot shows form fills full width without right cutoff', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);

    // Take a screenshot in print mode and check pixel content on the right edge
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot.length).toBeGreaterThan(0);

    // Save screenshot for visual inspection (in test-results/)
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(screenshot);

    // Check right edge of image: if content is cut off, the right ~20px column
    // would be abruptly white/blank while the rest has content.
    // Sample pixels from the right margin area (last 10% of width)
    const rightEdgeStart = Math.floor(png.width * 0.9);
    let nonWhitePixelsInRightEdge = 0;

    for (let y = 0; y < png.height; y += 10) { // sample every 10th row
      for (let x = rightEdgeStart; x < png.width; x += 5) {
        const idx = (png.width * y + x) << 2;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        // Count non-white pixels (anything not pure white/near-white)
        if (r < 245 || g < 245 || b < 245) {
          nonWhitePixelsInRightEdge++;
        }
      }
    }

    expect(png.width).toBeGreaterThan(100);
    expect(png.height).toBeGreaterThan(100);
    // The right 10% is the page margin: content reaching into it means the
    // layout is running off the sheet. Computing this and never asserting on it
    // was the whole point of the test going missing.
    const sampled = Math.ceil(png.height / 10) * Math.ceil((png.width - rightEdgeStart) / 5);
    expect(nonWhitePixelsInRightEdge).toBeLessThan(sampled * 0.5);
  });

  test('form grid borders are continuous (not broken by overflow)', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);

    // Check that bordered grid elements (meta fields, assessment table)
    // have consistent widths — a sign that borders aren't broken by cutoff
    const gridInfo = await page.evaluate(() => {
      // Find all grid containers with border classes
      const grids = document.querySelectorAll('[class*="grid"]');
      const results: { tag: string; width: number; parentWidth: number; overflows: boolean }[] = [];

      for (const grid of grids) {
        const rect = grid.getBoundingClientRect();
        const parentRect = grid.parentElement?.getBoundingClientRect();
        if (rect.width === 0 || !parentRect) continue;

        results.push({
          tag: `${grid.tagName}.${(grid.className?.toString() || '').slice(0, 40)}`,
          width: Math.round(rect.width),
          parentWidth: Math.round(parentRect.width),
          overflows: rect.right > (parentRect.right + 2),
        });
      }
      return results;
    });

    // No grid should overflow its parent
    for (const grid of gridInfo) {
      expect(grid.overflows).toBe(false);
    }
  });
});

test.describe('Print content visibility', () => {
  test('assessment legend is visible in print', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
    await page.emulateMedia({ media: 'print' });

    // The legend lives in the form view; on Home the guarded assertion below
    // never ran and the test passed without checking anything.
    const legend = page.locator('text=/Beispielhaft|Exemplary/');
    await expect(legend.first()).toBeVisible();
  });

  test('Swiss Volley logo is visible in print when form is shown', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
    await page.emulateMedia({ media: 'print' });

    // The real alt text is "Swiss Volley Region Zürich"; the exact-match
    // selector this used to carry matched nothing, so nothing was checked.
    const logo = page.locator('img[alt*="Swiss Volley"]');
    await expect(logo.first()).toBeVisible();
  });

  test('toolbar buttons are hidden in print', async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await page.emulateMedia({ media: 'print' });

    // Back button, PDF button, role toggle should all be hidden (no-print)
    const noPrintElements = page.locator('.no-print');
    const count = await noPrintElements.count();
    for (let i = 0; i < count; i++) {
      await expect(noPrintElements.nth(i)).toBeHidden();
    }
  });
});
