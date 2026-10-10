import { connectorPath } from "./routes";

// What it costs to draw some elements (a Rough.js shape, a pen stroke's outline)
// is spent in making them, and elements are immutable, so each is made once per
// element object. But dragging a frame or a group hands the board a new copy of
// every element on each step, each a little further along, and every copy would
// be made from scratch. These caches also remember the last thing made for each
// id, and reuse it for a copy that's the same but for where it is, to be drawn
// with the difference as an offset. (A filled hand-drawn shape's hatching, and
// a hand-drawn curve's wobble, come out a fraction of a unit differently at
// different places, so one that has been moved keeps the one it was first drawn with.)

const TOLERANCE = 1e-6;
const close = (a, b) => Math.abs(a - b) < TOLERANCE;

// What a Rough.js shape's drawing depends on, apart from where it is.
const SHAPE_LOOKS = ["type", "seed", "stroke", "fill", "strokeWidth", "sketchy"];

// What a line's or arrow's drawing depends on as well, apart from its path (see routes.js).
const CONNECTOR_LOOKS = ["startHead", "route"];

const isConnector = (element) => element.type === "line" || element.type === "arrow";

// How far `element`'s path is from `source`'s ({ dx, dy }) if it's the same path moved there, or null. A
// line or arrow is drawn along its path, and its heads come from that too, so a path that's only moved (both
// ends, every bend, a curve's control points) is a drawing that's only moved.
function pathMovedBy(source, element) {
  const [before, after] = [connectorPath(source), connectorPath(element)];
  if (before.curved !== after.curved || before.points.length !== after.points.length) return null;
  const dx = after.points[0].x - before.points[0].x;
  const dy = after.points[0].y - before.points[0].y;
  const same = after.points.every(
    (point, i) => close(point.x - before.points[i].x, dx) && close(point.y - before.points[i].y, dy),
  );
  return same ? { dx, dy } : null;
}

/**
 * How far `element` is from `source` ({ dx, dy }) if it's the same drawing
 * moved there, or null. Rectangles, ellipses, lines and arrows, and pen strokes, only.
 */
export function movedBy(source, element) {
  if (source.type !== element.type) return null;
  if (element.type === "pen") {
    const { points } = element;
    if (source.points.length !== points.length || source.penSize !== element.penSize) return null;
    if (source.pressure !== element.pressure || points.length === 0) return null;
    const dx = points[0][0] - source.points[0][0];
    const dy = points[0][1] - source.points[0][1];
    const same = points.every(
      (point, i) =>
        close(point[0] - source.points[i][0], dx) &&
        close(point[1] - source.points[i][1], dy) &&
        point[2] === source.points[i][2],
    );
    return same ? { dx, dy } : null;
  }
  if (isConnector(element)) {
    if ([...SHAPE_LOOKS, ...CONNECTOR_LOOKS].some((key) => source[key] !== element[key])) return null;
    return pathMovedBy(source, element);
  }
  if (element.type !== "rectangle" && element.type !== "ellipse") return null;
  if (SHAPE_LOOKS.some((key) => source[key] !== element[key])) return null;
  const dx = element.x1 - source.x1;
  const dy = element.y1 - source.y1;
  return close(element.x2 - source.x2, dx) && close(element.y2 - source.y2, dy) ? { dx, dy } : null;
}

/**
 * A cache of what's made for elements. `get(element, build)` gives
 * `{ built, dx, dy }`: what `build(element)` made for it, or for an element it's
 * a moved copy of, in which case it's to be drawn (dx, dy) along.
 */
export function createDrawingCache() {
  const byElement = new WeakMap();
  const byId = new Map(); // id -> { source, built }: the last thing made for each element

  return {
    get(element, build) {
      let entry = byElement.get(element);
      if (!entry) {
        const known = byId.get(element.id);
        const moved = known && movedBy(known.source, element);
        if (moved) {
          entry = { built: known.built, ...moved };
        } else {
          entry = { built: build(element), dx: 0, dy: 0 };
          byId.set(element.id, { source: element, built: entry.built });
        }
        byElement.set(element, entry);
      }
      return entry;
    },

    /** Lets go of what's remembered by id once it's far more than a board of `count` elements needs. */
    trim(count) {
      if (byId.size > count * 4 + 1000) byId.clear();
    },
  };
}
