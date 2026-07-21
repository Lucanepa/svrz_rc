import { test, expect } from '@playwright/test';
import type { FeedbackFormData } from '../src/types';

// Exercises src/lib/feedbackPdf.ts directly in the browser, which is the only
// place it can run: it embeds font subsets and a logo through Vite's asset
// pipeline. These assertions cover what the old screenshot-based PDF could not
// guarantee — real A4 pages, extractable text, and a byte size that does not
// depend on the coach's window.

type Built = { filled: string; blank: string; sizes: { filled: number; blank: number } };

/** Build the three documents inside the page and hand back base64. */
async function buildPdfs(page: import('@playwright/test').Page): Promise<Built> {
  return page.evaluate(async () => {
    // Resolved by the browser against the Vite dev server, so the specifier is
    // kept out of TypeScript's module resolution.
    const load = (path: string): Promise<Record<string, never>> => import(path);
    const pdf = await load('/src/lib/feedbackPdf.ts') as unknown as typeof import('../src/lib/feedbackPdf');
    const types = await load('/src/types.ts') as unknown as typeof import('../src/types');

    const sections = types.SECTIONS_1SR_DE.map((section, si) => ({
      ...section,
      items: section.items.map((item, ii) => ({
        ...item,
        // '1sr-lead-2' is the one criterion that can be marked not applicable.
        rating: item.id === '1sr-lead-2' ? 'N/A' : ['C', 'B', 'A', 'D', 'E'][(si + ii) % 5],
      })),
    }));

    const data = {
      role: '1. SR',
      lang: 'DE',
      meta: {
        spielNr: '2345678',
        liga: 'NLB Herren',
        datum: '2026-03-14',
        ort: 'Sporthalle Utogrund, Zürich',
        mannschaften: 'VBC Züri Unterland vs. Volley Näfels II',
        ergebnis: '3:1 (25:20 / 23:25 / 25:19 / 25:22)',
        // Latin Extended-A: jsPDF's built-in fonts cannot render these.
        srName: 'Šimun Đurđević-Łukasiewicz',
        srNiveau: 'N3 - 2',
        rc: 'Luca Canepa',
        gruppe: 'Gruppe B',
      },
      sections,
      results: {
        motivation: 'up',
        einstufung: 'check',
        bemerkungen: 'Sehr souveräne Spielleitung über die volle Distanz. '.repeat(12),
        highlights: 'Blicktechnik vor dem Service.',
        improvements: 'Netzsituationen früher einnehmen.',
        goals: 'Fokus auf konstantes Timing.',
        srZiel: '2L',
        spielniveau: 'normal',
        secondBesuch: 'Y',
      },
      signature: '',
    } as unknown as FeedbackFormData;

    const filledDoc = pdf.buildFeedbackPdf(data);
    const blankDoc = pdf.buildEmptyFeedbackPdf(['1. SR', '2. SR']);
    const b64 = (doc: ReturnType<typeof pdf.buildFeedbackPdf>) =>
      doc.output('datauristring').split(',')[1];
    return {
      filled: b64(filledDoc),
      blank: b64(blankDoc),
      sizes: { filled: filledDoc.getNumberOfPages(), blank: blankDoc.getNumberOfPages() },
    };
  }) as Promise<Built>;
}

test.describe('Feedback PDF builder', () => {
  test('produces A4 pages with real, extractable text', async ({ page }) => {
    await page.goto('/');
    const built = await buildPdfs(page);
    const pdf = Buffer.from(built.filled, 'base64');

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // Every page is A4 portrait, rather than the single tall custom page the
    // rasterised version emitted.
    const raw = pdf.toString('latin1');
    const boxes = [...raw.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(parseFloat(box[3])).toBeCloseTo(595.28, 1);
      expect(parseFloat(box[4])).toBeCloseTo(841.89, 1);
    }

    // Text, not pixels: an embedded font means a /FontFile2 and no page-sized image.
    expect(raw).toContain('/FontFile2');
  });

  test('stays small regardless of viewport', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/');
    const narrow = await buildPdfs(page);

    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto('/');
    const wide = await buildPdfs(page);

    // The screenshot approach grew with the window until it broke the server's
    // 3 MB limit. Two builds may differ only in their creation timestamp and the
    // file /ID jsPDF derives from it.
    const withoutTimestamp = (b64: string) =>
      Buffer.from(b64, 'base64')
        .toString('latin1')
        .replace(/\/CreationDate\s*\([^)]*\)/g, '')
        .replace(/\/ID\s*\[[^\]]*\]/g, '');
    expect(withoutTimestamp(wide.filled)).toBe(withoutTimestamp(narrow.filled));
    expect(Buffer.from(wide.filled, 'base64').length).toBeLessThan(600 * 1024);
  });

  test('gives the assessment one page and the remarks their own, growing as needed', async ({ page }) => {
    await page.goto('/');
    const pages = await page.evaluate(async () => {
      const load = (path: string): Promise<Record<string, never>> => import(path);
      const pdf = await load('/src/lib/feedbackPdf.ts') as unknown as typeof import('../src/lib/feedbackPdf');
      const types = await load('/src/types.ts') as unknown as typeof import('../src/types');

      const base = {
        role: '1. SR' as const,
        lang: 'DE' as const,
        meta: {
          spielNr: '2345678', liga: 'NLB Herren', datum: '14.03.2026 19:30',
          ort: 'Utogrund', mannschaften: 'A vs. B', ergebnis: '3:1',
          srName: 'Šimun Đurđević', srNiveau: 'N3 - 2', rc: 'RC', gruppe: 'B',
        },
        sections: types.SECTIONS_1SR_DE,
        results: {
          motivation: 'up' as const, einstufung: 'check' as const,
          bemerkungen: '', highlights: '', improvements: '', goals: '',
          srZiel: '2L', spielniveau: 'normal' as const, secondBesuch: 'Y' as const,
        },
        signature: '',
      };
      const long = 'Sehr souveräne Spielleitung über die volle Distanz, der Pfiff war jederzeit klar. '.repeat(120);
      return {
        empty: pdf.buildFeedbackPdf(base).getNumberOfPages(),
        typical: pdf.buildFeedbackPdf({ ...base, results: { ...base.results, bemerkungen: long.slice(0, 900) } }).getNumberOfPages(),
        verbose: pdf.buildFeedbackPdf({ ...base, results: { ...base.results, bemerkungen: long, highlights: long.slice(0, 1500) } }).getNumberOfPages(),
      };
    });

    // Criteria on page 1, written feedback on page 2 — however little is written.
    expect(pages.empty).toBe(2);
    expect(pages.typical).toBe(2);
    // A coach who writes at length gets more sheets rather than clipped text.
    expect(pages.verbose).toBeGreaterThanOrEqual(3);
  });

  test('shows the match date as dd.mm.yyyy HH:MM', async ({ page }) => {
    await page.goto('/');
    const formatted = await page.evaluate(async () => {
      const load = (path: string): Promise<Record<string, never>> => import(path);
      const pdf = await load('/src/lib/feedbackPdf.ts') as unknown as typeof import('../src/lib/feedbackPdf');
      // Every shape meta.datum can hold: what formatDisplayDate writes for a
      // synced game, a raw ISO date from a freshly initialised form, and the
      // slashed format the app used to produce.
      return [
        '2026-03-14T19:30:00.000Z',
        '2026-03-14 19:30',
        '14.03.2026 19:30',
        '14/03/2026 19:30',
        '2026-03-14',
        '',
      ].map((value) => pdf.__formatMetaDate(value));
    });

    expect(formatted).toEqual([
      '14.03.2026 19:30',
      '14.03.2026 19:30',
      '14.03.2026 19:30',
      '14.03.2026 19:30',
      // Date-only in, date-only out: inventing 00:00 would be a lie about kick-off.
      '14.03.2026',
      '',
    ]);
  });

  test('blank form is one printable sheet per role, with fillable fields', async ({ page }) => {
    await page.goto('/');
    const built = await buildPdfs(page);

    expect(built.sizes.blank).toBe(2);

    const raw = Buffer.from(built.blank, 'base64').toString('latin1');
    const fields = [...raw.matchAll(/\/T\s*\((.*?)\)/g)].map((m) => m[1]);
    for (const name of ['1SR_matchNo', '1SR_remarks', '1SR_matchLevel', '2SR_teams', '2SR_goals']) {
      expect(fields).toContain(name);
    }
  });
});
