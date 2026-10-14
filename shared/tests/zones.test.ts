import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, FrameElement } from "../src/types.ts";
import { insideZone, zoneBox } from "../src/zones.ts";

const frame = { id: "f", type: "frame", x1: 0, y1: 0, x2: 400, y2: 300, name: "Frame 1" } as FrameElement;
const rect = (x1: number, y1: number, x2: number, y2: number, angle?: number) =>
  ({ id: "r", type: "rectangle", x1, y1, x2, y2, ...(angle ? { angle } : {}) }) as unknown as Element;

describe("zoneBox", () => {
  it("is a box's own box, whichever way it was drawn", () => {
    assert.deepEqual(zoneBox(rect(100, 80, 20, 10)), { x1: 20, y1: 10, x2: 100, y2: 80 });
  });

  it("is a pen stroke's points' box", () => {
    const pen = {
      id: "p",
      type: "pen",
      points: [
        [5, 9, 0.5],
        [50, 2, 0.5],
        [30, 40, 0.5],
      ],
    } as unknown as Element;
    assert.deepEqual(zoneBox(pen), { x1: 5, y1: 2, x2: 50, y2: 40 });
  });

  it("estimates text from its longest line, its font and its lines", () => {
    const text = { id: "t", type: "text", x1: 10, y1: 10, text: "ab\nabcd", fontSize: 20, font: "code" } as Element;
    assert.deepEqual(zoneBox(text), { x1: 10, y1: 10, x2: 10 + 4 * 20 * 0.6, y2: 10 + 2 * 20 * 1.25 });
  });

  it("grows a turned element's box to what it covers", () => {
    const box = zoneBox(rect(0, 0, 100, 20, Math.PI / 2));
    assert.ok(Math.abs(box.x1 - 40) < 1e-9 && Math.abs(box.y1 + 40) < 1e-9, JSON.stringify(box));
  });
});

describe("insideZone", () => {
  it("takes what lies wholly inside, edges included, and nothing that crosses out", () => {
    assert.equal(insideZone(rect(0, 0, 400, 300), frame), true);
    assert.equal(insideZone(rect(390, 10, 410, 20), frame), false);
    assert.equal(insideZone(rect(500, 10, 600, 20), frame), false);
  });

  it("never takes a frame, even one inside", () => {
    assert.equal(insideZone({ ...frame, id: "g", x1: 10, y1: 10, x2: 20, y2: 20 }, frame), false);
  });

  it("counts a line or arrow by its ends", () => {
    const arrow = { id: "a", type: "arrow", x1: 10, y1: 10, x2: 390, y2: 290 } as unknown as Element;
    assert.equal(insideZone(arrow, frame), true);
    assert.equal(insideZone({ ...arrow, x2: 420 } as Element, frame), false);
  });
});
