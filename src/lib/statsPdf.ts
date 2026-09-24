// Deck model → PDF, one slide per A4 landscape page, drawn with jsPDF (which
// the feedback form already uses) in embedded Inter Display. Everything is
// vector: text stays searchable, charts are rectangles and circles, and the
// numbers are the deck's — nothing is computed here.
import { jsPDF } from 'jspdf';
import logoDataUrl from '../assets/svrz-logo.png?inline';
import { INTER_DISPLAY_BOLD_B64, INTER_DISPLAY_REGULAR_B64 } from './pdfFontsDisplay';
import { pdfSafeText } from './feedbackPdf';
import type { Deck, DeckChart, DeckSlide, DeckTable, DeckTile } from './statsDeck';
import { isThin, scoreToLetter, GRADE_SCALE, NORMAL_SCORE } from './statistics';

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const TITLE_Y = 40;
const BODY_Y = 92;
const FOOTER_Y = PAGE_H - 26;

const INK: [number, number, number] = [28, 25, 23];
const INK_2: [number, number, number] = [87, 83, 78];
const MUTED: [number, number, number] = [120, 113, 108];
const LINE: [number, number, number] = [231, 229, 228];
const TILE: [number, number, number] = [250, 250, 249];
// Brand red (#e2001a, the app's --color-brand) and the dashboard's series.
const ACCENT: [number, number, number] = [226, 0, 26];
const SERIES: Array<[number, number, number]> = [[42, 120, 214], [226, 0, 26], [237, 161, 0]];

type Rgb = [number, number, number];

class Sheet {
  doc: jsPDF;
  constructor() {
    this.doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    this.doc.addFileToVFS('InterDisplay-Regular.ttf', INTER_DISPLAY_REGULAR_B64);
    this.doc.addFont('InterDisplay-Regular.ttf', 'Inter', 'normal');
    this.doc.addFileToVFS('InterDisplay-Bold.ttf', INTER_DISPLAY_BOLD_B64);
    this.doc.addFont('InterDisplay-Bold.ttf', 'Inter', 'bold');
  }
  text(value: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'center' | 'right'; maxWidth?: number } = {}) {
    this.doc.setFont('Inter', opts.bold ? 'bold' : 'normal');
    this.doc.setFontSize(opts.size ?? 9);
    const c = opts.color ?? INK;
    this.doc.setTextColor(c[0], c[1], c[2]);
    let s = pdfSafeText(pdfChars(value));
    if (opts.maxWidth) s = this.clip(s, opts.maxWidth);
    this.doc.text(s, x, y, { align: opts.align ?? 'left' });
  }
  width(value: string, size: number, bold = false): number {
    this.doc.setFont('Inter', bold ? 'bold' : 'normal');
    this.doc.setFontSize(size);
    return this.doc.getTextWidth(pdfSafeText(pdfChars(value)));
  }
  clip(value: string, maxWidth: number): string {
    if (this.doc.getTextWidth(value) <= maxWidth) return value;
    let s = value;
    while (s.length > 1 && this.doc.getTextWidth(`${s}…`) > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  }
  rect(x: number, y: number, w: number, h: number, fill: Rgb, stroke?: Rgb, radius = 0) {
    this.doc.setFillColor(fill[0], fill[1], fill[2]);
    if (stroke) { this.doc.setDrawColor(stroke[0], stroke[1], stroke[2]); this.doc.setLineWidth(0.6); }
    if (radius > 0) this.doc.roundedRect(x, y, w, h, radius, radius, stroke ? 'FD' : 'F');
    else this.doc.rect(x, y, w, h, stroke ? 'FD' : 'F');
  }
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = LINE, width = 0.6) {
    this.doc.setDrawColor(color[0], color[1], color[2]);
    this.doc.setLineWidth(width);
    this.doc.line(x1, y1, x2, y2);
  }
  circle(x: number, y: number, r: number, fill: Rgb, hollow = false) {
    if (hollow) {
      this.doc.setFillColor(255, 255, 255);
      this.doc.setDrawColor(fill[0], fill[1], fill[2]);
      this.doc.setLineWidth(1.4);
    } else {
      this.doc.setFillColor(fill[0], fill[1], fill[2]);
      this.doc.setDrawColor(255, 255, 255);
      this.doc.setLineWidth(1.2);
    }
    this.doc.circle(x, y, r, 'FD');
  }
}

const fmt = (n: number) => new Intl.NumberFormat('de-CH').format(Math.round(n));
const hexRgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

// The embedded Inter subset is Latin only; the few symbols the deck uses that
// fall outside it get an ASCII stand-in rather than the □ placeholder.
const pdfChars = (value: string) => value
  .replace(/≈/g, '~').replace(/−/g, '-').replace(/≥/g, '>=').replace(/Δ/g, 'Diff.')
  .replace(/♂/g, 'M').replace(/♀/g, 'F');

function chrome(s: Sheet, deck: Deck, index: number, total: number) {
  s.rect(0, 0, PAGE_W, 6, ACCENT);
  try { s.doc.addImage(logoDataUrl, 'PNG', PAGE_W - MARGIN - 70, TITLE_Y - 18, 70, 28); } catch { /* the page is fine without it */ }
  s.line(MARGIN, FOOTER_Y - 10, PAGE_W - MARGIN, FOOTER_Y - 10);
  s.text(deck.footer, MARGIN, FOOTER_Y, { size: 7.5, color: MUTED, maxWidth: CONTENT_W - 80 });
  s.text(`${index + 1} / ${total}`, PAGE_W - MARGIN, FOOTER_Y, { size: 7.5, color: MUTED, align: 'right' });
}

function title(s: Sheet, slide: DeckSlide, cover: boolean) {
  if (cover) {
    s.text(slide.title, MARGIN, 230, { size: 30, bold: true });
    if (slide.subtitle) s.text(slide.subtitle, MARGIN, 262, { size: 16, color: MUTED });
    (slide.bullets ?? []).forEach((b, i) => s.text(b, MARGIN, 300 + i * 16, { size: 10, color: MUTED }));
    return;
  }
  s.text(slide.title, MARGIN, TITLE_Y + 6, { size: 18, bold: true, maxWidth: CONTENT_W - 90 });
  if (slide.subtitle) s.text(slide.subtitle, MARGIN, TITLE_Y + 24, { size: 9.5, color: MUTED, maxWidth: CONTENT_W - 90 });
}

function tiles(s: Sheet, list: DeckTile[], y: number, maxH: number): number {
  const perRow = list.length <= 4 ? list.length : Math.ceil(list.length / Math.ceil(list.length / 4));
  const rows = Math.ceil(list.length / perRow);
  const gap = 10;
  const w = (CONTENT_W - gap * (perRow - 1)) / perRow;
  const h = Math.min(82, (maxH - gap * (rows - 1)) / rows);
  list.forEach((tile, i) => {
    const x = MARGIN + (i % perRow) * (w + gap);
    const ty = y + Math.floor(i / perRow) * (h + gap);
    s.rect(x, ty, w, h, TILE, LINE, 6);
    if (h < 64) {
      // A short row (tiles above a chart and a table): label and sub share
      // the top line, the value sits under them — nothing stacks into it.
      s.text(tile.label, x + 10, ty + 13, { size: 7, color: MUTED, maxWidth: (w - 20) * (tile.sub ? 0.58 : 1) });
      if (tile.sub) s.text(tile.sub, x + w - 10, ty + 13, { size: 7, color: INK_2, align: 'right', maxWidth: (w - 20) * 0.4 });
      s.text(tile.value, x + 10, ty + Math.min(h - 8, 36), { size: tile.value.length > 12 ? 12 : 16, bold: true, maxWidth: w - 20 });
    } else {
      s.text(tile.label, x + 10, ty + 16, { size: 7.5, color: MUTED, maxWidth: w - 20 });
      s.text(tile.value, x + 10, ty + 44, { size: tile.value.length > 12 ? 14 : 20, bold: true, maxWidth: w - 20 });
      if (tile.sub) s.text(tile.sub, x + 10, ty + h - 12, { size: 7.5, color: INK_2, maxWidth: w - 20 });
    }
  });
  return rows * h + (rows - 1) * gap;
}

function legend(s: Sheet, items: Array<{ name: string; color: Rgb }>, x: number, y: number) {
  let cx = x;
  for (const it of items) {
    s.rect(cx, y - 6, 7, 7, it.color);
    s.text(it.name, cx + 10, y, { size: 7.5, color: INK_2 });
    cx += 10 + s.width(it.name, 7.5) + 12;
  }
}

function drawChart(s: Sheet, heading: string, chart: DeckChart, x: number, y: number, w: number, h: number) {
  s.text(heading, x, y + 8, { size: 9.5, bold: true, color: INK_2, maxWidth: w });
  const top = y + 20;
  const height = h - 20;

  if (chart.kind === 'columns') {
    const n = chart.categories.length;
    const legendH = chart.series.length > 1 ? 14 : 0;
    const plotH = height - 18 - legendH;
    const totals = chart.categories.map((_, i) => chart.values.reduce((acc, series) => acc + (series[i] ?? 0), 0));
    const maxV = Math.max(1, chart.grouping === 'stacked' ? Math.max(...totals) : Math.max(...chart.values.flat()));
    const slot = w / Math.max(1, n);
    const base = top + plotH;
    s.line(x, base, x + w, base);
    for (let i = 0; i < n; i += 1) {
      const cx = x + slot * i + slot / 2;
      if (chart.grouping === 'stacked') {
        const bw = Math.min(44, slot * 0.6);
        let acc = 0;
        chart.values.forEach((series, si) => {
          const v = series[i] ?? 0;
          const hh = (v / maxV) * plotH;
          if (hh > 0) s.rect(cx - bw / 2, base - acc - hh, bw, Math.max(0, hh - (si > 0 ? 1 : 0)), SERIES[si % SERIES.length]);
          acc += hh;
        });
        if (totals[i] > 0) s.text(fmt(totals[i]), cx, base - acc - 3, { size: 7, bold: true, color: INK_2, align: 'center' });
      } else {
        const k = chart.values.length;
        const bw = Math.min(30, (slot * 0.7) / k);
        chart.values.forEach((series, si) => {
          const v = series[i] ?? 0;
          const hh = (v / maxV) * plotH;
          const bx = cx - (bw * k) / 2 + si * bw;
          if (hh > 0) s.rect(bx, base - hh, bw - 1, hh, SERIES[si % SERIES.length]);
          if (v > 0) s.text(fmt(v), bx + bw / 2, base - hh - 2, { size: 6, color: INK_2, align: 'center' });
        });
      }
      s.text(chart.categories[i], cx, base + 11, { size: 7, color: MUTED, align: 'center', maxWidth: slot - 2 });
    }
    if (legendH) legend(s, chart.series.map((name, i) => ({ name, color: SERIES[i % SERIES.length] })), x, base + 26);
    return;
  }

  if (chart.kind === 'bars') {
    const rows = chart.categories.length;
    const rowH = Math.min(26, height / Math.max(1, rows));
    const labelW = Math.min(170, w * 0.38);
    const maxV = Math.max(1, ...chart.values);
    const barMax = w - labelW - 40;
    chart.categories.forEach((label, i) => {
      const ry = top + i * rowH;
      s.text(label, x, ry + rowH * 0.7, { size: 7.5, color: INK_2, maxWidth: labelW - 6 });
      const bw = (chart.values[i] / maxV) * barMax;
      s.rect(x + labelW, ry + rowH * 0.2, Math.max(chart.values[i] > 0 ? 2 : 0, bw), rowH * 0.6, SERIES[0]);
      s.text(fmt(chart.values[i]), x + labelW + bw + 4, ry + rowH * 0.7, { size: 7.5, bold: true, color: INK_2 });
    });
    return;
  }

  if (chart.kind === 'grade') {
    const rows = chart.categories.length;
    const rowH = Math.min(26, (height - 12) / Math.max(1, rows));
    const labelW = Math.min(170, w * 0.4);
    const valueW = 62;
    const trackX = x + labelW;
    const trackW = w - labelW - valueW;
    const pos = (score: number) => trackX + ((score - 1) / 14) * trackW;
    for (const l of ['E', 'D', 'C', 'B', 'A']) s.text(l, pos(GRADE_SCALE[l]), top + 6, { size: 6.5, color: MUTED, align: 'center' });
    const rowsTop = top + 12;
    chart.categories.forEach((label, i) => {
      const ry = rowsTop + i * rowH + rowH / 2;
      s.text(label, x, ry + 3, { size: 7.5, color: INK_2, maxWidth: labelW - 6 });
      s.line(trackX, ry, trackX + trackW, ry);
      s.line(pos(NORMAL_SCORE), ry - 5, pos(NORMAL_SCORE), ry + 5, MUTED, 0.6);
      const v = chart.values[i];
      if (v === null) {
        s.text('–', x + w, ry + 3, { size: 7, color: MUTED, align: 'right' });
      } else {
        const thin = isThin(chart.ns[i]);
        s.circle(pos(v), ry, 4, SERIES[0], thin);
        s.text(`${scoreToLetter(v)} · ${v.toFixed(1)} · ${thin ? `n = ${chart.ns[i]}` : chart.ns[i]}`, x + w, ry + 3, { size: 7, color: thin ? MUTED : INK_2, align: 'right' });
      }
    });
    return;
  }

  if (chart.kind === 'diverging') {
    // Rows centred on the neutral middle: negative left, positive right, in
    // shares so rows of different size compare; the % at each end.
    const rows = chart.categories.length;
    const legendH = 14;
    const rowH = Math.min(34, (height - legendH) / Math.max(1, rows));
    const labelW = Math.min(150, w * 0.3);
    const trackX = x + labelW;
    const trackW = w - labelW;
    const mid = trackX + trackW / 2;
    const shares = chart.categories.map((_, i) => {
      const n = chart.neg[i] + chart.mid[i] + chart.pos[i];
      return n ? { n, neg: chart.neg[i] / n, mid: chart.mid[i] / n, pos: chart.pos[i] / n } : null;
    });
    const reach = Math.max(0.01, ...shares.map((v) => (v ? Math.max(v.neg + v.mid / 2, v.pos + v.mid / 2) : 0)));
    const px = (v: number) => (v / reach) * (trackW / 2);
    const cNeg = hexRgb(chart.colors.neg); const cMid = hexRgb(chart.colors.mid); const cPos = hexRgb(chart.colors.pos);
    chart.categories.forEach((label, i) => {
      const ry = top + i * rowH;
      const v = shares[i];
      s.text(label, x, ry + rowH * 0.45, { size: 7.5, color: INK_2, maxWidth: labelW - 6 });
      if (v) s.text(`n = ${v.n}`, x, ry + rowH * 0.45 + 9, { size: 6.5, color: MUTED });
      const by = ry + rowH * 0.2;
      const bh = rowH * 0.42;
      s.rect(trackX, by, trackW, bh, LINE);
      if (v) {
        const half = px(v.mid / 2);
        if (v.neg) s.rect(mid - half - px(v.neg), by, px(v.neg), bh, cNeg);
        if (v.mid) s.rect(mid - half, by, px(v.mid), bh, cMid);
        if (v.pos) s.rect(mid + half, by, px(v.pos), bh, cPos);
        s.text(`${chart.labels.neg} ${Math.round(v.neg * 100)} %`, trackX, by + bh + 8, { size: 6.5, color: INK_2 });
        s.text(`${chart.labels.pos} ${Math.round(v.pos * 100)} %`, trackX + trackW, by + bh + 8, { size: 6.5, color: INK_2, align: 'right' });
      }
      s.line(mid, by - 2, mid, by + bh + 2, MUTED, 0.6);
    });
    legend(s, [{ name: chart.labels.neg, color: cNeg }, { name: chart.labels.mid, color: cMid }, { name: chart.labels.pos, color: cPos }], x, top + rows * rowH + 8);
    return;
  }

  if (chart.kind === 'line') {
    // Averages over time on the grade scale; C dashed as the reference, a
    // point from fewer than three observations drawn hollow.
    const vals = chart.values.filter((v): v is number => v !== null);
    if (!vals.length) { s.text('–', x + w / 2, top + 20, { size: 7, color: MUTED, align: 'center' }); return; }
    const lo = Math.max(1, Math.min(NORMAL_SCORE - 1, Math.floor(Math.min(...vals)) - 1));
    const hi = Math.min(15, Math.max(NORMAL_SCORE + 1, Math.ceil(Math.max(...vals)) + 1));
    const left = 14;
    const plotH = height - 20;
    const n = chart.categories.length;
    const px = (i: number) => x + left + (n === 1 ? (w - left) / 2 : ((w - left - 8) * i) / (n - 1));
    const py = (v: number) => top + 4 + plotH - ((v - lo) / (hi - lo)) * plotH;
    for (const l of ['E', 'D', 'C', 'B', 'A']) {
      const v = GRADE_SCALE[l];
      if (v < lo || v > hi) continue;
      s.line(x + left, py(v), x + w, py(v), v === NORMAL_SCORE ? MUTED : LINE, v === NORMAL_SCORE ? 0.8 : 0.5);
      s.text(l, x + left - 5, py(v) + 2.5, { size: 6.5, color: MUTED, align: 'right' });
    }
    let prev: [number, number] | null = null;
    chart.values.forEach((v, i) => {
      if (v === null) { prev = null; return; }
      const pt: [number, number] = [px(i), py(v)];
      if (prev) s.line(prev[0], prev[1], pt[0], pt[1], SERIES[0], 1.6);
      prev = pt;
    });
    chart.values.forEach((v, i) => { if (v !== null) s.circle(px(i), py(v), 3, SERIES[0], isThin(chart.ns[i])); });
    chart.categories.forEach((c, i) => s.text(c, px(i), top + plotH + 16, { size: 7, color: MUTED, align: 'center' }));
    return;
  }

  // donut / stack → a proportion bar: the same shares, readable in print.
  const total = chart.values.reduce((a, b) => a + b, 0);
  const barY = top + 4;
  const barH = 14;
  if (total === 0) { s.rect(x, barY, w, barH, LINE); s.text('–', x + w / 2, barY + 10, { size: 7, color: MUTED, align: 'center' }); return; }
  const sliceColor = (i: number): Rgb => (chart.colors?.[i] ? hexRgb(chart.colors[i]) : SERIES[i % SERIES.length]);
  let cx = x;
  chart.values.forEach((v, i) => {
    const bw = (v / total) * w;
    if (bw > 0) s.rect(cx, barY, Math.max(0, bw - 1), barH, sliceColor(i));
    cx += bw;
  });
  chart.categories.forEach((label, i) => {
    const ly = barY + barH + 14 + i * 12;
    s.rect(x, ly - 6, 7, 7, sliceColor(i));
    s.text(`${label}  ${fmt(chart.values[i])}  (${Math.round((chart.values[i] / total) * 100)} %)`, x + 11, ly, { size: 7.5, color: INK_2, maxWidth: w - 11 });
  });
}

function table(s: Sheet, t: DeckTable, x: number, y: number, w: number, maxH: number) {
  const cols = t.head.length;
  const fractions = t.widths && t.widths.length === cols
    ? t.widths
    : t.head.map((_, i) => (cols === 1 ? 1 : i === 0 ? 0.34 : 0.66 / (cols - 1)));
  const colW = (i: number) => fractions[i] * w;
  const colX = (i: number) => x + fractions.slice(0, i).reduce((a, f) => a + f, 0) * w;
  const alignOf = (i: number): 'left' | 'right' => (t.align ? (t.align[i] === 'r' ? 'right' : 'left') : i === 0 ? 'left' : 'right');
  const anchor = (i: number) => (alignOf(i) === 'left' ? colX(i) + 4 : colX(i) + colW(i) - 4);
  const rowH = 18;
  s.rect(x, y, w, rowH, TILE);
  t.head.forEach((cell, i) => s.text(cell, anchor(i), y + 12, { size: 7, bold: true, color: MUTED, align: alignOf(i), maxWidth: colW(i) - 8 }));
  const maxRows = Math.floor((maxH - rowH) / rowH);
  t.rows.slice(0, maxRows).forEach((r, ri) => {
    const ry = y + rowH * (ri + 1);
    s.line(x, ry + rowH, x + w, ry + rowH);
    r.forEach((cell, i) => s.text(cell, anchor(i), ry + 12, { size: 8, color: INK, align: alignOf(i), maxWidth: colW(i) - 8 }));
  });
  if (t.rows.length > maxRows) s.text(`… +${t.rows.length - maxRows}`, x + w, y + rowH * (maxRows + 1) + 10, { size: 7, color: MUTED, align: 'right' });
}

function bullets(s: Sheet, list: string[], x: number, y: number, w: number) {
  let cy = y + 14;
  s.doc.setFont('Inter', 'normal');
  s.doc.setFontSize(11);
  for (const b of list) {
    const lines = s.doc.splitTextToSize(pdfSafeText(pdfChars(b)), w - 16) as string[];
    s.text('•', x, cy, { size: 11, color: INK_2 });
    lines.forEach((ln, i) => s.text(ln, x + 14, cy + i * 15, { size: 11, color: INK_2 }));
    cy += lines.length * 15 + 6;
  }
}

function page(s: Sheet, deck: Deck, slide: DeckSlide, index: number, total: number) {
  if (index > 0) s.doc.addPage();
  chrome(s, deck, index, total);
  title(s, slide, index === 0);
  if (index === 0) return;
  let y = BODY_Y;
  const bottom = FOOTER_Y - 18 - (slide.note ? 14 : 0);
  if (slide.tiles?.length) {
    const alone = !slide.figures?.length && !slide.table;
    const used = tiles(s, slide.tiles, y, alone ? bottom - y : Math.min(90, (bottom - y) * 0.4));
    y += used + 14;
  }
  const figs = slide.figures ?? [];
  const h = bottom - y;
  if (slide.table && figs.length) {
    const half = (CONTENT_W - 20) / 2;
    table(s, slide.table, MARGIN, y, half, h);
    drawChart(s, figs[0].title, figs[0].chart, MARGIN + half + 20, y, half, h);
  } else if (slide.table) {
    table(s, slide.table, MARGIN, y, CONTENT_W, h);
  } else if (figs.length) {
    const gap = 16;
    const fw = (CONTENT_W - gap * (figs.length - 1)) / figs.length;
    figs.forEach((f, i) => drawChart(s, f.title, f.chart, MARGIN + i * (fw + gap), y, fw, h));
  } else if (slide.bullets?.length) {
    bullets(s, slide.bullets, MARGIN, y, CONTENT_W);
  }
  if (slide.note) s.text(slide.note, MARGIN, FOOTER_Y - 20, { size: 7.5, color: MUTED, maxWidth: CONTENT_W });
}

export function buildDeckPdf(deck: Deck): Blob {
  const s = new Sheet();
  deck.slides.forEach((slide, i) => page(s, deck, slide, i, deck.slides.length));
  return s.doc.output('blob');
}
