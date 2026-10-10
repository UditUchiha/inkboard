import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Text is measured with a canvas, which Node doesn't have: every character is 10 units wide.
globalThis.document ??= {
  createElement: () => ({ getContext: () => ({ font: "", measureText: (text) => ({ width: text.length * 10 }) }) }),
};

const { copyOffset } = await import("../src/features/board/placement.js");
const { copyGroup } = await import("../src/features/board/connectors.js");
const { getSceneBounds } = await import("../src/features/board/elements.js");
const { rectsOverlap } = await import("../src/features/board/geometry.js");

const frame = (id, x1, y1, x2, y2) => ({ id, type: "frame", x1, y1, x2, y2, name: "" });

describe("where a copy of a frame goes", () => {
  it("goes to the right when that is free", () => {
    const only = frame("a", 0, 0, 300, 200);
    assert.deepEqual(copyOffset([only], [only]), [380, 0]);
  });

  it("does not land on the next column of a row of frames", () => {
    const columns = [frame("a", 0, 0, 300, 400), frame("b", 340, 0, 640, 400), frame("c", 680, 0, 980, 400)];
    const [dx, dy] = copyOffset(columns, [columns[0]]);
    const [copy] = copyGroup(columns, [columns[0]], dx, dy);
    for (const other of columns) {
      assert.equal(rectsOverlap(getSceneBounds([copy]), getSceneBounds([other])), false, `overlaps ${other.id}`);
    }
  });

  it("goes below when there is no room beside", () => {
    const row = [frame("a", 0, 0, 300, 200), frame("b", 340, 0, 640, 200), frame("c", -340, 0, -40, 200)];
    const [dx, dy] = copyOffset(row, [row[0]]);
    assert.equal(dx, 0);
    assert.ok(dy > 200, `moved down by ${dy}`);
  });

  it("takes what is inside the frame into account", () => {
    const outer = frame("a", 0, 0, 300, 200);
    const note = {
      id: "n",
      type: "sticky",
      x1: 250,
      y1: 50,
      x2: 450,
      y2: 150,
      text: "",
      fill: "#ffec99",
      font: "hand",
    };
    const [dx, dy] = copyOffset([outer, note], [outer, note]);
    const [copy] = copyGroup([outer, note], [outer, note], dx, dy);
    assert.equal(rectsOverlap(getSceneBounds([copy]), getSceneBounds([outer, note])), false);
  });
});

describe("bringing an element into view", () => {
  it("leaves the view alone when any of the element is showing, and centres it otherwise", async () => {
    const { viewToReveal } = await import("../src/features/board/placement.js");
    const viewport = { x: 0, y: 0, zoom: 2 };
    const size = { width: 800, height: 600 }; // shows 400 x 300 units from the origin
    assert.equal(viewToReveal(viewport, size, { x: 390, y: 10, width: 100, height: 50 }), viewport);
    const next = viewToReveal(viewport, size, { x: 1000, y: 1000, width: 100, height: 60 });
    assert.equal(next.zoom, 2);
    assert.deepEqual([next.x, next.y], [200 - 1050, 150 - 1030]);
  });
});
