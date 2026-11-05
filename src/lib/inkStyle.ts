// How a stroke on the pen page looks. Render-only: the stored stroke stays
// { c, w, p, d } with its pressure before the pen curve, so a page written
// before these presets simply draws with them, and nothing has to be migrated
// (the server refuses a whole page as 'ink-shape' for any other field, or a w
// that is not an integer from 1 to 20). InkPad's PRESSURE_EMA is the one number
// that is not render-only: it smooths the pressure as a stroke is captured.
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

// The two numbers to tune on an iPad, for real Pencil pressure only: the finger
// and mouse preset below and the signature pad's own options stay as they were.
// A coach's voice note, 05.11.2026: harder to write on than GoodNotes. Her iPad
// already samples at about 240 Hz, so these gain her little by themselves (the
// predicted tail in InkPad is the main lag fix), and an older iPad gains more.
/** How far the line stays behind the pen: each sample pulls it
 *  0.15 + 0.85 · (1 − streamline) of the way there. Lower follows the pen more
 *  closely. Simulated on a synthetic 5 mm cursive, not measured on an iPad, the
 *  line's worst distance from the pen in CSS px, 0.35 → 0.2: 0.56 → 0.27 at
 *  240 Hz, 2.67 → 1.28 at 60 Hz (an iPad before 18.2 has no coalesced events).
 *  perfect-freehand's own 0.5 cut about 9 % off the corner of such a letter at
 *  60 Hz. */
export const PEN_STREAMLINE = 0.2;
/** How far apart the outline's points may lie, as a share of the line's size.
 *  Lower keeps more of a small letter's curve, at a few more outline points:
 *  was 0.5. */
export const PEN_SMOOTHING = 0.35;

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
      smoothing: PEN_SMOOTHING,
      streamline: PEN_STREAMLINE,
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
