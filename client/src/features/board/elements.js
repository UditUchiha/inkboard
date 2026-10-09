import { keyToMove } from "@inkboard/shared/board-order";
import { resolveConnectors } from "./connectors";
import { FILLABLE_TYPES, FONTS, FRAME_LABEL_GAP, FRAME_LABEL_SIZE, LINE_HEIGHT, NOTE_SIZE } from "./constants";
import {
  arrowHeadPoints,
  distanceToSegment,
  expandRect,
  normalizeRect,
  rectCenter,
  rectContains,
  rectsOverlap,
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
//   sticky: { id, type, x1, y1, x2, y2, text, fill, font }   (a sticky note, see notes.js)
//   frame:  { id, type, x1, y1, x2, y2, name }
//
// A frame holds whatever lies wholly inside it: moving, copying or deleting a
// frame does the same to its contents. Nothing records what's in a frame, so a
// change made elsewhere can't leave a frame and its contents disagreeing. Frames
// are drawn beneath everything else.
//
// Rectangles, ellipses, images, pen strokes, text and sticky notes can also carry `angle` (radians):
// they are drawn turned about the centre of their box. Lines and arrows have two
// ends instead, so they are reshaped by moving an end.

const TURNABLE_TYPES = new Set(["rectangle", "ellipse", "image", "pen", "text", "sticky"]);
export const canRotate = (element) => TURNABLE_TYPES.has(element.type);
export const isFrame = (element) => element.type === "frame";

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
  if (type === "frame") return { id, type, x1: x, y1: y, x2: x, y2: y, name: "" };
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

/** A sticky note centred on (x, y). */
export function createNote({ x, y }, style) {
  const half = NOTE_SIZE / 2;
  return {
    id: newId(),
    type: "sticky",
    x1: x - half,
    y1: y - half,
    x2: x + half,
    y2: y + half,
    text: "",
    fill: style.noteFill,
    font: style.font,
  };
}

/** "Frame 1", "Frame 2", …: the first such name no frame on the board has. */
export function nextFrameName(elements) {
  const frames = elements.filter(isFrame);
  const taken = new Set(frames.map((frame) => frame.name));
  let number = frames.length + 1;
  while (taken.has(`Frame ${number}`)) number += 1;
  return `Frame ${number}`;
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

let labels = new WeakMap(); // frame -> { scale, label }, see frameLabel

/**
 * A frame's name as drawn above its top left corner, cut short to the frame's
 * width: { text, font, x, bottom, width, height }. `scale` is board units per
 * pixel of label: 1 / zoom in the editor, so names stay readable at any zoom.
 *
 * Shortening a name takes a measurement per letter, and the editor asks on
 * every frame drawn and every mouse move, so each frame keeps its last label.
 */
export function frameLabel(frame, scale = 1) {
  const known = labels.get(frame);
  if (known?.scale === scale) return known.label;
  const label = measureFrameLabel(frame, scale);
  labels.set(frame, { scale, label });
  return label;
}

/** Forget measured frame names, once web fonts have loaded and text measures differently. */
export function forgetFrameLabels() {
  labels = new WeakMap();
}

/** Where a frame's label (see frameLabel) covers: { x, y, width, height }. */
export const frameLabelBox = (label) => ({
  x: label.x,
  y: label.bottom - label.height,
  width: label.width,
  height: label.height,
});

function measureFrameLabel(frame, scale) {
  const body = normalizeRect(frame.x1, frame.y1, frame.x2, frame.y2);
  const font = `500 ${FRAME_LABEL_SIZE * scale}px ${FONTS.sans.family}`;
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = font;
  const widthOf = (text) => measureContext.measureText(text).width;
  let text = frame.name || "Frame";
  if (widthOf(text) > body.width) {
    while (text.length > 1 && widthOf(`${text}…`) > body.width) text = text.slice(0, -1);
    text = `${text}…`;
  }
  return {
    text,
    font,
    x: body.x,
    bottom: body.y - FRAME_LABEL_GAP * scale,
    width: widthOf(text),
    height: FRAME_LABEL_SIZE * scale * LINE_HEIGHT,
  };
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
      bounds = expandRect({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, element.penSize / 2);
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
    case "sticky":
      bounds = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      break;
    case "frame": {
      // Room above for the name, at the size exports and thumbnails draw it.
      const body = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      const label = FRAME_LABEL_SIZE * LINE_HEIGHT + FRAME_LABEL_GAP;
      bounds = { x: body.x, y: body.y - label, width: body.width, height: body.height + label };
      break;
    }
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
  return unionRects(resolveConnectors(elements).map(getBounds));
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
      return (
        distanceToSegment(x, y, element.x1, element.y1, element.x2, element.y2) <= tolerance + element.strokeWidth / 2
      );
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
    case "sticky":
      return true; // inside its (tolerance-expanded) bounds, checked above
    case "frame": {
      // Its border. Inside a frame is picked by elementAt only when nothing else
      // is there, and isn't erased.
      const body = normalizeRect(element.x1, element.y1, element.x2, element.y2);
      return rectContains(expandRect(body, tolerance), x, y) && !rectContains(expandRect(body, -tolerance), x, y);
    }
    default:
      return false;
  }
}

const drawOrders = new WeakMap();

/** `elements` (in stack order) in the order they're drawn: frames first, beneath everything else. */
export function inDrawOrder(elements) {
  let ordered = drawOrders.get(elements);
  if (!ordered) {
    const frames = elements.filter(isFrame);
    ordered = frames.length === 0 ? elements : [...frames, ...elements.filter((element) => !isFrame(element))];
    drawOrders.set(elements, ordered);
  }
  return ordered;
}

/**
 * The element under a point, as it's drawn (see connectors.js): a frame's
 * name, then whatever is drawn on top, then the innermost frame the point is
 * inside. Pass `labelScale` (see frameLabel) to find frames by their names.
 */
export function elementAt(board, x, y, tolerance, { labelScale } = {}) {
  const elements = resolveConnectors(board);
  const frames = elements.filter(isFrame);
  if (labelScale) {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (rectContains(expandRect(frameLabelBox(frameLabel(frames[i], labelScale)), tolerance), x, y)) return frames[i];
    }
  }
  const ordered = inDrawOrder(elements);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (hitTest(ordered[i], x, y, tolerance)) return ordered[i];
  }
  let innermost = null;
  let smallest = Infinity;
  for (const frame of frames) {
    const body = normalizeRect(frame.x1, frame.y1, frame.x2, frame.y2);
    const area = body.width * body.height;
    if (area < smallest && rectContains(body, x, y)) {
      innermost = frame;
      smallest = area;
    }
  }
  return innermost;
}

// The box an element must lie within to be inside a frame (a frame's own name doesn't count).
const footprint = (element) =>
  isFrame(element) ? normalizeRect(element.x1, element.y1, element.x2, element.y2) : getBounds(element);

const encloses = (outer, inner) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/**
 * The elements inside `frame`, in stack order. They move, copy and delete with it.
 *
 * Each element belongs to one frame: the smallest wholly around it, or of two
 * the same size (overlapping copies, say), the one it sits nearer the middle
 * of. Frames inside it belong to it too, with their contents. A frame can only
 * be inside a bigger frame, or an equal one higher in the stack, so no two
 * frames are ever inside each other.
 */
export function frameContents(elements, frame) {
  const frames = elements.filter(isFrame);
  if (frames.length === 0) return [];
  const bodies = new Map(frames.map((each, position) => [each.id, { box: footprint(each), position }]));
  // Where connectors are drawn decides which frame they're in.
  const drawn = new Map(resolveConnectors(elements).map((element) => [element.id, element]));
  const area = (box) => box.width * box.height;
  const centre = (box) => rectCenter(box);

  function ownerOf(element) {
    const box = footprint(drawn.get(element.id) ?? element);
    const self = bodies.get(element.id);
    let owner = null;
    let best = null;
    for (const candidate of frames) {
      if (candidate.id === element.id) continue;
      const body = bodies.get(candidate.id);
      if (!encloses(body.box, box)) continue;
      if (self && area(body.box) === area(box) && body.position < self.position) continue;
      const middle = centre(body.box);
      const point = centre(box);
      const rank = [area(body.box), Math.hypot(middle.x - point.x, middle.y - point.y)];
      if (!best || rank[0] < best[0] || (rank[0] === best[0] && rank[1] < best[1])) {
        owner = candidate;
        best = rank;
      }
    }
    return owner;
  }

  const owners = new Map(frames.map((each) => [each.id, ownerOf(each)]));
  const isIn = (element) => {
    let owner = owners.get(element.id) ?? (isFrame(element) ? null : ownerOf(element));
    for (let depth = 0; owner && depth <= frames.length; depth += 1) {
      if (owner.id === frame.id) return true;
      owner = owners.get(owner.id);
    }
    return false;
  };
  return elements.filter((element) => element.id !== frame.id && isIn(element));
}

/** `element` and, for a frame, everything inside it. */
export const withContents = (elements, element) =>
  isFrame(element) ? [element, ...frameContents(elements, element)] : [element];

export function translate(element, dx, dy) {
  if (element.type === "pen") {
    return { ...element, points: element.points.map(([x, y, p]) => [x + dx, y + dy, p]) };
  }
  if (element.type === "text") {
    return { ...element, x1: element.x1 + dx, y1: element.y1 + dy };
  }
  return {
    ...element,
    x1: element.x1 + dx,
    y1: element.y1 + dy,
    x2: element.x2 + dx,
    y2: element.y2 + dy,
  };
}

/**
 * The stacking key that moves `element` to the "front" or "back" of the board,
 * or a step "forward" or "backward" past the next element it overlaps (see
 * shared/src/board-order.js). Null when there's nowhere to move it.
 * Frames are drawn beneath everything else, so they only move among frames,
 * and everything else among everything but frames.
 */
export function stackKey(board, element, where) {
  const elements = resolveConnectors(board);
  const bounds = getBounds(elements.find((other) => other.id === element.id) ?? element);
  const peers = elements.filter((other) => isFrame(other) === isFrame(element));
  return keyToMove(peers, element.id, where, (other) => rectsOverlap(bounds, getBounds(other)));
}

/** A copy of `element` with a new id, `dx` and `dy` along. */
export function duplicate(element, dx = 16, dy = 16) {
  const copy = { ...translate(element, dx, dy), id: newId() };
  if ("seed" in copy) copy.seed = newSeed();
  return copy;
}

// A click without a drag shouldn't leave an invisible shape behind.
export function isDegenerate(element) {
  if (element.type === "pen") return false;
  if (element.type === "text") return !element.text.trim();
  return Math.hypot(element.x2 - element.x1, element.y2 - element.y1) < 3;
}
