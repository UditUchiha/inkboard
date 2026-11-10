import type { Point } from "@inkboard/shared/types";
import { clamp, distanceToSegment, polygonCorners } from "./geometry";
import type { Pair } from "./geometry";

// Shape recognition for pen strokes: a stroke held still at its end (see BoardCanvas) becomes the shape it looks
// like, if it looks like one. Only on that hold, so a stroke drawn as usual is never changed behind someone's back.

/**
 * What a stroke was recognised as: the kind of shape, and its box (a line's or arrow's two ends). A triangle drawn
 * pointing down is one pointing up turned half round (`angle`).
 */
export type RecognizedShape = {
  type: "line" | "arrow" | "rectangle" | "ellipse" | "triangle" | "diamond";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  angle?: number;
};

const LINE_TOLERANCE = 0.08; // the farthest a point of a line may stray from it, as a share of its length
const CLOSED_GAP = 0.25; // ends this close, as a share of the box's diagonal, close the shape
const FIT_TOLERANCE = 0.12; // how far a closed stroke may stray from the outline on average, as a share of its half size
const THIN = 0.1; // a closed shape whose short side is less than this share of its long side is a scribble, not a shape
// An arrowhead reaches this far from the tip, as a share of the shaft: less is a wobble as the pen stopped, more is
// a second line rather than a head.
const HEAD_REACH = [0.12, 0.4];
// And its barbs open this far (radians) from the way back along the shaft: less only goes back over the line, more
// is a corner (an L, a Z) rather than a head.
const HEAD_SPREAD = [Math.PI / 9, (Math.PI * 5) / 12];
// A triangle or diamond must fit this many times better than the next best shape: a stroke with more corners (a
// pentagon) is about as near a diamond as an ellipse, and is neither. A rectangle and an ellipse are told apart by
// whichever is nearer, as they always were: a rough rectangle is never far from an ellipse.
const MARGIN = 1.5;

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

  // Before the line: a short head flicked back from the end of a line hardly strays from the line's two ends.
  const arrow = arrowIn(points);
  if (arrow) return arrow;
  const straying = Math.max(...points.map(([x, y]) => distanceToSegment(x, y, sx, sy, ex, ey)));
  if (straying <= LINE_TOLERANCE * span) return { type: "line", x1: sx, y1: sy, x2: ex, y2: ey };

  if (span > CLOSED_GAP * diagonal || Math.min(width, height) < THIN * Math.max(width, height)) return null;
  const box = { x: left, y: top, width, height };
  const [cx, cy, rx, ry] = [left + width / 2, top + height / 2, width / 2, height / 2];
  const mean = (error: (x: number, y: number) => number) =>
    points.reduce((sum, [x, y]) => sum + error(x, y), 0) / points.length;
  // How far each point is from an ellipse in the box, or from an outline through `corners`, as a share of the half size.
  const offEllipse = mean((x, y) => Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1));
  const offOutline = (corners: Pair[]) =>
    mean(
      (x, y) =>
        // The assertion: `at(i - 1)` of a corner is the one before it, or the last.
        Math.min(...corners.map((corner, i) => distanceToSegment(x, y, ...corner, ...corners.at(i - 1)!))) /
        Math.min(rx, ry),
    );
  const boxed = { x1: left, y1: top, x2: right, y2: bottom };
  // The assertion: a triangle has corners.
  const triangle = polygonCorners("triangle", box)!;
  const upsideDown = triangle.map(([x, y]): Pair => [x, top + bottom - y]);
  const fits: [RecognizedShape, number][] = [
    [{ type: "ellipse", ...boxed }, offEllipse],
    [
      { type: "rectangle", ...boxed },
      offOutline([
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ]),
    ],
    [{ type: "triangle", ...boxed }, offOutline(triangle)],
    [{ type: "triangle", ...boxed, angle: Math.PI }, offOutline(upsideDown)],
    // A square turned on its corner is a diamond: the two can't be told apart, and a diamond keeps the box drawn.
    // The assertion: a diamond has corners.
    [{ type: "diamond", ...boxed }, offOutline(polygonCorners("diamond", box)!)],
  ];
  const [[best, error], [, next]] = fits.sort((a, b) => a[1] - b[1]);
  if (error > FIT_TOLERANCE) return null;
  return (best.type === "triangle" || best.type === "diamond") && next < MARGIN * error ? null : best;
}

// An arrow drawn in one stroke: a straight shaft out to its tip, then a head flicked back from the tip, one barb or
// both (a V drawn from the tip, out and back and out again).
function arrowIn(points: readonly Point[]): RecognizedShape | null {
  const [sx, sy] = points[0];
  const far = points.map(([x, y]) => Math.hypot(x - sx, y - sy));
  const length = Math.max(...far);
  // The tip is the first time the stroke gets (nearly) as far from the start as it ever does: a V comes back to it.
  const tip = far.findIndex((distance) => distance >= length * (1 - LINE_TOLERANCE / 2));
  const [tx, ty] = points[tip];
  const head = points.slice(tip + 1);
  if (tip < 2 || head.length < 2) return null;
  if (points.slice(0, tip).some(([x, y]) => distanceToSegment(x, y, sx, sy, tx, ty) > LINE_TOLERANCE * length))
    return null;
  // How far each point of the head is from the tip, and its angle there from the way back along the shaft.
  const away = head.map(([x, y]) => Math.hypot(x - tx, y - ty));
  const reach = Math.max(...away);
  if (reach < HEAD_REACH[0] * length || reach > HEAD_REACH[1] * length) return null;
  const spread = ([x, y]: Point, i: number) =>
    Math.acos(clamp(((x - tx) * (sx - tx) + (y - ty) * (sy - ty)) / (away[i] * far[tip]), -1, 1));
  // The far end of a barb says how wide it opens, where the hand's wobble matters least. Near the tip, where the
  // stroke turns, isn't looked at.
  const end = away.indexOf(reach);
  if (spread(head[end], end) < HEAD_SPREAD[0]) return null;
  if (head.some((point, i) => away[i] > reach / 3 && spread(point, i) > HEAD_SPREAD[1])) return null;
  return { type: "arrow", x1: sx, y1: sy, x2: tx, y2: ty };
}
