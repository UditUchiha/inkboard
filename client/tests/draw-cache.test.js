import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDrawingCache, movedBy } from "../src/features/board/drawCache.ts";
import { shapePaths } from "../src/features/board/renderer.js";
import { resolveConnectors } from "../src/features/board/connectors.ts";
import { translate } from "../src/features/board/elements.ts";

const rect = (id, x = 0, y = 0, extra = {}) => ({
  id,
  type: "rectangle",
  seed: 11,
  x1: x,
  y1: y,
  x2: x + 120,
  y2: y + 70,
  stroke: "#16213a",
  fill: "#ffc9c9",
  strokeWidth: 2,
  sketchy: true,
  ...extra,
});
const pen = (id, dx = 0) => ({
  id,
  type: "pen",
  points: [
    [0 + dx, 0, 0.5],
    [10 + dx, 4.5, 0.5],
    [25 + dx, 9, 0.6],
  ],
  pressure: true,
  stroke: "#000000",
  penSize: 6,
});

describe("shapes moved by a drag", () => {
  it("are recognised as the same drawing, however far along", () => {
    const start = rect("a", 10, 20);
    assert.deepEqual(movedBy(start, translate(start, 300.5, -40.25)), { dx: 300.5, dy: -40.25 });
    assert.deepEqual(movedBy(start, start), { dx: 0, dy: 0 });
    const ellipse = rect("e", 0, 0, { type: "ellipse" });
    assert.deepEqual(movedBy(ellipse, translate(ellipse, 5, 6)), { dx: 5, dy: 6 });
    const stroke = pen("p");
    assert.deepEqual(movedBy(stroke, translate(stroke, 100, 50)), { dx: 100, dy: 50 });
  });

  it("are not when anything else about them differs", () => {
    const start = rect("a");
    assert.equal(movedBy(start, { ...start, x2: start.x2 + 1 }), null, "resized");
    assert.equal(movedBy(start, translate({ ...start, stroke: "#ff0000" }, 5, 5)), null, "recoloured");
    assert.equal(movedBy(start, translate({ ...start, seed: 12 }, 5, 5)), null, "new wobble");
    assert.equal(movedBy(start, { ...start, type: "ellipse" }), null);
    assert.equal(movedBy(start, { ...start, type: "arrow" }), null);
    const stroke = pen("p");
    assert.equal(movedBy(stroke, { ...stroke, points: [...stroke.points, [30, 9, 0.6]] }), null, "longer");
    assert.equal(movedBy(stroke, translate({ ...stroke, penSize: 8 }, 5, 5)), null, "thicker");
    const bent = { ...stroke, points: stroke.points.map(([x, y, p], i) => [x + 5, y + (i === 1 ? 7 : 5), p]) };
    assert.equal(movedBy(stroke, bent), null, "not moved as one");
  });

  it("are drawn from what was built once, however many steps the drag takes", () => {
    const cache = createDrawingCache();
    let built = 0;
    const build = () => ({ id: (built += 1) });
    const original = rect("a", 0, 0);
    const first = cache.get(original, build);
    for (let step = 1; step <= 100; step += 1) {
      const entry = cache.get(translate(original, step * 3, step * 2), build);
      assert.equal(entry.built, first.built);
      assert.deepEqual([entry.dx, entry.dy], [step * 3, step * 2]);
    }
    assert.equal(built, 1, "built once for a hundred copies");
    // The same copy again is the same entry, and a copy of the copy is still measured from the original.
    const moved = translate(original, 7, 7);
    assert.equal(cache.get(moved, build), cache.get(moved, build));
    assert.deepEqual((({ dx, dy }) => [dx, dy])(cache.get(translate(moved, 3, 3), build)), [10, 10]);
    assert.equal(built, 1);
    // Anything but a move builds a new drawing.
    cache.get({ ...original, x2: 500 }, build);
    cache.get(rect("b", 0, 0), build);
    assert.equal(built, 3);
  });

  it("forgets the shapes it remembers by id once the board is far smaller than they were", () => {
    const cache = createDrawingCache();
    let built = 0;
    const build = () => ({ id: (built += 1) });
    const elements = Array.from({ length: 1200 }, (_, i) => rect(`r${i}`, i, 0));
    for (const element of elements) cache.get(element, build);
    cache.trim(1200);
    assert.equal(cache.get(translate(elements[0], 4, 4), build).dx, 4, "a board that big keeps them");
    cache.trim(10);
    cache.get(translate(elements[0], 9, 9), build);
    assert.equal(built, 1201, "a small one lets go, so a moved copy is built afresh");
  });

  it("include lines and arrows, straight, curved or bent, but only when their whole path has moved", () => {
    const arrow = (extra = {}) => ({
      ...rect("c", 0, 0, { type: "arrow", fill: null }),
      x2: 200,
      y2: 90,
      startHead: false,
      route: "straight",
      ...extra,
    });
    for (const route of ["straight", "curved", "elbow"]) {
      const start = arrow({ route });
      assert.deepEqual(movedBy(start, translate(start, 40, -15)), { dx: 40, dy: -15 }, route);
      assert.equal(movedBy(start, { ...start, x2: 260 }), null, `${route}: one end moved`);
    }
    const start = arrow();
    assert.equal(movedBy(start, translate({ ...start, route: "elbow" }, 5, 5)), null, "rerouted");
    assert.equal(movedBy(start, translate({ ...start, startHead: true }, 5, 5)), null, "a head added");
    assert.equal(movedBy(start, translate({ ...start, type: "line" }, 5, 5)), null, "an arrow made a line");
    assert.equal(movedBy(start, translate({ ...start, strokeWidth: 4 }, 5, 5)), null, "thicker");
    assert.equal(movedBy(start, translate({ ...start, seed: 3 }, 5, 5)), null, "new wobble");
    assert.equal(movedBy(start, translate({ ...start, sketchy: false }, 5, 5)), null, "neat");

    // An elbow between two shapes, both dragged along with it: the same bends, so the same drawing.
    const board = (dx) => [
      rect("a", dx, 0),
      rect("b", 400 + dx, 300),
      { ...arrow({ route: "elbow" }), startId: "a", endId: "b", startAnchor: "right", endAnchor: "top" },
    ];
    const [before, after] = [resolveConnectors(board(0))[2], resolveConnectors(board(70))[2]];
    assert.deepEqual(movedBy(before, after), { dx: 70, dy: 0 });
    // Only one shape moved: the arrow's bends change, so it's drawn afresh.
    const one = board(0);
    one[0] = rect("a", 70, 0);
    assert.equal(movedBy(before, resolveConnectors(one)[2]), null);
  });

  it("really are the same drawing: Rough.js shapes keep their wobble wherever they are", () => {
    // What makes reusing a drawing valid. The outline moves exactly; the hatching of a fill only to within
    // a fraction of a board unit along its own lines, which nobody can see.
    const parts = (shape) => shapePaths(shape).map((path) => path.d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number));
    for (const type of ["rectangle", "ellipse"]) {
      for (const sketchy of [true, false]) {
        const shape = rect("s", 0, 0, { type, sketchy });
        const [dx, dy] = [312.5, -77.25];
        const [before, after] = [parts(shape), parts(translate(shape, dx, dy))];
        assert.equal(after.length, before.length);
        after.forEach((numbers, part) => {
          const outline = part === after.length - 1;
          numbers.forEach((value, i) => {
            const error = Math.abs(value - before[part][i] - (i % 2 === 0 ? dx : dy));
            assert.ok(error < (outline ? 1e-6 : 1), `${type} ${sketchy}: part ${part}, number ${i} is ${error} out`);
          });
        });
      }
    }
    // Lines and arrows, in every route, hand-drawn or not, move exactly, but for a hand-drawn curve's wobble,
    // which (like hatching) comes out a fraction of a unit differently elsewhere.
    for (const route of ["straight", "curved", "elbow"]) {
      for (const sketchy of [true, false]) {
        const arrow = { ...rect("s", 0, 0, { type: "arrow", sketchy }), x2: 240, y2: 130, route, startHead: true };
        const [dx, dy] = [312.5, -77.25];
        const [before, after] = [parts(arrow), parts(translate(arrow, dx, dy))];
        assert.equal(after.length, before.length);
        after.forEach((numbers, part) =>
          numbers.forEach((value, i) => {
            const error = Math.abs(value - before[part][i] - (i % 2 === 0 ? dx : dy));
            const allowed = route === "curved" && sketchy ? 1 : 1e-6;
            assert.ok(error < allowed, `${route} ${sketchy}: part ${part}, number ${i} is ${error} out`);
          }),
        );
      }
    }
  });
});
