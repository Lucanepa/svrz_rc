// The page in front of the Gebührenordnung.
//
// The GBO is seven pages of club fees, and the six lines a referee actually
// needs — what a game pays, what a missed upload costs, what a red card costs
// the team — are spread over articles 9, 11, 12, 13, 14 and 20. A coach asked
// "how much do I get for this game?" in the gym wants a table, not a search.
// So the proxy puts one in front of the official document, clearly marked as
// ours, with the article numbers so anyone can check it against the pages
// that follow.
//
// The figures are typed in by hand from the GBO of 8 July 2026. When the DV
// passes a new one, the upstream PDF changes under the same URL, this page
// does not — so `GBO_SUMMARY_STAND` is printed on the page, and the entry in
// src/lib/usefulDocs.ts names the same date. Bump `GBO_SUMMARY_VERSION` on
// any edit here so browsers holding the old ETag fetch the new page.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const GBO_SUMMARY_VERSION = 1;
export const GBO_SUMMARY_STAND = '8. Juli 2026';

type Row = [label: string, amount: string];
type Section = { title: string; rows: Row[] };

const SECTIONS: Section[] = [
  {
    title: 'Entschädigung SR pro Spiel (Art. 20) – zahlt das Heimteam',
    rows: [
      ['2. Liga Damen und Herren', 'CHF 60.–'],
      ['3. Liga Damen und Herren', 'CHF 50.–'],
      ['4. Liga und tiefer', 'CHF 40.–'],
      ['U23 1. Liga', 'CHF 50.–'],
      ['U23 2. Liga und tiefer', 'CHF 40.–'],
      ['Reisespesen pauschal, pro Tag und SR', 'CHF 20.–'],
      ['Turniere des RV (NSM-Quali, Finalissima, weitere), pro Spiel – zahlt der RV; Reise wie oben', 'CHF 30.–'],
      ['NLA, NLB und 1. Liga', 'Regelung Swiss Volley'],
    ],
  },
  {
    title: 'Referee Coach (Art. 14 Abs. 3)',
    rows: [
      ['Pauschal pro Einsatz, Fahrkosten inbegriffen', 'CHF 60.–'],
    ],
  },
  {
    title: 'Bussen gegenüber SR (Art. 13)',
    rows: [
      ['a) Matchblatt verspätet im VolleyManager hochgeladen', 'CHF 25.–'],
      ['b) Matchblatt nicht hochgeladen, oder Matchblatt und Einsatzliste nicht abgeschlossen', 'CHF 50.–'],
      ['c) Zu spät am Spiel (H – 30)', 'CHF 50.–'],
      ['d) Nichterscheinen bei einem Spiel', 'CHF 100.–'],
      ['e) SR-Daten im VolleyManager nicht fristgerecht erfasst', 'CHF 50.–'],
      ['f) E-Learning-Module nicht fristgerecht abgeschlossen', 'CHF 150.–'],
      ['g) Pflichtpensum nicht erfüllt, pro fehlendem Spiel', 'CHF 100.–'],
      ['h) Verpflichtung als Neu-SR (mindestens zwei Saisons) nicht eingehalten', 'CHF 500.–'],
    ],
  },
  {
    title: 'Was eine Karte das Team kostet (Art. 11)',
    rows: [
      ['Rote Karte', 'CHF 150.–'],
      ['Herausstellung (rot und gelb zusammen gezeigt)', 'CHF 300.–'],
      ['Disqualifikation (rot und gelb getrennt gezeigt), dazu Spielsperren', 'CHF 500.–'],
      ['Höchstens pro Ereignis', 'CHF 500.–'],
    ],
  },
  {
    title: 'Weitere Bussen für Teams, die der SR auslöst (Art. 12)',
    rows: [
      ['Unkorrektes Tenü – 1. / 2. / ab 3. Mal', '100 / 200 / 250'],
      ['Forfait – 1. / 2. / ab 3. Mal; bei Spielforfait zusätzlich die SR-Entschädigung, wenn nicht rechtzeitig abgesagt', '200 / 400 / 500'],
      ['Schreiber:in zu spät (H – 30) oder nicht erschienen, pro Spiel', 'CHF 30.–'],
      ['Der SR muss Einträge in der Einsatzliste löschen / hinzufügen, pauschal pro Mal', '50 / 100'],
    ],
  },
  {
    title: 'Kursgebühren (Art. 9)',
    rows: [
      ['SR-Ausbildung / Wiedereinsteiger / N3-Kurs für SR ohne N4 im RV', '350 / 200 / 150'],
    ],
  },
];

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 46;
const AMOUNT_WIDTH = 118;
const RED = rgb(0.72, 0.11, 0.11);
const INK = rgb(0.16, 0.14, 0.13);
const MUTED = rgb(0.45, 0.42, 0.40);
const RULE = rgb(0.85, 0.83, 0.81);

/** Greedy word wrap against the font's real metrics. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const probe = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(probe, size) <= width || !line) line = probe;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function drawSummaryPage(page: PDFPage, regular: PDFFont, bold: PDFFont): void {
  const width = PAGE.width - 2 * MARGIN;
  const labelWidth = width - AMOUNT_WIDTH - 12;
  let y = PAGE.height - MARGIN;

  page.drawText('Gebührenordnung SVRZ – das Wichtigste für SR und RC', { x: MARGIN, y: y - 14, size: 15, font: bold, color: INK });
  y -= 32;
  const intro = wrap(
    `Zusammenfassung aus der SR-Coaching-App, Stand GBO vom ${GBO_SUMMARY_STAND}. Sie ist nicht Teil des Reglements: ` +
    'massgebend ist die Gebührenordnung ab der nächsten Seite, die Artikelnummern führen dorthin.',
    regular, 8.5, width,
  );
  for (const line of intro) { page.drawText(line, { x: MARGIN, y, size: 8.5, font: regular, color: MUTED }); y -= 11; }
  y -= 8;

  const rowSize = 9.5;
  const lineHeight = 12;
  for (const section of SECTIONS) {
    // The baseline is what is positioned, so the heading needs room for its
    // own height above the previous section's last rule, plus a breath.
    y -= 22;
    page.drawText(section.title, { x: MARGIN, y, size: 10.5, font: bold, color: RED });
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.8, color: RED });
    y -= 4;
    for (const [label, amount] of section.rows) {
      const lines = wrap(label, regular, rowSize, labelWidth);
      const top = y;
      for (const line of lines) {
        y -= lineHeight;
        page.drawText(line, { x: MARGIN, y, size: rowSize, font: regular, color: INK });
      }
      // The amount sits on the first line of its label, flush right.
      const amountWidth = bold.widthOfTextAtSize(amount, rowSize);
      page.drawText(amount, { x: MARGIN + width - amountWidth, y: top - lineHeight, size: rowSize, font: bold, color: INK });
      y -= 3;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.4, color: RULE });
    }
  }

  const footer = 'Original: svrz.ch › Verband › Reglemente & Vorschriften › Reglemente Regionalverband. Bei Abweichungen gilt das Reglement.';
  page.drawText(footer, { x: MARGIN, y: MARGIN - 10, size: 7.5, font: regular, color: MUTED });
}

/**
 * The GBO with the summary page in front: a fresh document, our page drawn
 * first, then every upstream page copied over unchanged.
 */
export async function withGboSummary(upstream: Uint8Array): Promise<Uint8Array> {
  const source = await PDFDocument.load(upstream, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.setTitle('Gebührenordnung Swiss Volley Region Zürich');
  out.setSubject(`Mit Zusammenfassung für SR und RC, Stand ${GBO_SUMMARY_STAND}`);
  const regular = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  drawSummaryPage(out.addPage([PAGE.width, PAGE.height]), regular, bold);
  const pages = await out.copyPages(source, source.getPageIndices());
  for (const page of pages) out.addPage(page);
  return out.save();
}
