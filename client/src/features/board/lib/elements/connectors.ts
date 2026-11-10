import type { ConnectorFields, Element as BoardElement, Side } from "@inkboard/shared/types";
import {
  createElement,
  duplicate,
  elementAt,
  getBounds,
  getFrame,
  inDrawOrder,
  isFrame,
  newId,
  translate,
} from "./elements";
import type { AnyElement, Connector, ElementStyle } from "./elements";
import { expandRect, polygonCorners, reachOfOutline, rectContains, rotatePoint } from "./geometry";
import type { Pair, Rect, TurnedRect, XY } from "./geometry";
import { setEndDirections } from "./routes";

export type Connectable = AnyElement;

export type SidePoint = XY & { dx: number; dy: number };

// What a connector end at a point attaches to: a shape and, on one of its dots, that side; otherwise floating, or nothing.
export type Connection =
  { target: Connectable; side: Side } | { target: Connectable; side: null } | { target: null; side: null };

export type ConnectorChange = { before: Connector; after: Connector };

type DrawnBox = Rect & { turned: TurnedRect };

// `startId`/`endId` attach a connector end to a shape. An attached end is worked out from where the shape is now,
// so connectors follow moves, resizes and turns on every screen without being changed; stored x/y is only a fallback.
// A dot pins an end to a side (`startAnchor`/`endAnchor`); dropped on the shape itself it floats (see routes.ts).

export const CONNECTABLE_TYPES = new Set<BoardElement["type"]>([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "sticky",
  "image",
  "text",
]);
export const CONNECT_GAP = 6; // between an attached end and its shape's outline

export const DOT_GAP = 14; // between the dots and the shape's outline
export const DOT_REACH = 10; // around a dot that counts as being on it
export const DOT_CORE = 5; // around a dot's middle (about the dot drawn) that wins over an arrow running through it

export const SIDES: Record<Side, Pair> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export const isConnector = (element: BoardElement): element is Connector =>
  element.type === "line" || element.type === "arrow";
export const canConnectTo = (element: BoardElement) => CONNECTABLE_TYPES.has(element.type);
const isAttached = (element: BoardElement): element is Connector =>
  isConnector(element) && Boolean(element.startId || element.endId);
const isRouted = (element: Connector) => element.route === "curved" || element.route === "elbow";

const middleOf = (element: BoardElement): XY => {
  const { cx, cy } = getFrame(element);
  return { x: cx, y: cy };
};

export function outlinePoint(target: Connectable, toward: XY): XY {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [tx, ty] = angle ? rotatePoint(toward.x, toward.y, cx, cy, -angle) : [toward.x, toward.y];
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.hypot(dx, dy) < 1e-9) return { x: cx, y: cy };
  const pad = CONNECT_GAP + (target.strokeWidth ?? 0) / 2;
  const rx = width / 2 + pad;
  const ry = height / 2 + pad;
  // shortcut: a triangle's or diamond's gap is its box's, so it's narrower along a slanted side; fine for a few pixels.
  const corners = polygonCorners(target.type, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 });
  const reach = corners
    ? reachOfOutline(cx, cy, dx, dy, corners)
    : target.type === "ellipse"
      ? 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry))
      : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
  const [x, y] = rotatePoint(cx + dx * reach, cy + dy * reach, cx, cy, angle);
  return { x, y };
}

export function sidePoint(
  target: Connectable,
  side: Side,
  gap = CONNECT_GAP + (target.strokeWidth ?? 0) / 2,
): SidePoint {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [nx, ny] = SIDES[side];
  // A triangle's left and right sides slant in, so their middles are where the outline crosses the box's middle.
  const box = { x: cx - width / 2 - gap, y: cy - height / 2 - gap, width: width + gap * 2, height: height + gap * 2 };
  const corners = polygonCorners(target.type, box);
  const out = corners && reachOfOutline(cx, cy, nx, ny, corners);
  const [x, y] = rotatePoint(cx + nx * (out ?? box.width / 2), cy + ny * (out ?? box.height / 2), cx, cy, angle);
  const [dx, dy] = rotatePoint(nx, ny, 0, 0, angle);
  return { x, y, dx, dy };
}

export function facingSide(target: BoardElement, point: XY): Side {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [x, y] = angle ? rotatePoint(point.x, point.y, cx, cy, -angle) : [point.x, point.y];
  const across = (x - cx) / Math.max(width / 2, 1);
  const down = (y - cy) / Math.max(height / 2, 1);
  if (Math.abs(across) >= Math.abs(down)) return across >= 0 ? "right" : "left";
  return down >= 0 ? "bottom" : "top";
}

export function connectionDots(target: Connectable, zoom: number): Record<Side, SidePoint> {
  const gap = DOT_GAP / zoom + (target.strokeWidth ?? 0) / 2;
  return Object.fromEntries(
    (Object.keys(SIDES) as Side[]).map((side): [Side, SidePoint] => [side, sidePoint(target, side, gap)]),
  ) as Record<Side, SidePoint>;
}

export function dotAt(target: Connectable, point: XY, zoom: number): Side | null {
  const reach = DOT_REACH / zoom;
  let nearest: Side | null = null;
  let best = reach;
  for (const [side, dot] of Object.entries(connectionDots(target, zoom))) {
    const distance = Math.hypot(point.x - dot.x, point.y - dot.y);
    if (distance <= best) {
      nearest = side as Side; // Object.entries only knows strings, and the keys of the dots are sides
      best = distance;
    }
  }
  return nearest;
}

const unit = (dx: number, dy: number): XY | null => {
  const length = Math.hypot(dx, dy);
  return length < 1e-9 ? null : { x: dx / length, y: dy / length };
};

function floatingEnd(connector: Connector, target: Connectable, toward: XY): SidePoint {
  if (isRouted(connector)) return sidePoint(target, facingSide(target, toward));
  const point = outlinePoint(target, toward);
  const middle = middleOf(target);
  const out = unit(point.x - middle.x, point.y - middle.y) ?? { x: 1, y: 0 };
  return { ...point, dx: out.x, dy: out.y };
}

let drawnCopies = new WeakMap<
  Connector,
  { drawn: Connector; directions: Directions; boxes: { start: DrawnBox | null; end: DrawnBox | null } }
>(); // connector -> its last drawn copy and its ends' directions and boxes: { drawn, directions, boxes }

type Directions = { start: XY | null; end: XY | null };

function drawConnector(connector: Connector, from: Connectable | null, to: Connectable | null): Connector {
  if (!from && !to) return connector;
  // Pinned ends first: where floating ends aim depends on them.
  const pinned = (target: Connectable | null, side: Side | undefined) =>
    target && SIDES[side!] ? sidePoint(target, side!) : null;
  const startPin = pinned(from, connector.startAnchor);
  const endPin = pinned(to, connector.endAnchor);
  const aim = (pin: SidePoint | null, target: Connectable | null, x: number, y: number): XY =>
    pin ?? (target ? middleOf(target) : { x, y });
  const start = startPin ?? (from && floatingEnd(connector, from, aim(endPin, to, connector.x2, connector.y2)));
  const end = endPin ?? (to && floatingEnd(connector, to, aim(startPin, from, connector.x1, connector.y1)));
  const [x1, y1] = start ? [start.x, start.y] : [connector.x1, connector.y1];
  const [x2, y2] = end ? [end.x, end.y] : [connector.x2, connector.y2];
  const directions: Directions = {
    start: start ? { x: start.dx, y: start.dy } : null,
    end: end ? { x: end.dx, y: end.dy } : null,
  };
  const boxOf = (target: Connectable | null) => target && { ...getBounds(target), turned: getFrame(target) };
  const boxes = { start: boxOf(from), end: boxOf(to) };
  // The same object while nothing moves, so what's drawn from it stays cached.
  const last = drawnCopies.get(connector);
  if (
    last &&
    last.drawn.x1 === x1 &&
    last.drawn.y1 === y1 &&
    last.drawn.x2 === x2 &&
    last.drawn.y2 === y2 &&
    sameDirection(last.directions.start, directions.start) &&
    sameDirection(last.directions.end, directions.end) &&
    sameBox(last.boxes.start, boxes.start) &&
    sameBox(last.boxes.end, boxes.end)
  ) {
    return last.drawn;
  }
  const drawn = { ...connector, x1, y1, x2, y2 };
  setEndDirections(drawn, directions, boxes);
  drawnCopies.set(connector, { drawn, directions, boxes });
  return drawn;
}

const sameDirection = (a: XY | null, b: XY | null) => (!a && !b) || Boolean(a && b && a.x === b.x && a.y === b.y);
const sameBox = (a: DrawnBox | null, b: DrawnBox | null) =>
  (!a && !b) ||
  Boolean(
    a &&
    b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.turned.angle === b.turned.angle &&
    a.turned.width === b.turned.width &&
    a.turned.height === b.turned.height,
  );

let resolvedBoards = new WeakMap<BoardElement[], BoardElement[]>();

export function forgetResolvedConnectors() {
  drawnCopies = new WeakMap();
  resolvedBoards = new WeakMap();
}

export function resolveConnectors(elements: BoardElement[]): BoardElement[] {
  let resolved = resolvedBoards.get(elements);
  if (resolved) return resolved;
  if (!elements.some(isAttached)) {
    resolved = elements;
  } else {
    const byId = new Map(elements.map((element) => [element.id, element]));
    const target = (id: string | undefined) => {
      const found = id ? byId.get(id) : null;
      return found && canConnectTo(found) ? found : null;
    };
    resolved = elements.map((element) =>
      isAttached(element) ? drawConnector(element, target(element.startId), target(element.endId)) : element,
    );
  }
  resolvedBoards.set(elements, resolved);
  return resolved;
}

export const drawnElement = (elements: BoardElement[], id: string): BoardElement | undefined =>
  resolveConnectors(elements).find((element) => element.id === id);

function covers(target: Connectable, point: XY, tolerance: number): boolean {
  // Most elements are nowhere near: their (cached) bounds rule them out without measuring anything.
  if (!rectContains(expandRect(getBounds(target), tolerance), point.x, point.y)) return false;
  const { cx, cy, width, height, angle } = getFrame(target);
  const [x, y] = angle ? rotatePoint(point.x, point.y, cx, cy, -angle) : [point.x, point.y];
  const rx = width / 2 + tolerance;
  const ry = height / 2 + tolerance;
  const corners = polygonCorners(target.type, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 });
  if (corners) return reachOfOutline(cx, cy, x - cx, y - cy, corners) >= 1;
  if (target.type === "ellipse") return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  return Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry;
}

// Shapes come before text: a label on a shape is part of it, so text is only attached when no shape is there.
export function connectTargetAt(
  elements: BoardElement[],
  point: XY,
  tolerance: number,
  { except }: { except?: string } = {},
): Connectable | null {
  const ordered = inDrawOrder(resolveConnectors(elements));
  const excluded = except ? ordered.find((element) => element.id === except) : null;
  let text: Connectable | null = null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const element = ordered[i];
    if (element.id === except || !canConnectTo(element) || !covers(element, point, tolerance)) continue;
    if (element.type !== "text") return element;
    if (!text && !(excluded && covers(excluded, middleOf(element), 0))) text = element;
  }
  return text;
}

export function connectionAt(
  elements: BoardElement[],
  point: XY,
  { zoom, tolerance, except }: { zoom: number; tolerance: number; except?: string },
): Connection {
  const reach = (DOT_GAP + DOT_REACH) / zoom + tolerance;
  const near = connectTargetAt(elements, point, reach, { except });
  const side = near ? dotAt(near, point, zoom) : null;
  if (side) return { target: near!, side };
  return { target: connectTargetAt(elements, point, tolerance, { except }), side: null };
}

const hitAt = (elements: BoardElement[], point: XY, zoom: number, tolerance: number): BoardElement | null =>
  elementAt(elements, point.x, point.y, tolerance, { labelScale: 1 / zoom });

type Lookup = { zoom: number; tolerance: number };

function dotIsFree(
  elements: BoardElement[],
  point: XY,
  found: { target: Connectable; side: Side },
  { zoom, tolerance, hit = hitAt(elements, point, zoom, tolerance) }: Lookup & { hit?: BoardElement | null },
) {
  if (hit && isConnector(hit)) {
    // An arrow pinned to this side runs out through its dot: only a press right on the dot starts another,
    // and one anywhere else along the arrow is a press on the arrow, so a short arrow can still be selected.
    const dot = connectionDots(found.target, zoom)[found.side];
    return Math.hypot(point.x - dot.x, point.y - dot.y) <= DOT_CORE / zoom;
  }
  return !hit || isFrame(hit) || hit.id === found.target.id;
}

// A press on a dot starts an arrow unless something else is drawn there (dots sit just outside shapes, where a neighbour may be).
// An arrow pinned to this side runs out through the dot, so only the dot's core (DOT_CORE) counts for it.
export function dotGrab(
  elements: BoardElement[],
  point: XY,
  { zoom, tolerance, ...known }: Lookup & { found?: Connection; hit?: BoardElement | null },
): { target: Connectable; side: Side } | null {
  const found = known.found ?? connectionAt(elements, point, { zoom, tolerance });
  if (!found.side) return null;
  return dotIsFree(elements, point, found, { zoom, tolerance, ...known }) ? found : null;
}

// The dots show while the pointer is over a shape or its dots; a dot a press wouldn't start from isn't shown as hovered.
export function dotHover(
  elements: BoardElement[],
  point: XY,
  { zoom, tolerance, ...known }: Lookup & { found?: Connection; hit?: BoardElement | null },
): { target: Connectable; side: Side | null } | null {
  const found = known.found ?? connectionAt(elements, point, { zoom, tolerance });
  if (!found.target) return null;
  if (!found.side) return found;
  const hit = known.hit === undefined ? hitAt(elements, point, zoom, tolerance) : known.hit;
  if (dotIsFree(elements, point, found, { zoom, tolerance, hit })) return found;
  return hit && canConnectTo(hit) ? { target: hit, side: null } : null;
}

// A handle wins over a dot, except a line's or arrow's end: a pinned end sits inside its dot, so the nearer of the two wins.
export function dotBeatsHandle(
  selected: BoardElement,
  handle: string | null,
  grab: { target: Connectable; side: Side } | null,
  point: XY,
  zoom: number,
): boolean {
  if (!grab) return false;
  if (!handle) return true;
  if (!isConnector(selected) || (handle !== "start" && handle !== "end")) return false;
  const end = handle === "start" ? { x: selected.x1, y: selected.y1 } : { x: selected.x2, y: selected.y2 };
  const dot = connectionDots(grab.target, zoom)[grab.side];
  return Math.hypot(point.x - dot.x, point.y - dot.y) < Math.hypot(point.x - end.x, point.y - end.y);
}

export function attachEnd(
  connector: Connector,
  end: "start" | "end",
  target: Connectable | null,
  side: Side | null = null,
): Connector {
  const [idKey, sideKey]: ["startId", "startAnchor"] | ["endId", "endAnchor"] =
    end === "start" ? ["startId", "startAnchor"] : ["endId", "endAnchor"];
  const next: Connector = { ...connector };
  if (target) next[idKey] = target.id;
  else delete next[idKey];
  if (target && side) next[sideKey] = side;
  else delete next[sideKey];
  return next;
}

function letGoOf(connector: Connector, drawn: Connector, isGone: (id: string) => boolean): Connector {
  let next = connector;
  if (connector.startId && isGone(connector.startId)) {
    next = { ...next, x1: drawn.x1, y1: drawn.y1 };
    delete next.startId;
    delete next.startAnchor;
  }
  if (connector.endId && isGone(connector.endId)) {
    next = { ...next, x2: drawn.x2, y2: drawn.y2 };
    delete next.endId;
    delete next.endAnchor;
  }
  return next;
}

export function releaseFrom(elements: BoardElement[], ids: Set<string>): ConnectorChange[] {
  const resolved = resolveConnectors(elements);
  const changes: ConnectorChange[] = [];
  elements.forEach((element, position) => {
    if (!isAttached(element) || ids.has(element.id)) return;
    const after = letGoOf(element, resolved[position] as Connector, (id) => ids.has(id));
    if (after !== element) changes.push({ before: element, after });
  });
  return changes;
}

// Connectors keep hold of shapes in the group and let go of the rest, staying where they're drawn.
export function readyToMove(elements: BoardElement[], group: BoardElement[]): BoardElement[] {
  const inGroup = new Set(group.map((element) => element.id));
  const drawn = new Map<string, BoardElement>(resolveConnectors(elements).map((element) => [element.id, element]));
  return group.map((element) => {
    if (!isAttached(element)) return element;
    const now = (drawn.get(element.id) ?? element) as Connector;
    return { ...letGoOf(element, now, (id) => !inGroup.has(id)), x1: now.x1, y1: now.y1, x2: now.x2, y2: now.y2 };
  });
}

export const moveGroup = (elements: BoardElement[], group: BoardElement[], dx: number, dy: number): BoardElement[] =>
  readyToMove(elements, group).map((element) => translate(element, dx, dy));

export function copyGroup(
  elements: BoardElement[],
  group: BoardElement[],
  dx: number,
  dy: number,
  { sameLook = false }: { sameLook?: boolean } = {},
): BoardElement[] {
  const ready = readyToMove(elements, group);
  const copies = ready.map((element) =>
    sameLook ? { ...translate(element, dx, dy), id: newId() } : duplicate(element, dx, dy),
  );
  const ids = new Map(ready.map((element, position) => [element.id, copies[position].id]));
  for (const copy of copies as ConnectorFields[]) {
    if (copy.startId) copy.startId = ids.get(copy.startId);
    if (copy.endId) copy.endId = ids.get(copy.endId);
  }
  return copies;
}

// Keyboard connecting: K offers the shapes an arrow could go to, nearest first; Enter draws it like a dragged arrow.

export function connectTargets(elements: BoardElement[], from: BoardElement): Connectable[] {
  const start = middleOf(from);
  const away = (element: BoardElement) => {
    const { x, y } = middleOf(element);
    return Math.hypot(x - start.x, y - start.y);
  };
  return elements
    .filter(
      (element) =>
        element.id !== from.id &&
        canConnectTo(element) &&
        (element.type !== "text" || connectTargetAt(elements, middleOf(element), 0)?.type === "text"),
    )
    .sort((a, b) => away(a) - away(b));
}

export function connectArrow(from: Connectable, to: Connectable, style: ElementStyle): Connector {
  const arrow = attachEnd(
    attachEnd(createElement("arrow", middleOf(from), style) as Connector, "start", from),
    "end",
    to,
  );
  const { x1, y1, x2, y2 } = resolveConnectors([from, to, arrow])[2] as Connector;
  return { ...arrow, x1, y1, x2, y2 };
}
