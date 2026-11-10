import type { Route, ShapeElement } from "@inkboard/shared/types";
import { clamp, rotatePoint } from "./geometry";
import type { Rect, TurnedRect, XY } from "./geometry";

// A connector runs from (x1, y1) to (x2, y2) by its `route`: straight (default), curved (one cubic Bézier) or
// elbow (right angles, straight out of a shape before turning). An attached end leaves its shape's side
// (connectors.ts supplies that and the shape's box via `setEndDirections`); a free end goes along the axis pointing
// more towards the other end.

export const ROUTES: Route[] = ["straight", "curved", "elbow"];
export const ELBOW_GAP = 24; // how far an elbow runs out of a shape before it turns

const CURVE_SAMPLES = 32;

export type EndDirections = { start?: XY | null; end?: XY | null };

export type AttachedBox = Rect & { turned?: TurnedRect };

export type EndBoxes = { start?: AttachedBox | null; end?: AttachedBox | null };

export type Path = { points: XY[]; curved: boolean };

type Ends = { directions: EndDirections; boxes: EndBoxes };

const endDirections = new WeakMap<ShapeElement, Ends>(); // drawn connector -> its directions and boxes, each { start, end }: null for a free end
const paths = new WeakMap<ShapeElement, Path>();

export function setEndDirections(connector: ShapeElement, directions: EndDirections, boxes: EndBoxes) {
  endDirections.set(connector, { directions, boxes });
}

const along = (point: XY, direction: XY, distance: number): XY => ({
  x: point.x + direction.x * distance,
  y: point.y + direction.y * distance,
});

function freeDirection(from: XY, to: XY): XY {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) };
}

const isRouted = (element: ShapeElement) => element.route === "curved" || element.route === "elbow";

export function connectorPath(element: ShapeElement): Path {
  let path = paths.get(element);
  if (!path) {
    path = buildPath(element, endDirections.get(element) ?? { directions: {}, boxes: {} });
    paths.set(element, path);
  }
  return path;
}

function buildPath(element: ShapeElement, { directions, boxes }: Ends): Path {
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
      [boxes.start, boxes.end].filter(Boolean) as AttachedBox[],
    ),
    curved: false,
  };
}

const same = (a: XY, b: XY) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

function simplify(points: XY[]): XY[] {
  const kept: XY[] = [];
  for (const point of points) {
    if (kept.length > 0 && same(kept.at(-1)!, point)) continue;
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

function doublesBack(points: XY[]) {
  for (let i = 2; i < points.length; i += 1) {
    const [a, b, c] = [points[i - 2], points[i - 1], points[i]];
    if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -1e-6) return true;
  }
  return false;
}

export function pathLength(points: XY[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

const runsInto = (from: number, to: number, low: number, size: number) =>
  Math.max(from, to) > low + 1e-6 && Math.min(from, to) < low + size - 1e-6;

function runsIntoTurned(p: XY, q: XY, { cx, cy, width, height, angle }: TurnedRect) {
  const [ax, ay] = rotatePoint(p.x, p.y, cx, cy, -angle);
  const [bx, by] = rotatePoint(q.x, q.y, cx, cy, -angle);
  const [halfWidth, halfHeight] = [width / 2 - 1e-6, height / 2 - 1e-6];
  const [dx, dy] = [bx - ax, by - ay];
  let low = 0;
  let high = 1;
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

// A turned shape's upright box would hold the end on its side and make every route seem to cross it, so its own frame
// is used.
function boxesCrossed(points: XY[], boxes: AttachedBox[]) {
  return boxes.filter((box) =>
    points.some((point, i) => {
      if (i === 0) return false;
      const from = points[i - 1];
      if (box.turned?.angle) return runsIntoTurned(from, point, box.turned);
      return runsInto(from.x, point.x, box.x, box.width) && runsInto(from.y, point.y, box.y, box.height);
    }),
  ).length;
}

// Right-angled route: fewest boxes crossed, then fewest turns, then shortest; never doubles back. Free ends have no
// gap.
function elbow(
  start: XY,
  startDirection: XY,
  end: XY,
  endDirection: XY,
  gaps: { start: number; end: number },
  boxes: AttachedBox[],
): XY[] {
  const a = along(start, startDirection, gaps.start);
  const b = along(end, endDirection, gaps.end);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
  let best: { points: XY[]; score: number[] } | null = null;
  for (const middle of middles) {
    const points = simplify([start, a, ...middle, b, end]);
    const score = [boxesCrossed(points, boxes), doublesBack(points) ? 1 : 0, points.length, pathLength(points)];
    if (!best || compareScores(score, best.score) < 0) best = { points, score };
  }
  return best!.points;
}

function compareScores(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return a[i] - b[i];
  }
  return 0;
}

function bezierPoint([p0, p1, p2, p3]: XY[], t: number): XY {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function turningPoints([p0, p1, p2, p3]: number[]) {
  const a = p3 - 3 * p2 + 3 * p1 - p0;
  const b = 2 * (p2 - 2 * p1 + p0);
  const c = p1 - p0;
  const roots: number[] = [];
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

export function pathExtremes(path: Path): XY[] {
  if (!path.curved) return path.points;
  const turns = [
    ...turningPoints(path.points.map((point) => point.x)),
    ...turningPoints(path.points.map((point) => point.y)),
  ];
  return [path.points[0], ...turns.map((t) => bezierPoint(path.points, t)), path.points[3]];
}

const polylines = new WeakMap<Path, XY[]>(); // path -> its points along a curve; a path never changes

export function pathPolyline(path: Path): XY[] {
  if (!path.curved) return path.points;
  let polyline = polylines.get(path);
  if (!polyline) {
    polyline = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => bezierPoint(path.points, i / CURVE_SAMPLES));
    polylines.set(path, polyline);
  }
  return polyline;
}

export function pathMiddle(path: Path): XY {
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
  return points.at(-1)!;
}

export function approachTo(path: Path, end: "start" | "end"): XY {
  const points = end === "end" ? path.points : [...path.points].reverse();
  const tip = points.at(-1)!;
  for (let i = points.length - 2; i >= 0; i -= 1) if (!same(points[i], tip)) return points[i];
  return tip;
}

export function pathData(path: Path): string {
  const [first, ...rest] = path.points;
  const at = (point: XY) => `${point.x} ${point.y}`;
  if (path.curved) return `M${at(first)} C${rest.map(at).join(" ")}`;
  return `M${at(first)} ${rest.map((point) => `L${at(point)}`).join(" ")}`;
}
