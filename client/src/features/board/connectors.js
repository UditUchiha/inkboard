import { duplicate, getBounds, getFrame, inDrawOrder, newId, translate } from "./elements";
import { expandRect, rectContains, rotatePoint } from "./geometry";
import { setEndDirections } from "./routes";

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

export const CONNECTABLE_TYPES = new Set(["rectangle", "ellipse", "sticky", "image", "text"]);
export const CONNECT_GAP = 6; // between an attached end and its shape's outline

// The connection dots shown around a shape, in screen pixels.
export const DOT_GAP = 14; // between the dots and the shape's outline
export const DOT_REACH = 10; // around a dot that counts as being on it

// Each side's way out of a shape, before it's turned.
export const SIDES = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export const isConnector = (element) => element.type === "line" || element.type === "arrow";
export const canConnectTo = (element) => CONNECTABLE_TYPES.has(element.type);
const isAttached = (element) => isConnector(element) && Boolean(element.startId || element.endId);
const isRouted = (element) => element.route === "curved" || element.route === "elbow";

const middleOf = (element) => {
  const { cx, cy } = getFrame(element);
  return { x: cx, y: cy };
};

/** Where a line from `target`'s middle towards `toward` leaves its outline, plus the gap. */
export function outlinePoint(target, toward) {
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
export function sidePoint(target, side, gap = CONNECT_GAP + (target.strokeWidth ?? 0) / 2) {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [nx, ny] = SIDES[side];
  const [x, y] = rotatePoint(cx + nx * (width / 2 + gap), cy + ny * (height / 2 + gap), cx, cy, angle);
  const [dx, dy] = rotatePoint(nx, ny, 0, 0, angle);
  return { x, y, dx, dy };
}

/** The side of `target` that faces `point`. */
export function facingSide(target, point) {
  const { cx, cy, width, height, angle } = getFrame(target);
  const [x, y] = angle ? rotatePoint(point.x, point.y, cx, cy, -angle) : [point.x, point.y];
  const across = (x - cx) / Math.max(width / 2, 1);
  const down = (y - cy) / Math.max(height / 2, 1);
  if (Math.abs(across) >= Math.abs(down)) return across >= 0 ? "right" : "left";
  return down >= 0 ? "bottom" : "top";
}

/** Where `target`'s connection dots are drawn at `zoom`: { side: { x, y } }. */
export function connectionDots(target, zoom) {
  const gap = DOT_GAP / zoom + (target.strokeWidth ?? 0) / 2;
  return Object.fromEntries(Object.keys(SIDES).map((side) => [side, sidePoint(target, side, gap)]));
}

/** The side whose connection dot is under `point` at `zoom`, if any. */
export function dotAt(target, point, zoom) {
  const reach = DOT_REACH / zoom;
  let nearest = null;
  let best = reach;
  for (const [side, dot] of Object.entries(connectionDots(target, zoom))) {
    const distance = Math.hypot(point.x - dot.x, point.y - dot.y);
    if (distance <= best) {
      nearest = side;
      best = distance;
    }
  }
  return nearest;
}

const unit = (dx, dy) => {
  const length = Math.hypot(dx, dy);
  return length < 1e-9 ? null : { x: dx / length, y: dy / length };
};

// Where an end floating on `target` is drawn, and the way out of it, aiming at `toward`.
function floatingEnd(connector, target, toward) {
  if (isRouted(connector)) return sidePoint(target, facingSide(target, toward));
  const point = outlinePoint(target, toward);
  const middle = middleOf(target);
  const out = unit(point.x - middle.x, point.y - middle.y) ?? { x: 1, y: 0 };
  return { ...point, dx: out.x, dy: out.y };
}

const drawnCopies = new WeakMap(); // connector -> its last drawn copy and its ends' directions: { drawn, directions }

function drawConnector(connector, from, to) {
  if (!from && !to) return connector;
  // Pinned ends first: where floating ends aim depends on them.
  const pinned = (target, side) => (target && SIDES[side] ? sidePoint(target, side) : null);
  const startPin = pinned(from, connector.startAnchor);
  const endPin = pinned(to, connector.endAnchor);
  const aim = (pin, target, x, y) => pin ?? (target ? middleOf(target) : { x, y });
  const start = startPin ?? (from && floatingEnd(connector, from, aim(endPin, to, connector.x2, connector.y2)));
  const end = endPin ?? (to && floatingEnd(connector, to, aim(startPin, from, connector.x1, connector.y1)));
  const [x1, y1] = start ? [start.x, start.y] : [connector.x1, connector.y1];
  const [x2, y2] = end ? [end.x, end.y] : [connector.x2, connector.y2];
  const directions = {
    start: start ? { x: start.dx, y: start.dy } : null,
    end: end ? { x: end.dx, y: end.dy } : null,
  };
  // The same object while nothing moves, so what's drawn from it stays cached.
  const last = drawnCopies.get(connector);
  if (
    last &&
    last.drawn.x1 === x1 &&
    last.drawn.y1 === y1 &&
    last.drawn.x2 === x2 &&
    last.drawn.y2 === y2 &&
    sameDirection(last.directions.start, directions.start) &&
    sameDirection(last.directions.end, directions.end)
  ) {
    return last.drawn;
  }
  const drawn = { ...connector, x1, y1, x2, y2 };
  setEndDirections(drawn, directions);
  drawnCopies.set(connector, { drawn, directions });
  return drawn;
}

const sameDirection = (a, b) => (!a && !b) || Boolean(a && b && a.x === b.x && a.y === b.y);

const resolvedBoards = new WeakMap();

/**
 * `elements` as they're drawn: attached connector ends moved to their shapes.
 * The same array when nothing is attached; otherwise aligned with `elements`.
 */
export function resolveConnectors(elements) {
  let resolved = resolvedBoards.get(elements);
  if (resolved) return resolved;
  if (!elements.some(isAttached)) {
    resolved = elements;
  } else {
    const byId = new Map(elements.map((element) => [element.id, element]));
    const target = (id) => {
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
export const drawnElement = (elements, id) => resolveConnectors(elements).find((element) => element.id === id);

/** Whether `point` is on or inside `target`, give or take `tolerance`. */
function covers(target, point, tolerance) {
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
export function connectTargetAt(elements, point, tolerance, { except } = {}) {
  const ordered = inDrawOrder(resolveConnectors(elements));
  const excluded = except ? ordered.find((element) => element.id === except) : null;
  let text = null;
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
export function connectionAt(elements, point, { zoom, tolerance, except }) {
  const reach = (DOT_GAP + DOT_REACH) / zoom + tolerance;
  const near = connectTargetAt(elements, point, reach, { except });
  const side = near ? dotAt(near, point, zoom) : null;
  if (side) return { target: near, side };
  return { target: connectTargetAt(elements, point, tolerance, { except }), side: null };
}

/**
 * A connector with one end ("start" or "end") attached to `target`, pinned to
 * its `side` if one's given, or let go when `target` is null.
 */
export function attachEnd(connector, end, target, side = null) {
  const [idKey, sideKey] = end === "start" ? ["startId", "startAnchor"] : ["endId", "endAnchor"];
  const next = { ...connector };
  if (target) next[idKey] = target.id;
  else delete next[idKey];
  if (target && side) next[sideKey] = side;
  else delete next[sideKey];
  return next;
}

// A connector let go of its ends attached to shapes `isGone` says are going,
// left where those ends are drawn now.
function letGoOf(connector, drawn, isGone) {
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
export function releaseFrom(elements, ids) {
  const resolved = resolveConnectors(elements);
  const changes = [];
  elements.forEach((element, position) => {
    if (!isAttached(element) || ids.has(element.id)) return;
    const after = letGoOf(element, resolved[position], (id) => ids.has(id));
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
export function readyToMove(elements, group) {
  const inGroup = new Set(group.map((element) => element.id));
  const drawn = new Map(resolveConnectors(elements).map((element) => [element.id, element]));
  return group.map((element) => {
    if (!isAttached(element)) return element;
    const now = drawn.get(element.id) ?? element;
    return { ...letGoOf(element, now, (id) => !inGroup.has(id)), x1: now.x1, y1: now.y1, x2: now.x2, y2: now.y2 };
  });
}

/** `group` moved by (dx, dy): connectors attached outside it let go (see readyToMove). */
export const moveGroup = (elements, group, dx, dy) =>
  readyToMove(elements, group).map((element) => translate(element, dx, dy));

/**
 * Copies of `group` (elements of `elements`), (dx, dy) along, with new ids.
 * Connectors attached within the group are attached to the copies; the rest
 * let go. Hand-drawn shapes get a new wobble unless `sameLook` is set.
 */
export function copyGroup(elements, group, dx, dy, { sameLook = false } = {}) {
  const ready = readyToMove(elements, group);
  const copies = ready.map((element) =>
    sameLook ? { ...translate(element, dx, dy), id: newId() } : duplicate(element, dx, dy),
  );
  const ids = new Map(ready.map((element, position) => [element.id, copies[position].id]));
  for (const copy of copies) {
    if (copy.startId) copy.startId = ids.get(copy.startId);
    if (copy.endId) copy.endId = ids.get(copy.endId);
  }
  return copies;
}
