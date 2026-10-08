import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createImage, duplicate, getBounds, hitTest, translate } = await import("../src/features/board/elements.js");
const { getSelectionBox, resizeElement, rotateElement } = await import("../src/features/board/transform.js");
const { fitWithin, isImageFile, placementSize } = await import("../src/features/board/images.js");

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${message}: expected ${expected}, got ${actual}`);

const picture = (overrides = {}) => ({
  id: "pic",
  type: "image",
  imageId: "a".repeat(32),
  x1: 100,
  y1: 50,
  x2: 300,
  y2: 150,
  ...overrides,
});

describe("shrinking a picture before upload", () => {
  it("scales the longer side down to the limit and keeps the proportions", () => {
    assert.deepEqual(fitWithin(4000, 3000, 2000), { width: 2000, height: 1500 });
    assert.deepEqual(fitWithin(1000, 4000, 2000), { width: 500, height: 2000 });
  });

  it("never scales a picture up, and never collapses one to nothing", () => {
    assert.deepEqual(fitWithin(800, 600, 2000), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(5000, 1, 2000), { width: 2000, height: 1 });
  });

  it("recognises the four formats the server takes, and nothing else", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"])
      assert.equal(isImageFile({ type }), true);
    for (const type of ["image/svg+xml", "application/pdf", "text/html", ""])
      assert.equal(isImageFile({ type }), false);
    assert.equal(isImageFile(undefined), false);
  });
});

describe("placing a new picture", () => {
  const screen = { width: 1000, height: 800 };

  it("keeps a small picture at its own size", () => {
    assert.deepEqual(placementSize({ width: 200, height: 100 }, screen), { width: 200, height: 100 });
  });

  it("shrinks a large picture to 60% of the screen, keeping its proportions", () => {
    const size = placementSize({ width: 2000, height: 1000 }, screen);
    near(size.width, 600, "width");
    near(size.height, 300, "height");
    const tall = placementSize({ width: 1000, height: 2000 }, screen);
    near(tall.height, 480, "tall height");
    near(tall.width / tall.height, 0.5, "tall proportions");
  });

  it("makes a picture that fits the board's visible area when zoomed in", () => {
    // Zoomed in 4x, the screen shows 250 x 200 board units.
    const size = placementSize({ width: 2000, height: 1000 }, { width: 250, height: 200 });
    near(size.width, 150, "width");
  });
});

describe("pictures as board elements", () => {
  it("is created from where it goes and how big it is", () => {
    const element = createImage("b".repeat(32), { x: 10, y: 20 }, { width: 300, height: 200 });
    assert.equal(element.type, "image");
    assert.deepEqual([element.x1, element.y1, element.x2, element.y2], [10, 20, 310, 220]);
    assert.ok(element.id);
  });

  it("measures exactly its own rectangle, with no stroke around it", () => {
    assert.deepEqual(getBounds(picture()), { x: 100, y: 50, width: 200, height: 100 });
  });

  it("is hit anywhere inside, and just outside by the tolerance", () => {
    const element = picture();
    assert.equal(hitTest(element, 200, 100, 0), true);
    assert.equal(hitTest(element, 99, 100, 0), false);
    assert.equal(hitTest(element, 97, 100, 4), true);
    assert.equal(hitTest(element, 200, 400, 4), false);
  });

  it("is hit where it is drawn when turned, not where it was", () => {
    // A quarter turn about its centre (200, 100) makes it 100 wide and 200 tall.
    const turned = picture({ angle: Math.PI / 2 });
    assert.equal(hitTest(turned, 200, 10, 0), true);
    assert.equal(hitTest(turned, 120, 100, 0), false);
  });

  it("moves and duplicates without losing which image it shows", () => {
    const moved = translate(picture(), 10, -5);
    assert.deepEqual([moved.x1, moved.y1, moved.x2, moved.y2], [110, 45, 310, 145]);
    const copy = duplicate(picture());
    assert.notEqual(copy.id, "pic");
    assert.equal(copy.imageId, "a".repeat(32));
    assert.ok(!("seed" in copy));
  });
});

describe("resizing and turning a picture", () => {
  it("shows eight resize handles and a turn handle", () => {
    const ids = getSelectionBox(picture(), 1).handles.map((handle) => handle.id);
    assert.deepEqual(new Set(ids), new Set(["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"]));
  });

  it("keeps its proportions when dragged by a corner, even without Shift", () => {
    // Drag the bottom right corner well to the right, and only a little down.
    const next = resizeElement(picture(), "se", { x: 500, y: 160 });
    assert.deepEqual([next.x1, next.y1], [100, 50], "the opposite corner stays put");
    const width = next.x2 - next.x1;
    const height = next.y2 - next.y1;
    near(width / height, 2, "proportions");
    assert.ok(width >= 400, `grew with the larger pull, got ${width}`);
  });

  it("stretches when dragged by a side", () => {
    const next = resizeElement(picture(), "e", { x: 500, y: 999 });
    assert.deepEqual([next.x1, next.y1, next.y2], [100, 50, 150]);
    near(next.x2, 500, "right edge");
  });

  it("turns and keeps everything else about it", () => {
    const next = rotateElement(picture(), { x: 200, y: 0 }, { x: 300, y: 100 });
    near(next.angle, Math.PI / 2, "angle");
    assert.equal(next.imageId, "a".repeat(32));
  });
});
