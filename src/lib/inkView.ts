// Where the pen page sits on screen, and how big: the camera of the pen page.
// Pure arithmetic, no DOM, so every rule is pinned without a browser
// (e2e/ink-view-rules.spec.ts).
//
// The page is PAGE_W × PAGE_H logical units, the unit strokes are stored in.
// The STAGE is the grey area the pad fills, in CSS px. A view is { z, ox, oy }:
// z is the zoom RELATIVE TO FIT-WIDTH (1 = the page's width fills the stage
// less a margin either side), ox/oy are where the page's top-left corner sits
// on the stage. The scale is s = fitWidthScale · z CSS px per page unit, and a
// page point (x, y) is drawn at (ox + x·s, oy + y·s); toPage is the exact
// inverse, so the ink always lands under the pen at any zoom.
//
// Fit-width, not "whole page", is the 100 %: an A4 page fitted whole into an
// iPad sheet was 293 px wide in landscape, and handwriting on it came out at
// a quarter of its size (Jennifer, 23.10.2026). The whole page is still one
// tap away, as the smallest zoom.

export const PAGE_W = 1000;
export const PAGE_H = 1414;
/** Grey kept around the page at fit, the p-2 the box used to have. */
export const VIEW_MARGIN = 8;
/** The deepest zoom, in CSS px per page unit: a 4-unit line is 10 px wide. */
export const MAX_SCALE = 2.5;
/** However small the stage, zooming in reaches at least twice fit-width. */
export const MIN_MAX_ZOOM = 2;
/** One tap on Vergrössern / Verkleinern. */
export const ZOOM_STEP = 1.5;

export type Stage = { w: number; h: number };
export type View = { z: number; ox: number; oy: number };
export type ZoomRange = { min: number; max: number };

const EPS = 1e-6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** CSS px per page unit when the page's width fills the stage. */
export function fitWidthScale(st: Stage): number {
  return Math.max(0.01, (st.w - 2 * VIEW_MARGIN) / PAGE_W);
}

/** CSS px per page unit when the whole page fits the stage. */
export function fitPageScale(st: Stage): number {
  return Math.max(0.01, Math.min((st.w - 2 * VIEW_MARGIN) / PAGE_W, (st.h - 2 * VIEW_MARGIN) / PAGE_H));
}

/** min = the whole page (never above fit-width: a wide, short stage shows the
 *  whole width at 1 already), max = MAX_SCALE but at least MIN_MAX_ZOOM. */
export function zoomRange(st: Stage): ZoomRange {
  const fw = fitWidthScale(st);
  return { min: Math.min(1, fitPageScale(st) / fw), max: Math.max(MIN_MAX_ZOOM, MAX_SCALE / fw) };
}

export function clampZoom(st: Stage, z: number): number {
  const r = zoomRange(st);
  return clamp(Number.isFinite(z) ? z : 1, r.min, r.max);
}

export function scaleOf(st: Stage, z: number): number {
  return fitWidthScale(st) * z;
}

/** One axis: a page smaller than the room is centred; a bigger one may not
 *  leave more than the margin of grey past either edge. */
function clampAxis(o: number, room: number, size: number): number {
  if (size + 2 * VIEW_MARGIN <= room + EPS) return (room - size) / 2;
  return clamp(o, room - VIEW_MARGIN - size, VIEW_MARGIN);
}

export function clampView(st: Stage, v: View): View {
  const z = clampZoom(st, v.z);
  const s = scaleOf(st, z);
  return { z, ox: clampAxis(Number.isFinite(v.ox) ? v.ox : 0, st.w, PAGE_W * s), oy: clampAxis(Number.isFinite(v.oy) ? v.oy : 0, st.h, PAGE_H * s) };
}

/** The view a page opens in: its top, and its left edge when it is wider
 *  than the stage — where writing starts. */
export function topView(st: Stage, z: number): View {
  return clampView(st, { z, ox: VIEW_MARGIN, oy: VIEW_MARGIN });
}

/** Zoom to z keeping the page point under (cx, cy) where it is (unless an
 *  edge of the page would leave the stage). */
export function zoomAbout(st: Stage, v: View, z: number, cx: number, cy: number): View {
  const s0 = scaleOf(st, v.z);
  const px = (cx - v.ox) / s0;
  const py = (cy - v.oy) / s0;
  const z1 = clampZoom(st, z);
  const s1 = scaleOf(st, z1);
  return clampView(st, { z: z1, ox: cx - px * s1, oy: cy - py * s1 });
}

export type Point = { x: number; y: number };

/** Two fingers, one motion: the page point that was under the starting
 *  centroid follows the centroid, and the zoom follows the finger distance.
 *  With the distance unchanged this is a pan. */
export function pinchView(st: Stage, start: View, c0: Point, d0: number, c: Point, d: number): View {
  const s0 = scaleOf(st, start.z);
  const px = (c0.x - start.ox) / s0;
  const py = (c0.y - start.oy) / s0;
  const z = clampZoom(st, start.z * (d / Math.max(1, d0)));
  const s1 = scaleOf(st, z);
  return clampView(st, { z, ox: c.x - px * s1, oy: c.y - py * s1 });
}

export function panBy(st: Stage, v: View, dx: number, dy: number): View {
  return clampView(st, { z: v.z, ox: v.ox + dx, oy: v.oy + dy });
}

/** The stage changed size (fullscreen, rotation, the keyboard): the same zoom
 *  level, and the page point at the centre stays at the centre. */
export function resizeView(prev: Stage, next: Stage, v: View): View {
  const s0 = scaleOf(prev, v.z);
  const px = (prev.w / 2 - v.ox) / s0;
  const py = (prev.h / 2 - v.oy) / s0;
  const z = clampZoom(next, v.z);
  const s1 = scaleOf(next, z);
  return clampView(next, { z, ox: next.w / 2 - px * s1, oy: next.h / 2 - py * s1 });
}

/** The part of the page on screen, in page units: [x0, y0, x1, y1]. */
export function visibleRect(st: Stage, v: View): [number, number, number, number] {
  const s = scaleOf(st, v.z);
  return [-v.ox / s, -v.oy / s, (st.w - v.ox) / s, (st.h - v.oy) / s];
}

/** A stage point (CSS px from the stage's top-left) in page units. */
export function toPage(st: Stage, v: View, sx: number, sy: number): [number, number] {
  const s = scaleOf(st, v.z);
  return [(sx - v.ox) / s, (sy - v.oy) / s];
}

/** A page point on the stage, in CSS px. */
export function fromPage(st: Stage, v: View, x: number, y: number): [number, number] {
  const s = scaleOf(st, v.z);
  return [v.ox + x * s, v.oy + y * s];
}

export function pageVisibleWhole(st: Stage, v: View): boolean {
  const s = scaleOf(st, v.z);
  return PAGE_W * s + 2 * VIEW_MARGIN <= st.w + EPS && PAGE_H * s + 2 * VIEW_MARGIN <= st.h + EPS;
}

/** Vergrössern: one step, stopping at fit-width on the way up from the whole page. */
export function zoomStepIn(st: Stage, z: number): number {
  const { max } = zoomRange(st);
  let next = z * ZOOM_STEP;
  if (z < 1 - EPS && next > 1 + EPS) next = 1;
  return Math.min(max, next);
}

/** Verkleinern: one step, stopping at fit-width on the way down. */
export function zoomStepOut(st: Stage, z: number): number {
  const { min } = zoomRange(st);
  let next = z / ZOOM_STEP;
  if (z > 1 + EPS && next < 1 - EPS) next = 1;
  return Math.max(min, next);
}
