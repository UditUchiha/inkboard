import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShapeElement } from "@inkboard/shared/types";
import { HOLD_MS, loopTime, polyline, stateAt } from "../src/features/landing/lib/showcase.ts";
import type { Scene } from "../src/features/landing/lib/showcase.ts";

const maya = { name: "Maya", color: "#c2410c" };
const box = (id: string): ShapeElement => ({
  id,
  type: "rectangle",
  seed: 1,
  x1: 0,
  y1: 0,
  x2: 10,
  y2: 10,
  stroke: "#000",
  fill: null,
  strokeWidth: 2,
  sketchy: true,
});
const stroke = polyline("s", "#000", [
  [0, 0],
  [10, 0],
  [20, 0],
  [30, 0],
]);

const scene: Scene = {
  duration: 3000,
  steps: [
    { at: 0, add: box("a") },
    { at: 500, stroke, over: 1000, by: maya },
    { at: 1000, suggest: box("b"), by: maya },
    { at: 1200, note: "Maya suggested a step" },
    { at: 2000, accept: "b" },
    { at: 2000, note: null },
    { at: 2500, remove: "a" },
  ],
};

describe("a showcase scene", () => {
  it("shows what has happened so far and nothing after", () => {
    const start = stateAt(scene, 0);
    assert.deepEqual(
      start.elements.map((element) => element.id),
      ["a"],
    );
    assert.equal(start.suggestions.length, 0);
    assert.equal(stateAt(scene, 1200).note, "Maya suggested a step");
    assert.equal(stateAt(scene, 2600).note, null);
  });

  it("draws a stroke point by point, with its author's cursor at the tip", () => {
    const half = stateAt(scene, 1000);
    const drawn = half.elements.find((element) => element.id === "s");
    const drawnPoints = drawn?.type === "pen" ? drawn.points.length : 0;
    assert.ok(drawnPoints > 1 && drawnPoints < stroke.points.length, `${drawnPoints} of ${stroke.points.length}`);
    assert.equal(half.cursors[0]?.by, maya);
    const done = stateAt(scene, 1600);
    const finished = done.elements.find((element) => element.id === "s");
    assert.equal(finished?.type === "pen" && finished.points.length, stroke.points.length);
    assert.equal(done.cursors.length, 0);
  });

  it("turns an accepted suggestion into part of the board", () => {
    const pending = stateAt(scene, 1500);
    assert.equal(pending.suggestions[0]?.element.id, "b");
    assert.ok(!pending.elements.some((element) => element.id === "b"));
    const accepted = stateAt(scene, 2000);
    assert.equal(accepted.suggestions.length, 0);
    assert.ok(accepted.elements.some((element) => element.id === "b"));
    assert.ok(!stateAt(scene, 2500).elements.some((element) => element.id === "a"));
  });

  it("holds at the end, then loops", () => {
    assert.equal(loopTime(scene, 3000 + HOLD_MS - 1), 3000 + HOLD_MS - 1);
    assert.equal(loopTime(scene, 3000 + HOLD_MS + 10), 10);
  });
});
