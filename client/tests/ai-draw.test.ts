import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, ShapeElement, StickyElement } from "@inkboard/shared/types";
import { answerToElements, boardContext, OUTPUT_SCHEMA, requestMessage } from "../src/features/board/aiDraw.ts";

const box = (id: string, x: number): ShapeElement =>
  ({
    id,
    type: "rectangle",
    x1: x,
    y1: 0,
    x2: x + 100,
    y2: 50,
    stroke: "#16213a",
    strokeWidth: 2,
    seed: 1,
  }) as ShapeElement;
const view = { x: 0, y: 0, width: 1000, height: 600 };

describe("drawing with AI", () => {
  it("turns Claude's answer into board elements, arrows attached whatever order they came in", () => {
    const { elements, skipped } = answerToElements(
      {
        elements: [
          { id: "ai-link", type: "arrow", from: "ai-a", to: "ai-b" },
          { id: "ai-a", type: "sticky", x: 0, y: 0, width: 200, height: 200, text: "Idea" },
          { id: "ai-b", type: "ellipse", x: 400, y: 0, width: 160, height: 80 },
        ],
      },
      [],
    );
    assert.equal(skipped, 0);
    assert.deepEqual(elements.map((element) => element.id).sort(), ["ai-a", "ai-b", "ai-link"]);
    const arrow = elements.find((element) => element.id === "ai-link") as ShapeElement;
    assert.deepEqual([arrow.startId, arrow.endId], ["ai-a", "ai-b"]);
  });

  it("changes elements already on the board, keeps what it isn't told, and skips what can't be drawn", () => {
    const board: Element[] = [box("old", 0)];
    const { elements, skipped } = answerToElements(
      {
        elements: [
          { id: "old", fill: "#ffc9c9" },
          { id: "ai-loose", type: "arrow", to: "nowhere" }, // no coordinates, and attached to nothing
        ],
      },
      board,
    );
    assert.equal(skipped, 1);
    const changed = elements[0] as ShapeElement;
    assert.deepEqual([changed.id, changed.fill, changed.x2], ["old", "#ffc9c9", 100]);
  });

  it("refuses an answer that isn't a list of elements", () => {
    assert.throws(() => answerToElements({ shapes: [] }, []), /couldn't be read/);
  });

  it("describes a big board by what's in view only", () => {
    const many = Array.from({ length: 400 }, (_, i) => box(`b${i}`, i * 200));
    const described = boardContext(many, view);
    assert.ok(described.length < 10, "only the few boxes in the visible area");
    assert.ok(described.every((element) => (element.x as number) <= 1000)); // touching the edge counts as in view
    const message = requestMessage("Add a title", [box("a", 0)], view);
    assert.match(message, /Visible area: \{"x":0,"y":0,"width":1000,"height":600\}/);
    assert.match(message, /Request: Add a title$/);
  });

  it("asks for an answer whose every element needs an id and a type, and nothing else unknown", () => {
    const items = OUTPUT_SCHEMA.properties.elements.items;
    assert.deepEqual(items.required, ["id", "type"]);
    assert.equal(items.additionalProperties, false);
    for (const field of items.required) assert.ok(field in items.properties);
    const sticky = answerToElements({ elements: [{ id: "n", type: "sticky", x: 0, y: 0, width: 1, height: 1 }] }, [])
      .elements[0] as StickyElement;
    assert.equal(sticky.text, "", "a note without text is still a note");
  });
});
