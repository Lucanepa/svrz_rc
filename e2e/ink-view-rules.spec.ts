import { test, expect } from '@playwright/test';
import {
  PAGE_H, PAGE_W, VIEW_MARGIN, clampView, clampZoom, fitPageScale, fitWidthScale, fromPage, pageVisibleWhole, pinchView, panBy, resizeView, scaleOf,
  toPage, topView, visibleRect, zoomAbout, zoomRange, zoomStepIn, zoomStepOut, type Stage, type View,
} from '../src/lib/inkView';

/**
 * The pen page's camera (src/lib/inkView.ts): where the page sits on the
 * stage and how big. Zoom bugs hide in this arithmetic — a pinch that drifts,
 * a page that jumps, ink that lands beside the pen — so it is pinned here
 * without a browser (the notebook-times-rules idiom).
 *
 * z is relative to fit-width: 1 = the page's width fills the stage less the
 * margin. The stages are the ones measured in the app (CSS px).
 */

const IPAD_PORTRAIT: Stage = { w: 768, h: 736.5 };      // 820 × 1180, the sheet
const IPAD_LANDSCAPE: Stage = { w: 768, h: 430.5 };     // 1180 × 820, the sheet
const IPAD_LANDSCAPE_FULL: Stage = { w: 1180, h: 553.5 };
const PHONE_FULL: Stage = { w: 390, h: 577.5 };         // 390 × 844, fullscreen
const STAGES = [IPAD_PORTRAIT, IPAD_LANDSCAPE, IPAD_LANDSCAPE_FULL, PHONE_FULL];

const M = VIEW_MARGIN;
const pageBox = (st: Stage, v: View) => { const s = scaleOf(st, v.z); return { x0: v.ox, y0: v.oy, x1: v.ox + PAGE_W * s, y1: v.oy + PAGE_H * s, w: PAGE_W * s, h: PAGE_H * s }; };

test('the zoom range on the iPad: the whole page is the smallest zoom, 2.5 px per unit the deepest', () => {
  const portrait = zoomRange(IPAD_PORTRAIT);
  expect(portrait.min).toBeCloseTo((720.5 / 1414) / 0.752, 6);
  expect(portrait.max).toBeCloseTo(2.5 / 0.752, 6);
  // Landscape: the whole page is 39 % of fit-width — 293 px wide, as measured before.
  const landscape = zoomRange(IPAD_LANDSCAPE);
  expect(landscape.min).toBeCloseTo(0.3898, 3);
  expect(fitPageScale(IPAD_LANDSCAPE) * PAGE_W).toBeCloseTo(293.1, 1);
  // A wide stage still zooms to at least twice fit-width.
  expect(zoomRange(IPAD_LANDSCAPE_FULL).max).toBeCloseTo(2.5 / 1.164, 6);
  expect(zoomRange({ w: 2000, h: 900 }).max).toBe(2);
  // A stage taller than the page: fit-width already shows it whole.
  expect(zoomRange(PHONE_FULL).min).toBe(1);
});

test('a page opens at its top, its width filling the stage less the margin', () => {
  for (const st of STAGES) {
    const v = topView(st, 1);
    const b = pageBox(st, v);
    expect(b.x0).toBeCloseTo(M, 9);
    expect(b.x1).toBeCloseTo(st.w - M, 9);
    expect(b.y0).toBeCloseTo(b.h + 2 * M <= st.h ? (st.h - b.h) / 2 : M, 9);
  }
});

test('the whole page is centred both ways and fits with the margin', () => {
  for (const st of STAGES) {
    const v = topView(st, zoomRange(st).min);
    const b = pageBox(st, v);
    expect(b.x0 - 0).toBeCloseTo(st.w - b.x1, 9);
    expect(b.y0 - 0).toBeCloseTo(st.h - b.y1, 9);
    expect(Math.min(b.x0, b.y0)).toBeCloseTo(M, 9);
    expect(b.w / b.h).toBeCloseTo(PAGE_W / PAGE_H, 12);
  }
});

test('clamping: zoom stays in range, a big page never shows more than the margin past an edge, a small one is centred', () => {
  const st = IPAD_PORTRAIT;
  const r = zoomRange(st);
  expect(clampView(st, { z: 0.01, ox: 0, oy: 0 }).z).toBe(r.min);
  expect(clampView(st, { z: 99, ox: 0, oy: 0 }).z).toBe(r.max);
  expect(clampView(st, { z: Number.NaN, ox: 0, oy: 0 }).z).toBe(1);
  for (const z of [1, 1.5, 3]) {
    for (const [ox, oy] of [[5000, 5000], [-5000, -5000], [5000, -5000], [-5000, 5000]]) {
      const b = pageBox(st, clampView(st, { z, ox, oy }));
      expect(b.x0).toBeLessThanOrEqual(M + 1e-9);
      expect(b.x1).toBeGreaterThanOrEqual(st.w - M - 1e-9);
      expect(b.y0).toBeLessThanOrEqual(M + 1e-9);
      expect(b.y1).toBeGreaterThanOrEqual(st.h - M - 1e-9);
    }
  }
  const small = clampView(st, { z: r.min, ox: -300, oy: 900 });
  expect(small.ox).toBeCloseTo((st.w - pageBox(st, small).w) / 2, 9);
  expect(small.oy).toBeCloseTo((st.h - pageBox(st, small).h) / 2, 9);
});

test('a level a hair above the whole page is the whole page: a remembered level reopens a page that fits', () => {
  // The sheet remembers the level as a number. The whole page rounded to two
  // places (0.68 for 0.6776 on an iPad in portrait) reopened a page 2.6 px too
  // tall for the stage, off-centre and scrollable.
  for (const st of STAGES) {
    const { min } = zoomRange(st);
    for (const stored of [Number(min.toFixed(2)), Number(min.toFixed(4)), min * 1.004]) {
      expect(clampZoom(st, stored)).toBe(min);
      expect(pageVisibleWhole(st, topView(st, stored))).toBe(true);
    }
    // A level the coach chose just above it stays hers.
    if (min < 1) expect(clampZoom(st, min * 1.02)).toBeCloseTo(min * 1.02, 12);
  }
});

test('zooming about a point keeps the page point under it', () => {
  const st = IPAD_PORTRAIT;
  const v = clampView(st, { z: 2, ox: -400, oy: -600 });
  for (const [cx, cy, z] of [[384, 368, 2.8], [100, 600, 1.4], [700, 50, 3.1]]) {
    const before = toPage(st, v, cx, cy);
    const next = zoomAbout(st, v, z, cx, cy);
    expect(next.z).toBe(z);
    const after = toPage(st, next, cx, cy);
    expect(Math.abs(after[0] - before[0])).toBeLessThan(1e-9);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(1e-9);
  }
});

test('a pinch with the fingers the same distance apart is a pan; otherwise the point under them follows them', () => {
  const st = IPAD_LANDSCAPE_FULL;
  const start = clampView(st, { z: 1.6, ox: -300, oy: -500 });
  const c0 = { x: 500, y: 300 };
  const moved = pinchView(st, start, c0, 120, { x: 460, y: 250 }, 120);
  const panned = panBy(st, start, -40, -50);
  expect(moved.z).toBe(start.z);
  expect(moved.ox).toBeCloseTo(panned.ox, 9);
  expect(moved.oy).toBeCloseTo(panned.oy, 9);
  const anchor = toPage(st, start, c0.x, c0.y);
  const zoomed = pinchView(st, start, c0, 100, { x: 520, y: 310 }, 125);
  expect(zoomed.z).toBeCloseTo(2, 12);
  const [sx, sy] = fromPage(st, zoomed, anchor[0], anchor[1]);
  expect(sx).toBeCloseTo(520, 9);
  expect(sy).toBeCloseTo(310, 9);
});

test('toPage is the exact inverse of where a page point is drawn', () => {
  for (const st of STAGES) {
    for (const v of [topView(st, 1), topView(st, zoomRange(st).min), clampView(st, { z: 2.2, ox: -321.5, oy: -987.25 })]) {
      for (const [x, y] of [[0, 0], [1000, 1414], [123.4, 987.6], [500, 707]]) {
        const [sx, sy] = fromPage(st, v, x, y);
        const [px, py] = toPage(st, v, sx, sy);
        expect(px).toBeCloseTo(x, 9);
        expect(py).toBeCloseTo(y, 9);
      }
    }
  }
});

test('a resize (fullscreen, rotation) keeps the zoom level and the page point in the middle', () => {
  const v = zoomAbout(IPAD_PORTRAIT, topView(IPAD_PORTRAIT, 1), 1.5, 384, 368);
  const centre = toPage(IPAD_PORTRAIT, v, IPAD_PORTRAIT.w / 2, IPAD_PORTRAIT.h / 2);
  const full: Stage = { w: 820, h: 913.5 };
  const next = resizeView(IPAD_PORTRAIT, full, v);
  expect(next.z).toBe(1.5);
  const after = toPage(full, next, full.w / 2, full.h / 2);
  expect(after[0]).toBeCloseTo(centre[0], 9);
  expect(after[1]).toBeCloseTo(centre[1], 9);
  // Rotated to a stage that allows less: the level is clamped, not lost.
  const deep = clampView(IPAD_PORTRAIT, { z: 3.3, ox: -900, oy: -1200 });
  expect(resizeView(IPAD_PORTRAIT, IPAD_LANDSCAPE_FULL, deep).z).toBeCloseTo(zoomRange(IPAD_LANDSCAPE_FULL).max, 12);
});

test('the visible rect is the stage in page units', () => {
  const st = IPAD_LANDSCAPE;
  const v = topView(st, 1);
  const [x0, y0, x1, y1] = visibleRect(st, v);
  expect(x0).toBeCloseTo(-M / fitWidthScale(st), 9);
  expect(y0).toBeCloseTo(-M / fitWidthScale(st), 9);
  expect(x1).toBeCloseTo(PAGE_W + M / fitWidthScale(st), 9);
  expect(y1).toBeCloseTo((st.h - M) / fitWidthScale(st), 9);
  expect(y1).toBeLessThan(PAGE_H);
});

test('the zoom buttons step by half again, stop at fit-width on the way, and at the ends', () => {
  const st = IPAD_PORTRAIT;
  const r = zoomRange(st);
  expect(zoomStepIn(st, 1)).toBe(1.5);
  expect(zoomStepIn(st, 1.5)).toBe(2.25);
  expect(zoomStepIn(st, 2.25)).toBe(r.max);
  expect(zoomStepIn(st, r.min)).toBe(1);
  expect(zoomStepOut(st, 2.25)).toBe(1.5);
  expect(zoomStepOut(st, 1.2)).toBe(1);
  expect(zoomStepOut(st, 1)).toBe(r.min);
  expect(zoomStepOut(st, r.min)).toBe(r.min);
});
