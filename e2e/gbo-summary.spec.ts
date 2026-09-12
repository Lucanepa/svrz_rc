import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { withGboSummary, GBO_SUMMARY_STAND } from '../server/gboSummary';

/**
 * The page the proxy puts in front of the Gebührenordnung.
 *
 * A referee asks "what does this game pay?"; the answer is one line in a
 * seven-page club-fee document. So the API serves the GBO with a summary page
 * first — ours, labelled as such — and the official pages after it, untouched.
 *
 * No browser needed: the function takes bytes and returns bytes. The upstream
 * stand-in is built here rather than fetched, so the test neither depends on
 * svrz.ch nor ships a copy of the regulation.
 */

async function fakeUpstream(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([595, 842]).drawText(text, { x: 50, y: 700, size: 12, font });
  return doc.save();
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    out.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return out;
}

test('the summary comes first and the regulation follows, page for page', async () => {
  const upstream = await fakeUpstream(['GBO Seite eins', 'GBO Seite zwei', 'GBO Seite drei']);
  const served = await withGboSummary(upstream);

  expect(Buffer.from(served.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  const texts = await pageTexts(served);
  expect(texts).toHaveLength(4);
  expect(texts[1]).toContain('GBO Seite eins');
  expect(texts[3]).toContain('GBO Seite drei');
});

test('the summary says what it is, and carries the figures a referee looks up', async () => {
  const [summary] = await pageTexts(await withGboSummary(await fakeUpstream(['x'])));

  // Ours, dated, and pointing at the real thing — not passed off as the DV's.
  expect(summary).toContain('SR-Coaching-App');
  expect(summary).toContain(GBO_SUMMARY_STAND);
  expect(summary).toMatch(/nicht Teil des Reglements/);

  // The articles, so a doubter can turn the page and check.
  for (const art of ['Art. 20', 'Art. 13', 'Art. 11', 'Art. 12', 'Art. 14', 'Art. 9']) expect(summary).toContain(art);
  // The lines a coach actually gets asked about, searchable as text — the
  // reader's search is the whole point of serving this in the app.
  expect(summary).toMatch(/2\. Liga Damen und Herren\s+CHF 60\.–/);
  expect(summary).toMatch(/Rote Karte\s+CHF 150\.–/);
  expect(summary).toMatch(/Nichterscheinen bei einem Spiel\s+CHF 100\.–/);
  expect(summary).toMatch(/Fahrkosten inbegriffen\s+CHF 60\.–/);
});
