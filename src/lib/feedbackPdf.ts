// Draws the coaching feedback form as a real, text-based A4 PDF.
//
// This replaces rasterising the on-screen DOM with html-to-image. That approach
// produced a single custom-size page of pixels whose byte size grew with the
// coach's window — a filled form on a wide monitor once blew the server's 3 MB
// body limit — and it forced the send path to mutate React state, wait for a
// re-render, and screenshot the live DOM before it could build the attachment.
//
// FeedbackFormData already holds everything the document says, so nothing here
// touches the DOM: the same input always yields the same PDF, regardless of
// viewport, browser, zoom or theme, and the text stays selectable and
// searchable. Layout is expressed in points; the wording of the criteria still
// comes from the shared SECTIONS_* constants, so only the visual arrangement
// lives here.
import { jsPDF } from 'jspdf';
import qrcode from 'qrcode-generator';
import logoDataUrl from '../assets/svrz-logo.png?inline';
import { BUILD_INFO } from './buildInfo';
import { INTER_BOLD_B64, INTER_REGULAR_B64 } from './pdfFonts';
import {
  FeedbackFormData,
  LEGEND,
  SECTIONS_1SR_DE,
  SECTIONS_1SR_EN,
  SECTIONS_2SR_DE,
  SECTIONS_2SR_EN,
} from '../types';

// ---------------------------------------------------------------- page metrics

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 26;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 16;
const RULE = 0.75; // weight of the structural borders
const SIGNATURE_H = 62;
// Height the blank form keeps below its criteria grid for the remarks bands,
// the two signature lines and the survey QR.
const BLANK_TAIL_H = 120;
const CONTENT_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

const RATINGS = ['A', 'B', 'C', 'D', 'E'] as const;
const RATING_COL_W = 26; // default cell width; the filled page 1 widens it to a square

const LOGO_ASPECT = 351 / 175;

// ---------------------------------------------------------------------- colours
// Mirrors the Tailwind palette the on-screen form uses, so the print matches it.

type Rgb = readonly [number, number, number];

const INK: Rgb = [28, 25, 23]; // stone-900
const MUTED: Rgb = [120, 113, 108]; // stone-500
const FAINT: Rgb = [168, 162, 158]; // stone-400
const HAIR: Rgb = [231, 229, 228]; // stone-200
const WASH: Rgb = [250, 250, 249]; // stone-50
const BAND: Rgb = [245, 245, 244]; // stone-100
const WHITE: Rgb = [255, 255, 255];
const ACCENT: Rgb = [220, 38, 38]; // red-600
const HEADING: Rgb = [41, 37, 36]; // stone-800
const SUBHEAD: Rgb = [68, 64, 60]; // stone-700
const C_HINT: Rgb = [243, 242, 241]; // stone-200/50 — the unrated C column

// The referee feedback survey printed on the blank form.
const SURVEY_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSe-UY2EknI02mkGwoPlFso9pcigGV5ceSt2Q3CKJaT6PQzzpA/viewform?usp=sf_link';

const RATING_FILL: Record<string, Rgb> = {
  A: [74, 222, 128], // green-400
  B: [21, 128, 61], // green-700
  C: [37, 99, 235], // blue-600
  D: [249, 115, 22], // orange-500
  E: [220, 38, 38], // red-600
};

// ----------------------------------------------------------------------- labels
// Deliberately a local copy rather than an import of the app's UI_STRINGS: this
// is a filed document, and its wording should not shift when a button label in
// the interface is reworded.

const LABELS = {
  DE: {
    title: 'SR-Coaching Feedback',
    strap: 'SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch',
    matchNo: 'Spiel-Nr.',
    league: 'Liga',
    date: 'Datum',
    location: 'Ort',
    teams: 'Mannschaften',
    result: 'Ergebnis',
    refLevel: 'SR-Niveau',
    rc: 'Referee Coach',
    group: 'Gruppe',
    criteria: 'Kriterien',
    matchLevel: 'Spielniveau',
    motivation: 'Motivation',
    outlook: 'Ausblick',
    secondVisit: 'Weiterer Besuch',
    refGoal: 'SR-Ziel',
    easy: 'Leicht',
    normal: 'Normal',
    difficult: 'Schwierig',
    remarks: 'Bemerkungen',
    highlights: 'Highlights & Potenziale',
    improvements: 'Bereiche / Potenzial zur Verbesserung',
    goalsNext: 'Ziele für nächste Spiele',
    refSignature: 'Unterschrift Schiedsrichter',
    coachSignature: 'Unterschrift Referee Coach',
    surveyCaption: 'Feedback-\nUmfrage',
    version: 'Stand',
    versionDate: '12. März 2026',
    page: 'Seite',
  },
  EN: {
    title: 'Referee Coaching Feedback',
    strap: 'SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch',
    matchNo: 'Match No.',
    league: 'League',
    date: 'Date',
    location: 'Location',
    teams: 'Teams',
    result: 'Result',
    refLevel: 'Referee Level',
    rc: 'Referee Coach',
    group: 'Group',
    criteria: 'Criteria',
    matchLevel: 'Match Level',
    motivation: 'Motivation',
    outlook: 'Outlook',
    secondVisit: 'Further visit',
    refGoal: 'Referee Goal',
    easy: 'Easy',
    normal: 'Normal',
    difficult: 'Difficult',
    remarks: 'Remarks',
    highlights: 'Highlights & potential',
    improvements: 'Areas / potential for improvement',
    goalsNext: 'Goals for next games',
    refSignature: 'Referee signature',
    coachSignature: 'Referee Coach signature',
    surveyCaption: 'Feedback\nsurvey',
    version: 'Version',
    versionDate: '12 March 2026',
    page: 'Page',
  },
};

type Labels = (typeof LABELS)['DE'];

// ------------------------------------------------------------------ primitives

/** A text field to overlay on the blank form, in final page coordinates. */
type BlankField = { name: string; page: number; x: number; y: number; w: number; h: number; multiline?: boolean };

// The embedded Inter subsets cover Latin only (scripts/build-pdf-fonts.mjs).
// jsPDF silently drops any codepoint the subset has no glyph for, so an emoji
// typed on a phone keyboard, or a Greek/Cyrillic name arriving unromanised from
// VolleyManager, vanished from the archived PDF while the e-mail body showed it
// intact. A visible placeholder keeps the two documents honest with each other.
const PDF_GLYPHS = new Set<number>();
for (const [from, to] of [[0x20, 0x7e], [0xa0, 0xff], [0x100, 0x17f], [0x1c4, 0x1cc], [0x2190, 0x2193]]) {
  for (let cp = from; cp <= to; cp++) PDF_GLYPHS.add(cp);
}
for (const ch of 'ƒ–—‘’‚“”„•…‹›′″€™✓✔□☐\n\r\t') PDF_GLYPHS.add(ch.codePointAt(0)!);
const PDF_MISSING_GLYPH = '□';

export function pdfSafeText(value: string): string {
  let out = '';
  for (const ch of value) {
    out += PDF_GLYPHS.has(ch.codePointAt(0)!) ? ch : PDF_MISSING_GLYPH;
  }
  return out;
}

class Sheet {
  readonly doc: jsPDF;
  y = MARGIN;
  /** Points kept free at the foot of the page (for the signature block). */
  reserve = 0;
  /** Run after a page break, to re-establish the banner on the new page. */
  onNewPage?: (sheet: Sheet) => void;
  /** Width of one A–E rating cell. Widened on the filled page so it is square. */
  ratingColW = RATING_COL_W;
  /** When set, every criterion row is this tall — a uniform grid of squares. */
  criterionRowH: number | null = null;

  get ratingsW(): number {
    return this.ratingColW * RATINGS.length;
  }
  /** Fields collected while drawing the blank form; empty otherwise. */
  readonly fields: BlankField[] = [];

  constructor(readonly blank: boolean) {
    // compress: the embedded font subsets dominate the file otherwise.
    this.doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
    this.doc.addFileToVFS('Inter-Regular.ttf', INTER_REGULAR_B64);
    this.doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
    this.doc.addFileToVFS('Inter-Bold.ttf', INTER_BOLD_B64);
    this.doc.addFont('Inter-Bold.ttf', 'Inter', 'bold');
    this.doc.setLineHeightFactor(1.15);
    // One chokepoint for every string that reaches the page — see pdfSafeText.
    const rawText = this.doc.text.bind(this.doc);
    type TextArg = Parameters<jsPDF['text']>[0];
    this.doc.text = ((content: TextArg, ...rest: unknown[]) => rawText(
      typeof content === 'string' ? pdfSafeText(content)
        : Array.isArray(content) ? (content as string[]).map(pdfSafeText)
        : content,
      ...(rest as never[]),
    )) as jsPDF['text'];
  }

  font(weight: 'normal' | 'bold', size: number, colour: Rgb = INK): this {
    this.doc.setFont('Inter', weight);
    this.doc.setFontSize(size);
    this.doc.setTextColor(...colour);
    return this;
  }

  stroke(colour: Rgb, width = 0.5): this {
    this.doc.setDrawColor(...colour);
    this.doc.setLineWidth(width);
    return this;
  }

  fill(colour: Rgb): this {
    this.doc.setFillColor(...colour);
    return this;
  }

  /** Break to a new page unless `height` still fits under the current cursor. */
  ensure(height: number): boolean {
    if (this.y + height <= CONTENT_BOTTOM - this.reserve) return false;
    this.newPage();
    return true;
  }

  newPage(): void {
    this.doc.addPage();
    this.y = MARGIN;
    this.onNewPage?.(this);
  }

  /** Wrap `text` to `width`, returning the lines at the current font size. */
  wrap(text: string, width: number): string[] {
    if (!text) return [];
    return this.doc.splitTextToSize(text, width) as string[];
  }

  /**
   * Draw `text` at a size that fits `width`, shrinking down to `min` before
   * giving up and clipping. Long results ("3:1 (25:20 / 23:25 / …)") and team
   * pairings otherwise run straight out of their meta box.
   */
  fitText(text: string, x: number, y: number, width: number, size: number, min = 5.5): void {
    if (!text) return;
    let s = size;
    while (s > min && this.doc.getTextWidth(text) > width) {
      s -= 0.25;
      this.doc.setFontSize(s);
    }
    this.doc.text(text, x, y, { baseline: 'middle', maxWidth: width });
    this.doc.setFontSize(size);
  }

  /**
   * Record a fillable field. jsPDF adds AcroForm fields to whichever page is
   * current at the time, so the page has to be captured here — a blank form
   * whose criteria spill onto a second page would otherwise stack every field
   * onto the last one.
   */
  field(field: Omit<BlankField, 'page'>): void {
    if (this.blank) this.fields.push({ ...field, page: this.page() });
  }

  page(): number {
    return this.doc.getCurrentPageInfo().pageNumber;
  }
}

// --------------------------------------------------------------- glyph drawing
// ↑ ✓ ↓ are drawn as vectors rather than set as text: it keeps them identical
// at every size and independent of what the embedded subset happens to contain.

function drawVerdict(sheet: Sheet, kind: 'up' | 'check' | 'down', cx: number, cy: number, size: number, colour: Rgb): void {
  const { doc } = sheet;
  const r = size / 2;
  doc.setDrawColor(...colour);
  doc.setFillColor(...colour);
  doc.setLineWidth(size * 0.14);
  if (kind === 'check') {
    doc.lines([[r * 0.55, r * 0.6], [r * 0.95, -r * 1.25]], cx - r * 0.62, cy - r * 0.05);
    return;
  }
  // PDF y grows downward, so an "up" arrow puts its head at the smaller y.
  const dir = kind === 'up' ? 1 : -1;
  doc.line(cx, cy + r * 0.75 * dir, cx, cy - r * 0.55 * dir);
  doc.triangle(
    cx, cy - r * 0.95 * dir,
    cx - r * 0.5, cy - r * 0.2 * dir,
    cx + r * 0.5, cy - r * 0.2 * dir,
    'F',
  );
}

/** A small square with an optional label, filled when it is the chosen value. */
function drawChoiceBox(sheet: Sheet, x: number, y: number, w: number, h: number, selected: boolean, draw: (colour: Rgb) => void): void {
  const { doc } = sheet;
  if (selected) {
    sheet.fill(RATING_FILL.C).stroke(RATING_FILL.C, 0.5);
    doc.roundedRect(x, y, w, h, 2, 2, 'FD');
  } else {
    sheet.fill(WHITE).stroke(HAIR, 0.5);
    doc.roundedRect(x, y, w, h, 2, 2, 'FD');
  }
  draw(selected ? WHITE : FAINT);
}

// -------------------------------------------------------------------- sections

function drawHeader(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const { doc } = sheet;
  const logoH = 34;
  const logoW = logoH * LOGO_ASPECT;
  doc.addImage(logoDataUrl, 'PNG', MARGIN, sheet.y, logoW, logoH);

  const x = MARGIN + logoW + 10;
  sheet.font('bold', 5.8, MUTED);
  doc.text(t.strap.toUpperCase(), x, sheet.y + 6, { baseline: 'middle', charSpace: 0.3 });

  sheet.font('bold', 15, INK);
  doc.text(t.title, x, sheet.y + 22, { baseline: 'middle' });

  // Role badge, matching the dark chip beside the on-screen heading.
  const badgeX = x + doc.getTextWidth(t.title) + 8;
  sheet.font('bold', 10, WHITE);
  const badgeW = doc.getTextWidth(data.role) + 12;
  sheet.fill(INK);
  doc.roundedRect(badgeX, sheet.y + 13, badgeW, 18, 3, 3, 'F');
  doc.text(data.role, badgeX + badgeW / 2, sheet.y + 22.5, { baseline: 'middle', align: 'center' });

  sheet.y += logoH + 8;
}

/**
 * A slim banner for the pages after the first. A detached sheet still has to
 * say which match and which referee it belongs to.
 */
function drawContinuationHeader(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const { doc } = sheet;
  const logoH = 22;
  const logoW = logoH * LOGO_ASPECT;
  doc.addImage(logoDataUrl, 'PNG', MARGIN, sheet.y, logoW, logoH);

  const x = MARGIN + logoW + 10;
  sheet.font('bold', 11.5, INK);
  doc.text(t.title, x, sheet.y + 7, { baseline: 'middle' });

  const badgeX = x + doc.getTextWidth(t.title) + 7;
  sheet.font('bold', 7.5, WHITE);
  const badgeW = doc.getTextWidth(data.role) + 10;
  sheet.fill(INK);
  doc.roundedRect(badgeX, sheet.y + 1, badgeW, 13, 2, 2, 'F');
  doc.text(data.role, badgeX + badgeW / 2, sheet.y + 7.5, { baseline: 'middle', align: 'center' });

  const reference = [
    data.meta.spielNr && `${t.matchNo} ${data.meta.spielNr}`,
    data.meta.mannschaften,
    formatMetaDate(data.meta.datum),
    data.meta.srName,
  ].filter(Boolean).join('  ·  ');
  sheet.font('normal', 7, MUTED);
  sheet.fitText(reference, x, sheet.y + 21, CONTENT_W - logoW - 10, 7);

  // No rule under the banner: the remarks box that follows draws its own top
  // edge, so a second line here just doubled up.
  sheet.y += logoH + 12;
}

/** One labelled cell of the meta grid. Returns nothing; advances no cursor. */
function drawMetaCell(sheet: Sheet, label: string, value: string, name: string, x: number, y: number, w: number, h: number): void {
  const { doc } = sheet;
  sheet.stroke(INK, RULE);
  doc.rect(x, y, w, h, 'S');
  sheet.font('bold', 5.2, FAINT);
  doc.text(label.toUpperCase(), x + 4, y + 7, { baseline: 'middle', charSpace: 0.2 });
  sheet.font('normal', 8.5, INK);
  sheet.fitText(value, x + 4, y + h - 9, w - 8, 8.5);
  sheet.field({ name, x: x + 3, y: y + 11, w: w - 6, h: h - 14 });
}

function drawMetaGrid(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const unit = CONTENT_W / 5;
  const rowH = sheet.blank ? 26 : 29;
  const { meta } = data;
  const v = (s: string) => (sheet.blank ? '' : s);

  let y = sheet.y;
  // Row 1 — 1fr 1fr 1fr 2fr, as on screen.
  drawMetaCell(sheet, t.matchNo, v(meta.spielNr), 'matchNo', MARGIN, y, unit, rowH);
  drawMetaCell(sheet, t.league, v(meta.liga), 'league', MARGIN + unit, y, unit, rowH);
  drawMetaCell(sheet, t.date, v(formatMetaDate(meta.datum)), 'date', MARGIN + unit * 2, y, unit, rowH);
  drawMetaCell(sheet, t.location, v(meta.ort), 'location', MARGIN + unit * 3, y, unit * 2, rowH);
  y += rowH;

  drawMetaCell(sheet, t.teams, v(meta.mannschaften), 'teams', MARGIN, y, CONTENT_W, rowH);
  y += rowH;

  drawMetaCell(sheet, data.role, v(meta.srName), 'srName', MARGIN, y, unit * 2, rowH);
  drawMetaCell(sheet, t.refLevel, v(meta.srNiveau), 'refLevel', MARGIN + unit * 2, y, unit, rowH);
  drawMetaCell(sheet, t.group, v(meta.gruppe), 'group', MARGIN + unit * 3, y, unit * 2, rowH);
  y += rowH;

  drawMetaCell(sheet, t.rc, v(meta.rc), 'rc', MARGIN, y, unit * 2, rowH);
  drawMetaCell(sheet, t.result, v(meta.ergebnis), 'result', MARGIN + unit * 2, y, unit * 3, rowH);
  y += rowH;

  sheet.y = y + 7;
}

function drawLegend(sheet: Sheet, lang: FeedbackFormData['lang']): void {
  const { doc } = sheet;
  sheet.font('normal', 6.4, MUTED);
  const lines = sheet.wrap(LEGEND[lang], CONTENT_W - 16);
  const h = lines.length * 8 + 8;
  sheet.fill(WASH).stroke(HAIR, 0.5);
  doc.rect(MARGIN, sheet.y, CONTENT_W, h, 'FD');
  // The red info dot standing in for the on-screen icon.
  sheet.fill(ACCENT);
  doc.circle(MARGIN + 7, sheet.y + h / 2, 1.7, 'F');
  doc.text(lines, MARGIN + 14, sheet.y + h / 2, { baseline: 'middle' });
  sheet.y += h + 9;
}

function drawSectionHeader(sheet: Sheet, title: string, t: Labels): void {
  const { doc } = sheet;
  const barH = 14;
  sheet.fill(BAND).stroke(INK, RULE);
  doc.rect(MARGIN, sheet.y, CONTENT_W, barH, 'FD');
  sheet.font('bold', 7.6, SUBHEAD);
  doc.text(title.toUpperCase(), MARGIN + 6, sheet.y + barH / 2, { baseline: 'middle', charSpace: 0.3 });
  sheet.y += barH;

  // Column heads: criteria, then A–E with C shaded as the expected default.
  const headH = 11;
  const colW = sheet.ratingColW;
  const criteriaW = CONTENT_W - sheet.ratingsW;
  sheet.fill(WASH).stroke(INK, RULE);
  doc.rect(MARGIN, sheet.y, criteriaW, headH, 'FD');
  sheet.font('bold', 5.6, MUTED);
  doc.text(t.criteria.toUpperCase(), MARGIN + 6, sheet.y + headH / 2, { baseline: 'middle', charSpace: 0.2 });
  RATINGS.forEach((r, i) => {
    const x = MARGIN + criteriaW + i * colW;
    sheet.fill(r === 'C' ? HAIR : WASH).stroke(INK, RULE);
    doc.rect(x, sheet.y, colW, headH, 'FD');
    sheet.font('bold', 6.4, MUTED);
    doc.text(r, x + colW / 2, sheet.y + headH / 2, { baseline: 'middle', align: 'center' });
  });
  sheet.y += headH;
}

function drawCriterionRow(sheet: Sheet, label: string, rating: string): void {
  const { doc } = sheet;
  const colW = sheet.ratingColW;
  const criteriaW = CONTENT_W - sheet.ratingsW;

  // Filled page 1 runs a fixed row height (see planRatingGrid): the A–E cells
  // become a uniform grid of squares. Elsewhere the row grows with its label.
  const uniform = sheet.criterionRowH;
  sheet.font('normal', sheet.blank ? 7.2 : 7.4, INK);
  const lines = uniform ? [label] : sheet.wrap(label, criteriaW - 12);
  const rowH = uniform ?? Math.max(sheet.blank ? 13.5 : 15, lines.length * 8.4 + 6);

  sheet.stroke(INK, RULE).fill(WHITE);
  doc.rect(MARGIN, sheet.y, criteriaW, rowH, 'FD');
  if (uniform) {
    // One line, shrunk to fit — a wrapped label would break the square grid.
    sheet.fitText(label, MARGIN + 6, sheet.y + rowH / 2, criteriaW - 12, 7.4);
  } else {
    doc.text(lines, MARGIN + 6, sheet.y + rowH / 2, { baseline: 'middle' });
  }

  if (rating === 'N/A') {
    // Struck through, exactly as the on-screen row renders it.
    sheet.stroke(INK, RULE).fill(WHITE);
    doc.rect(MARGIN + criteriaW, sheet.y, sheet.ratingsW, rowH, 'FD');
    sheet.stroke(INK, 1);
    doc.line(MARGIN + criteriaW + 6, sheet.y + rowH / 2, MARGIN + CONTENT_W - 6, sheet.y + rowH / 2);
    sheet.y += rowH;
    return;
  }

  RATINGS.forEach((r, i) => {
    const x = MARGIN + criteriaW + i * colW;
    const selected = rating.startsWith(r);
    if (selected) sheet.fill(RATING_FILL[r]);
    else if (r === 'C' && !rating) sheet.fill(C_HINT);
    else sheet.fill(WHITE);
    sheet.stroke(INK, RULE);
    doc.rect(x, sheet.y, colW, rowH, 'FD');
    if (selected) {
      sheet.font('bold', 8.5, WHITE);
      doc.text(rating, x + colW / 2, sheet.y + rowH / 2, { baseline: 'middle', align: 'center' });
    }
  });
  sheet.y += rowH;
}

function drawSections(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const rowH = sheet.criterionRowH ?? 15;
  for (const section of data.sections) {
    // Never leave a section heading stranded at the foot of a page.
    sheet.ensure(14 + 11 + rowH + 6);
    drawSectionHeader(sheet, section.title, t);
    for (const item of section.items) {
      if (sheet.ensure(rowH)) drawSectionHeader(sheet, `${section.title} (…)`, t);
      drawCriterionRow(sheet, item.label, sheet.blank ? '' : item.rating);
    }
    sheet.y += sheet.blank ? 4 : 7;
  }
}

function drawResultsRow(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const { doc } = sheet;
  const h = 40;
  sheet.ensure(h + 4);
  const cellW = CONTENT_W / 5;
  const { results } = data;
  const top = sheet.y;

  sheet.fill(WASH).stroke(INK, RULE);
  doc.rect(MARGIN, top, CONTENT_W, h, 'FD');

  const cellLabel = (label: string, i: number) => {
    const x = MARGIN + cellW * i;
    if (i > 0) {
      sheet.stroke(INK, RULE);
      doc.line(x, top, x, top + h);
    }
    sheet.font('bold', 5.2, MUTED);
    doc.text(label.toUpperCase(), x + 5, top + 8, { baseline: 'middle', charSpace: 0.2 });
    return x;
  };

  // Match level — three chips, the chosen one filled. On the blank form it is a
  // typeable field instead: chips cannot be ticked in a fillable PDF, and the
  // form it replaces let this one be entered.
  const lvlX = cellLabel(t.matchLevel, 0);
  if (sheet.blank) {
    sheet.field({ name: 'matchLevel', x: lvlX + 4, y: top + 15, w: cellW - 8, h: 14 });
  } else {
    const levels: [string, string][] = [['leicht', t.easy], ['normal', t.normal], ['schwierig', t.difficult]];
    let chipX = lvlX + 5;
    sheet.font('bold', 5.6);
    for (const [value, label] of levels) {
      const w = doc.getTextWidth(label) + 8;
      const chosen = results.spielniveau === value;
      sheet.fill(chosen ? RATING_FILL.C : WHITE).stroke(chosen ? RATING_FILL.C : HAIR, 0.5);
      doc.roundedRect(chipX, top + 16, w, 12, 2, 2, 'FD');
      sheet.font('bold', 5.6, chosen ? WHITE : MUTED);
      doc.text(label, chipX + w / 2, top + 22, { baseline: 'middle', align: 'center' });
      chipX += w + 3;
    }
  }

  // Motivation and outlook — up / check / down.
  const verdicts: ['motivation' | 'einstufung', string, number][] = [
    ['motivation', t.motivation, 1],
    ['einstufung', t.outlook, 2],
  ];
  for (const [key, label, col] of verdicts) {
    const x = cellLabel(label, col);
    (['up', 'check', 'down'] as const).forEach((kind, i) => {
      const bx = x + 5 + i * 17;
      const chosen = !sheet.blank && results[key] === kind;
      drawChoiceBox(sheet, bx, top + 15, 14, 14, chosen, (colour) =>
        drawVerdict(sheet, kind, bx + 7, top + 22, 9, colour));
    });
  }

  // Further visit — Y / N.
  const visitX = cellLabel(t.secondVisit, 3);
  (['Y', 'N'] as const).forEach((value, i) => {
    const bx = visitX + 5 + i * 17;
    const chosen = !sheet.blank && results.secondBesuch === value;
    drawChoiceBox(sheet, bx, top + 15, 14, 14, chosen, (colour) => {
      sheet.font('bold', 7.5, colour);
      doc.text(value, bx + 7, top + 22.5, { baseline: 'middle', align: 'center' });
    });
  });

  // Referee goal — free text.
  const goalX = cellLabel(t.refGoal, 4);
  sheet.font('normal', 8.5, INK);
  sheet.fitText(sheet.blank ? '' : results.srZiel, goalX + 5, top + 23, cellW - 10, 8.5);
  sheet.field({ name: 'refGoal', x: goalX + 4, y: top + 15, w: cellW - 8, h: 14 });

  sheet.y = top + h;
}

/**
 * Draw one line of prose, optionally justified to `width`.
 *
 * jsPDF's own `align: 'justify'` is no use here: it deliberately leaves the
 * last line of whatever text it is given ragged, and this flow hands it a
 * single line at a time — so every line counts as the last and nothing is ever
 * stretched. Placing the words individually is also the only way to keep the
 * per-line page-break control the remarks block needs.
 */
function drawProseLine(sheet: Sheet, line: string, x: number, y: number, width: number, justify: boolean): void {
  const { doc } = sheet;
  const words = justify ? line.trim().split(/\s+/).filter(Boolean) : [];
  if (words.length < 2) {
    doc.text(line, x, y, { baseline: 'middle' });
    return;
  }

  const wordsW = words.reduce((sum, w) => sum + doc.getTextWidth(w), 0);
  const gap = (width - wordsW) / (words.length - 1);
  // A line only a couple of words long would be pulled apart into a gappy mess;
  // leave those ragged rather than "justified" in name only.
  const space = doc.getTextWidth(' ');
  if (gap <= 0 || gap > space * 4) {
    doc.text(line, x, y, { baseline: 'middle' });
    return;
  }

  let cx = x;
  for (const word of words) {
    doc.text(word, cx, y, { baseline: 'middle' });
    cx += doc.getTextWidth(word) + gap;
  }
}

/**
 * The remarks block, which is the one part of the form that can be any length.
 * It may span pages, so the enclosing rule is drawn per page segment once the
 * text has been laid out rather than as a single rectangle.
 */
function drawRemarks(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const { doc } = sheet;
  // One enclosing rectangle per page the block touches. They are stroked at the
  // end, because a segment's extent is only known once its text has been laid
  // out — and a segment can be closed by a page break several blocks later.
  const segments: { page: number; top: number; bottom: number }[] = [];
  const floor = () => CONTENT_BOTTOM - sheet.reserve;
  const openSegment = () => segments.push({ page: sheet.page(), top: sheet.y, bottom: sheet.y });
  const closeSegment = (atLeast = 0) => {
    const seg = segments[segments.length - 1];
    if (seg) seg.bottom = Math.max(sheet.y, atLeast);
  };

  /**
   * Break to a new page if `needed` points do not fit, closing the open segment
   * at the page floor and reopening one under the continuation banner.
   */
  const breakIfNeeded = (needed: number): boolean => {
    if (!sheet.ensure(needed)) return false;
    closeSegment(floor());
    openSegment();
    sheet.y += 8;
    return true;
  };

  sheet.ensure(80);
  openSegment();
  // Room for the "Bemerkungen" heading and its rule, both drawn at the end once
  // the first segment's origin is known.
  sheet.y += 24;

  const blocks: { label: string; value: string; name: string; minH: number }[] = [
    { label: t.remarks, value: data.results.bemerkungen, name: 'remarks', minH: 34 },
    { label: t.highlights, value: data.results.highlights || '', name: 'highlights', minH: 22 },
    { label: t.improvements, value: data.results.improvements || '', name: 'improvements', minH: 22 },
    { label: t.goalsNext, value: data.results.goals || '', name: 'goals', minH: 22 },
  ];

  for (const [index, block] of blocks.entries()) {
    sheet.font('normal', 8, INK);
    const lines = sheet.blank ? [] : sheet.wrap(block.value, CONTENT_W - 20);

    // Never strand a heading at the foot of a page: keep it with its first two
    // lines, or move the whole thing down.
    const labelH = index > 0 ? 10 : 0;
    breakIfNeeded(labelH + Math.min(lines.length || 1, 2) * 10.5 + 6);

    if (index > 0) {
      sheet.font('bold', 5.6, FAINT);
      doc.text(block.label.toUpperCase(), MARGIN + 10, sheet.y + 4, { baseline: 'middle', charSpace: 0.2 });
      sheet.y += labelH;
    }

    sheet.font('normal', 8, INK);
    const textW = CONTENT_W - 20;
    let blockTop = sheet.y;
    for (const [i, line] of lines.entries()) {
      if (breakIfNeeded(11)) {
        // The band restarts on the new page, so the fillable rectangle does too.
        sheet.field({ name: block.name, x: MARGIN + 8, y: blockTop - 2, w: CONTENT_W - 16, h: floor() - blockTop, multiline: true });
        blockTop = sheet.y;
        // The continuation header this break just drew leaves the doc on 7pt
        // muted; without this the rest of a long block came out small and grey
        // — in the archived PDF the coachee receives.
        sheet.font('normal', 8, INK);
      }
      // Justified prose, except where a line ends its paragraph — stretching a
      // short closing line to the full column is exactly what justification
      // should not do. A blank line is the paragraph separator.
      const next = lines[i + 1];
      const endsParagraph = next === undefined || next.trim() === '';
      const justify = line.trim() !== '' && !endsParagraph;
      drawProseLine(sheet, line, MARGIN + 10, sheet.y + 5, textW, justify);
      sheet.y += 10.5;
    }
    // Keep a writable band even when the coach left the field empty, so the
    // printed form stays usable by hand.
    if (sheet.y - blockTop < block.minH) sheet.y = blockTop + block.minH;
    sheet.field({ name: block.name, x: MARGIN + 8, y: blockTop - 2, w: CONTENT_W - 16, h: sheet.y - blockTop, multiline: true });

    sheet.stroke(HAIR, 0.5);
    doc.line(MARGIN + 10, sheet.y + 1, MARGIN + CONTENT_W - 10, sheet.y + 1);
    sheet.y += 8;
  }

  // Every segment runs to the page floor, the last one included: a box that
  // stopped wherever the prose ended would leave the sheet looking unfinished.
  closeSegment(floor());
  sheet.y = Math.max(sheet.y, floor());

  // Enclose each page's slice. Closing the top as well as the sides matters
  // where the block continues onto a new page: left open, the continuation
  // reads as an unfinished box running off the top edge.
  for (const seg of segments) {
    doc.setPage(seg.page);
    sheet.stroke(INK, RULE);
    doc.rect(MARGIN, seg.top, CONTENT_W, seg.bottom - seg.top, 'S');
  }
  doc.setPage(segments[segments.length - 1]?.page ?? sheet.page());

  // Heading bar last: it belongs to the first segment, which may be pages back.
  const first = segments[0];
  if (first) {
    doc.setPage(first.page);
    sheet.font('bold', 9, HEADING);
    doc.text(t.remarks, MARGIN + 10, first.top + 12, { baseline: 'middle' });
    sheet.stroke(INK, RULE);
    doc.line(MARGIN + 10, first.top + 18, MARGIN + CONTENT_W - 10, first.top + 18);
    doc.setPage(segments[segments.length - 1].page);
  }
}

/**
 * The survey QR the printed blank form carries, drawn module by module as
 * vector squares — a rasterised QR at this size scans poorly once the form has
 * been through a photocopier.
 */
function drawQr(sheet: Sheet, text: string, x: number, y: number, size: number): void {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const module = size / count;
  sheet.fill(INK);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      // Overdraw by a hair so adjacent modules meet without a seam.
      sheet.doc.rect(x + col * module, y + row * module, module + 0.05, module + 0.05, 'F');
    }
  }
}

/**
 * The blank form's closing block: remarks on the left, signature lines and the
 * survey QR on the right, sized to whatever is left on the sheet. Laying these
 * side by side is what keeps a printable form to one page per role — stacked,
 * as the filled document has them, it always spilled onto a second sheet.
 */
function drawBlankTail(sheet: Sheet, t: Labels): void {
  const { doc } = sheet;
  const top = sheet.y;
  const h = Math.max(120, CONTENT_BOTTOM - top);
  const rightW = 172;
  const leftW = CONTENT_W - rightW;

  sheet.stroke(INK, RULE);
  doc.rect(MARGIN, top, CONTENT_W, h, 'S');
  doc.line(MARGIN + leftW, top, MARGIN + leftW, top + h);

  // Left: remarks heading, then one writable band per field.
  sheet.font('bold', 9, HEADING);
  doc.text(t.remarks, MARGIN + 8, top + 11, { baseline: 'middle' });
  sheet.stroke(INK, RULE);
  doc.line(MARGIN + 8, top + 17, MARGIN + leftW - 8, top + 17);

  const blocks: [string, string, number][] = [
    [t.remarks, 'remarks', 2],
    [t.highlights, 'highlights', 1],
    [t.improvements, 'improvements', 1],
    [t.goalsNext, 'goals', 1],
  ];
  const totalWeight = blocks.reduce((sum, [, , weight]) => sum + weight, 0);
  const free = h - 24 - blocks.length * 9;
  let y = top + 22;
  for (const [label, name, weight] of blocks) {
    sheet.font('bold', 5.2, FAINT);
    doc.text(label.toUpperCase(), MARGIN + 8, y + 4, { baseline: 'middle', charSpace: 0.2 });
    y += 8;
    const bandH = (free * weight) / totalWeight;
    sheet.field({ name, x: MARGIN + 7, y, w: leftW - 14, h: bandH, multiline: true });
    y += bandH;
    sheet.stroke(HAIR, 0.5);
    doc.line(MARGIN + 8, y, MARGIN + leftW - 8, y);
    y += 1;
  }

  // Right: both signature lines above the survey QR.
  const rx = MARGIN + leftW;
  [t.refSignature, t.coachSignature].forEach((label, i) => {
    const ly = top + 14 + i * 40;
    sheet.font('bold', 5.2, MUTED);
    doc.text(label.toUpperCase(), rx + 8, ly, { baseline: 'middle', charSpace: 0.2 });
    sheet.stroke(FAINT, RULE);
    doc.line(rx + 8, ly + 26, rx + rightW - 8, ly + 26);
  });
  const qrSize = Math.min(52, h - 100);
  if (qrSize > 24) {
    drawQr(sheet, SURVEY_URL, rx + 8, top + h - qrSize - 8, qrSize);
    sheet.font('normal', 5.2, FAINT);
    doc.text(t.surveyCaption, rx + qrSize + 14, top + h - qrSize / 2 - 8, { baseline: 'middle' });
  }

  sheet.y = top + h;
}

function drawSignatures(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  const { doc } = sheet;
  const h = 62;
  sheet.ensure(h);
  const top = sheet.y;
  // The blank form reserves the right-hand strip for the survey QR.
  const qrStrip = sheet.blank ? 74 : 0;
  const signW = CONTENT_W - qrStrip;
  sheet.stroke(INK, RULE);
  doc.rect(MARGIN, top, CONTENT_W, h, 'S');

  // Both parties sign: the referee that the feedback was discussed with them,
  // the coach for what it says. A blank form carries the same two lines, empty.
  const columns = sheet.blank
    ? [{ label: t.refSignature, image: '' }, { label: t.coachSignature, image: '' }]
    : [
        { label: t.refSignature, image: data.signature || '' },
        { label: t.coachSignature, image: data.rcSignature || '' },
      ];
  const colW = signW / columns.length;

  columns.forEach((column, i) => {
    const x = MARGIN + colW * i;
    if (i > 0) doc.line(x, top, x, top + h);
    sheet.font('bold', 5.2, MUTED);
    doc.text(column.label.toUpperCase(), x + 8, top + 10, { baseline: 'middle', charSpace: 0.2 });
    if (column.image) {
      const size = pngSize(column.image);
      const maxW = colW - 20;
      const maxH = 34;
      const scale = size ? Math.min(maxW / size.width, maxH / size.height) : 0;
      if (scale > 0 && size) {
        doc.addImage(column.image, 'PNG', x + 8, top + h - 14 - size.height * scale, size.width * scale, size.height * scale);
      }
    }
    sheet.stroke(FAINT, RULE);
    doc.line(x + 8, top + h - 12, x + colW - 8, top + h - 12);
  });

  if (qrStrip) {
    const x = MARGIN + signW;
    sheet.stroke(INK, RULE);
    doc.line(x, top, x, top + h);
    drawQr(sheet, SURVEY_URL, x + 8, top + 8, 46);
    sheet.font('normal', 5.2, FAINT);
    doc.text(t.surveyCaption, x + 58, top + 28, { baseline: 'middle', maxWidth: qrStrip - 62 });
  }

  sheet.y = top + h;
}

function drawFooters(sheet: Sheet, t: Labels): void {
  const { doc } = sheet;
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    const y = PAGE_H - MARGIN + 2;
    sheet.stroke(HAIR, 0.5);
    doc.line(MARGIN, y - 9, MARGIN + CONTENT_W, y - 9);
    sheet.font('normal', 5.8, FAINT);
    doc.text(`${t.version}: ${t.versionDate} | Build ${BUILD_INFO} | SVRZ Referee Coaching Tool`, MARGIN, y, { baseline: 'middle' });
    doc.text(`${t.page} ${page}/${total}`, MARGIN + CONTENT_W, y, { baseline: 'middle', align: 'right' });
  }
}

// ------------------------------------------------------------------- utilities

/**
 * Normalise the match date to dd.mm.yyyy HH:MM. The field usually arrives
 * already formatted from the game, but a manually entered or newly initialised
 * form can still hold a plain ISO date, and the document should not show two
 * different date styles depending on where the value came from.
 */
function formatMetaDate(value: string): string {
  const raw = value?.trim();
  if (!raw) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (d: number, m: number, y: number, hh?: string, mm?: string) =>
    `${pad(d)}.${pad(m)}.${y}${hh ? ` ${hh}:${mm}` : ''}`;

  // Already dd.mm.yyyy or dd/mm/yyyy, optionally with a time.
  const written = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[\sT]+(\d{1,2}):(\d{2}))?/);
  if (written) {
    return stamp(+written[1], +written[2], +written[3], written[4] && pad(+written[4]), written[5]);
  }

  // ISO, with or without a time component.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[\sT](\d{2}):(\d{2}))?/);
  if (iso) {
    return stamp(+iso[3], +iso[2], +iso[1], iso[4], iso[5]);
  }

  return raw;
}

/**
 * Read a PNG's pixel dimensions straight out of its IHDR chunk. Signatures
 * arrive as canvas data URLs, and decoding one through an Image would make the
 * whole builder asynchronous for a number that sits at a fixed byte offset.
 */
function pngSize(dataUrl: string): { width: number; height: number } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  try {
    const head = atob(dataUrl.slice(comma + 1, comma + 45));
    if (head.charCodeAt(1) !== 0x50 || head.charCodeAt(2) !== 0x4e) return null; // "PNG"
    const at = (i: number) =>
      (head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3);
    const width = at(16);
    const height = at(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

type PdfTextField = { fieldName: string; Rect: number[]; fontSize?: number; multiline?: boolean };

/** Overlay the collected blank-form fields as real AcroForm text fields. */
function addBlankFields(sheet: Sheet, prefix: string): void {
  const AcroForm = (jsPDF as unknown as { AcroForm?: { TextField: new () => PdfTextField } }).AcroForm;
  const addField = (sheet.doc as unknown as { addField?: (f: PdfTextField) => void }).addField;
  if (!AcroForm || typeof addField !== 'function') return;
  const resume = sheet.page();
  for (const f of sheet.fields) {
    if (f.w < 3 || f.h < 3) continue;
    sheet.doc.setPage(f.page);
    const tf = new AcroForm.TextField();
    tf.fieldName = `${prefix}_${f.name}`;
    tf.Rect = [f.x, f.y, f.w, f.h];
    tf.fontSize = f.multiline ? 9 : 10;
    if (f.multiline) tf.multiline = true;
    addField.call(sheet.doc, tf);
  }
  sheet.doc.setPage(resume);
}

// ---------------------------------------------------------------- entry points

/**
 * Size the criteria rows so they are a uniform grid of squares filling whatever
 * page-1 height is left below the meta and legend. The A–E cell is square —
 * `ratingColW` is set equal to the row height — and every row is the same
 * height, so the boxes line up in a clean lattice. Freeing page 1 of the
 * signature block is what makes room for cells this size.
 */
function planRatingGrid(
  sheet: Sheet,
  data: FeedbackFormData,
  opts: { below?: number; min?: number; max?: number } = {},
): void {
  // `below` is the height that still has to fit under the grid on this page —
  // the results row always, plus the remarks/signature tail on the blank form.
  const { below = 48, min = 16, max = 34 } = opts;
  const numRows = data.sections.reduce((n, s) => n + s.items.length, 0) || 1;
  const numSections = data.sections.length;
  const headerBlockH = numSections * (14 + 11); // section bar + column head
  const gapH = numSections * 7; // the gap drawSections leaves after each section
  const avail = CONTENT_BOTTOM - sheet.y - headerBlockH - gapH - below;

  // Square cells (col width = row height), kept in range: too short and the mark
  // is cramped, too tall and a short list looks sparse.
  const rowH = Math.max(min, Math.min(max, avail / numRows));
  sheet.criterionRowH = rowH;
  sheet.ratingColW = rowH;
}

/** Sign the foot of the written-feedback pages (2..N); page 1 carries none. */
function signRemarksPages(sheet: Sheet, data: FeedbackFormData, t: Labels): void {
  sheet.reserve = 0;
  sheet.onNewPage = undefined;
  const total = sheet.doc.getNumberOfPages();
  for (let page = 2; page <= total; page++) {
    sheet.doc.setPage(page);
    sheet.y = CONTENT_BOTTOM - SIGNATURE_H;
    drawSignatures(sheet, data, t);
  }
}

/**
 * Page 1 carries the assessment — match details, the graded criteria and the
 * summary row — with no signature, so the freed height goes to a uniform grid of
 * square A–E cells. The written feedback then starts on its own page, which
 * gives the remarks room to breathe, and runs onto further pages when a coach
 * writes at length. Every feedback page is signed at the foot.
 */
function draw(sheet: Sheet, data: FeedbackFormData): void {
  const t = LABELS[data.lang];
  sheet.onNewPage = (s) => drawContinuationHeader(s, data, t);

  // Page 1: no reserved signature band, so the criteria can fill the sheet.
  sheet.reserve = 0;
  drawHeader(sheet, data, t);
  drawMetaGrid(sheet, data, t);
  drawLegend(sheet, data.lang);
  planRatingGrid(sheet, data);
  drawSections(sheet, data, t);
  drawResultsRow(sheet, data, t);
  sheet.criterionRowH = null;
  sheet.ratingColW = RATING_COL_W;

  // Written feedback on its own page(s), each signed at the foot.
  sheet.newPage();
  sheet.reserve = SIGNATURE_H + 10;
  drawRemarks(sheet, data, t);
  sheet.reserve = 0;
  signRemarksPages(sheet, data, t);

  drawFooters(sheet, t);
}

/** Exposed for e2e coverage of the Datum cell's normalisation. */
export const __formatMetaDate = formatMetaDate;

/** The filled-in feedback form, ready to save, share or attach. */
export function buildFeedbackPdf(data: FeedbackFormData): jsPDF {
  const sheet = new Sheet(false);
  draw(sheet, data);
  return sheet.doc;
}

/** Base64 of the same document, for the save/e-mail payload. */
export function feedbackPdfBase64(data: FeedbackFormData): string {
  return buildFeedbackPdf(data).output('datauristring').split(',')[1] ?? '';
}

/**
 * The printable blank form — one page per role, with fillable text fields. The
 * fields sit at coordinates this module chose, so unlike the old screenshot
 * overlay they cannot drift out of alignment with what is drawn beneath them.
 */
export function buildEmptyFeedbackPdf(roles: FeedbackFormData['role'][], lang: FeedbackFormData['lang'] = 'DE'): jsPDF {
  const sheet = new Sheet(true);
  const t = LABELS[lang];
  roles.forEach((role, index) => {
    if (index > 0) {
      sheet.doc.addPage();
      sheet.y = MARGIN;
    }
    const sections = role === '1. SR'
      ? (lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN)
      : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
    const blank: FeedbackFormData = {
      role,
      lang,
      meta: { spielNr: '', liga: '', datum: '', ort: '', mannschaften: '', ergebnis: '', srName: '', srNiveau: '', rc: '', gruppe: '' },
      sections,
      results: { motivation: '', einstufung: '', bemerkungen: '', highlights: '', improvements: '', goals: '', srZiel: '', spielniveau: '', secondBesuch: '' },
      signature: '',
    };
    sheet.fields.length = 0;
    drawHeader(sheet, blank, t);
    drawMetaGrid(sheet, blank, t);
    drawLegend(sheet, lang);
    // Square A–E cells here too, but compact: unlike the filled page 1 this
    // sheet still has to carry the remarks bands, both signature lines and the
    // QR below the grid, and stay a single printable page per role.
    planRatingGrid(sheet, blank, { below: 48 + BLANK_TAIL_H, min: 13, max: 20 });
    drawSections(sheet, blank, t);
    drawResultsRow(sheet, blank, t);
    drawBlankTail(sheet, t);
    addBlankFields(sheet, role === '1. SR' ? '1SR' : '2SR');
  });
  drawFooters(sheet, t);
  return sheet.doc;
}
