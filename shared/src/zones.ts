import type { Element, FrameElement } from "./types.ts";

// Classroom mode's rule for what is inside a student's frame (their "zone"): worked out from the stored numbers alone,
// so the browser, which keeps a student's work inside, and the server, which refuses what isn't, always agree. It's
// coarser than how the board is drawn: text can't be measured without a browser, so its width is estimated, and a
// line or arrow counts by its two ends.

/** A box on the board, by its edges. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// A character's width as a share of the font size, about the average of each font's: only an estimate.
const CHARACTER_WIDTH = { hand: 0.42, sans: 0.55, code: 0.6 };
const LINE_HEIGHT = 1.25; // as text is laid out on the board
const SLACK = 0.5; // board units an element may stray over its frame's edge, for rounding

const boxOf = (x1: number, y1: number, x2: number, y2: number): Box => ({
  x1: Math.min(x1, x2),
  y1: Math.min(y1, y2),
  x2: Math.max(x1, x2),
  y2: Math.max(y1, y2),
});

/** A frame's own box, where what's inside it lies. */
export const frameBox = (frame: FrameElement): Box => boxOf(frame.x1, frame.y1, frame.x2, frame.y2);

// The box around `box` turned by `angle` about its middle.
function turned(box: Box, angle: number): Box {
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const halfWidth = ((box.x2 - box.x1) / 2) * cos + ((box.y2 - box.y1) / 2) * sin;
  const halfHeight = ((box.x2 - box.x1) / 2) * sin + ((box.y2 - box.y1) / 2) * cos;
  return { x1: cx - halfWidth, y1: cy - halfHeight, x2: cx + halfWidth, y2: cy + halfHeight };
}

/** The box classroom mode takes `element` to fill (see above). */
export function zoneBox(element: Element): Box {
  let box: Box;
  if (element.type === "pen") {
    let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
    // A loop, not Math.min(...points): a stroke can have tens of thousands of points.
    for (const [x, y] of element.points) {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
    box = { x1, y1, x2, y2 };
  } else if (element.type === "text") {
    const lines = element.text.split("\n");
    const longest = Math.max(1, ...lines.map((line) => [...line].length));
    const width = longest * element.fontSize * (CHARACTER_WIDTH[element.font] ?? CHARACTER_WIDTH.sans);
    box = {
      x1: element.x1,
      y1: element.y1,
      x2: element.x1 + width,
      y2: element.y1 + lines.length * element.fontSize * LINE_HEIGHT,
    };
  } else {
    box = boxOf(element.x1, element.y1, element.x2, element.y2);
  }
  const angle = "angle" in element ? element.angle : undefined;
  return angle ? turned(box, angle) : box;
}

/** Whether `element` lies wholly inside `frame`, by classroom mode's rule. A frame is never inside a zone. */
export function insideZone(element: Element, frame: FrameElement): boolean {
  if (element.type === "frame") return false;
  const box = zoneBox(element);
  const zone = frameBox(frame);
  return (
    box.x1 >= zone.x1 - SLACK && box.y1 >= zone.y1 - SLACK && box.x2 <= zone.x2 + SLACK && box.y2 <= zone.y2 + SLACK
  );
}
