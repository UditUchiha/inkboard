import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Point } from "@inkboard/shared/types";
import type { Pair } from "../src/features/board/geometry.ts";
import { recognizeStroke } from "../src/features/board/recognize.ts";

// A hand's wobble, the same every run.
const wobble = (i: number, size: number) => Math.sin(i * 1.7) * size;

const ellipse = (cx: number, cy: number, rx: number, ry: number, gap = 0.05): Point[] =>
  Array.from({ length: 60 }, (_, i) => {
    const angle = (i / 59) * Math.PI * 2 * (1 - gap);
    return [cx + Math.cos(angle) * rx + wobble(i, 2), cy + Math.sin(angle) * ry + wobble(i + 3, 2), 0.5];
  });

// A wobbly stroke through `corners` in turn, ten points to a side.
function stroke(...corners: Pair[]): Point[] {
  const points: Point[] = [];
  corners.slice(1).forEach(([bx, by], side) => {
    const [ax, ay] = corners[side];
    for (let i = 0; i < 10; i += 1) {
      const t = i / 10;
      points.push([
        ax + (bx - ax) * t + wobble(i + side * 7, 3),
        ay + (by - ay) * t + wobble(i + side * 5 + 2, 3),
        0.5,
      ]);
    }
  });
  // The assertion: a stroke goes through at least one corner.
  const [x, y] = corners.at(-1)!;
  return [...points, [x, y, 0.5]];
}

// A closed outline through `corners`, ending not quite back at the start.
const outline = (...corners: Pair[]) => stroke(...corners, [corners[0][0] + 4, corners[0][1] + 6]);

const box = (x: number, y: number, w: number, h: number) => outline([x, y], [x + w, y], [x + w, y + h], [x, y + h]);

describe("recognizeStroke", () => {
  it("knows a wobbly line, keeping the ends where they were drawn", () => {
    const line: Point[] = Array.from({ length: 30 }, (_, i) => [i * 10, i * 5 + wobble(i, 3), 0.5]);
    const shape = recognizeStroke(line);
    assert.equal(shape?.type, "line");
    assert.deepEqual([shape!.x1, shape!.x2], [0, 290]);
  });

  it("knows an ellipse and a rectangle, by their boxes", () => {
    const round = recognizeStroke(ellipse(100, 100, 80, 40));
    assert.equal(round?.type, "ellipse");
    assert.ok(Math.abs(round!.x1 - 20) < 5 && Math.abs(round!.x2 - 180) < 5);
    assert.equal(recognizeStroke(box(0, 0, 200, 120))?.type, "rectangle");
  });

  it("knows a triangle, pointing up or down, from wherever it's started", () => {
    const up = recognizeStroke(outline([100, 0], [200, 170], [0, 170]));
    assert.equal(up?.type, "triangle");
    assert.equal(up!.angle, undefined);
    assert.ok(Math.abs(up!.y1) < 5 && Math.abs(up!.y2 - 170) < 5);
    assert.equal(recognizeStroke(outline([0, 160], [115, 0], [210, 160]))?.type, "triangle", "its tip a little off");
    const down = recognizeStroke(outline([0, 0], [200, 0], [100, 170]));
    assert.deepEqual([down?.type, down?.angle], ["triangle", Math.PI]);
  });

  it("knows a diamond, tall or wide, by the box it's drawn in", () => {
    const tall = recognizeStroke(outline([100, 0], [180, 90], [100, 180], [20, 90]));
    assert.equal(tall?.type, "diamond");
    assert.ok(Math.abs(tall!.x1 - 20) < 5 && Math.abs(tall!.x2 - 180) < 5);
    assert.equal(recognizeStroke(outline([0, 60], [120, 0], [240, 60], [120, 120]))?.type, "diamond");
  });

  it("knows an arrow drawn in one stroke, its head flicked back or drawn as a V", () => {
    const flicked = recognizeStroke(stroke([0, 0], [300, 0], [258, -26]));
    assert.equal(flicked?.type, "arrow");
    assert.ok(Math.abs(flicked!.x2 - 300) < 5 && Math.abs(flicked!.y2) < 5, "pointing where the shaft ends");
    assert.equal(recognizeStroke(stroke([0, 0], [300, 0], [262, -24], [300, 0], [262, 24]))?.type, "arrow");
    const slanted = recognizeStroke(stroke([0, 200], [240, 20], [222, 62]));
    assert.equal(slanted?.type, "arrow");
    assert.ok(Math.abs(slanted!.x1) < 5 && Math.abs(slanted!.y1 - 200) < 5, "from where it starts");
  });

  it("leaves alone what is no shape: an open curve, a zigzag, a scribble too small", () => {
    assert.equal(recognizeStroke(ellipse(100, 100, 80, 80, 0.5)), null, "half a circle");
    const zigzag: Point[] = Array.from({ length: 20 }, (_, i) => [i * 10, i % 2 ? 0 : 60, 0.5]);
    assert.equal(recognizeStroke(zigzag), null);
    assert.equal(recognizeStroke(ellipse(0, 0, 3, 3), 20), null);
    assert.equal(recognizeStroke([[0, 0, 0.5]]), null);
  });

  it("doesn't force a shape it can't draw into one it can", () => {
    assert.equal(recognizeStroke(outline([0, 0], [0, 150], [200, 150])), null, "a right-angled triangle");
    const turn = (x: number, y: number): Pair => [
      x * Math.cos(0.35) - y * Math.sin(0.35),
      x * Math.sin(0.35) + y * Math.cos(0.35),
    ];
    assert.equal(
      recognizeStroke(outline(turn(0, 0), turn(200, 0), turn(200, 120), turn(0, 120))),
      null,
      "a tilted box",
    );
    const pentagon = [0, 1, 2, 3, 4].map((i): Pair => [Math.sin(i * 1.2566) * 100, -Math.cos(i * 1.2566) * 100]);
    assert.notEqual(recognizeStroke(outline(...pentagon))?.type, "diamond", "a pentagon, about as near an ellipse");
  });

  it("doesn't take a line with a hook, doubling back or turning a corner for an arrow", () => {
    assert.equal(recognizeStroke(stroke([0, 0], [300, 0], [293, -8]))?.type, "line", "a hook as the pen stopped");
    assert.notEqual(recognizeStroke(stroke([0, 0], [300, 0], [220, 4]))?.type, "arrow", "back over the line");
    assert.equal(recognizeStroke(stroke([0, 0], [300, 0], [300, 80])), null, "an L");
    assert.equal(recognizeStroke(stroke([0, 0], [200, 0], [40, 60])), null, "a head as long as the line");
  });
});
