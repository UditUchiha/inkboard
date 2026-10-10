import { MAX_ZOOM, MIN_ZOOM } from "./constants";

// NaN (a ratio of two zeros, say) clamps to `min` rather than carrying on as NaN.
export const clamp = (value, min, max) => (Number.isNaN(value) ? min : Math.min(max, Math.max(min, value)));

export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export const rectContains = (rect, x, y) =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

export const rectsOverlap = (a, b) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Turns a point about (cx, cy) by `angle` radians. */
export function rotatePoint(x, y, cx, cy, angle) {
  if (!angle) return [x, y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

export const rectCenter = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/** The smallest upright rectangle that holds `rect` after it is turned about its centre. */
export function rotatedRectBounds(rect, angle) {
  if (!angle) return rect;
  const center = rectCenter(rect);
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ].map(([x, y]) => rotatePoint(x, y, center.x, center.y, angle));
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionRects(rects) {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const hundredths = (value) => Math.round(value * 100) / 100;

/**
 * A stroke's `points` with `added` ([x, y, pressure]) after them. Points are kept to two decimals,
 * far finer than a screen shows, and one where the one before already is is left out. The same
 * array when nothing is added.
 */
export function appendPoints(points, added) {
  let next = points;
  let last = points.at(-1);
  for (const [x, y, pressure] of added) {
    const point = [hundredths(x), hundredths(y), hundredths(pressure)];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    if (next === points) next = [...points];
    next.push(point);
    last = point;
  }
  return next;
}

// The two barbs of an arrow pointing from (x1, y1) to (x2, y2).
export function arrowHeadPoints(x1, y1, x2, y2, length) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - length * Math.cos(angle - spread), y2 - length * Math.sin(angle - spread)],
    [x2 - length * Math.cos(angle + spread), y2 - length * Math.sin(angle + spread)],
  ];
}

// Shift-drag: squares and circles for boxes, 15° steps for lines.
export function constrainEnd(type, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (type !== "line" && type !== "arrow") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x2: x1 + side * Math.sign(dx || 1), y2: y1 + side * Math.sign(dy || 1) };
  }
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = Math.hypot(dx, dy);
  return { x2: x1 + Math.cos(angle) * length, y2: y1 + Math.sin(angle) * length };
}

// Viewport: screen = (world + offset) * zoom.
export const toWorld = (viewport, sx, sy) => ({
  x: sx / viewport.zoom - viewport.x,
  y: sy / viewport.zoom - viewport.y,
});

export const toScreen = (viewport, wx, wy) => ({
  x: (wx + viewport.x) * viewport.zoom,
  y: (wy + viewport.y) * viewport.zoom,
});

export function zoomAround(viewport, nextZoom, sx, sy) {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const anchor = toWorld(viewport, sx, sy);
  return { zoom, x: sx / zoom - anchor.x, y: sy / zoom - anchor.y };
}

// Two fingers that start closer than this are treated as this far apart, so there's a distance to scale by.
const MIN_PINCH_DISTANCE = 10;

/** The viewport for a pinch that began at `startMid` (screen) with the fingers `startDistance` apart, now at `a` and `b`. */
export function pinchViewport(start, startMid, startDistance, a, b) {
  const zoom = clamp(
    (start.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(startDistance, MIN_PINCH_DISTANCE),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const anchor = toWorld(start, startMid.x, startMid.y);
  return { zoom, x: (a.x + b.x) / 2 / zoom - anchor.x, y: (a.y + b.y) / 2 / zoom - anchor.y };
}

// How far (screen pixels) a pointer must travel before a press becomes a drag, so a click with a
// shaky hand or a pen tap doesn't move, draw or change anything.
export const DRAG_THRESHOLD = 4;

/** Whether a pointer pressed at screen point `from` and now at `to` has gone far enough to count as dragging. */
export const hasDragged = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;

// A finger held this long without a single pointermove (a real one always jitters a little) has been lifted
// without its pointerup or pointercancel reaching the canvas.
export const TOUCH_IDLE_MS = 8000;

/**
 * The pointers among those held on the canvas (`held`: a Map of pointerId -> { type, at }, `at` the time of
 * its last event) that a press of `pointerId`, a `type` pointer ("mouse", "pen" or "touch"), shows were let
 * go of unseen, their pointerup missed (capture lost to a context menu, say, or a switch of window
 * mid-press): one with the same id, for a mouse or pen press any mouse or pen, for a mouse press any finger
 * (a mouse can't be used while one is down, and a finger that never lifted would block it for good), and,
 * given the time `now` of the press, a finger idle for TOUCH_IDLE_MS when another finger lands (or it would
 * be taken for the first half of a pinch). A pen is left to find fingers down: a resting palm is expected.
 */
export function stalePointers(held, pointerId, type, now) {
  const stale = [];
  for (const [id, pointer] of held) {
    const touch = pointer.type === "touch";
    if (
      id === pointerId ||
      (type !== "touch" && !touch) ||
      (type === "mouse" && touch) ||
      (type === "touch" && touch && now !== undefined && pointer.at !== undefined && now - pointer.at > TOUCH_IDLE_MS)
    )
      stale.push(id);
  }
  return stale;
}

/**
 * What a press of a `type` pointer does, with `held` (the other pointers down on the canvas, each { type })
 * already there: "start" a gesture of its own; "pinch" (a second finger); "take over" (a pen landing beside a
 * resting palm: whatever the fingers began is put back and the pen draws); or "ignore" (a palm beside a pen,
 * a mouse click while touching, a third finger).
 */
export function pressRole(held, type) {
  if (held.length === 0) return "start";
  if (type === "pen" && held.every((pointer) => pointer.type === "touch")) return "take over";
  if (type === "touch" && held.length === 1 && held[0].type === "touch") return "pinch";
  return "ignore";
}

export function fitViewport(bounds, size, { padding = 48, maxZoom = 1 } = {}) {
  const zoom = clamp(
    Math.min(
      (size.width - padding * 2) / Math.max(bounds.width, 1),
      (size.height - padding * 2) / Math.max(bounds.height, 1),
    ),
    MIN_ZOOM,
    maxZoom,
  );
  return {
    zoom,
    x: size.width / 2 / zoom - (bounds.x + bounds.width / 2),
    y: size.height / 2 / zoom - (bounds.y + bounds.height / 2),
  };
}
