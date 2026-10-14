import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element } from "@inkboard/shared/types";
import { DEFAULT_STYLE } from "../src/features/board/constants.ts";
import { describeElement } from "../src/features/board/elementLabels.ts";
import { boardOutline, placedElement } from "../src/features/board/elements.ts";
import type { OutlineNode } from "../src/features/board/elements.ts";
import { placeFree } from "../src/features/board/placement.ts";

const box = (id: string, x: number, y: number, size = 20) =>
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
const frame = (id: string, x: number, y: number, size: number) =>
  ({ id, type: "frame", x1: x, y1: y, x2: x + size, y2: y + size, name: id }) as unknown as Element;
const shape = (nodes: OutlineNode[]): unknown[] =>
  nodes.map(({ element, children }) => (children.length ? [element.id, shape(children)] : element.id));

describe("boardOutline", () => {
  it("nests elements under the innermost frame, each level read from the top, left to right", () => {
    const elements = [
      box("loose-below", 0, 900),
      frame("outer", 0, 0, 800),
      box("in-outer", 500, 10),
      frame("inner", 10, 100, 300),
      box("in-inner-right", 200, 120),
      box("in-inner-left", 20, 120),
      box("loose-right", 900, 0),
    ];
    assert.deepEqual(shape(boardOutline(elements)), [
      ["outer", ["in-outer", ["inner", ["in-inner-left", "in-inner-right"]]]],
      "loose-right",
      "loose-below",
    ]);
  });

  it("stops at the limit", () => {
    const elements = [box("a", 0, 0), box("b", 0, 50), box("c", 0, 100)];
    assert.deepEqual(shape(boardOutline(elements, 2)), ["a", "b"]);
  });
});

describe("describeElement with what a connector joins", () => {
  it("names both ends, after any label", () => {
    const elements = new Map([
      ["s", { type: "rectangle", text: "Start" }],
      ["e", { type: "ellipse" }],
    ]) as unknown as Map<string, Element>;
    const find = (id: string) => elements.get(id);
    const arrow = { type: "arrow", text: "", startId: "s", endId: "e" } as unknown as Element;
    assert.equal(describeElement(arrow, find), "Arrow from Rectangle: Start to Ellipse");
    assert.equal(
      describeElement({ ...arrow, text: "yes" } as Element, find),
      "Arrow: yes, from Rectangle: Start to Ellipse",
    );
    assert.equal(describeElement({ ...arrow, startId: null } as unknown as Element, find), "Arrow to Ellipse");
    assert.equal(describeElement(arrow), "Arrow", "without a way to find them, ends aren't named");
  });
});

describe("placedElement (drawing from the keyboard)", () => {
  it("centres a standard-size shape", () => {
    const first = placedElement("rectangle", { x: 0, y: 0 }, DEFAULT_STYLE, []) as Element & {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };
    assert.deepEqual([first.x1, first.y1, first.x2, first.y2], [-80, -50, 80, 50]);
  });

  it("names a frame", () => {
    const placed = placedElement("frame", { x: 0, y: 0 }, DEFAULT_STYLE, [frame("Frame 1", 0, 0, 10)]);
    assert.equal(placed.type === "frame" && placed.name, "Frame 2");
  });
});

describe("placeFree", () => {
  it("leaves a clear spot alone, moves off a shape beside it, and may go inside a frame", () => {
    const placed = box("new", 0, 0);
    assert.equal(placeFree([box("far", 500, 500)], placed), placed);
    const moved = placeFree([box("there", 0, 0)], placed) as typeof placed & { x1: number; y1: number };
    assert.ok(moved.x1 > 20 && moved.y1 === 0, "beside, to the right");
    assert.equal(placeFree([frame("f", -100, -100, 400)], placed), placed);
  });
});
