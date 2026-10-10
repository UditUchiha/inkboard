import { keyToMove } from "@inkboard/shared/board-order";
import type {
  Element as BoardElement,
  Font,
  FrameElement,
  ImageElement,
  PenElement,
  Point,
  ShapeElement,
  StackMove,
  StickyElement,
  TextElement,
} from "@inkboard/shared/types";
import { resolveConnectors } from "./connectors";
import {
  FILLABLE_TYPES,
  FONTS,
  fontKey,
  FRAME_LABEL_GAP,
  FRAME_LABEL_SIZE,
  LABEL_FONT_SIZE,
  LABEL_PADDING,
  LINE_HEIGHT,
  NOTE_SIZE,
} from "./constants";
import type { Style } from "./constants";
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
import type { Pair, Rect, Size, TurnedRect, XY } from "./geometry";
import { charactersOf } from "./notes";
import { approachTo, connectorPath, pathExtremes, pathLength, pathMiddle, pathPolyline } from "./routes";

/** A line or arrow: the shapes whose ends can be attached to other shapes, and that have a route and a label. */
export type Connector = ShapeElement & { type: "line" | "arrow" };

/** An element that can be turned (see canRotate): it has an `angle`. */
export type Turnable =
  PenElement | TextElement | StickyElement | ImageElement | (ShapeElement & { type: "rectangle" | "ellipse" });

/** Any element, for code that reads a field only some kinds have (an angle, a stroke width, text): there it is optional. */
export type AnyElement = BoardElement & { angle?: number; strokeWidth?: number; text?: string };

/** What createElement draws with. A pen needs only a colour and a size; the rest is for the other kinds. */
export type ElementStyle = Pick<Style, "stroke" | "penSize"> & Partial<Style>;

/** What decides how text is drawn: its size and font (the default font if it has none). */
export type TextStyle = { fontSize: number; font?: Font };

/** What measuring text gives: its size, and its lines. */
export type TextSize = { width: number; height: number; lines: string[] };

/** A frame's name as it is drawn above the frame (see frameLabel). */
export type FrameLabel = { text: string; font: string; x: number; bottom: number; width: number; height: number };

/** A line's or arrow's label (see connectorLabel): its lines, font and size, and the box they fill. */
export type ConnectorLabel = Rect & { lines: string[]; font: string; fontSize: number };

/** An arrow's head: the points of its barb, its tip and its other barb. */
export type ArrowHead = [Pair, Pair, Pair];

// Elements are plain, immutable, JSON-serialisable objects. Any change makes a
// new object, which lets the renderer cache expensive work per element.
//
//   shapes: { id, type, seed, x1, y1, x2, y2, stroke, fill, strokeWidth, sketchy }
//   lines and arrows also: { route, font, text?, startId?, endId?, startAnchor?, endAnchor? },
//   and arrows { startHead } (an arrowhead at the start too). See connectors.js and routes.js.
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

const TURNABLE_TYPES = new Set<BoardElement["type"]>(["rectangle", "ellipse", "image", "pen", "text", "sticky"]);
export const canRotate = (element: BoardElement): element is Turnable => TURNABLE_TYPES.has(element.type);
export const isFrame = (element: BoardElement): element is FrameElement => element.type === "frame";
const isConnector = (element: BoardElement): element is Connector =>
  element.type === "line" || element.type === "arrow";

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const newSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;

export function createElement(
  type: "pen" | "text" | "frame" | ShapeElement["type"],
  { x, y }: XY,
  style: ElementStyle,
  pressure?: number,
): BoardElement {
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
    // The non-null assertions: a text is made with a whole style, of which a pen needs only part.
    return { id, type, x1: x, y1: y, text: "", stroke: style.stroke, fontSize: style.fontSize!, font: style.font! };
  }
  if (type === "frame") return { id, type, x1: x, y1: y, x2: x, y2: y, name: "" };
  const shape: ShapeElement = {
    id,
    type,
    seed: newSeed(),
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    stroke: style.stroke,
    // The casts and assertions: a shape is made with a whole style, of which a pen needs only part.
    fill: FILLABLE_TYPES.has(type) ? (style.fill as string | null) : null,
    strokeWidth: style.strokeWidth!,
    sketchy: style.sketchy!,
  };
  if (!isConnector(shape)) return shape;
  // Every optional field is there from the start: a copy that lacks one has no say in it when changes
  // are merged, so a label typed while someone else moves the arrow isn't lost. A label typed on it
  // later is written in the font of the moment.
  shape.text = "";
  shape.route = style.route ?? "straight";
  shape.font = style.font ?? "hand";
  if (type === "arrow") shape.startHead = Boolean(style.startHead);
  return shape;
}

/** A picture placed with its top left corner at (x, y). */
export function createImage(imageId: string, { x, y }: XY, { width, height }: Size): ImageElement {
  return { id: newId(), type: "image", imageId, x1: x, y1: y, x2: x + width, y2: y + height };
}

/** A sticky note centred on (x, y). */
export function createNote({ x, y }: XY, style: Style): StickyElement {
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
export function nextFrameName(elements: BoardElement[]): string {
  const frames = elements.filter(isFrame);
  const taken = new Set(frames.map((frame) => frame.name));
  let number = frames.length + 1;
  while (taken.has(`Frame ${number}`)) number += 1;
  return `Frame ${number}`;
}

let measureContext: CanvasRenderingContext2D; // made on first use

export const fontFor = (element: TextStyle, scale = 1): string =>
  `${element.fontSize * scale}px ${FONTS[fontKey(element.font)].family}`;

// The non-null assertions: a text with no text of its own is measured with one given, and a canvas always gives a 2D context.
export function measureText(element: TextStyle & { text?: string }, text = element.text!): TextSize {
  measureContext ??= document.createElement("canvas").getContext("2d")!;
  measureContext.font = fontFor(element);
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => measureContext.measureText(line).width), element.fontSize * 0.5);
  return { width, height: lines.length * element.fontSize * LINE_HEIGHT, lines };
}

let labels = new WeakMap<FrameElement, { scale: number; label: FrameLabel }>(); // frame -> { scale, label }, see frameLabel

/**
 * A frame's name as drawn above its top left corner, cut short to the frame's
 * width: { text, font, x, bottom, width, height }. `scale` is board units per
 * pixel of label: 1 / zoom in the editor, so names stay readable at any zoom.
 *
 * Shortening a name takes a few measurements, and the editor asks on every
 * frame drawn and every mouse move, so each frame keeps its last label.
 */
export function frameLabel(frame: FrameElement, scale = 1): FrameLabel {
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
export const frameLabelBox = (label: FrameLabel): Rect => ({
  x: label.x,
  y: label.bottom - label.height,
  width: label.width,
  height: label.height,
});

function measureFrameLabel(frame: FrameElement, scale: number): FrameLabel {
  const body = normalizeRect(frame.x1, frame.y1, frame.x2, frame.y2);
  const font = `500 ${FRAME_LABEL_SIZE * scale}px ${FONTS.sans.family}`;
  measureContext ??= document.createElement("canvas").getContext("2d")!; // a canvas always gives a 2D context
  measureContext.font = font;
  const widthOf = (text: string) => measureContext.measureText(text).width;
  let text = frame.name || "Frame";
  if (widthOf(text) > body.width) {
    // The most characters that fit with the ellipsis, at least one.
    const characters = charactersOf(text);
    const shortened = (count: number) => `${characters.slice(0, count).join("")}…`;
    let low = 1;
    let high = characters.length; // all of them doesn't fit
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (widthOf(shortened(middle)) <= body.width) low = middle;
      else high = middle;
    }
    text = shortened(low);
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

export const arrowHeadLength = (element: ShapeElement): number =>
  Math.min(14 + element.strokeWidth * 3, pathLength(connectorPath(element).points) * 0.45);

/** An arrow's heads, each as the three points of its barbs and tip: the end's, then the start's if it has one. */
export function arrowHeads(element: BoardElement): ArrowHead[] {
  if (element.type !== "arrow") return [];
  const path = connectorPath(element);
  const full = arrowHeadLength(element);
  const head = (tip: XY, from: XY): ArrowHead => {
    // On a bent path a head is no longer than the straight run it sits on, or its barbs would stick out sideways,
    // but no shorter than half a full one: a run of next to nothing (an end just beside the bend) would leave no head.
    const run = Math.hypot(tip.x - from.x, tip.y - from.y);
    const length = path.curved ? full : Math.min(full, Math.max(run, full / 2));
    const [a, b] = arrowHeadPoints(from.x, from.y, tip.x, tip.y, length);
    return [a, [tip.x, tip.y], b];
  };
  // The non-null assertion: a path has its two ends at least.
  const heads = [head(path.points.at(-1)!, approachTo(path, "end"))];
  if (element.startHead) heads.push(head(path.points[0], approachTo(path, "start")));
  return heads;
}

let connectorLabels = new WeakMap<Connector, ConnectorLabel>();

/**
 * A line's or arrow's label, centred halfway along it: { lines, font,
 * fontSize, x, y, width, height } (the box is the text's, padding included),
 * or null when it has none.
 */
export function connectorLabel(element: BoardElement): ConnectorLabel | null {
  if (!isConnector(element) || !element.text) return null;
  let label = connectorLabels.get(element);
  if (!label) {
    const style = { fontSize: LABEL_FONT_SIZE, font: element.font };
    const { width, height, lines } = measureText(style, element.text);
    const middle = pathMiddle(connectorPath(element));
    const box = expandRect({ x: middle.x - width / 2, y: middle.y - height / 2, width, height }, LABEL_PADDING);
    label = { lines, font: fontFor(style), fontSize: LABEL_FONT_SIZE, ...box };
    connectorLabels.set(element, label);
  }
  return label;
}

/** Forget measured connector labels, once web fonts have loaded and text measures differently. */
export function forgetConnectorLabels() {
  connectorLabels = new WeakMap();
}

let boundsCache = new WeakMap<BoardElement, Rect>();
let turnedBoundsCache = new WeakMap<BoardElement, Rect>();

/** Forget measured bounds, once web fonts have loaded and text measures differently. */
export function forgetBounds() {
  boundsCache = new WeakMap();
  turnedBoundsCache = new WeakMap();
}

/** The box around an element before any turning, including its stroke. */
export function getLocalBounds(element: BoardElement): Rect {
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
    case "line":
    case "arrow": {
      const points = [
        ...pathExtremes(connectorPath(element)).map((point) => [point.x, point.y]),
        ...arrowHeads(element).flat(),
      ];
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const pad = element.type === "arrow" ? element.strokeWidth : element.strokeWidth / 2 + (element.sketchy ? 3 : 0);
      bounds = expandRect({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, pad);
      const label = connectorLabel(element);
      // The non-null assertion: there are two rectangles to join.
      if (label) bounds = unionRects([bounds, label])!;
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
export function getBounds(element: BoardElement): Rect {
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
export function getFrame(element: AnyElement): TurnedRect {
  let box: Rect;
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

export function getSceneBounds(elements: BoardElement[]): Rect | null {
  return unionRects(resolveConnectors(elements).map(getBounds));
}

export function hitTest(element: BoardElement, pointX: number, pointY: number, tolerance: number): boolean {
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
    case "arrow": {
      const reach = tolerance + element.strokeWidth / 2;
      const label = connectorLabel(element);
      if (label && rectContains(expandRect(label, tolerance), x, y)) return true;
      const near = (points: Pair[]) =>
        points.some((point, i) => i > 0 && distanceToSegment(x, y, ...points[i - 1], ...point) <= reach);
      const along = pathPolyline(connectorPath(element)).map((point): Pair => [point.x, point.y]);
      return near(along) || arrowHeads(element).some(near);
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

const drawOrders = new WeakMap<BoardElement[], BoardElement[]>();

// How many frames are wholly around `frame` (and bigger), so a frame is always drawn over the ones it sits in.
function nesting(frames: FrameElement[], frame: FrameElement): number {
  const body = footprint(frame);
  return frames.filter((other) => {
    const around = footprint(other);
    return other !== frame && encloses(around, body) && around.width * around.height > body.width * body.height;
  }).length;
}

/**
 * `elements` (in stack order) in the order they're drawn: frames first, beneath
 * everything else, those inside others after the ones around them (otherwise by
 * stack order), so a big frame never covers a smaller one inside it.
 */
export function inDrawOrder(elements: BoardElement[]): BoardElement[] {
  let ordered = drawOrders.get(elements);
  if (!ordered) {
    const frames = elements.filter(isFrame);
    const depths = new Map<FrameElement, number>(frames.map((frame) => [frame, nesting(frames, frame)]));
    // The non-null assertions: every frame is in `depths`.
    const byDepth = [...frames].sort((a, b) => depths.get(a)! - depths.get(b)!);
    ordered = frames.length === 0 ? elements : [...byDepth, ...elements.filter((element) => !isFrame(element))];
    drawOrders.set(elements, ordered);
  }
  return ordered;
}

/**
 * The element under a point, as it's drawn (see connectors.js): a frame's
 * name, then whatever is drawn on top, then the innermost frame the point is
 * inside. Pass `labelScale` (see frameLabel) to find frames by their names.
 */
export function elementAt(
  board: BoardElement[],
  x: number,
  y: number,
  tolerance: number,
  { labelScale }: { labelScale?: number } = {},
): BoardElement | null {
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
  let innermost: FrameElement | null = null;
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
const footprint = (element: BoardElement): Rect =>
  isFrame(element) ? normalizeRect(element.x1, element.y1, element.x2, element.y2) : getBounds(element);

const encloses = (outer: Rect, inner: Rect) =>
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
export function frameContents(elements: BoardElement[], frame: FrameElement): BoardElement[] {
  const frames = elements.filter(isFrame);
  if (frames.length === 0) return [];
  const bodies = new Map<string, { box: Rect; position: number }>(
    frames.map((each, position) => [each.id, { box: footprint(each), position }]),
  );
  // Where connectors are drawn decides which frame they're in.
  const drawn = new Map<string, BoardElement>(resolveConnectors(elements).map((element) => [element.id, element]));
  const area = (box: Rect) => box.width * box.height;
  const centre = (box: Rect) => rectCenter(box);

  function ownerOf(element: BoardElement): FrameElement | null {
    const box = footprint(drawn.get(element.id) ?? element);
    const self = bodies.get(element.id);
    let owner: FrameElement | null = null;
    let best: number[] | null = null;
    for (const candidate of frames) {
      if (candidate.id === element.id) continue;
      const body = bodies.get(candidate.id)!; // every frame has a body
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

  const owners = new Map<string, FrameElement | null>(frames.map((each) => [each.id, ownerOf(each)]));
  const isIn = (element: BoardElement) => {
    let owner: FrameElement | null | undefined = owners.get(element.id) ?? (isFrame(element) ? null : ownerOf(element));
    for (let depth = 0; owner && depth <= frames.length; depth += 1) {
      if (owner.id === frame.id) return true;
      owner = owners.get(owner.id);
    }
    return false;
  };
  return elements.filter((element) => element.id !== frame.id && isIn(element));
}

/** `element` and, for a frame, everything inside it. */
export const withContents = (elements: BoardElement[], element: BoardElement): BoardElement[] =>
  isFrame(element) ? [element, ...frameContents(elements, element)] : [element];

export function translate(element: BoardElement, dx: number, dy: number): BoardElement {
  if (element.type === "pen") {
    return { ...element, points: element.points.map(([x, y, p]): Point => [x + dx, y + dy, p]) };
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
 * shared/src/board-order.ts). Null when there's nowhere to move it.
 * Frames are drawn beneath everything else, so they only move among frames,
 * and everything else among everything but frames.
 */
export function stackKey(board: BoardElement[], element: BoardElement, where: StackMove): string | null {
  const elements = resolveConnectors(board);
  const bounds = getBounds(elements.find((other) => other.id === element.id) ?? element);
  const peers = elements.filter((other) => isFrame(other) === isFrame(element));
  return keyToMove(peers, element.id, where, (other) => rectsOverlap(bounds, getBounds(other)));
}

/** A copy of `element` with a new id, `dx` and `dy` along. */
export function duplicate(element: BoardElement, dx = 16, dy = 16): BoardElement {
  const copy = { ...translate(element, dx, dy), id: newId() };
  if ("seed" in copy) copy.seed = newSeed();
  return copy;
}

// A click without a drag shouldn't leave an invisible shape behind: one under 3 screen pixels across (at `zoom`) is that.
export function isDegenerate(element: BoardElement, zoom = 1): boolean {
  if (element.type === "pen") return false;
  if (element.type === "text") return !element.text.trim();
  return Math.hypot(element.x2 - element.x1, element.y2 - element.y1) * zoom < 3;
}
