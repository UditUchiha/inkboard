import type { Element as BoardElement, ImageCrop, ImageElement, Point } from "@inkboard/shared/types";
import { canRotate, getFrame, getLocalBounds, textSize } from "./elements";
import type { Connector } from "./elements";
import { clamp, constrainEnd, rotatePoint } from "./geometry";
import type { Pair, TurnedRect, XY } from "./geometry";

export const MIN_SIZE = 4;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 400;

const SNAP_STEP = Math.PI / 12; // 15 degrees
const SELECTION_GAP = 6; // screen pixels between an element and its selection box
const ROTATE_HANDLE_DISTANCE = 26; // screen pixels above the box
const HANDLE_REACH = 9; // screen pixels around a handle that count as grabbing it

export type Handle = { id: string } & XY;

export type SelectionBox =
  | { kind: "line"; handles: Handle[] }
  | {
      kind: "box";
      frame: TurnedRect;
      pad: number;
      halfWidth: number;
      halfHeight: number;
      top: XY;
      handles: Handle[];
    };

const DIRECTIONS: Record<string, Pair> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};
const CORNERS = new Set(["nw", "ne", "se", "sw"]);
const EDGES = new Set(["n", "e", "s", "w"]);

const isLine = (element: BoardElement): element is Connector => element.type === "line" || element.type === "arrow";
const normalizeAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

export function getSelectionBox(element: BoardElement, zoom: number): SelectionBox {
  if (isLine(element)) {
    return {
      kind: "line",
      handles: [
        { id: "start", x: element.x1, y: element.y1 },
        { id: "end", x: element.x2, y: element.y2 },
      ],
    };
  }

  const frame = getFrame(element);
  const local = getLocalBounds(element);
  // The gap to the element covers its stroke, plus a little breathing room.
  const pad = Math.max(0, (local.width - frame.width) / 2) + SELECTION_GAP / zoom;
  const halfWidth = frame.width / 2 + pad;
  const halfHeight = frame.height / 2 + pad;
  const place = (lx: number, ly: number): XY => {
    const [x, y] = rotatePoint(frame.cx + lx, frame.cy + ly, frame.cx, frame.cy, frame.angle);
    return { x, y };
  };

  const ids = element.type === "text" ? [...CORNERS] : [...CORNERS, ...EDGES];
  const handles = ids.map((id) => {
    const [dx, dy] = DIRECTIONS[id];
    return { id, ...place(dx * halfWidth, dy * halfHeight) };
  });
  if (canRotate(element)) handles.push({ id: "rotate", ...place(0, -(halfHeight + ROTATE_HANDLE_DISTANCE / zoom)) });

  return { kind: "box", frame, pad, halfWidth, halfHeight, top: place(0, -halfHeight), handles };
}

export function handleAt(element: BoardElement, point: XY, zoom: number): string | null {
  const reach = HANDLE_REACH / zoom;
  const { handles } = getSelectionBox(element, zoom);
  const near = handles.filter((handle) => Math.hypot(point.x - handle.x, point.y - handle.y) <= reach);
  if (near.length === 0) return null;
  const rank = (handle: Handle) => {
    if (CORNERS.has(handle.id)) return 0;
    return EDGES.has(handle.id) ? 1 : 2;
  };
  near.sort((a, b) => rank(a) - rank(b));
  return near[0].id;
}

export function cursorForHandle(handleId: string, angle = 0): string {
  if (handleId === "rotate") return "grab";
  if (handleId === "start" || handleId === "end") return "crosshair";
  const [dx, dy] = DIRECTIONS[handleId];
  const eighths = Math.round(((Math.atan2(dy, dx) + angle) / Math.PI) * 4);
  const cursors = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  return cursors[((eighths % 4) + 4) % 4];
}

function moveLineEnd(element: Connector, handleId: string, point: XY, snap: boolean): Connector {
  if (handleId === "end") {
    const end = snap ? constrainEnd("line", element.x1, element.y1, point.x, point.y) : { x2: point.x, y2: point.y };
    return { ...element, ...end };
  }
  const start = snap ? constrainEnd("line", element.x2, element.y2, point.x, point.y) : { x2: point.x, y2: point.y };
  return { ...element, x1: start.x2, y1: start.y2 };
}

// The side opposite the handle stays put, even turned. `pad` is the selection gap the handle sits outside by, so nothing jumps when the drag starts.
export function resizeElement(
  original: BoardElement,
  handleId: string,
  point: XY,
  {
    keepAspect = false,
    pad = 0,
    maxSize,
  }: { keepAspect?: boolean; pad?: number; maxSize?: { width: number; height: number } } = {},
): BoardElement {
  if (isLine(original)) return moveLineEnd(original, handleId, point, keepAspect);

  const frame = getFrame(original);
  const [dx, dy] = DIRECTIONS[handleId];
  // A pen stroke with no width (or height) has nothing to scale along it, so it keeps its size that way.
  const flatX = original.type === "pen" && frame.width < 1;
  const flatY = original.type === "pen" && frame.height < 1;
  // Not for a flat stroke (a line's proportions would scale by a drag over a size of nothing). A picture being cropped (`maxSize`) changes shape freely.
  const lockAspect =
    (keepAspect || original.type === "text" || (original.type === "image" && !maxSize)) &&
    dx !== 0 &&
    dy !== 0 &&
    !flatX &&
    !flatY;

  const [ax, ay] = rotatePoint(
    frame.cx - (dx * frame.width) / 2,
    frame.cy - (dy * frame.height) / 2,
    frame.cx,
    frame.cy,
    frame.angle,
  );
  const [alongX, alongY] = rotatePoint(point.x, point.y, ax, ay, -frame.angle);
  const relX = alongX - ax;
  const relY = alongY - ay;

  let width = dx === 0 ? frame.width : Math.max(MIN_SIZE, dx * relX - pad);
  let height = dy === 0 ? frame.height : Math.max(MIN_SIZE, dy * relY - pad);
  if (lockAspect) {
    const scale = Math.max(width / Math.max(frame.width, 1), height / Math.max(frame.height, 1));
    width = Math.max(MIN_SIZE, frame.width * scale);
    height = Math.max(MIN_SIZE, frame.height * scale);
  }
  if (maxSize) {
    width = Math.min(width, maxSize.width);
    height = Math.min(height, maxSize.height);
  }
  if (flatX) width = frame.width;
  if (flatY) height = frame.height;

  const [cx, cy] = rotatePoint(ax + dx * (width / 2), ay + dy * (height / 2), ax, ay, frame.angle);

  switch (original.type) {
    case "pen": {
      // Every point goes with the centre, which moves when the stroke is turned even along a flat side.
      const scaleX = flatX ? 1 : width / frame.width;
      const scaleY = flatY ? 1 : height / frame.height;
      return {
        ...original,
        points: original.points.map(([x, y, pressure]): Point => [
          cx + (x - frame.cx) * scaleX,
          cy + (y - frame.cy) * scaleY,
          pressure,
        ]),
      };
    }
    case "text": {
      const fontSize = clamp(
        Math.round(original.fontSize * (width / Math.max(frame.width, 1))),
        MIN_FONT_SIZE,
        MAX_FONT_SIZE,
      );
      const resized = { ...original, fontSize };
      const size = textSize(resized);
      return { ...resized, x1: cx - size.width / 2, y1: cy - size.height / 2 };
    }
    default:
      return { ...original, x1: cx - width / 2, y1: cy - height / 2, x2: cx + width / 2, y2: cy + height / 2 };
  }
}

export const WHOLE_PICTURE: ImageCrop = { x: 0, y: 0, w: 1, h: 1 };

// Like resizing but the picture keeps its scale, so the box shows more or less of it, never past its edges.
export function cropImage(original: ImageElement, handleId: string, point: XY, { pad = 0 } = {}): ImageElement {
  const crop = original.crop ?? WHOLE_PICTURE;
  const { width, height } = getFrame(original);
  const perX = width / crop.w;
  const perY = height / crop.h;
  const [dx, dy] = DIRECTIONS[handleId];
  const maxSize = {
    width: (dx > 0 ? 1 - crop.x : crop.x + crop.w) * perX,
    height: (dy > 0 ? 1 - crop.y : crop.y + crop.h) * perY,
  };
  const resized = resizeElement(original, handleId, point, { pad, maxSize }) as ImageElement;
  const after = getFrame(resized);
  const w = Math.min(1, after.width / perX);
  const h = Math.min(1, after.height / perY);
  const x = dx < 0 ? Math.max(0, crop.x + crop.w - w) : crop.x;
  const y = dy < 0 ? Math.max(0, crop.y + crop.h - h) : crop.y;
  return { ...resized, crop: { x, y, w, h } };
}

export function uncropImage(element: ImageElement): ImageElement {
  const { crop, ...rest } = element;
  if (!crop) return element;
  const { cx, cy, width, height } = getFrame(element);
  const halfWidth = width / crop.w / 2;
  const halfHeight = height / crop.h / 2;
  return { ...rest, x1: cx - halfWidth, y1: cy - halfHeight, x2: cx + halfWidth, y2: cy + halfHeight };
}

export function rotateElement(
  original: BoardElement,
  startPoint: XY,
  point: XY,
  { snap = false }: { snap?: boolean } = {},
): BoardElement {
  if (!canRotate(original)) return original;
  const { cx, cy, angle } = getFrame(original);
  const swing = Math.atan2(point.y - cy, point.x - cx) - Math.atan2(startPoint.y - cy, startPoint.x - cx);
  let next = angle + swing;
  if (snap) next = Math.round(next / SNAP_STEP) * SNAP_STEP;
  return { ...original, angle: normalizeAngle(next) };
}
