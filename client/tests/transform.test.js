import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// Text is measured with a canvas, which Node doesn't have. This stand-in makes each character half
// as wide as the font is tall, so text scales with its font size as it does in a browser.
before(() => {
  const context = {
    font: "",
    measureText: (text) => ({ width: text.length * (parseFloat(context.font) / 2) }),
  };
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
});

const { getBounds, getFrame, hitTest } = await import("../src/features/board/elements.js");
const { cursorForHandle, getSelectionBox, handleAt, resizeElement, rotateElement } =
  await import("../src/features/board/transform.js");
const { rotatePoint, rotatedRectBounds } = await import("../src/features/board/geometry.js");

const near = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
const nearPoint = (actual, expected, message) => {
  near(actual[0], expected[0], `${message} (x)`);
  near(actual[1], expected[1], `${message} (y)`);
};

const rect = (overrides = {}) => ({
  id: "r",
  type: "rectangle",
  seed: 1,
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 60,
  stroke: "#000",
  fill: null,
  strokeWidth: 2.5,
  sketchy: false,
  ...overrides,
});
const pen = (overrides = {}) => ({
  id: "p",
  type: "pen",
  points: [
    [0, 0, 0.5],
    [100, 0, 0.5],
    [100, 50, 0.5],
  ],
  stroke: "#000",
  penSize: 8,
  ...overrides,
});
const box = (element) => {
  const frame = getFrame(element);
  return {
    x1: frame.cx - frame.width / 2,
    y1: frame.cy - frame.height / 2,
    x2: frame.cx + frame.width / 2,
    y2: frame.cy + frame.height / 2,
  };
};
const handle = (element, id, zoom = 1) => getSelectionBox(element, zoom).handles.find((h) => h.id === id);

describe("turning points and boxes", () => {
  it("turns a point about a centre", () => {
    nearPoint(rotatePoint(10, 0, 0, 0, Math.PI / 2), [0, 10], "quarter turn");
    nearPoint(rotatePoint(5, 5, 5, 5, 1.2), [5, 5], "the centre stays put");
    assert.deepEqual(rotatePoint(3, 4, 0, 0, 0), [3, 4]);
  });

  it("finds the upright box around a turned rectangle", () => {
    const quarter = rotatedRectBounds({ x: 0, y: 0, width: 100, height: 50 }, Math.PI / 2);
    near(quarter.width, 50, "width after a quarter turn");
    near(quarter.height, 100, "height after a quarter turn");
    near(quarter.x + quarter.width / 2, 50, "still centred");
    const eighth = rotatedRectBounds({ x: 0, y: 0, width: 100, height: 100 }, Math.PI / 4);
    near(eighth.width, 141.4213562, "a square turned 45 degrees", 1e-5);
  });

  it("uses the turned size for an element's bounds", () => {
    const turned = rect({ angle: Math.PI / 2 });
    const upright = getBounds(rect());
    const bounds = getBounds(turned);
    near(bounds.width, upright.height, "width and height swap");
    near(bounds.height, upright.width, "width and height swap");
  });
});

describe("hit testing turned elements", () => {
  it("follows the turned shape, not its old position", () => {
    // 100 wide, 20 tall, turned a quarter turn about (50, 10): now 20 wide, 100 tall.
    const bar = rect({ x1: 0, y1: 0, x2: 100, y2: 20, fill: "#ccc", angle: Math.PI / 2 });
    assert.equal(hitTest(bar, 50, 55, 2), true, "the upper end of the turned bar");
    assert.equal(hitTest(bar, 5, 10, 2), false, "where the bar used to be");
    assert.equal(hitTest(bar, 50, -35, 2), true, "the lower end of the turned bar");
  });

  it("still hits unturned elements the same way", () => {
    assert.equal(hitTest(rect({ fill: "#ccc" }), 50, 30, 2), true);
    assert.equal(hitTest(rect({ fill: "#ccc" }), 300, 30, 2), false);
  });
});

describe("selection handles", () => {
  it("puts eight handles and a turn handle on a box, and fewer on text", () => {
    assert.equal(getSelectionBox(rect(), 1).handles.length, 9);
    const text = { id: "t", type: "text", x1: 0, y1: 0, text: "hello", stroke: "#000", fontSize: 20, font: "hand" };
    assert.equal(getSelectionBox(text, 1).handles.length, 5, "four corners plus turn");
  });

  it("puts one handle on each end of a line or arrow", () => {
    const line = { id: "l", type: "arrow", x1: 0, y1: 0, x2: 50, y2: 20, strokeWidth: 2, stroke: "#000" };
    assert.deepEqual(
      getSelectionBox(line, 1).handles.map((h) => h.id),
      ["start", "end"],
    );
  });

  it("keeps handles a steady size on screen as you zoom", () => {
    const gap1 = handle(rect(), "se", 1).x - 100;
    const gap4 = handle(rect(), "se", 4).x - 100;
    // Part of the gap covers the stroke and stays put; the 6 screen pixels of breathing room shrink with zoom.
    near(gap1 - gap4, 6 - 6 / 4, "the breathing room is 6 screen pixels at any zoom");
  });

  it("follows the element when it is turned", () => {
    const upright = handle(rect(), "e");
    const turned = handle(rect({ angle: Math.PI / 2 }), "e");
    assert.ok(Math.abs(upright.y - 30) < 1e-6);
    assert.ok(Math.abs(turned.x - 50) < 1e-6, "the east handle swings round to the bottom");
    assert.ok(turned.y > 30);
  });

  it("finds the handle under a point, preferring corners, and nothing in empty space", () => {
    const se = handle(rect(), "se");
    assert.equal(handleAt(rect(), { x: se.x + 2, y: se.y + 1 }, 1), "se");
    const rotate = handle(rect(), "rotate");
    assert.equal(handleAt(rect(), { x: rotate.x, y: rotate.y }, 1), "rotate");
    assert.equal(handleAt(rect(), { x: 50, y: 30 }, 1), null);
  });

  it("shows a cursor that matches the way the handle pulls, even when turned", () => {
    assert.equal(cursorForHandle("e", 0), "ew-resize");
    assert.equal(cursorForHandle("n", 0), "ns-resize");
    assert.equal(cursorForHandle("se", 0), "nwse-resize");
    assert.equal(cursorForHandle("ne", 0), "nesw-resize");
    assert.equal(
      cursorForHandle("e", Math.PI / 2),
      "ns-resize",
      "an east handle on a quarter-turned box pulls vertically",
    );
    assert.equal(cursorForHandle("rotate"), "grab");
  });
});

describe("resizing", () => {
  it("drags a corner and keeps the opposite corner fixed", () => {
    const resized = resizeElement(rect(), "se", { x: 150, y: 90 });
    assert.deepEqual(box(resized), { x1: 0, y1: 0, x2: 150, y2: 90 });
  });

  it("drags an edge and leaves the other dimension alone", () => {
    const resized = resizeElement(rect(), "e", { x: 180, y: 999 });
    assert.deepEqual(box(resized), { x1: 0, y1: 0, x2: 180, y2: 60 });
    const top = resizeElement(rect(), "n", { x: 999, y: -40 });
    assert.deepEqual(box(top), { x1: 0, y1: -40, x2: 100, y2: 60 });
  });

  it("works from the top-left too", () => {
    const resized = resizeElement(rect(), "nw", { x: -20, y: -10 });
    assert.deepEqual(box(resized), { x1: -20, y1: -10, x2: 100, y2: 60 });
  });

  it("won't shrink below a minimum or flip over", () => {
    const resized = resizeElement(rect(), "se", { x: -500, y: -500 });
    const { x1, y1, x2, y2 } = box(resized);
    assert.ok(x2 - x1 >= 4 && y2 - y1 >= 4);
    near(x1, 0, "the fixed corner didn't move");
    near(y1, 0, "the fixed corner didn't move");
  });

  it("keeps proportions on corners with Shift", () => {
    const resized = resizeElement(rect(), "se", { x: 200, y: 70 }, { keepAspect: true });
    const { x1, y1, x2, y2 } = box(resized);
    near((x2 - x1) / (y2 - y1), 100 / 60, "aspect ratio");
    near(x2 - x1, 200, "the larger pull wins");
  });

  it("keeps the opposite corner fixed when the element is turned", () => {
    const turned = rect({ angle: Math.PI / 6 });
    const before = getSelectionBox(turned, 1);
    const fixedBefore = before.handles.find((h) => h.id === "nw");
    // Drag the south-east handle outwards along the turned axes.
    const target = rotatePoint(160, 80, 50, 30, Math.PI / 6);
    const resized = resizeElement(turned, "se", { x: target[0], y: target[1] });
    const after = getSelectionBox(resized, 1);
    const fixedAfter = after.handles.find((h) => h.id === "nw");
    // The padded handle sits a fixed gap from the frame corner, so compare the frame corner itself.
    const corner = (element) => {
      const f = getFrame(element);
      return rotatePoint(f.cx - f.width / 2, f.cy - f.height / 2, f.cx, f.cy, f.angle);
    };
    nearPoint(corner(resized), corner(turned), "the opposite corner stayed in place");
    assert.ok(fixedBefore && fixedAfter);
    assert.equal(resized.angle, Math.PI / 6, "the angle is untouched");
    near(getFrame(resized).width, 160, "new width along the turned axis", 1e-6);
    near(getFrame(resized).height, 80, "new height along the turned axis", 1e-6);
  });

  it("allows for the gap between element and handle, so nothing jumps when a drag starts", () => {
    const pad = 8;
    const se = handle(rect(), "se", 1);
    const resized = resizeElement(rect(), "se", { x: se.x, y: se.y }, { pad: getSelectionBox(rect(), 1).pad });
    assert.deepEqual(box(resized), { x1: 0, y1: 0, x2: 100, y2: 60 });
    assert.ok(pad > 0);
  });

  it("scales a pen stroke about the fixed side", () => {
    const resized = resizeElement(pen(), "se", { x: 200, y: 100 });
    const xs = resized.points.map((p) => p[0]);
    const ys = resized.points.map((p) => p[1]);
    near(Math.min(...xs), 0, "left edge stays");
    near(Math.max(...xs), 200, "right edge follows the pointer");
    near(Math.min(...ys), 0, "top edge stays");
    near(Math.max(...ys), 100, "bottom edge follows the pointer");
    assert.equal(resized.points[0][2], 0.5, "pressure is kept");
    assert.equal(resized.penSize, 8);
  });

  it("doesn't blow up on a perfectly straight stroke", () => {
    const straight = pen({
      points: [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
    });
    const resized = resizeElement(straight, "s", { x: 50, y: 40 });
    assert.ok(resized.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  });

  it("moves one end of a line or arrow, with 15 degree steps on Shift", () => {
    const line = { id: "l", type: "line", x1: 0, y1: 0, x2: 100, y2: 0, strokeWidth: 2, stroke: "#000" };
    const free = resizeElement(line, "end", { x: 40, y: 70 });
    assert.deepEqual([free.x2, free.y2], [40, 70]);
    assert.deepEqual([free.x1, free.y1], [0, 0]);

    const startMoved = resizeElement(line, "start", { x: -30, y: 20 });
    assert.deepEqual([startMoved.x1, startMoved.y1], [-30, 20]);
    assert.deepEqual([startMoved.x2, startMoved.y2], [100, 0]);

    const snapped = resizeElement(line, "end", { x: 100, y: 3 }, { keepAspect: true });
    near(snapped.y2, 0, "snapped to horizontal", 1e-6);
  });

  it("scales text by changing its font size, keeping the opposite corner", () => {
    const text = { id: "t", type: "text", x1: 100, y1: 100, text: "hello", stroke: "#000", fontSize: 20, font: "hand" };
    const frame = getFrame(text);
    const resized = resizeElement(text, "se", { x: 100 + frame.width * 2, y: 100 + frame.height * 2 });
    assert.equal(resized.fontSize, 40);
    near(resized.x1, 100, "left edge stays", 1e-6);
    near(resized.y1, 100, "top edge stays", 1e-6);
    const tiny = resizeElement(text, "se", { x: 101, y: 101 });
    assert.equal(tiny.fontSize, 8, "never smaller than the minimum");
    const huge = resizeElement(text, "se", { x: 100000, y: 100000 });
    assert.equal(huge.fontSize, 400, "never larger than the maximum");
  });

  it("doesn't change the original element", () => {
    const original = Object.freeze(rect());
    assert.doesNotThrow(() => resizeElement(original, "se", { x: 10, y: 10 }));
    assert.equal(original.x2, 100);
  });
});

describe("turning", () => {
  it("turns by the swing of the pointer around the centre", () => {
    const turned = rotateElement(rect(), { x: 50, y: -50 }, { x: 150, y: 30 });
    near(turned.angle, Math.PI / 2, "a quarter turn clockwise");
  });

  it("adds to an angle the element already has", () => {
    const turned = rotateElement(rect({ angle: 0.5 }), { x: 50, y: -50 }, { x: 150, y: 30 });
    near(turned.angle, 0.5 + Math.PI / 2, "keeps turning from where it was");
  });

  it("snaps to 15 degree steps with Shift", () => {
    const start = { x: 50, y: -50 };
    const end = rotatePoint(50, -50, 50, 30, (31 * Math.PI) / 180);
    const turned = rotateElement(rect(), start, { x: end[0], y: end[1] }, { snap: true });
    near(turned.angle, (30 * Math.PI) / 180, "31 degrees snaps to 30");
  });

  it("keeps the angle within a half turn either way", () => {
    const turned = rotateElement(rect({ angle: 3 }), { x: 50, y: -50 }, { x: 150, y: 30 });
    assert.ok(turned.angle <= Math.PI && turned.angle > -Math.PI);
  });

  it("turns strokes and leaves lines alone", () => {
    assert.ok(Math.abs(rotateElement(pen(), { x: 50, y: -50 }, { x: 150, y: 30 }).angle) > 1);
    const line = { id: "l", type: "line", x1: 0, y1: 0, x2: 10, y2: 10, strokeWidth: 2, stroke: "#000" };
    assert.equal(rotateElement(line, { x: 0, y: 0 }, { x: 5, y: 5 }), line);
  });

  it("keeps a stroke's points as they are, so turning is undoable and lossless", () => {
    const turned = rotateElement(pen(), { x: 50, y: -50 }, { x: 150, y: 30 });
    assert.deepEqual(turned.points, pen().points);
  });
});
