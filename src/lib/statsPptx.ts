// Deck model → .pptx, with pptxgenjs loaded on demand: the library is its own
// chunk, fetched the first time somebody exports, so the app bundle every
// coach's phone precaches does not carry it. Charts are NATIVE PowerPoint
// charts — the commission can retitle, recolour and reuse them in Keynote,
// Google Slides or PowerPoint — not pictures of charts.
import type PptxGenJS from 'pptxgenjs';
import logoDataUrl from '../assets/svrz-logo.png?inline';
import type { Deck, DeckChart, DeckSlide, DeckTable, DeckTile } from './statsDeck';
import { isThin, scoreToLetter } from './statistics';

// 16:9 — 10" × 5.625".
const W = 10;
const H = 5.625;
const MARGIN = 0.45;
const CONTENT_W = W - MARGIN * 2;
const TITLE_Y = 0.32;
const BODY_Y = 1.05;
const FOOTER_Y = H - 0.38;
const BODY_H = FOOTER_Y - BODY_Y - 0.12;

const INK = '1C1917';
const INK_2 = '57534E';
const MUTED = '78716C';
const LINE = 'E7E5E4';
const TILE_FILL = 'FAFAF9';
const ACCENT = 'DC2626';
const SERIES = ['2A78D6', 'DC2626', 'EDA100'];
// Rendered as Inter Display where the font is installed; PowerPoint cannot
// embed a font from here, so a machine without it substitutes its default.
const FONT = 'Inter Display';

type Slide = PptxGenJS.Slide;

function addTitle(slide: Slide, s: DeckSlide, isCover: boolean) {
  slide.addText(s.title, {
    x: MARGIN, y: isCover ? 1.6 : TITLE_Y, w: CONTENT_W, h: isCover ? 0.9 : 0.55,
    fontFace: FONT, fontSize: isCover ? 32 : 22, bold: true, color: INK, valign: 'middle',
  });
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: MARGIN, y: isCover ? 2.5 : TITLE_Y + 0.5, w: CONTENT_W, h: 0.35,
      fontFace: FONT, fontSize: isCover ? 18 : 11, color: MUTED, valign: 'middle',
    });
  }
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
    slide.addChart(pptx.ChartType.bar, [{ name: title, labels: [...chart.categories].reverse(), values: [...chart.values].reverse() }], {
      ...common, barDir: 'bar', barGapWidthPct: 50, showLegend: false, showValue: true, dataLabelPosition: 'outEnd',
      valAxisMinVal: 0, valAxisHidden: true, valGridLine: { style: 'none' },
    });
  } else if (chart.kind === 'grade') {
    // Averages on the 1–15 scale, the letter beside each; a thin one (fewer
    // than three observations) says so in its label.
    const keep = chart.values.map((v, i) => ({ v, i })).filter((e) => e.v !== null).reverse();
    const withheld = chart.values.map((v, i) => ({ v, i })).filter((e) => e.v === null).map((e) => chart.categories[e.i]);
    slide.addChart(pptx.ChartType.bar, [{
      name: title,
      labels: keep.map((e) => `${chart.categories[e.i]}  ${scoreToLetter(e.v!)} · ${isThin(chart.ns[e.i]) ? `n = ${chart.ns[e.i]} !` : `n ${chart.ns[e.i]}`}`),
      values: keep.map((e) => e.v!),
    }], {
      ...common, barDir: 'bar', barGapWidthPct: 45, showLegend: false, showValue: true, dataLabelPosition: 'outEnd', dataLabelFormatCode: '0.0',
      valAxisMinVal: 1, valAxisMaxVal: 15, valAxisMajorUnit: 3, valAxisLabelFormatCode: '0',
      valAxisTitle: 'E = 2 · D = 5 · C = 8 · B = 11 · A = 14', showValAxisTitle: true, valAxisTitleFontSize: 7, valAxisTitleColor: MUTED,
    });
    if (withheld.length) {
      slide.addText(`–: ${withheld.join(', ')}`, { x, y: y + h - 0.02, w, h: 0.22, fontFace: FONT, fontSize: 7, color: MUTED, valign: 'top' });
    }
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
      showLegend: true, legendPos: 'b', showValue: false,
      valAxisLabelFormatCode: '0"%";0"%"', valAxisMinVal: -100, valAxisMaxVal: 100, valAxisMajorUnit: 25,
    });
  } else if (chart.kind === 'line') {
    // Averages per month on the grade scale, with C as a flat reference line.
    const vals = chart.values.map((v) => (v === null ? null : Math.round(v * 10) / 10));
    slide.addChart(pptx.ChartType.line, [
      { name: title, labels: chart.categories, values: vals as number[] },
      { name: 'C', labels: chart.categories, values: chart.categories.map(() => 8) },
    ], {
      ...common, chartColors: [SERIES[0], 'A8A29E'], lineSize: 2, lineDataSymbol: 'circle', lineDataSymbolSize: 6,
      showLegend: false, showValue: false, displayBlanksAs: 'gap',
      valAxisMinVal: 1, valAxisMaxVal: 15, valAxisMajorUnit: 3, valAxisLabelFormatCode: '0',
      valAxisTitle: 'E = 2 · D = 5 · C = 8 · B = 11 · A = 14', showValAxisTitle: true, valAxisTitleFontSize: 7, valAxisTitleColor: MUTED,
    });
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
  slide.background = { color: 'FFFFFF' };
  const isCover = index === 0;
  addChrome(slide, deck, index, total);
  addTitle(slide, s, isCover);
  if (isCover) {
    if (s.bullets?.length) slide.addText(s.bullets.join('\n'), { x: MARGIN, y: 3.1, w: CONTENT_W, h: 0.8, fontFace: FONT, fontSize: 11, color: MUTED, valign: 'top' });
    return;
  }
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
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = deck.title;
  pptx.subject = deck.subtitle;
  deck.slides.forEach((s, i) => renderSlide(pptx, deck, s, i, deck.slides.length));
  const out = await pptx.write({ outputType: 'blob' });
  return out as Blob;
}
