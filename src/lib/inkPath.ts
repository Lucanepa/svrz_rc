// The one place a list of pen samples becomes a filled outline. Shared by the
// notebook's pen page (InkPad) and the signature pad, so a Pencil line looks
// the same in both and the signature pad does not have to pull InkPad's lazy
// chunk into the main bundle to get it.
//
// Points are [x, y, pressure 0..1] in whatever units the caller draws in; the
// options are perfect-freehand's, chosen by the caller.

import { getStroke, type StrokeOptions } from 'perfect-freehand';

export type InkSample = [number, number, number];

/** perfect-freehand outline → a closed Path2D, through the midpoints of the
 *  outline so the edge is a smooth quadratic curve, not a polygon. */
export function freehandPath(points: InkSample[], options: StrokeOptions): Path2D | null {
  if (points.length === 0) return null;
  const outline = getStroke(points, options);
  if (outline.length === 0) return null;
  const path = new Path2D();
  const [x0, y0] = outline[0];
  path.moveTo(x0, y0);
  for (let i = 1; i < outline.length; i += 1) {
    const [x1, y1] = outline[i];
    const [x2, y2] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  path.closePath();
  return path;
}
