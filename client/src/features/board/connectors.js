import { duplicate, getFrame, inDrawOrder, newId, translate } from "./elements";
import { rotatePoint } from "./geometry";

// Lines and arrows can be connected to shapes: `startId` and `endId` name the
// element each end is attached to. An attached end isn't kept where it's drawn:
// it's worked out from where its shape is now, aiming at the shape's middle and
// stopping just short of its outline. So when a shape moves, resizes or turns,
// here or on anyone else's screen, its connectors follow without any change to
// them, and two people's edits can't pull an arrow off its shape. The stored
// x/y of an attached end is only a fallback, used if the shape is gone.

export const CONNECTABLE_TYPES = new Set(["rectangle", "ellipse", "sticky", "image", "text"]);
export const CONNECT_GAP = 6; // between an attached end and its shape's outline

export const isConnector = (element) => element.type === "line" || element.type === "arrow";
export const canConnectTo = (element) => CONNECTABLE_TYPES.has(element.type);
const isAttached = (element) => isConnector(element) && Boolean(element.startId || element.endId);

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

const drawnCopies = new WeakMap(); // connector -> its last drawn copy

function drawConnector(connector, from, to) {
  if (!from && !to) return connector;
  const start = from
    ? outlinePoint(from, to ? middleOf(to) : { x: connector.x2, y: connector.y2 })
    : { x: connector.x1, y: connector.y1 };
  const end = to
    ? outlinePoint(to, from ? middleOf(from) : { x: connector.x1, y: connector.y1 })
    : { x: connector.x2, y: connector.y2 };
  // The same object while nothing moves, so what's drawn from it stays cached.
  const last = drawnCopies.get(connector);
  if (last && last.x1 === start.x && last.y1 === start.y && last.x2 === end.x && last.y2 === end.y) return last;
  const drawn = { ...connector, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
  drawnCopies.set(connector, drawn);
  return drawn;
}

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

/** A connector with one end ("start" or "end") attached to `target`, or let go when it's null. */
export function attachEnd(connector, end, target) {
  const key = end === "start" ? "startId" : "endId";
  const next = { ...connector };
  if (target) next[key] = target.id;
  else delete next[key];
  return next;
}

// A connector let go of its ends attached to shapes `isGone` says are going,
// left where those ends are drawn now.
function letGoOf(connector, drawn, isGone) {
  let next = connector;
  if (connector.startId && isGone(connector.startId)) {
    next = { ...next, x1: drawn.x1, y1: drawn.y1 };
    delete next.startId;
  }
  if (connector.endId && isGone(connector.endId)) {
    next = { ...next, x2: drawn.x2, y2: drawn.y2 };
    delete next.endId;
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
