import type { ConnectorFields, Element as BoardElement, Side } from "@inkboard/shared/types";
import { duplicate, elementAt, getBounds, getFrame, inDrawOrder, isFrame, newId, translate } from "./elements";
import type { AnyElement, Connector } from "./elements";
import { expandRect, rectContains, rotatePoint } from "./geometry";
import type { Pair, Rect, TurnedRect, XY } from "./geometry";
import { setEndDirections } from "./routes";

/** An element a connector end can be attached to, and so one whose outline is worked out. */
export type Connectable = AnyElement;

/** A point on the side of a shape, and the unit vector that points out of the shape there. */
export type SidePoint = XY & { dx: number; dy: number };

/**
 * What a connector end at a point would attach to: a shape and, if the point is on one of its dots, that
 * side of it. Not on a dot, it is the shape there (floating), or nothing.
 */
export type Connection =
  { target: Connectable; side: Side } | { target: Connectable; side: null } | { target: null; side: null };

/** A connector, and what it looked like before and after being let go of the shapes that are going. */
export type ConnectorChange = { before: Connector; after: Connector };

// The box of a shape a connector is drawn round, with the shape's frame (what draws it turned).
type DrawnBox = Rect & { turned: TurnedRect };

// Lines and arrows can be connected to shapes: `startId` and `endId` name the
// element each end is attached to. An attached end isn't kept where it's drawn:
// it's worked out from where its shape is now. So when a shape moves, resizes
// or turns, here or on anyone else's screen, its connectors follow without any
// change to them, and two people's edits can't pull an arrow off its shape.
// The stored x/y of an attached end is only a fallback, used if the shape is gone.
//
// An end dropped on one of the dots around a shape is pinned to that side
// (`startAnchor` / `endAnchor`: "top", "right", "bottom" or "left") and is
// drawn at the side's middle. One dropped on the shape itself floats: a
// straight connector aims at the shape's middle and stops just short of its
// outline; a curved or elbow one leaves from the middle of the side facing the
// other end (see routes.js for the paths themselves).

export const CONNECTABLE_TYPES = new Set<BoardElement["type"]>(["rectangle", "ellipse", "sticky", "image", "text"]);
export const CONNECT_GAP = 6; // between an attached end and its shape's outline

// The connection dots shown around a shape, in screen pixels.
export const DOT_GAP = 14; // between the dots and the shape's outline
export const DOT_REACH = 10; // around a dot that counts as being on it
export const DOT_CORE = 5; // around a dot's middle (about the dot drawn) that wins over an arrow running through it

// Each side's way out of a shape, before it's turned.
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

/** Where a line from `target`'s middle towards `toward` leaves its outline, plus the gap. */
export function outlinePoint(target: Connectable, toward: XY): XY {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [tx, ty] = angle ? rotatePoint(toward.x, toward.y, cx, cy, -angle) : [toward.x, toward.y];
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.hypot(dx, dy) < 1e-9) return { x: cx, y: cy };
  const pad = CONNECT_GAP + (target.strokeWidth ?? 0) / 2;
  const rx = width / 2 + pad;
  const ry = height / 2 + pad;
  const reach =
    target.type === "ellipse"
      ? 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry))
      : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
  const [x, y] = rotatePoint(cx + dx * reach, cy + dy * reach, cx, cy, angle);
  return { x, y };
}

/**
 * The middle of `side` of `target`, `gap` out from its outline, and the way
 * out of that side: { x, y, dx, dy }. The gap defaults to an attached end's.
 */
export function sidePoint(
  target: Connectable,
  side: Side,
  gap = CONNECT_GAP + (target.strokeWidth ?? 0) / 2,
): SidePoint {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [nx, ny] = SIDES[side];
  const [x, y] = rotatePoint(cx + nx * (width / 2 + gap), cy + ny * (height / 2 + gap), cx, cy, angle);
  const [dx, dy] = rotatePoint(nx, ny, 0, 0, angle);
  return { x, y, dx, dy };
}

/** The side of `target` that faces `point`. */
export function facingSide(target: BoardElement, point: XY): Side {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [x, y] = angle ? rotatePoint(point.x, point.y, cx, cy, -angle) : [point.x, point.y];
  const across = (x - cx) / Math.max(width / 2, 1);
  const down = (y - cy) / Math.max(height / 2, 1);
  if (Math.abs(across) >= Math.abs(down)) return across >= 0 ? "right" : "left";
  return down >= 0 ? "bottom" : "top";
}

/** Where `target`'s connection dots are drawn at `zoom`: { side: { x, y } }. */
export function connectionDots(target: Connectable, zoom: number): Record<Side, SidePoint> {
  const gap = DOT_GAP / zoom + (target.strokeWidth ?? 0) / 2;
  // The casts: Object.keys and Object.fromEntries only know strings, and the keys of SIDES are its sides.
  return Object.fromEntries(
    (Object.keys(SIDES) as Side[]).map((side): [Side, SidePoint] => [side, sidePoint(target, side, gap)]),
  ) as Record<Side, SidePoint>;
}

/** The side whose connection dot is under `point` at `zoom`, if any. */
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

// Where an end floating on `target` is drawn, and the way out of it, aiming at `toward`.
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
  // The non-null assertions: an end with no anchor, or one that is no side, finds nothing in SIDES, and then has no pin.
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
  // The shapes' boxes, which an elbow goes round, and for a turned shape the shape itself (see routes.js).
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

/** Forget where connector ends were drawn, once web fonts have loaded and the text they're attached to measures differently. */
export function forgetResolvedConnectors() {
  drawnCopies = new WeakMap();
  resolvedBoards = new WeakMap();
}

/**
 * `elements` as they're drawn: attached connector ends moved to their shapes.
 * The same array when nothing is attached; otherwise aligned with `elements`.
 */
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

/** The element with `id` as it's drawn. */
export const drawnElement = (elements: BoardElement[], id: string): BoardElement | undefined =>
  resolveConnectors(elements).find((element) => element.id === id);

/** Whether `point` is on or inside `target`, give or take `tolerance`. */
function covers(target: Connectable, point: XY, tolerance: number): boolean {
  // Most elements are nowhere near: their (cached) bounds rule them out without measuring anything.
  if (!rectContains(expandRect(getBounds(target), tolerance), point.x, point.y)) return false;
  const { cx, cy, width, height, angle } = getFrame(target);
  const [x, y] = angle ? rotatePoint(point.x, point.y, cx, cy, -angle) : [point.x, point.y];
  const rx = width / 2 + tolerance;
  const ry = height / 2 + tolerance;
  if (target.type === "ellipse") return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  return Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry;
}

/**
 * The topmost shape a connector end at `point` would attach to, other than
 * `except` (the other end's). Shapes come before text: a label sitting on a
 * shape is part of it, so text is only attached to when there's no shape
 * there, and never when it sits on `except`.
 */
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

/**
 * What a connector end at `point` would attach to, at `zoom` with `tolerance`
 * (board units) to spare: `{ target, side }`. On one of a shape's dots, which
 * sit just outside it, that shape and side; otherwise the shape there (see
 * connectTargetAt), floating; or nothing.
 */
export function connectionAt(
  elements: BoardElement[],
  point: XY,
  { zoom, tolerance, except }: { zoom: number; tolerance: number; except?: string },
): Connection {
  const reach = (DOT_GAP + DOT_REACH) / zoom + tolerance;
  const near = connectTargetAt(elements, point, reach, { except });
  const side = near ? dotAt(near, point, zoom) : null;
  // The non-null assertion: there is a side only if there was a shape for it to be on.
  if (side) return { target: near!, side };
  return { target: connectTargetAt(elements, point, tolerance, { except }), side: null };
}

// What is picked at `point`: the element there, frame names included (they're sized on screen).
const hitAt = (elements: BoardElement[], point: XY, zoom: number, tolerance: number): BoardElement | null =>
  elementAt(elements, point.x, point.y, tolerance, { labelScale: 1 / zoom });

// How far a point is looked at, and what is already known about it (see dotGrab).
type Lookup = { zoom: number; tolerance: number };

// Whether a press at `point` on `found`'s dot goes to the dot, not to something else drawn there (see dotGrab).
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

/**
 * The shape and side ({ target, side }) a press at `point` would start an arrow from, or null. That's
 * connectionAt's dot, unless something else is drawn there: the dots sit just outside a shape, where a
 * neighbour may be, and that is picked instead (a caption just above a box stays selectable). A frame
 * the point is merely inside doesn't count: shapes in frames keep their dots. A line or arrow does only
 * off the dot's core (DOT_CORE): one pinned to a side runs out through that side's dot, and another arrow
 * must still be drawable from the dot itself, but a press on the arrow beside it selects the arrow.
 * A caller that has already looked up `found` (connectionAt) and `hit` (what's picked at `point`, with the
 * same `zoom` and `tolerance`; null for nothing) at this point can pass them, to not scan the board again.
 */
export function dotGrab(
  elements: BoardElement[],
  point: XY,
  { zoom, tolerance, ...known }: Lookup & { found?: Connection; hit?: BoardElement | null },
): { target: Connectable; side: Side } | null {
  const found = known.found ?? connectionAt(elements, point, { zoom, tolerance });
  if (!found.side) return null;
  return dotIsFree(elements, point, found, { zoom, tolerance, ...known }) ? found : null;
}

/**
 * The shape whose connection dots to show with the select tool's pointer at `point`, and the dot it's on:
 * { target, side } (side null off the dots), or null. The dots show while the pointer is over a shape or
 * out on its dots, so they can be seen before they're pressed. A dot a press wouldn't start an arrow from
 * (see dotGrab) isn't shown as the one under the pointer: whatever is picked there is shown instead.
 * `found` and `hit` can be passed as for dotGrab.
 */
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

/**
 * Whether a select-tool press at `point` goes to a connection dot (`grab`, from dotGrab) rather than to
 * `handle`, the handle of the `selected` element (as drawn) there, at `zoom`. A handle wins, except for a
 * line's or arrow's end: one pinned to a side sits just inside that side's dot, close enough for the two to
 * overlap, so the nearer of them does. Another arrow can then be drawn from the dot, and the end still dragged.
 */
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

/**
 * A connector with one end ("start" or "end") attached to `target`, pinned to
 * its `side` if one's given, or let go when `target` is null.
 */
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

// A connector let go of its ends attached to shapes `isGone` says are going,
// left where those ends are drawn now.
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

/**
 * Connectors on the board attached to elements being removed (`ids`), let go
 * where they're drawn, so they don't jump when their shape goes: [{ before, after }].
 */
export function releaseFrom(elements: BoardElement[], ids: Set<string>): ConnectorChange[] {
  const resolved = resolveConnectors(elements);
  const changes: ConnectorChange[] = [];
  elements.forEach((element, position) => {
    if (!isAttached(element) || ids.has(element.id)) return;
    // The cast: a connector is drawn as a connector.
    const after = letGoOf(element, resolved[position] as Connector, (id) => ids.has(id));
    if (after !== element) changes.push({ before: element, after });
  });
  return changes;
}

/**
 * `group` (elements on the board) ready to be moved or copied together: its
 * connectors keep hold of shapes in the group and let go of the rest, staying
 * where they're drawn. Ends kept attached are brought up to where they're
 * drawn too, so the fallback stays close.
 */
export function readyToMove(elements: BoardElement[], group: BoardElement[]): BoardElement[] {
  const inGroup = new Set(group.map((element) => element.id));
  const drawn = new Map<string, BoardElement>(resolveConnectors(elements).map((element) => [element.id, element]));
  return group.map((element) => {
    if (!isAttached(element)) return element;
    // The cast: a connector is drawn as a connector.
    const now = (drawn.get(element.id) ?? element) as Connector;
    return { ...letGoOf(element, now, (id) => !inGroup.has(id)), x1: now.x1, y1: now.y1, x2: now.x2, y2: now.y2 };
  });
}

/** `group` moved by (dx, dy): connectors attached outside it let go (see readyToMove). */
export const moveGroup = (elements: BoardElement[], group: BoardElement[], dx: number, dy: number): BoardElement[] =>
  readyToMove(elements, group).map((element) => translate(element, dx, dy));

/**
 * Copies of `group` (elements of `elements`), (dx, dy) along, with new ids.
 * Connectors attached within the group are attached to the copies; the rest
 * let go. Hand-drawn shapes get a new wobble unless `sameLook` is set.
 */
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
  // The cast: only a connector has these fields, and what has none is left as it is.
  for (const copy of copies as ConnectorFields[]) {
    if (copy.startId) copy.startId = ids.get(copy.startId);
    if (copy.endId) copy.endId = ids.get(copy.endId);
  }
  return copies;
}
