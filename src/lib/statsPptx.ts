// Deck model → .pptx, with pptxgenjs loaded on demand: the library is its own
// chunk, fetched the first time somebody exports, so the app bundle every
// coach's phone precaches does not carry it. Charts are NATIVE PowerPoint
// charts — the commission can retitle, recolour and reuse them in Keynote,
// Google Slides or PowerPoint — not pictures of charts.
import type PptxGenJS from 'pptxgenjs';
import logoDataUrl from '../assets/svrz-logo.png?inline';
import type { Deck, DeckChart, DeckFormat, DeckSlide, DeckTable, DeckTile } from './statsDeck';
import { isThin, scoreToLetter, GRADE_SCALE, NORMAL_SCORE } from './statistics';

// 16:9 — 10" × 5.625", or A4 landscape — 11.69" × 8.27". Set per export by
// setLayout(); everything below reads these.
let W = 10;
let H = 5.625;
const MARGIN = 0.45;
let CONTENT_W = W - MARGIN * 2;
const TITLE_Y = 0.32;
const BODY_Y = 1.1;
let FOOTER_Y = H - 0.38;
let BODY_H = FOOTER_Y - BODY_Y - 0.12;
function setLayout(pptx: PptxGenJS, format: DeckFormat) {
  if (format === 'A4') {
    pptx.defineLayout({ name: 'A4_LANDSCAPE', width: 11.69, height: 8.27 });
    pptx.layout = 'A4_LANDSCAPE';
    W = 11.69; H = 8.27;
  } else {
    pptx.layout = 'LAYOUT_16x9';
    W = 10; H = 5.625;
  }
  CONTENT_W = W - MARGIN * 2;
  FOOTER_Y = H - 0.38;
  BODY_H = FOOTER_Y - BODY_Y - 0.12;
}

const INK = '1C1917';
const INK_2 = '57534E';
const MUTED = '78716C';
const LINE = 'E7E5E4';
const TILE_FILL = 'FAFAF9';
// Brand red (#e2001a, the app's --color-brand) and the dashboard's series.
const ACCENT = 'E2001A';
const SERIES = ['2A78D6', 'E2001A', 'EDA100'];
// The app's typeface. "Inter" is the family name the Google Fonts / rsms
// download installs (the variable font carries the display cut the app uses);
// PowerPoint cannot embed a font from here, so a machine without Inter
// substitutes its default. The PDF embeds Inter Display and needs nothing.
const FONT = 'Inter';

type Slide = PptxGenJS.Slide;

function addTitle(slide: Slide, s: DeckSlide) {
  // The chapter above the title, in the brand red: where in the deck this is.
  if (s.eyebrow) {
    slide.addText(s.eyebrow.toUpperCase(), { x: MARGIN, y: TITLE_Y - 0.14, w: CONTENT_W - 1.2, h: 0.22, fontFace: FONT, fontSize: 8, bold: true, color: ACCENT, charSpacing: 1, valign: 'middle' });
  }
  slide.addText(s.title, {
    x: MARGIN, y: TITLE_Y + 0.08, w: CONTENT_W - 1.2, h: 0.5,
    fontFace: FONT, fontSize: 22, bold: true, color: INK, valign: 'middle', fit: 'shrink',
  });
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: MARGIN, y: TITLE_Y + 0.55, w: CONTENT_W - 1.2, h: 0.3,
      fontFace: FONT, fontSize: 11, color: MUTED, valign: 'middle',
    });
  }
}

/** The cover: logo, title, season, and a brand-red band carrying the sender. */
function addCover(slide: Slide, s: DeckSlide) {
  const band = 0.85;
  slide.addImage({ data: logoDataUrl, x: MARGIN, y: 0.5, w: 1.6, h: 0.64 });
  const top = H * 0.36;
  slide.addShape('rect', { x: MARGIN, y: top - 0.25, w: 0.65, h: 0.06, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
  slide.addText(s.title, { x: MARGIN, y: top, w: CONTENT_W, h: 0.8, fontFace: FONT, fontSize: 34, bold: true, color: INK, valign: 'middle', fit: 'shrink' });
  if (s.subtitle) slide.addText(s.subtitle, { x: MARGIN, y: top + 0.8, w: CONTENT_W, h: 0.45, fontFace: FONT, fontSize: 18, color: INK_2, valign: 'middle' });
  if (s.bullets?.length) slide.addText(s.bullets.join('\n'), { x: MARGIN, y: top + 1.3, w: CONTENT_W, h: 0.7, fontFace: FONT, fontSize: 11, color: MUTED, valign: 'top' });
  slide.addShape('rect', { x: 0, y: H - band, w: W, h: band, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
  slide.addText('Swiss Volley Region Zürich · Referee Coaching', { x: MARGIN, y: H - band, w: CONTENT_W, h: band, fontFace: FONT, fontSize: 12, bold: true, color: 'FFFFFF', valign: 'middle' });
}

/** Contents: one line per chapter, its number in red. */
function addAgenda(slide: Slide, s: DeckSlide) {
  const lines = s.bullets ?? [];
  const rowH = Math.min(0.62, BODY_H / Math.max(1, lines.length));
  lines.forEach((l, i) => {
    const [num, ...rest] = l.split('  ');
    const y = BODY_Y + i * rowH;
    slide.addText(num, { x: MARGIN, y, w: 0.8, h: rowH - 0.08, fontFace: FONT, fontSize: 24, bold: true, color: ACCENT, valign: 'middle' });
    slide.addText(rest.join('  '), { x: MARGIN + 0.85, y, w: CONTENT_W - 0.85, h: rowH - 0.08, fontFace: FONT, fontSize: 17, bold: true, color: INK, valign: 'middle' });
    slide.addShape('line', { x: MARGIN, y: y + rowH - 0.04, w: CONTENT_W, h: 0, line: { color: LINE, width: 0.75 } });
  });
}

/** A chapter opens: its number large in red, its name, one line on what follows. */
function addDivider(slide: Slide, s: DeckSlide) {
  const mid = H * 0.44;
  slide.addText(s.number ?? '', { x: MARGIN, y: mid - 1.1, w: 3, h: 1, fontFace: FONT, fontSize: 60, bold: true, color: ACCENT, valign: 'bottom' });
  slide.addText(s.title, { x: MARGIN, y: mid, w: CONTENT_W, h: 0.65, fontFace: FONT, fontSize: 30, bold: true, color: INK, valign: 'middle' });
  if (s.subtitle) slide.addText(s.subtitle, { x: MARGIN, y: mid + 0.65, w: CONTENT_W, h: 0.4, fontFace: FONT, fontSize: 13, color: INK_2, valign: 'middle' });
  slide.addShape('rect', { x: MARGIN, y: mid + 1.15, w: 0.65, h: 0.06, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
}

/** The dashboard's dot scale: one row per thing graded, a dot on an E–A track
 *  with C marked; the letter and n beside it. Drawn as shapes, so the only
 *  scale anyone sees is the five letters. */
function addGradeScale(slide: Slide, chart: Extract<DeckChart, { kind: 'grade' }>, x: number, y: number, w: number, h: number) {
  const rows = chart.categories.length;
  const labelW = Math.min(2.4, w * 0.4);
  const valueW = 0.85;
  const trackX = x + labelW;
  const trackW = w - labelW - valueW;
  const pos = (score: number) => trackX + ((score - 1) / 14) * trackW;
  const rowH = Math.min(0.34, (h - 0.25) / Math.max(1, rows));
  for (const l of ['E', 'D', 'C', 'B', 'A']) {
    slide.addText(l, { x: pos(GRADE_SCALE[l]) - 0.15, y, w: 0.3, h: 0.2, fontFace: FONT, fontSize: 7.5, color: MUTED, align: 'center', valign: 'middle' });
  }
  chart.categories.forEach((label, i) => {
    const cy = y + 0.25 + i * rowH + rowH / 2;
    slide.addText(label, { x, y: cy - rowH / 2, w: labelW - 0.08, h: rowH, fontFace: FONT, fontSize: 8.5, color: INK_2, valign: 'middle', fit: 'shrink' });
    slide.addShape('line', { x: trackX, y: cy, w: trackW, h: 0, line: { color: LINE, width: 1 } });
    slide.addShape('line', { x: pos(NORMAL_SCORE), y: cy - 0.08, w: 0, h: 0.16, line: { color: 'A8A29E', width: 1 } });
    const v = chart.values[i];
    if (v === null) {
      slide.addText('–', { x: x + w - valueW, y: cy - rowH / 2, w: valueW, h: rowH, fontFace: FONT, fontSize: 8.5, color: MUTED, align: 'right', valign: 'middle' });
      return;
    }
    const thin = isThin(chart.ns[i]);
    const d = 0.13;
    slide.addShape('ellipse', { x: pos(v) - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: thin ? 'FFFFFF' : SERIES[0] }, line: { color: SERIES[0], width: thin ? 1.5 : 0.75 } });
    slide.addText(`${scoreToLetter(v)} · ${thin ? `n = ${chart.ns[i]}` : chart.ns[i]}`, { x: x + w - valueW, y: cy - rowH / 2, w: valueW, h: rowH, fontFace: FONT, fontSize: 8.5, bold: !thin, color: thin ? MUTED : INK, align: 'right', valign: 'middle' });
  });
}

/** The average grade over the months: letters on the axis, C dashed. */
function addGradeLine(slide: Slide, chart: Extract<DeckChart, { kind: 'line' }>, x: number, y: number, w: number, h: number) {
  const vals = chart.values.filter((v): v is number => v !== null);
  if (!vals.length) return;
  const lo = Math.max(1, Math.min(NORMAL_SCORE - 1, Math.floor(Math.min(...vals)) - 1));
  const hi = Math.min(15, Math.max(NORMAL_SCORE + 1, Math.ceil(Math.max(...vals)) + 1));
  const left = 0.3;
  const plotH = h - 0.35;
  const n = chart.categories.length;
  const px = (i: number) => x + left + (n === 1 ? (w - left) / 2 : ((w - left - 0.15) * i) / (n - 1));
  const py = (v: number) => y + 0.05 + plotH - ((v - lo) / (hi - lo)) * plotH;
  for (const l of ['E', 'D', 'C', 'B', 'A']) {
    const v = GRADE_SCALE[l];
    if (v < lo || v > hi) continue;
    slide.addShape('line', { x: x + left, y: py(v), w: w - left, h: 0, line: { color: v === NORMAL_SCORE ? 'A8A29E' : LINE, width: 0.75, dashType: v === NORMAL_SCORE ? 'dash' : 'solid' } });
    slide.addText(l, { x, y: py(v) - 0.1, w: left - 0.05, h: 0.2, fontFace: FONT, fontSize: 8, color: MUTED, align: 'right', valign: 'middle' });
  }
  let prev: [number, number] | null = null;
  chart.values.forEach((v, i) => {
    if (v === null) { prev = null; return; }
    const pt: [number, number] = [px(i), py(v)];
    if (prev) {
      const [x1, y1] = prev;
      slide.addShape('line', { x: Math.min(x1, pt[0]), y: Math.min(y1, pt[1]), w: Math.abs(pt[0] - x1), h: Math.abs(pt[1] - y1), flipV: pt[1] < y1, line: { color: SERIES[0], width: 2 } });
    }
    prev = pt;
  });
  const d = 0.12;
  chart.values.forEach((v, i) => {
    if (v === null) return;
    const thin = isThin(chart.ns[i]);
    slide.addShape('ellipse', { x: px(i) - d / 2, y: py(v) - d / 2, w: d, h: d, fill: { color: thin ? 'FFFFFF' : SERIES[0] }, line: { color: thin ? SERIES[0] : 'FFFFFF', width: 1.25 } });
  });
  chart.categories.forEach((c, i) => slide.addText(c, { x: px(i) - 0.3, y: y + plotH + 0.1, w: 0.6, h: 0.2, fontFace: FONT, fontSize: 8, color: MUTED, align: 'center', valign: 'middle' }));
}

function addChrome(slide: Slide, deck: Deck, index: number, total: number) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.09, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
  slide.addImage({ data: logoDataUrl, x: W - MARGIN - 0.95, y: TITLE_Y + 0.05, w: 0.95, h: 0.38 });
  slide.addShape('line', { x: MARGIN, y: FOOTER_Y - 0.06, w: CONTENT_W, h: 0, line: { color: LINE, width: 0.75 } });
  slide.addText(deck.footer, { x: MARGIN, y: FOOTER_Y, w: CONTENT_W - 1, h: 0.3, fontFace: FONT, fontSize: 8, color: MUTED, valign: 'middle' });
  slide.addText(`${index + 1} / ${total}`, { x: W - MARGIN - 1, y: FOOTER_Y, w: 1, h: 0.3, fontFace: FONT, fontSize: 8, color: MUTED, align: 'right', valign: 'middle' });
}

/** Tiles in rows of up to four. Everything inside is placed relative to the
 *  tile's height, so a compact row (tiles above a chart) still holds label,
 *  value and sub-line without one running into the next. */
function addTiles(slide: Slide, tiles: DeckTile[], y: number, h: number): number {
  const perRow = tiles.length <= 4 ? tiles.length : Math.ceil(tiles.length / Math.ceil(tiles.length / 4));
  const rows = Math.ceil(tiles.length / perRow);
  const gap = 0.12;
  const tileW = (CONTENT_W - gap * (perRow - 1)) / perRow;
  const tileH = Math.max(0.62, Math.min(1.15, (h - gap * (rows - 1)) / rows));
  const compact = tileH < 0.9;
  tiles.forEach((tile, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = MARGIN + col * (tileW + gap);
    const ty = y + row * (tileH + gap);
    const hasSub = Boolean(tile.sub);
    const labelH = compact ? 0.2 : 0.28;
    const subH = hasSub ? (compact ? 0.18 : 0.26) : 0;
    const valueH = tileH - labelH - subH - 0.1;
    slide.addShape('roundRect', { x, y: ty, w: tileW, h: tileH, fill: { color: TILE_FILL }, line: { color: LINE, width: 0.75 }, rectRadius: 0.08 });
    slide.addText(tile.label, { x: x + 0.12, y: ty + 0.05, w: tileW - 0.24, h: labelH, fontFace: FONT, fontSize: compact ? 8 : 9, color: MUTED, valign: 'top', fit: 'shrink' });
    slide.addText(tile.value, { x: x + 0.12, y: ty + 0.05 + labelH, w: tileW - 0.24, h: valueH, fontFace: FONT, fontSize: compact ? (tile.value.length > 10 ? 12 : 15) : (tile.value.length > 12 ? 16 : 22), bold: true, color: INK, valign: 'middle', fit: 'shrink' });
    if (tile.sub) slide.addText(tile.sub, { x: x + 0.12, y: ty + tileH - subH - 0.04, w: tileW - 0.24, h: subH, fontFace: FONT, fontSize: compact ? 7.5 : 8.5, color: INK_2, valign: 'middle', fit: 'shrink' });
  });
  return rows * tileH + (rows - 1) * gap;
}

function addChart(pptx: PptxGenJS, slide: Slide, title: string, chart: DeckChart, x: number, y: number, w: number, h: number) {
  slide.addText(title, { x, y, w, h: 0.3, fontFace: FONT, fontSize: 10.5, bold: true, color: INK_2, valign: 'middle' });
  const cy = y + 0.32;
  const ch = h - 0.32;
  const common: PptxGenJS.IChartOpts = {
    x, y: cy, w, h: ch,
    chartColors: SERIES,
    catAxisLabelFontSize: 8, catAxisLabelColor: INK_2, catAxisLabelFontFace: FONT,
    valAxisLabelFontSize: 8, valAxisLabelColor: MUTED, valAxisLabelFontFace: FONT,
    valGridLine: { color: LINE, style: 'solid', size: 0.5 },
    catGridLine: { style: 'none' },
    dataLabelFontSize: 8, dataLabelColor: INK_2, dataLabelFontFace: FONT,
    legendFontSize: 8, legendColor: INK_2, legendFontFace: FONT,
    plotArea: { fill: { color: 'FFFFFF' } },
    chartArea: { fill: { color: 'FFFFFF' }, roundedCorners: false },
  };
  if (chart.kind === 'columns') {
    slide.addChart(pptx.ChartType.bar, chart.series.map((name, i) => ({ name, labels: chart.categories, values: chart.values[i] })), {
      ...common, barDir: 'col', barGrouping: chart.grouping,
      barGapWidthPct: 60, showLegend: chart.series.length > 1, legendPos: 'b',
      showValue: false, valAxisMinVal: 0,
    });
  } else if (chart.kind === 'bars') {
    // A horizontal bar chart lists its first category at the BOTTOM; reversed
    // here so the deck reads top-down like the dashboard.
    // One series, one colour: PowerPoint would otherwise vary it per bar.
    slide.addChart(pptx.ChartType.bar, [{ name: title, labels: [...chart.categories].reverse(), values: [...chart.values].reverse() }], {
      ...common, chartColors: [SERIES[0]], barDir: 'bar', barGapWidthPct: 50, showLegend: false, showValue: true, dataLabelPosition: 'outEnd',
      valAxisMinVal: 0, valAxisHidden: true, valGridLine: { style: 'none' },
    });
  } else if (chart.kind === 'grade') {
    addGradeScale(slide, chart, x, cy, w, ch);
  } else if (chart.kind === 'stack') {
    // One 100 % bar, a series per part: native, so it stays editable.
    const hex = (c: string) => c.replace('#', '').toUpperCase();
    slide.addChart(pptx.ChartType.bar, chart.categories.map((name, i) => ({ name, labels: [''], values: [chart.values[i]] })), {
      ...common, h: Math.min(ch, 1.6), barDir: 'bar', barGrouping: 'percentStacked', barGapWidthPct: 30,
      chartColors: chart.colors.map(hex), showLegend: true, legendPos: 'b', showValue: true, dataLabelColor: 'FFFFFF',
      valAxisHidden: true, catAxisHidden: true, valGridLine: { style: 'none' },
    });
  } else if (chart.kind === 'diverging') {
    // Centred on the neutral middle: each row's middle split in two halves
    // around zero, the negative part stacked outward to the left. Shares in %.
    const hex = (c: string) => c.replace('#', '').toUpperCase();
    const rows = chart.categories.map((_, i) => {
      const n = chart.neg[i] + chart.mid[i] + chart.pos[i] || 1;
      return { neg: (chart.neg[i] / n) * 100, mid: (chart.mid[i] / n) * 100, pos: (chart.pos[i] / n) * 100 };
    }).reverse();
    const labels = [...chart.categories].reverse();
    slide.addChart(pptx.ChartType.bar, [
      { name: chart.labels.mid, labels, values: rows.map((r) => -r.mid / 2) },
      { name: chart.labels.neg, labels, values: rows.map((r) => -r.neg) },
      { name: `${chart.labels.mid} `, labels, values: rows.map((r) => r.mid / 2) },
      { name: chart.labels.pos, labels, values: rows.map((r) => r.pos) },
    ], {
      ...common, barDir: 'bar', barGrouping: 'stacked', barGapWidthPct: 45, barOverlapPct: 100,
      chartColors: [hex(chart.colors.mid), hex(chart.colors.neg), hex(chart.colors.mid), hex(chart.colors.pos)],
      // Row names at the left edge, not on the centre line through the bars;
      // the legend is written out below (the middle is two series in the chart).
      catAxisLabelPos: 'low', showLegend: false, showValue: false,
      valAxisLabelFormatCode: '0"%";0"%"', valAxisMinVal: -100, valAxisMaxVal: 100, valAxisMajorUnit: 25,
      h: ch - 0.3,
    });
    slide.addText([
      { text: '■ ', options: { color: hex(chart.colors.neg) } }, { text: `${chart.labels.neg}    `, options: { color: INK_2 } },
      { text: '■ ', options: { color: hex(chart.colors.mid) } }, { text: `${chart.labels.mid}    `, options: { color: INK_2 } },
      { text: '■ ', options: { color: hex(chart.colors.pos) } }, { text: chart.labels.pos, options: { color: INK_2 } },
    ], { x, y: cy + ch - 0.26, w, h: 0.24, fontFace: FONT, fontSize: 8, align: 'center', valign: 'middle' });
  } else if (chart.kind === 'line') {
    addGradeLine(slide, chart, x, cy, w, ch);
  } else {
    slide.addChart(pptx.ChartType.doughnut, [{ name: title, labels: chart.categories, values: chart.values }], {
      ...common, chartColors: chart.colors ? chart.colors.map((c) => c.replace('#', '').toUpperCase()) : SERIES,
      holeSize: 55, showPercent: true, showValue: false, showLegend: true, legendPos: 'b', dataLabelColor: 'FFFFFF',
      showLabel: false,
    });
  }
}

function addTable(slide: Slide, table: DeckTable, x: number, y: number, w: number, h: number) {
  const cols = table.head.length;
  const fractions = table.widths && table.widths.length === cols
    ? table.widths
    : table.head.map((_, i) => (cols === 1 ? 1 : i === 0 ? 0.34 : 0.66 / (cols - 1)));
  const colW = fractions.map((f) => f * w);
  const alignOf = (i: number) => (table.align ? (table.align[i] === 'r' ? 'right' as const : 'left' as const) : i === 0 ? 'left' as const : 'right' as const);
  // Rows past the slide's height are cut, not spilled over the footer.
  const rowH = 0.26;
  const fit = Math.max(1, Math.floor(h / rowH) - 1);
  const body = table.rows.slice(0, fit);
  const rows: PptxGenJS.TableRow[] = [
    table.head.map((cell, i) => ({ text: cell, options: { bold: true, color: MUTED, fontSize: 8, fill: { color: TILE_FILL }, align: alignOf(i) } })),
    ...body.map((r) => r.map((cell, i) => ({ text: cell, options: { color: INK, fontSize: 8.5, align: alignOf(i) } }))),
  ];
  slide.addTable(rows, {
    x, y, w, colW, h: rowH * rows.length,
    fontFace: FONT, border: { type: 'solid', color: LINE, pt: 0.5 }, rowH, margin: 0.04, autoPage: false, valign: 'middle',
  });
  if (table.rows.length > body.length) {
    slide.addText(`… +${table.rows.length - body.length}`, { x, y: y + rowH * rows.length, w, h: 0.22, fontFace: FONT, fontSize: 7.5, color: MUTED, align: 'right' });
  }
}

function addBullets(slide: Slide, bullets: string[], x: number, y: number, w: number, h: number, size = 13) {
  slide.addText(bullets.map((b) => ({ text: b, options: { bullet: { indent: 14 }, breakLine: true } })), {
    x, y, w, h, fontFace: FONT, fontSize: size, color: INK_2, valign: 'top', paraSpaceAfter: 6,
  });
}

function renderSlide(pptx: PptxGenJS, deck: Deck, s: DeckSlide, index: number, total: number) {
  const slide = pptx.addSlide();
  slide.background = { color: s.layout === 'divider' ? TILE_FILL : 'FFFFFF' };
  if (s.layout === 'cover') { addCover(slide, s); return; }
  addChrome(slide, deck, index, total);
  if (s.layout === 'divider') { addDivider(slide, s); return; }
  addTitle(slide, s);
  if (s.layout === 'agenda') { addAgenda(slide, s); return; }
  let y = BODY_Y;
  let hLeft = BODY_H;
  if (s.tiles?.length) {
    const wantFull = !s.figures?.length && !s.table;
    const used = addTiles(slide, s.tiles, y, wantFull ? hLeft : Math.min(1.7, hLeft * 0.5));
    y += used + 0.18;
    hLeft -= used + 0.18;
  }
  if (s.note) hLeft -= 0.28;
  const figs = s.figures ?? [];
  if (s.table && figs.length) {
    const half = (CONTENT_W - 0.25) / 2;
    addTable(slide, s.table, MARGIN, y, half, hLeft);
    addChart(pptx, slide, figs[0].title, figs[0].chart, MARGIN + half + 0.25, y, half, hLeft);
  } else if (s.table) {
    addTable(slide, s.table, MARGIN, y, CONTENT_W, hLeft);
  } else if (figs.length) {
    const gap = 0.2;
    const fw = (CONTENT_W - gap * (figs.length - 1)) / figs.length;
    figs.forEach((f, i) => addChart(pptx, slide, f.title, f.chart, MARGIN + i * (fw + gap), y, fw, hLeft));
  } else if (s.bullets?.length) {
    addBullets(slide, s.bullets, MARGIN, y, CONTENT_W, hLeft);
  }
  if (s.note) slide.addText(s.note, { x: MARGIN, y: FOOTER_Y - 0.36, w: CONTENT_W, h: 0.26, fontFace: FONT, fontSize: 8, color: MUTED, valign: 'middle' });
}

export async function buildDeckPptx(deck: Deck): Promise<Blob> {
  const { default: PptxGen } = await import('pptxgenjs');
  const pptx = new PptxGen();
  setLayout(pptx, deck.format ?? '16:9');
  // The theme's fonts too, so text typed into the deck later is Inter as well.
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  pptx.title = deck.title;
  pptx.subject = deck.subtitle;
  deck.slides.forEach((s, i) => renderSlide(pptx, deck, s, i, deck.slides.length));
  const out = await pptx.write({ outputType: 'blob' });
  return out as Blob;
}
