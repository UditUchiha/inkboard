import { MAX_ZOOM, MIN_ZOOM } from "./constants";

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
