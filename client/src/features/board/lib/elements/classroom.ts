import type { Element as BoardElement, FrameElement } from "@inkboard/shared/types";
import { frameBox, insideZone, zoneBox } from "@inkboard/shared/zones";
import type { Box } from "@inkboard/shared/zones";
import { getBounds, translate } from "./elements";
import type { XY } from "./geometry";

// Classroom mode (docs/classroom-mode.md): a student's changes stay inside their frame, so the server (shared/src/zones.ts) never turns them away.
// What they make must also lie inside the frame as drawn (getBounds, strokes and all), so it stays in when the teacher moves the frame.

export type Zone = FrameElement | null | undefined;

export const canChange = (element: BoardElement, zone: Zone) =>
  zone === undefined || (zone !== null && insideZone(element, zone));

function bothBoxes(element: BoardElement): Box {
  const coarse = zoneBox(element);
  const drawn = getBounds(element);
  return {
    x1: Math.min(coarse.x1, drawn.x),
    y1: Math.min(coarse.y1, drawn.y),
    x2: Math.max(coarse.x2, drawn.x + drawn.width),
    y2: Math.max(coarse.y2, drawn.y + drawn.height),
  };
}

const within = (box: Box, zone: Box) =>
  box.x1 >= zone.x1 && box.y1 >= zone.y1 && box.x2 <= zone.x2 && box.y2 <= zone.y2;

export const staysInside = (element: BoardElement, zone: Zone) =>
  zone === undefined || (zone !== null && element.type !== "frame" && within(bothBoxes(element), frameBox(zone)));

export function edgeRoom(element: Pick<BoardElement, "type"> & { penSize?: number; strokeWidth?: number }) {
  if (element.type === "pen") return (element.penSize ?? 0) / 2 + 1;
  // A line's or arrow's head reaches out past its end.
  if (element.type === "line" || element.type === "arrow") return (element.strokeWidth ?? 0) * 2 + 14;
  return (element.strokeWidth ?? 0) / 2 + 4; // a sketchy outline wanders a little
}

export function pointInside(point: XY, frame: FrameElement) {
  const box = frameBox(frame);
  return point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2;
}

export function clampPoint(point: XY, frame: FrameElement, room = 0): XY {
  const box = frameBox(frame);
  const keep = (value: number, min: number, max: number) =>
    min + room > max - room ? (min + max) / 2 : Math.min(Math.max(value, min + room), max - room);
  return { x: keep(point.x, box.x1, box.x2), y: keep(point.y, box.y1, box.y2) };
}

export function clampShift(elements: BoardElement[], frame: FrameElement, dx: number, dy: number): [number, number] {
  if (elements.length === 0) return [dx, dy];
  const boxes = elements.map((element) => bothBoxes(element));
  const left = Math.min(...boxes.map((box) => box.x1));
  const top = Math.min(...boxes.map((box) => box.y1));
  const right = Math.max(...boxes.map((box) => box.x2));
  const bottom = Math.max(...boxes.map((box) => box.y2));
  const zone = frameBox(frame);
  // The (min, max) of a range that's empty, as when what's moved is already bigger than the frame, is to stay put.
  const limit = (value: number, min: number, max: number) => (min > max ? 0 : Math.min(Math.max(value, min), max));
  return [limit(dx, zone.x1 - left, zone.x2 - right), limit(dy, zone.y1 - top, zone.y2 - bottom)];
}

export function fitInside(element: BoardElement, frame: FrameElement): BoardElement | null {
  if (staysInside(element, frame)) return element;
  const box = bothBoxes(element);
  const zone = frameBox(frame);
  if (box.x2 - box.x1 > zone.x2 - zone.x1 || box.y2 - box.y1 > zone.y2 - zone.y1) return null;
  const dx = box.x1 < zone.x1 ? zone.x1 - box.x1 : Math.min(0, zone.x2 - box.x2);
  const dy = box.y1 < zone.y1 ? zone.y1 - box.y1 : Math.min(0, zone.y2 - box.y2);
  const moved = translate(element, dx, dy);
  return staysInside(moved, frame) ? moved : null;
}

export function frameAt(elements: BoardElement[], point: XY): FrameElement | null {
  const area = (frame: FrameElement) => Math.abs((frame.x2 - frame.x1) * (frame.y2 - frame.y1));
  let found: FrameElement | null = null;
  for (const element of elements) {
    if (element.type !== "frame" || !pointInside(point, element)) continue;
    if (!found || area(element) < area(found)) found = element;
  }
  return found;
}
