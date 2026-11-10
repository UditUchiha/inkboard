import type { Point } from "@inkboard/shared/types";
import { MAX_ZOOM, MIN_ZOOM } from "../../constants/board";

export type Rect = { x: number; y: number; width: number; height: number };

export type XY = { x: number; y: number };

export type Pair = [x: number, y: number];

export type Size = { width: number; height: number };

export type TurnedRect = { cx: number; cy: number; width: number; height: number; angle: number };

export type Viewport = { x: number; y: number; zoom: number };

// NaN (a ratio of two zeros, say) clamps to `min` rather than carrying on as NaN.
export const clamp = (value: number, min: number, max: number) =>
  Number.isNaN(value) ? min : Math.min(max, Math.max(min, value));

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export const rectContains = (rect: Rect, x: number, y: number) =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

export const rectsOverlap = (a: Rect, b: Rect) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

export function rotatePoint(x: number, y: number, cx: number, cy: number, angle: number): Pair {
  if (!angle) return [x, y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

export const rectCenter = (rect: Rect): XY => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

export function rotatedRectBounds(rect: Rect, angle: number): Rect {
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

// Each corner is a share of the half size out from the box's middle; the triangle points up.
const POLYGONS: Record<string, Pair[]> = {
  triangle: [
    [0, -1],
    [1, 1],
    [-1, 1],
  ],
  diamond: [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ],
};

export function polygonCorners(kind: string, rect: Rect): Pair[] | null {
  const unit = Object.hasOwn(POLYGONS, kind) ? POLYGONS[kind] : null;
  if (!unit) return null;
  const [rx, ry] = [rect.width / 2, rect.height / 2];
  return unit.map(([x, y]): Pair => [rect.x + rx + x * rx, rect.y + ry + y * ry]);
}

// How many times (dx, dy) it is from (x, y) to the outline: 1 on it, more inside, Infinity no way at all.
export function reachOfOutline(x: number, y: number, dx: number, dy: number, corners: Pair[]): number {
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  let reach = Infinity;
  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % corners.length];
    const [ex, ey] = [bx - ax, by - ay];
    const across = cross(dx, dy, ex, ey);
    if (!across) return;
    const t = cross(ax - x, ay - y, ex, ey) / across;
    const s = cross(ax - x, ay - y, dx, dy) / across;
    if (t > 0 && s >= 0 && s <= 1) reach = Math.min(reach, t);
  });
  return reach;
}

export function unionRects(rects: Rect[]): Rect | null {
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

const hundredths = (value: number) => Math.round(value * 100) / 100;

// Points keep two decimals and one equal to the one before is dropped; the same array when nothing is added.
export function appendPoints(points: Point[], added: readonly Point[]): Point[] {
  let next = points;
  let last = points.at(-1);
  for (const [x, y, pressure] of added) {
    const point: Point = [hundredths(x), hundredths(y), hundredths(pressure)];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    if (next === points) next = [...points];
    next.push(point);
    last = point;
  }
  return next;
}

export function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, length: number): [Pair, Pair] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - length * Math.cos(angle - spread), y2 - length * Math.sin(angle - spread)],
    [x2 - length * Math.cos(angle + spread), y2 - length * Math.sin(angle + spread)],
  ];
}

// Shift-drag: squares and circles for boxes, 15° steps for lines.
export function constrainEnd(type: string, x1: number, y1: number, x2: number, y2: number): { x2: number; y2: number } {
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
export const toWorld = (viewport: Viewport, sx: number, sy: number): XY => ({
  x: sx / viewport.zoom - viewport.x,
  y: sy / viewport.zoom - viewport.y,
});

export const toScreen = (viewport: Viewport, wx: number, wy: number): XY => ({
  x: (wx + viewport.x) * viewport.zoom,
  y: (wy + viewport.y) * viewport.zoom,
});

export function zoomAround(viewport: Viewport, nextZoom: number, sx: number, sy: number): Viewport {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const anchor = toWorld(viewport, sx, sy);
  return { zoom, x: sx / zoom - anchor.x, y: sy / zoom - anchor.y };
}

// Two fingers that start closer than this are treated as this far apart, so there's a distance to scale by.
const MIN_PINCH_DISTANCE = 10;

export function pinchViewport(start: Viewport, startMid: XY, startDistance: number, a: XY, b: XY): Viewport {
  const zoom = clamp(
    (start.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(startDistance, MIN_PINCH_DISTANCE),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const anchor = toWorld(start, startMid.x, startMid.y);
  return { zoom, x: (a.x + b.x) / 2 / zoom - anchor.x, y: (a.y + b.y) / 2 / zoom - anchor.y };
}

// Pixels a pointer must travel before a press becomes a drag, so a shaky click doesn't move or draw anything.
export const DRAG_THRESHOLD = 4;

export const hasDragged = (from: XY, to: XY) => Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;

// A finger held this long without a single pointermove (a real one always jitters a little) has been lifted
// without its pointerup or pointercancel reaching the canvas.
export const TOUCH_IDLE_MS = 8000;

export type HeldPointer = { type: string; at?: number };

// A press shows which held pointers were released unseen (pointerup missed): same id; a mouse press frees any finger
// (a stuck one would block it); a finger idle for TOUCH_IDLE_MS is freed when another lands (else it reads as a pinch).
export function stalePointers(held: Map<number, HeldPointer>, pointerId: number, type: string, now?: number): number[] {
  const stale: number[] = [];
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

export type PressRole = "start" | "pinch" | "take over" | "ignore";

// "take over" is a pen landing beside a resting palm; "ignore" a palm beside a pen, a mouse click while touching, or a
// third finger.
export function pressRole(held: { type: string }[], type: string): PressRole {
  if (held.length === 0) return "start";
  if (type === "pen" && held.every((pointer) => pointer.type === "touch")) return "take over";
  if (type === "touch" && held.length === 1 && held[0].type === "touch") return "pinch";
  return "ignore";
}

export function fitViewport(
  bounds: Rect,
  size: Size,
  { padding = 48, maxZoom = 1 }: { padding?: number; maxZoom?: number } = {},
): Viewport {
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
