import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Point } from "@inkboard/shared/types";
import { recognizeStroke } from "../src/features/board/recognize.ts";

// A hand's wobble, the same every run.
const wobble = (i: number, size: number) => Math.sin(i * 1.7) * size;

const ellipse = (cx: number, cy: number, rx: number, ry: number, gap = 0.05): Point[] =>
  Array.from({ length: 60 }, (_, i) => {
    const angle = (i / 59) * Math.PI * 2 * (1 - gap);
    return [cx + Math.cos(angle) * rx + wobble(i, 2), cy + Math.sin(angle) * ry + wobble(i + 3, 2), 0.5];
  });

function box(x: number, y: number, w: number, h: number): Point[] {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x + 4, y + 6], // not quite back at the start
  ];
  const points: Point[] = [];
  for (let side = 0; side < 4; side += 1) {
    const [ax, ay] = corners[side];
    const [bx, by] = corners[side + 1];
    for (let t = 0; t < 1; t += 0.1) points.push([ax + (bx - ax) * t + wobble(t * 10, 2), ay + (by - ay) * t, 0.5]);
  }
  return points;
}

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

  it("leaves alone what is no shape: an open curve, a zigzag, a scribble too small", () => {
    assert.equal(recognizeStroke(ellipse(100, 100, 80, 80, 0.5)), null, "half a circle");
    const zigzag: Point[] = Array.from({ length: 20 }, (_, i) => [i * 10, i % 2 ? 0 : 60, 0.5]);
    assert.equal(recognizeStroke(zigzag), null);
    assert.equal(recognizeStroke(ellipse(0, 0, 3, 3), 20), null);
    assert.equal(recognizeStroke([[0, 0, 0.5]]), null);
  });
});
