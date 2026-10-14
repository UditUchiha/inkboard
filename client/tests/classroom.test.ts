import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, FrameElement } from "@inkboard/shared/types";
import {
  canChange,
  clampPoint,
  clampShift,
  edgeRoom,
  fitInside,
  frameAt,
  pointInside,
  staysInside,
} from "../src/features/board/classroom.ts";
import { frameContents } from "../src/features/board/elements.ts";
import { createBoardStore } from "../src/features/board/store.ts";
import { copyGrid, copyNames } from "../src/features/board/placement.ts";

const frame: FrameElement = { id: "f", type: "frame", x1: 0, y1: 0, x2: 400, y2: 300, name: "Frame 1" };
const rect = (id: string, x: number, y: number, size = 50) =>
  ({
    id,
    type: "rectangle",
    x1: x,
    y1: y,
    x2: x + size,
    y2: y + size,
    stroke: "#000",
    fill: null,
    strokeWidth: 2,
    sketchy: false,
    seed: 1,
  }) as unknown as Element;

describe("classroom zones on screen", () => {
  it("lets anyone change anything without a zone, a student only what's in theirs, and nothing without one", () => {
    assert.equal(canChange(rect("a", 500, 0), undefined), true);
    assert.equal(canChange(rect("a", 10, 10), frame), true);
    assert.equal(canChange(rect("a", 380, 10), frame), false);
    assert.equal(canChange(rect("a", 10, 10), null), false);
  });

  it("keeps a point, and a move, inside the frame", () => {
    assert.equal(pointInside({ x: 400, y: 300 }, frame), true);
    assert.deepEqual(clampPoint({ x: -20, y: 500 }, frame), { x: 0, y: 300 });
    assert.deepEqual(clampPoint({ x: -20, y: 500 }, frame, 5), { x: 5, y: 295 }, "room for a stroke");
    // Each box is drawn a stroke's half-width (1) beyond its corners.
    assert.deepEqual(clampShift([rect("a", 10, 10), rect("b", 300, 200)], frame, 100, -50), [49, -9]);
    assert.deepEqual(clampShift([rect("a", 10, 10)], frame, 5, 5), [5, 5], "a move that stays inside is untouched");
  });

  it("fits what's dropped near an edge inside, and refuses what's too big", () => {
    const moved = fitInside(rect("a", 380, 290), frame) as unknown as { x1: number; y1: number };
    assert.deepEqual([moved.x1, moved.y1], [349, 249]);
    assert.equal(fitInside(rect("a", 10, 10, 500), frame), null);
  });

  it("keeps what a student makes inside the frame as it's drawn, so the frame holds it", () => {
    const touching = rect("edge", 350, 10); // its outline reaches past the frame's right edge
    assert.equal(canChange(touching, frame), true, "it may still be picked and changed");
    assert.equal(staysInside(touching, frame), false, "but not left there by a change");
    assert.ok(
      !frameContents([frame, touching], frame).some((element) => element.id === "edge"),
      "the frame wouldn't hold it",
    );
    const kept = rect("kept", 340, 10);
    assert.equal(staysInside(kept, frame), true);
    assert.ok(
      frameContents([frame, kept], frame).some((element) => element.id === "kept"),
      "this the frame holds",
    );
    assert.equal(staysInside({ ...frame, id: "g", x1: 10, y1: 10, x2: 20, y2: 20 }, frame), false, "never a frame");
  });

  it("leaves room at the edge for a stroke, wider for a pen or an arrowhead", () => {
    assert.equal(edgeRoom({ type: "pen", penSize: 8 }), 5);
    assert.equal(edgeRoom({ type: "rectangle", strokeWidth: 2 }), 5);
    assert.ok(edgeRoom({ type: "arrow", strokeWidth: 2 }) > edgeRoom({ type: "rectangle", strokeWidth: 2 }));
  });

  it("finds the innermost frame under a point", () => {
    const inner: FrameElement = { ...frame, id: "inner", x1: 100, y1: 100, x2: 200, y2: 200 };
    assert.equal(frameAt([inner, frame], { x: 150, y: 150 })?.id, "inner");
    assert.equal(frameAt([frame, inner], { x: 50, y: 50 })?.id, "f");
    assert.equal(frameAt([frame], { x: 500, y: 50 }), null);
  });
});

describe("a removal the server kept", () => {
  it("comes back on this screen, and isn't remembered as removed", () => {
    const store = createBoardStore();
    const box = rect("box", 10, 10);
    store.applyRemote({ upsert: [box] });
    store.commit({ undo: { upsert: [box] }, redo: { remove: ["box"] } });
    assert.equal(store.getElement("box"), undefined);
    store.reconcile({ restored: [box] });
    assert.equal(store.getElement("box")?.id, "box");
    assert.ok(!store.removedStamps().some(({ id }) => id === "box"), "not remembered as removed");
  });
});

describe("copies of a frame for a class", () => {
  it("go in rows to the right of everything, as near square as can be", () => {
    const board = [frame, { ...frame, id: "far", x1: 900, x2: 950 }];
    const offsets = copyGrid(board, frame, 5, 80);
    assert.equal(offsets.length, 5);
    const columns = new Set(offsets.map(([dx]) => dx));
    assert.equal(columns.size, 3, "three columns for five");
    assert.ok(Math.min(...columns) > 950 - frame.x1, "beyond everything on the board");
    assert.ok(offsets[3][1] > offsets[0][1], "the fourth starts a new row");
  });

  it("are named on from the frame's name, skipping names taken", () => {
    const board = [{ ...frame, name: "Group 2" }];
    assert.deepEqual(copyNames(board, "Group 2", 3), ["Group 1", "Group 3", "Group 4"]);
    assert.deepEqual(copyNames([], "Worksheet", 2), ["Worksheet 1", "Worksheet 2"]);
    assert.deepEqual(copyNames([], "", 1), ["Frame 1"]);
  });
});
