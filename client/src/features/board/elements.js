import { FILLABLE_TYPES, FONTS, LINE_HEIGHT } from "./constants";
import {
  arrowHeadPoints,
  distanceToSegment,
  expandRect,
  normalizeRect,
  rectCenter,
  rectContains,
  rotatePoint,
  rotatedRectBounds,
  unionRects,
} from "./geometry";

// Elements are plain, immutable, JSON-serialisable objects. Any change makes a
// new object, which lets the renderer cache expensive work per element.
//
//   shapes: { id, type, seed, x1, y1, x2, y2, stroke, fill, strokeWidth, sketchy }
//   pen:    { id, type, points: [[x, y, pressure]], pressure, stroke, penSize }
//   text:   { id, type, x1, y1, text, stroke, fontSize, font }
//   image:  { id, type, imageId, x1, y1, x2, y2 }   (imageId names a file stored on the server)
//
// Rectangles, ellipses, images, pen strokes and text can also carry `angle` (radians):
// they are drawn turned about the centre of their box. Lines and arrows have two
// ends instead, so they are reshaped by moving an end.

const TURNABLE_TYPES = new Set(["rectangle", "ellipse", "image", "pen", "text"]);
export const canRotate = (element) => TURNABLE_TYPES.has(element.type);

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const newSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;

export function createElement(type, { x, y }, style, pressure) {
  const id = newId();
  if (type === "pen") {
    return {
      id,
      type,
      points: [[x, y, pressure ?? 0.5]],
      pressure: pressure !== undefined,
      stroke: style.stroke,
      penSize: style.penSize,
    };
  }
  if (type === "text") {
    return { id, type, x1: x, y1: y, text: "", stroke: style.stroke, fontSize: style.fontSize, font: style.font };
  }
  return {
    id,
    type,
    seed: newSeed(),
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    stroke: style.stroke,
    fill: FILLABLE_TYPES.has(type) ? style.fill : null,
    strokeWidth: style.strokeWidth,
    sketchy: style.sketchy,
  };
}

/** A picture placed with its top left corner at (x, y). */
export function createImage(imageId, { x, y }, { width, height }) {
  return { id: newId(), type: "image", imageId, x1: x, y1: y, x2: x + width, y2: y + height };
}

let measureContext;

export const fontFor = (element, scale = 1) =>
  `${element.fontSize * scale}px ${(FONTS[element.font] ?? FONTS.hand).family}`;

export function measureText(element, text = element.text) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = fontFor(element);
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => measureContext.measureText(line).width), element.fontSize * 0.5);
  return { width, height: lines.length * element.fontSize * LINE_HEIGHT, lines };
}

export const arrowHeadLength = (element) =>
  Math.min(14 + element.strokeWidth * 3, Math.hypot(element.x2 - element.x1, element.y2 - element.y1) * 0.45);

const boundsCache = new WeakMap();
const turnedBoundsCache = new WeakMap();

/** The box around an element before any turning, including its stroke. */
export function getLocalBounds(element) {
  let bounds = boundsCache.get(element);
  if (bounds) return bounds;

  switch (element.type) {
    case "pen": {
      const xs = element.points.map((p) => p[0]);
      const ys = element.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      bounds = expandRect(
        { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
        element.penSize / 2,
      );
      break;
    }
    case "text": {
      const { width, height } = measureText(element);
      bounds = { x: element.x1, y: element.y1, width, height };
      break;
    }
    case "arrow": {
      const heads = arrowHeadPoints(element.x1, element.y1, element.x2, element.y2, arrowHeadLength(element));
      const xs = [element.x1, element.x2, heads[0][0], heads[1][0]];
      const ys = [element.y1, element.y2, heads[0][1], heads[1][1]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      bounds = expandRect({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, element.strokeWidth);
      break;
    }
    case "image":
      bounds = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      break;
    default:
      bounds = expandRect(
        normalizeRect(element.x1, element.y1, element.x2, element.y2),
        element.strokeWidth / 2 + (element.sketchy ? 3 : 0),
      );
  }

  boundsCache.set(element, bounds);
  return bounds;
}

/** The upright rectangle that holds the element as it is drawn, turned or not. */
export function getBounds(element) {
  if (!canRotate(element) || !element.angle) return getLocalBounds(element);
  let bounds = turnedBoundsCache.get(element);
  if (!bounds) {
    bounds = rotatedRectBounds(getLocalBounds(element), element.angle);
    turnedBoundsCache.set(element, bounds);
  }
  return bounds;
}

/**
 * The element's box without its stroke, and the angle it is turned by. Resizing
 * and turning work on this. Not meant for lines and arrows.
 */
export function getFrame(element) {
  let box;
  if (element.type === "pen") {
    const xs = element.points.map((p) => p[0]);
    const ys = element.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    box = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  } else if (element.type === "text") {
    const { width, height } = measureText(element);
    box = { x: element.x1, y: element.y1, width, height };
  } else {
    box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  }
  const center = rectCenter(box);
  return { cx: center.x, cy: center.y, width: box.width, height: box.height, angle: element.angle ?? 0 };
}

export function getSceneBounds(elements) {
  return unionRects(elements.map(getBounds));
}

export function hitTest(element, pointX, pointY, tolerance) {
  let x = pointX;
  let y = pointY;
  if (canRotate(element) && element.angle) {
    // Test in the element's own, unturned space.
    const center = rectCenter(getLocalBounds(element));
    [x, y] = rotatePoint(x, y, center.x, center.y, -element.angle);
  }
  if (!rectContains(expandRect(getLocalBounds(element), tolerance), x, y)) return false;

  switch (element.type) {
    case "line":
      return distanceToSegment(x, y, element.x1, element.y1, element.x2, element.y2) <= tolerance + element.strokeWidth / 2;
    case "arrow": {
      const reach = tolerance + element.strokeWidth / 2;
      if (distanceToSegment(x, y, element.x1, element.y1, element.x2, element.y2) <= reach) return true;
      const heads = arrowHeadPoints(element.x1, element.y1, element.x2, element.y2, arrowHeadLength(element));
      return heads.some(([hx, hy]) => distanceToSegment(x, y, hx, hy, element.x2, element.y2) <= reach);
    }
    case "rectangle": {
      const rect = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      const reach = tolerance + element.strokeWidth / 2;
      if (!rectContains(expandRect(rect, reach), x, y)) return false;
      return Boolean(element.fill) || !rectContains(expandRect(rect, -reach), x, y);
    }
    case "ellipse": {
      const rect = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      const rx = rect.width / 2;
      const ry = rect.height / 2;
      const reach = tolerance + element.strokeWidth / 2;
      if (rx < 1 || ry < 1) return true; // a flat ellipse is just its bounding box
      const d = Math.hypot((x - rect.x - rx) / rx, (y - rect.y - ry) / ry);
      if (element.fill && d <= 1) return true;
      return Math.abs(d - 1) * Math.min(rx, ry) <= reach;
    }
    case "pen": {
      const reach = tolerance + element.penSize / 2;
      const { points } = element;
      if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= reach;
      for (let i = 1; i < points.length; i += 1) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        if (distanceToSegment(x, y, ax, ay, bx, by) <= reach) return true;
      }
      return false;
    }
    case "text":
    case "image":
      return true; // inside its (tolerance-expanded) bounds, checked above
    default:
      return false;
  }
}

export function elementAt(elements, x, y, tolerance) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    if (hitTest(elements[i], x, y, tolerance)) return elements[i];
  }
  return null;
}

export function translate(element, dx, dy) {
  if (element.type === "pen") {
    return { ...element, points: element.points.map(([x, y, p]) => [x + dx, y + dy, p]) };
  }
  if (element.type === "text") {
    return { ...element, x1: element.x1 + dx, y1: element.y1 + dy };
  }
  return { ...element, x1: element.x1 + dx, y1: element.y1 + dy, x2: element.x2 + dx, y2: element.y2 + dy };
}

export function duplicate(element) {
  const copy = { ...translate(element, 16, 16), id: newId() };
  if ("seed" in copy) copy.seed = newSeed();
  return copy;
}

// A click without a drag shouldn't leave an invisible shape behind.
export function isDegenerate(element) {
  if (element.type === "pen") return false;
  if (element.type === "text") return !element.text.trim();
  return Math.hypot(element.x2 - element.x1, element.y2 - element.y1) < 3;
}
