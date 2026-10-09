import { clamp } from "./geometry";

// The paths lines and arrows are drawn along. A connector runs from (x1, y1)
// to (x2, y2) by its `route`:
//
//   straight (the default)  one segment
//   curved                  one cubic Bézier, leaving and arriving along each end's direction
//   elbow                   right angles only, running straight out of a shape before turning
//
// An end's direction is the way the path leaves it. For an end attached to a
// shape it's out of the shape's side (connectors.js works that out and hands
// it over with `setEndDirections`); for a free end, along whichever axis
// points more towards the other end.

export const ROUTES = ["straight", "curved", "elbow"];
export const ELBOW_GAP = 24; // how far an elbow runs out of a shape before it turns

const CURVE_SAMPLES = 32;

const endDirections = new WeakMap(); // drawn connector -> { start, end }: unit vectors, null for a free end
const paths = new WeakMap();

/** Records which way the path leaves each attached end of a drawn connector (see connectors.js). */
export function setEndDirections(connector, directions) {
  endDirections.set(connector, directions);
}

const along = (point, direction, distance) => ({
  x: point.x + direction.x * distance,
  y: point.y + direction.y * distance,
});

// The axis direction from `from` that points more towards `to`.
function freeDirection(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) };
}

const isRouted = (element) => element.route === "curved" || element.route === "elbow";

/**
 * The path `element` (a line or arrow) is drawn along: `{ points, curved }`.
 * A curved path's points are a cubic Bézier's [start, control, control, end];
 * otherwise they're the corners of a polyline, ends included.
 */
export function connectorPath(element) {
  let path = paths.get(element);
  if (!path) {
    path = buildPath(element, endDirections.get(element) ?? {});
    paths.set(element, path);
  }
  return path;
}

function buildPath(element, directions) {
  const start = { x: element.x1, y: element.y1 };
  const end = { x: element.x2, y: element.y2 };
  if (!isRouted(element)) return { points: [start, end], curved: false };
  const startDirection = directions.start ?? freeDirection(start, end);
  const endDirection = directions.end ?? freeDirection(end, start);
  if (element.route === "curved") {
    const reach = clamp(Math.hypot(end.x - start.x, end.y - start.y) * 0.45, 16, 320);
    return {
      points: [start, along(start, startDirection, reach), along(end, endDirection, reach), end],
      curved: true,
    };
  }
  return {
    points: elbow(start, startDirection, end, endDirection, {
      start: directions.start ? ELBOW_GAP : 0,
      end: directions.end ? ELBOW_GAP : 0,
    }),
    curved: false,
  };
}

const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

// `points` without repeats, or corners that don't turn.
function simplify(points) {
  const kept = [];
  for (const point of points) {
    if (kept.length > 0 && same(kept.at(-1), point)) continue;
    if (kept.length >= 2) {
      const [a, b] = kept.slice(-2);
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const forward = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) < 1e-6 && forward > 0) kept.pop();
    }
    kept.push(point);
  }
  return kept;
}

// Whether a path ever doubles back on itself: no segment may head against the one before.
function doublesBack(points) {
  for (let i = 2; i < points.length; i += 1) {
    const [a, b, c] = [points[i - 2], points[i - 1], points[i]];
    if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -1e-6) return true;
  }
  return false;
}

export function pathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

/**
 * Right-angled corners from `start` to `end`. The path runs `gaps.start` out
 * of the start along its direction, and arrives at the end along the opposite
 * of the end's direction after running `gaps.end` straight in, then takes the
 * route with the fewest turns, and of those the shortest, that never doubles
 * back. Free ends have no gap, so they can be left any way.
 */
function elbow(start, startDirection, end, endDirection, gaps) {
  const a = along(start, startDirection, gaps.start);
  const b = along(end, endDirection, gaps.end);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const xs = [mid.x, Math.max(a.x, b.x), Math.min(a.x, b.x)];
  const ys = [mid.y, Math.max(a.y, b.y), Math.min(a.y, b.y)];
  const middles = [
    // Split down the middle first: of two equally good routes, that one looks tidiest.
    ...xs.map((x) => [
      { x, y: a.y },
      { x, y: b.y },
    ]),
    ...ys.map((y) => [
      { x: a.x, y },
      { x: b.x, y },
    ]),
    [{ x: b.x, y: a.y }],
    [{ x: a.x, y: b.y }],
  ];
  let best = null;
  for (const middle of middles) {
    const points = simplify([start, a, ...middle, b, end]);
    const score = [doublesBack(points) ? 1 : 0, points.length, pathLength(points)];
    if (!best || compareScores(score, best.score) < 0) best = { points, score };
  }
  return best.points;
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return a[i] - b[i];
  }
  return 0;
}

function bezierPoint([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** The path as a polyline: its corners, or points along its curve. */
export function pathPolyline(path) {
  if (!path.curved) return path.points;
  return Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => bezierPoint(path.points, i / CURVE_SAMPLES));
}

/** Halfway along the path, where its label goes. */
export function pathMiddle(path) {
  if (path.curved) return bezierPoint(path.points, 0.5);
  const { points } = path;
  let remaining = pathLength(points) / 2;
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return points.at(-1);
}

/** The point the path arrives at `end` ("start" or "end") from: where an arrowhead there points from. */
export function approachTo(path, end) {
  const points = end === "end" ? path.points : [...path.points].reverse();
  const tip = points.at(-1);
  for (let i = points.length - 2; i >= 0; i -= 1) if (!same(points[i], tip)) return points[i];
  return tip;
}

/** SVG path data for the path. */
export function pathData(path) {
  const [first, ...rest] = path.points;
  const at = (point) => `${point.x} ${point.y}`;
  if (path.curved) return `M${at(first)} C${rest.map(at).join(" ")}`;
  return `M${at(first)} ${rest.map((point) => `L${at(point)}`).join(" ")}`;
}
