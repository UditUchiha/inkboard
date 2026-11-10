import type { Element as BoardElement, PenElement, ShapeElement } from "@inkboard/shared/types";
import type { Connector } from "../elements/elements";
import { connectorPath } from "../elements/routes";

export type CachedDrawing<Built> = { built: Built; dx: number; dy: number };

export type Moved = { dx: number; dy: number };

// Elements are immutable, so each is built once per object. A drag hands the board a new copy of every element per
// step, so the last build per id is reused for a copy that differs only in position, drawn with an offset. Hatching and
// wobble differ slightly by position, so a moved element keeps the look it was first drawn with.

const TOLERANCE = 1e-6;
const close = (a: number, b: number) => Math.abs(a - b) < TOLERANCE;

const SHAPE_LOOKS: (keyof ShapeElement)[] = ["type", "seed", "stroke", "fill", "strokeWidth", "sketchy"];

const CONNECTOR_LOOKS: (keyof ShapeElement)[] = ["startHead", "route"];

const isConnector = (element: BoardElement): element is Connector =>
  element.type === "line" || element.type === "arrow";

// A line's heads come from its path too, so a path that only moved is a drawing that only moved.
function pathMovedBy(source: Connector, element: Connector): Moved | null {
  const [before, after] = [connectorPath(source), connectorPath(element)];
  if (before.curved !== after.curved || before.points.length !== after.points.length) return null;
  const dx = after.points[0].x - before.points[0].x;
  const dy = after.points[0].y - before.points[0].y;
  const same = after.points.every(
    (point, i) => close(point.x - before.points[i].x, dx) && close(point.y - before.points[i].y, dy),
  );
  return same ? { dx, dy } : null;
}

export function movedBy(source: BoardElement, element: BoardElement): Moved | null {
  if (source.type !== element.type) return null;
  if (element.type === "pen") {
    const { points } = element;
    if ((source as PenElement).points.length !== points.length || (source as PenElement).penSize !== element.penSize)
      return null;
    if ((source as PenElement).pressure !== element.pressure || points.length === 0) return null;
    const dx = points[0][0] - (source as PenElement).points[0][0];
    const dy = points[0][1] - (source as PenElement).points[0][1];
    const same = points.every(
      (point, i) =>
        close(point[0] - (source as PenElement).points[i][0], dx) &&
        close(point[1] - (source as PenElement).points[i][1], dy) &&
        point[2] === (source as PenElement).points[i][2],
    );
    return same ? { dx, dy } : null;
  }
  if (isConnector(element)) {
    if ([...SHAPE_LOOKS, ...CONNECTOR_LOOKS].some((key) => (source as Connector)[key] !== element[key])) return null;
    return pathMovedBy(source as Connector, element);
  }
  if (!("seed" in element)) return null; // after lines and arrows, the shapes left are the ones drawn in a box
  if (SHAPE_LOOKS.some((key) => (source as ShapeElement)[key] !== element[key])) return null;
  const dx = element.x1 - (source as ShapeElement).x1;
  const dy = element.y1 - (source as ShapeElement).y1;
  return close(element.x2 - (source as ShapeElement).x2, dx) && close(element.y2 - (source as ShapeElement).y2, dy)
    ? { dx, dy }
    : null;
}

export function createDrawingCache<Built>() {
  const byElement = new WeakMap<BoardElement, CachedDrawing<Built>>();
  const byId = new Map<string, { source: BoardElement; built: Built }>(); // id -> { source, built }: the last thing made for each element

  return {
    get(element: BoardElement, build: (element: BoardElement) => Built): CachedDrawing<Built> {
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

    trim(count: number) {
      if (byId.size > count * 4 + 1000) byId.clear();
    },
  };
}
