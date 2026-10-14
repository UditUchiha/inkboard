import type { Point } from "@inkboard/shared/types";
import { distanceToSegment } from "./geometry";

// Shape recognition for pen strokes: a stroke held still at its end (see BoardCanvas) becomes the shape it looks
// like, if it looks like one. Only on that hold, so a stroke drawn as usual is never changed behind someone's back.

/** What a stroke was recognised as: the kind of shape, and its box (a line's two ends). */
export type RecognizedShape = {
  type: "line" | "rectangle" | "ellipse";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const LINE_TOLERANCE = 0.08; // the farthest a point of a line may stray from it, as a share of its length
const CLOSED_GAP = 0.25; // ends this close, as a share of the box's diagonal, close the shape
const FIT_TOLERANCE = 0.12; // how far a closed stroke may stray from the outline on average, as a share of its half size
const THIN = 0.1; // a closed shape whose short side is less than this share of its long side is a scribble, not a shape

/** The shape `points` were drawn as, or null. `minSize`: the smallest box diagonal worth recognising, in board units. */
export function recognizeStroke(points: readonly Point[], minSize = 0): RecognizedShape | null {
  if (points.length < 3) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const width = right - left;
  const height = bottom - top;
  const diagonal = Math.hypot(width, height);
  if (diagonal === 0 || diagonal < minSize) return null;
  const [sx, sy] = points[0];
  // The assertion: there are points (see above).
  const [ex, ey] = points.at(-1)!;
  const span = Math.hypot(ex - sx, ey - sy);

  const straying = Math.max(...points.map(([x, y]) => distanceToSegment(x, y, sx, sy, ex, ey)));
  if (straying <= LINE_TOLERANCE * span) return { type: "line", x1: sx, y1: sy, x2: ex, y2: ey };

  if (span > CLOSED_GAP * diagonal || Math.min(width, height) < THIN * Math.max(width, height)) return null;
  const [cx, cy, rx, ry] = [left + width / 2, top + height / 2, width / 2, height / 2];
  const mean = (error: (x: number, y: number) => number) =>
    points.reduce((sum, [x, y]) => sum + error(x, y), 0) / points.length;
  // How far each point is from an ellipse in the box, and from the box's own edges, both as a share of the half size.
  const offEllipse = mean((x, y) => Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1));
  const offBox = mean((x, y) => Math.min(x - left, right - x, y - top, bottom - y) / Math.min(rx, ry));
  const best = Math.min(offEllipse, offBox);
  if (best > FIT_TOLERANCE) return null;
  return { type: best === offBox ? "rectangle" : "ellipse", x1: left, y1: top, x2: right, y2: bottom };
}
