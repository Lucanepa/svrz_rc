// How a stroke on the pen page looks. Render-only: the stored stroke stays
// { c, w, p, d } with raw pressure, so a page written before these presets
// simply draws with them, and nothing has to be migrated (the server refuses
// a whole page as 'ink-shape' for any other field, or a w that is not an
// integer from 1 to 20).
//
// Outlines are computed in PAGE UNITS, once per stroke, and drawn under the
// view's transform: a line is part of the paper, so it grows when the coach
// zooms in, like ink on a page under a magnifier.

import type { StrokeOptions } from 'perfect-freehand';
import type { InkSample } from './inkPath';

/** The app's ink, and Swiss Volley red. */
export const INK_COLOURS = ['#1c1917', '#b91c1c'];

/** The width every new stroke is stored with, in page units. Live and
 *  committed strokes both use it, or a line would jump in width at pen-up. At
 *  fit-width on an iPad in portrait (0.75 CSS px per unit) this draws a
 *  Pencil line of about 2.5 px at a light pressure of 0.2 and 3.5 px at 0.5. */
export const NEW_STROKE_W = 4;

/** The thinnest a line may draw when the whole page is on screen, in CSS px.
 *  The page is then as small as 293 px wide (an iPad in landscape), and a
 *  light Pencil line under a pixel wide is the "faint, scratchy" ink of the
 *  first report (Jennifer, 23.10.2026). */
export const MIN_LINE_CSS_PX = 1.25;

/** tldraw's pen curve: concave, so the light pressure of normal handwriting
 *  (Safari reports a Pencil's force / maximum force, about 0.1–0.35) still
 *  makes a clear line, and a firm press still makes a bolder one. */
export const PEN_EASING = (t: number): number => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35;
const easeOutSine = (t: number): number => Math.sin((t * Math.PI) / 2);
const linear = (t: number): number => t;

/** A raw Pencil pressure (0..1) as the outline uses it: boosted ×1.25, as
 *  tldraw does, then eased. */
export function penPressure(p: number): number {
  return PEN_EASING(Math.min(1, Math.max(0, 1.25 * p)));
}

/** The smallest radius a line may draw with, in page units, for a stage whose
 *  whole-page view has this scale. Recomputed when the stage changes size,
 *  never per frame: every cached outline depends on it. */
export function minRadiusFor(fitPageScale: number): number {
  return MIN_LINE_CSS_PX / 2 / Math.max(0.01, fitPageScale);
}

/** perfect-freehand's radius is size · easing(0.5 − thinning · (0.5 − p)); a
 *  floor on the eased value floors the drawn width without making the firm
 *  end any bolder. */
function floored(ease: (t: number) => number, size: number, minRadius: number): (t: number) => number {
  const floor = size > 0 ? minRadius / size : 0;
  return floor > 0 ? (t: number) => Math.max(ease(t), floor) : ease;
}

/** The samples a stroke's outline is built from: a real pen's pressure goes
 *  through the pen curve; finger and mouse strokes carry none (perfect-freehand
 *  simulates it from the speed). */
export function outlineSamples(points: InkSample[], realPressure: boolean): InkSample[] {
  return realPressure ? points.map(([x, y, p]) => [x, y, penPressure(p)]) : points;
}

/** The perfect-freehand options for a stroke: the pen preset when it carries
 *  real pressure (p = 1), the simulated one otherwise. `last` is false only
 *  for the stroke still being drawn. */
export function strokeOptions(stroke: { w: number; p: 0 | 1 }, minRadius: number, last: boolean): StrokeOptions {
  const size = stroke.w;
  if (stroke.p === 1) {
    return {
      size,
      thinning: 0.4,
      smoothing: 0.5,
      // Less lag than perfect-freehand's 0.5: at 60 Hz (an iPad before 18.2
      // has no coalesced events) 0.5 cut about 9 % off the corner of a 5 mm
      // letter.
      streamline: 0.35,
      simulatePressure: false,
      easing: floored(linear, size, minRadius),
      last,
    };
  }
  return {
    size,
    thinning: 0.5,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: true,
    easing: floored(easeOutSine, size, minRadius),
    last,
  };
}
