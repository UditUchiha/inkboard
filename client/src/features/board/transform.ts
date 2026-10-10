import type { Element as BoardElement, Point } from "@inkboard/shared/types";
import { canRotate, getFrame, getLocalBounds, measureText } from "./elements";
import type { Connector } from "./elements";
import { clamp, constrainEnd, rotatePoint } from "./geometry";
import type { Pair, TurnedRect, XY } from "./geometry";

// Resizing and turning a selected element. Everything here is plain math on
// elements and points in board coordinates, so it can be tested without a browser.

export const MIN_SIZE = 4;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 400;

const SNAP_STEP = Math.PI / 12; // 15 degrees
const SELECTION_GAP = 6; // screen pixels between an element and its selection box
const ROTATE_HANDLE_DISTANCE = 26; // screen pixels above the box
const HANDLE_REACH = 9; // screen pixels around a handle that count as grabbing it

/** A handle on a selected element: "nw", "n", "ne", "e", "se", "s", "sw" or "w" to resize, "rotate" to turn, "start" or "end" for a line's ends. */
export type Handle = { id: string } & XY;

/** What to draw around a selected element (see getSelectionBox): a line's end handles, or a box and its handles. */
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

// Which way each handle pulls: -1 is the left or top edge, 1 the right or bottom.
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

/**
 * What to draw around a selected element and where its handles are.
 * Boxes (rectangles, ellipses, strokes, text, notes, frames) get eight resize
 * handles and, unless they're frames, a turn handle; lines and arrows get a
 * handle on each end. `zoom` keeps handle
 * sizes steady on screen.
 */
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

/** The handle under a point, if any. Corners win over edges, which win over the turn handle. */
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

/** The mouse cursor to show over a handle, turned along with the element. */
export function cursorForHandle(handleId: string, angle = 0): string {
  if (handleId === "rotate") return "grab";
  if (handleId === "start" || handleId === "end") return "crosshair";
  const [dx, dy] = DIRECTIONS[handleId];
  // Direction of the handle on screen, in eighths of a turn, clockwise from "east".
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

/**
 * Drags a resize handle to `point`. The side opposite the handle stays where it
 * is, even when the element is turned. `keepAspect` (Shift) keeps proportions on
 * corners; text and pictures always keep them. `pad` is the selection gap the handle sits
 * outside the element by, so the element doesn't jump when the drag starts.
 */
export function resizeElement(
  original: BoardElement,
  handleId: string,
  point: XY,
  { keepAspect = false, pad = 0 }: { keepAspect?: boolean; pad?: number } = {},
): BoardElement {
  if (isLine(original)) return moveLineEnd(original, handleId, point, keepAspect);

  const frame = getFrame(original);
  const [dx, dy] = DIRECTIONS[handleId];
  // A pen stroke with no width (or height) has nothing to scale along it, so it keeps its size that way.
  const flatX = original.type === "pen" && frame.width < 1;
  const flatY = original.type === "pen" && frame.height < 1;
  // Not for a flat stroke: its proportions are a line, so keeping them would scale by the ratio of a drag to
  // a size of nothing. It's scaled along its real side only, as it is without Shift.
  const lockAspect =
    (keepAspect || original.type === "text" || original.type === "image") && dx !== 0 && dy !== 0 && !flatX && !flatY;

  // The fixed point, and the point's position along the element's own axes from it.
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
  if (flatX) width = frame.width;
  if (flatY) height = frame.height;

  // Where the new box is centred: half its size out from the fixed point.
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
      const size = measureText(resized);
      return { ...resized, x1: cx - size.width / 2, y1: cy - size.height / 2 };
    }
    default:
      return { ...original, x1: cx - width / 2, y1: cy - height / 2, x2: cx + width / 2, y2: cy + height / 2 };
  }
}

/**
 * Turns an element by however far the pointer has swung around its centre since
 * the drag began. `snap` (Shift) lands on 15 degree steps.
 */
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
