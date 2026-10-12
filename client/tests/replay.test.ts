import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReplayStep } from "@inkboard/shared/socket";
import type { Element, ShapeElement } from "@inkboard/shared/types";
import { createReplay } from "../src/features/board/replay.ts";

const box = (id: string, x: number, index = "a0"): ShapeElement =>
  ({
    id,
    type: "rectangle",
    x1: x,
    y1: 0,
    x2: x + 10,
    y2: 10,
    index,
    stroke: "#000",
    strokeWidth: 2,
    seed: 1,
  }) as ShapeElement;
const ids = (elements: Element[]) => elements.map((element) => element.id);
const left = (elements: Element[]) => (elements[0] as ShapeElement).x1;

describe("a replay", () => {
  const steps: ReplayStep[] = [
    { at: 1, upsert: [box("a", 0, "a0")], remove: [] },
    { at: 2, upsert: [box("b", 100, "a1")], remove: [] },
    { at: 3, upsert: [], remove: ["a"] },
  ];

  it("shows the board after each step, then as it is now, in stack order", () => {
    const now = [box("b", 100, "a1"), box("c", 300, "a2")];
    const replay = createReplay(steps, now);
    assert.equal(replay.length, 4);
    assert.deepEqual(ids(replay.frameAt(0)), ["a"]);
    assert.deepEqual(ids(replay.frameAt(1)), ["a", "b"]);
    assert.deepEqual(ids(replay.frameAt(2)), ["b"]);
    assert.equal(replay.frameAt(3), now);
    assert.deepEqual([replay.timeAt(2), replay.timeAt(3)], [3, null]);
  });

  it("keeps one view that holds everything ever drawn in it", () => {
    const bounds = createReplay(steps, [box("c", 300)]).bounds!;
    assert.ok(bounds.x <= 0 && bounds.x > -10);
    assert.ok(bounds.x + bounds.width >= 310 && bounds.x + bounds.width < 320);
  });

  it("finds any step of a long one", () => {
    const long = Array.from({ length: 130 }, (_, i): ReplayStep => ({ at: i, upsert: [box("a", i)], remove: [] }));
    const replay = createReplay(long, []);
    assert.equal(left(replay.frameAt(117)), 117);
    assert.equal(left(replay.frameAt(49)), 49);
    assert.equal(left(replay.frameAt(50)), 50);
  });
});
