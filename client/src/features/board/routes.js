import { clamp, rotatePoint } from "./geometry";

// The paths lines and arrows are drawn along. A connector runs from (x1, y1)
// to (x2, y2) by its `route`:
//
//   straight (the default)  one segment
//   curved                  one cubic Bézier, leaving and arriving along each end's direction
//   elbow                   right angles only, running straight out of a shape before turning
//
// An end's direction is the way the path leaves it. For an end attached to a
// shape it's out of the shape's side (connectors.js works that out and hands
// it over with `setEndDirections`, along with the shape's box, which an elbow
// goes round); for a free end, along whichever axis points more towards the
// other end.

export const ROUTES = ["straight", "curved", "elbow"];
export const ELBOW_GAP = 24; // how far an elbow runs out of a shape before it turns

const CURVE_SAMPLES = 32;

const endDirections = new WeakMap(); // drawn connector -> { directions, boxes }, each { start, end }: null for a free end
const paths = new WeakMap();

/**
 * Records which way the path leaves each attached end of a drawn connector (unit
 * vectors) and the box of the shape each is attached to (see connectors.js).
 */
export function setEndDirections(connector, directions, boxes) {
  endDirections.set(connector, { directions, boxes });
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
    path = buildPath(element, endDirections.get(element) ?? { directions: {}, boxes: {} });
    paths.set(element, path);
  }
  return path;
}

function buildPath(element, { directions, boxes }) {
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
    points: elbow(
      start,
      startDirection,
      end,
      endDirection,
      { start: directions.start ? ELBOW_GAP : 0, end: directions.end ? ELBOW_GAP : 0 },
      [boxes.start, boxes.end].filter(Boolean),
    ),
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

// Whether the span from `from` to `to` runs into the inside of the span `low` to `low + size`.
const runsInto = (from, to, low, size) => Math.max(from, to) > low + 1e-6 && Math.min(from, to) < low + size - 1e-6;

// Whether the segment from `p` to `q` runs into the inside of a turned rectangle (`frame`: { cx, cy, width,
// height, angle }): clipped to it in its own upright space, something of the segment is left.
function runsIntoTurned(p, q, { cx, cy, width, height, angle }) {
  const [ax, ay] = rotatePoint(p.x, p.y, cx, cy, -angle);
  const [bx, by] = rotatePoint(q.x, q.y, cx, cy, -angle);
  const [halfWidth, halfHeight] = [width / 2 - 1e-6, height / 2 - 1e-6];
  const [dx, dy] = [bx - ax, by - ay];
  let low = 0;
  let high = 1;
  // Each edge as (how fast the segment heads out through it, how far inside it the segment starts).
  for (const [out, inside] of [
    [-dx, ax - cx + halfWidth],
    [dx, cx + halfWidth - ax],
    [-dy, ay - cy + halfHeight],
    [dy, cy + halfHeight - ay],
  ]) {
    if (Math.abs(out) < 1e-12) {
      if (inside <= 0) return false; // alongside the edge, outside it
    } else if (out < 0) low = Math.max(low, inside / out);
    else high = Math.min(high, inside / out);
    if (high - low < 1e-9) return false;
  }
  return true;
}

// How many of `boxes` the path runs through (touching a box's edge doesn't count). A box whose shape is
// turned (`box.turned`, its frame) is the shape itself: its upright box would hold the end on the shape's
// side and the run out of it, so every route would seem to cross it and none would be ranked worse.
function boxesCrossed(points, boxes) {
  return boxes.filter((box) =>
    points.some((point, i) => {
      if (i === 0) return false;
      const from = points[i - 1];
      if (box.turned?.angle) return runsIntoTurned(from, point, box.turned);
      return runsInto(from.x, point.x, box.x, box.width) && runsInto(from.y, point.y, box.y, box.height);
    }),
  ).length;
}

/**
 * Right-angled corners from `start` to `end`. The path runs `gaps.start` out
 * of the start along its direction, and arrives at the end along the opposite
 * of the end's direction after running `gaps.end` straight in, then takes the
 * route that crosses the fewest of `boxes` (the shapes it joins), and of those
 * the fewest turns, and of those the shortest, that never doubles back. Free
 * ends have no gap, so they can be left any way.
 */
function elbow(start, startDirection, end, endDirection, gaps, boxes) {
  const a = along(start, startDirection, gaps.start);
  const b = along(end, endDirection, gaps.end);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Where the middle of the route can run: down the middle, between the run-outs, or round the outside of the shapes.
  const xs = [mid.x, Math.max(a.x, b.x), Math.min(a.x, b.x)];
  const ys = [mid.y, Math.max(a.y, b.y), Math.min(a.y, b.y)];
  for (const box of boxes) {
    xs.push(box.x - ELBOW_GAP, box.x + box.width + ELBOW_GAP);
    ys.push(box.y - ELBOW_GAP, box.y + box.height + ELBOW_GAP);
  }
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
    const score = [boxesCrossed(points, boxes), doublesBack(points) ? 1 : 0, points.length, pathLength(points)];
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

// Where along a Bézier (t between 0 and 1) one axis stops going one way and turns back.
function turningPoints([p0, p1, p2, p3]) {
  const a = p3 - 3 * p2 + 3 * p1 - p0;
  const b = 2 * (p2 - 2 * p1 + p0);
  const c = p1 - p0;
  const roots = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

/** The points that decide how far the path reaches: its corners, or a curve's ends and its furthest points each way. */
export function pathExtremes(path) {
  if (!path.curved) return path.points;
  const turns = [
    ...turningPoints(path.points.map((point) => point.x)),
    ...turningPoints(path.points.map((point) => point.y)),
  ];
  return [path.points[0], ...turns.map((t) => bezierPoint(path.points, t)), path.points[3]];
}

const polylines = new WeakMap(); // path -> its points along a curve; a path never changes

/** The path as a polyline: its corners, or points along its curve. */
export function pathPolyline(path) {
  if (!path.curved) return path.points;
  let polyline = polylines.get(path);
  if (!polyline) {
    polyline = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => bezierPoint(path.points, i / CURVE_SAMPLES));
    polylines.set(path, polyline);
  }
  return polyline;
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
