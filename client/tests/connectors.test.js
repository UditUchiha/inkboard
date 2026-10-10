import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIELD_GROUPS } from "@inkboard/shared/board-merge";
import {
  CONNECT_GAP,
  DOT_CORE,
  DOT_GAP,
  attachEnd,
  connectTargetAt,
  connectionAt,
  connectionDots,
  copyGroup,
  dotBeatsHandle,
  dotGrab,
  dotHover,
  facingSide,
  moveGroup,
  outlinePoint,
  readyToMove,
  releaseFrom,
  resolveConnectors,
} from "../src/features/board/connectors.js";
import {
  arrowHeads,
  connectorLabel,
  createElement,
  elementAt,
  frameContents,
  getLocalBounds,
  getSceneBounds,
  hitTest,
} from "../src/features/board/elements.js";
import { ELBOW_GAP, connectorPath, pathMiddle } from "../src/features/board/routes.js";
import { createBoardStore } from "../src/features/board/store.js";

// Text is measured with a canvas, which Node doesn't have: a stand-in measures 10 units a character.
const measuringDocument = {
  createElement: () => ({ getContext: () => ({ measureText: (value) => ({ width: value.length * 10 }) }) }),
};
globalThis.document ??= measuringDocument;

const shape = (id, x1, y1, x2, y2, type = "rectangle", extra = {}) => ({
  id,
  type,
  seed: 1,
  x1,
  y1,
  x2,
  y2,
  stroke: "#000000",
  fill: null,
  strokeWidth: 2,
  sketchy: false,
  ...extra,
});
const arrow = (id, startId, endId, extra = {}) => ({
  ...shape(id, 0, 0, 10, 10, "arrow"),
  ...(startId ? { startId } : {}),
  ...(endId ? { endId } : {}),
  ...extra,
});
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} ≈ ${expected}`);
const byId = (elements, id) => elements.find((element) => element.id === id);

// Two boxes side by side, 100 wide, with 200 between them, and an arrow from one to the other.
const board = () => [shape("a", 0, 0, 100, 100), shape("b", 300, 0, 400, 100), arrow("link", "a", "b")];
const EDGE = CONNECT_GAP + 1; // the gap, plus half a box's stroke

describe("attached connector ends", () => {
  it("are drawn at their shapes' outlines, aiming at each other's middle", () => {
    const drawn = byId(resolveConnectors(board()), "link");
    near(drawn.x1, 100 + EDGE);
    near(drawn.y1, 50);
    near(drawn.x2, 300 - EDGE);
    near(drawn.y2, 50);
  });

  it("follow a shape when it moves, with no change to the connector", () => {
    const moved = board().map((element) => (element.id === "b" ? shape("b", 300, 300, 400, 400) : element));
    const drawn = byId(resolveConnectors(moved), "link");
    // Diagonal from box to box, so it meets the moved box at its corner, plus the gap.
    near(drawn.x2, 300 - EDGE, "comes in at the corner");
    near(drawn.y2, 300 - EDGE);
  });

  it("stop at an ellipse's curve, and at a turned box's edge", () => {
    const circle = shape("c", 0, 0, 100, 100, "ellipse");
    const point = outlinePoint(circle, { x: 1000, y: 1000 });
    near(Math.hypot(point.x - 50, point.y - 50), 50 + EDGE, "on the circle, plus the gap");
    const turned = shape("t", 0, 0, 100, 100, "rectangle", { angle: Math.PI / 4 });
    const corner = outlinePoint(turned, { x: 1000, y: 50 });
    near(corner.y, 50);
    near(corner.x - 50, (50 + EDGE) * Math.SQRT2, "to the turned box's corner");
  });

  it("aim at the free end when only one end is attached", () => {
    const loose = [shape("a", 0, 0, 100, 100), { ...arrow("link", "a", null), x2: 50, y2: 500 }];
    const drawn = byId(resolveConnectors(loose), "link");
    near(drawn.x1, 50);
    near(drawn.y1, 100 + EDGE);
    assert.equal(drawn.x2, 50);
    assert.equal(drawn.y2, 500);
  });

  it("stay where they were stored when their shape is gone, or can't be connected to", () => {
    const gone = [shape("a", 0, 0, 100, 100), arrow("link", "a", "missing")];
    assert.equal(byId(resolveConnectors(gone), "link").x2, 10);
    const toLine = [shape("a", 0, 0, 100, 100), arrow("link", "a", "other"), arrow("other", null, null)];
    assert.equal(byId(resolveConnectors(toLine), "link").x2, 10);
  });

  it("leave a board without attachments as it is, and draw the same connector object while nothing moves", () => {
    const plain = [shape("a", 0, 0, 100, 100)];
    assert.equal(resolveConnectors(plain), plain);
    const first = resolveConnectors(board());
    const elements = board();
    const again = resolveConnectors([...elements]);
    assert.notEqual(first, again);
    assert.equal(byId(resolveConnectors(elements), "link"), byId(resolveConnectors([...elements]), "link"));
  });

  it("count where they're drawn for picking, frames and the board's bounds", () => {
    const elements = [
      { id: "f", type: "frame", x1: -50, y1: -50, x2: 450, y2: 150, name: "" },
      ...board(),
      { ...arrow("far", "a", null), x2: 50, y2: 2000 },
    ];
    assert.equal(elementAt(elements, 200, 50, 2).id, "link", "picked along its drawn line");
    assert.deepEqual(
      frameContents(elements, elements[0]).map((element) => element.id),
      ["a", "b", "link"],
      "the arrow drawn between the boxes is in the frame",
    );
    assert.ok(getSceneBounds(board()).x >= -1, "bounds from drawn ends, not stored ones");
  });
});

describe("attaching ends", () => {
  it("finds the topmost shape under a point, inside it as well as on its edge", () => {
    const elements = [shape("a", 0, 0, 100, 100), shape("b", 50, 50, 150, 150), arrow("x", null, null)];
    assert.equal(connectTargetAt(elements, { x: 75, y: 75 }, 2).id, "b");
    assert.equal(connectTargetAt(elements, { x: 20, y: 20 }, 2).id, "a");
    assert.equal(connectTargetAt(elements, { x: 75, y: 75 }, 2, { except: "b" }).id, "a");
    assert.equal(connectTargetAt(elements, { x: 500, y: 500 }, 2), null);
    const circle = [shape("c", 0, 0, 100, 100, "ellipse")];
    assert.equal(connectTargetAt(circle, { x: 3, y: 3 }, 2), null, "outside the ellipse, inside its box");
  });

  it("prefer a shape to the label sitting on it, and take text where there's no shape", () => {
    // Text is measured with a canvas; a stand-in measures 10 units a character.
    const realDocument = globalThis.document;
    globalThis.document = measuringDocument;
    try {
      const label = (id, x) => ({
        id,
        type: "text",
        x1: x,
        y1: 10,
        text: "Hi",
        stroke: "#000",
        fontSize: 20,
        font: "hand",
      });
      const elements = [shape("a", 0, 0, 100, 100), label("on-shape", 10), label("alone", 500)];
      assert.equal(connectTargetAt(elements, { x: 15, y: 15 }, 2).id, "a");
      assert.equal(connectTargetAt(elements, { x: 505, y: 15 }, 2).id, "alone");
      // An arrow from "a" let go over a's own label doesn't attach to the label.
      assert.equal(connectTargetAt(elements, { x: 15, y: 15 }, 2, { except: "a" }), null);
      assert.equal(connectTargetAt(elements, { x: 505, y: 15 }, 2, { except: "a" }).id, "alone");
    } finally {
      globalThis.document = realDocument;
    }
  });

  it("sets or clears one end", () => {
    const attached = attachEnd(arrow("x", null, null), "end", { id: "b" });
    assert.equal(attached.endId, "b");
    assert.equal("endId" in attachEnd(attached, "end", null), false);
    assert.equal(attachEnd(attached, "start", { id: "a" }).endId, "b");
  });

  it("are kept in one property group with the ends, so they merge together", () => {
    for (const field of ["x1", "y1", "x2", "y2", "startId", "endId"]) assert.ok(FIELD_GROUPS.shape.includes(field));
  });
});

describe("moving, copying and removing with connectors", () => {
  it("lets go of shapes left behind, where the end is drawn, and keeps hold of shapes moving along", () => {
    const elements = board();
    const [alone] = readyToMove(elements, [byId(elements, "link")]);
    assert.equal("startId" in alone || "endId" in alone, false);
    near(alone.x1, 100 + EDGE);
    const together = moveGroup(elements, elements, 10, 0);
    const link = byId(together, "link");
    assert.equal(link.startId, "a");
    assert.equal(link.endId, "b");
  });

  it("copies a group with its connectors attached to the copies", () => {
    const elements = board();
    const copies = copyGroup(elements, elements, 0, 500);
    const [a, b, link] = copies;
    assert.equal(link.startId, a.id);
    assert.equal(link.endId, b.id);
    assert.ok(![a.id, b.id, link.id].some((id) => ["a", "b", "link"].includes(id)));
    const [loneCopy] = copyGroup(elements, [byId(elements, "link")], 16, 16);
    assert.equal("startId" in loneCopy, false, "a connector copied alone is let go");
    const sameLook = copyGroup(elements, elements, 0, 0, { sameLook: true });
    assert.equal(sameLook[0].seed, elements[0].seed);
  });

  it("leaves connectors where they're drawn when their shape is removed", () => {
    const elements = board();
    const [change] = releaseFrom(elements, new Set(["b"]));
    assert.equal(change.before.endId, "b");
    assert.equal("endId" in change.after, false);
    assert.equal(change.after.startId, "a", "still attached at the other end");
    near(change.after.x2, 300 - EDGE);
    assert.deepEqual(releaseFrom(elements, new Set(["link", "a"])), [], "nothing to let go when it goes too");
  });

  it("lets go of connectors whenever a change here removes their shape, and attaches them again on undo", () => {
    const store = createBoardStore({ release: releaseFrom });
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    const start = board();
    store.commit({ undo: { remove: start.map((element) => element.id) }, redo: { upsert: start } });
    // Removed the way emptying a text does: a plain removal.
    store.commit({ undo: { upsert: [store.getElement("b")] }, redo: { remove: ["b"] } });
    const loose = store.getElement("link");
    assert.equal("endId" in loose, false);
    near(loose.x2, 300 - EDGE, "left where it was drawn");
    assert.ok(
      sent.at(-1).upsert.some((element) => element.id === "link"),
      "sent in the same change",
    );
    store.undo();
    assert.equal(store.getElement("link").endId, "b");
    store.redo();
    assert.equal("endId" in store.getElement("link"), false);
    store.undo();
    assert.equal(store.getElement("link").endId, "b");
  });

  it("lets go of connectors when undoing brings their shape's removal, and attaches them again on redo", () => {
    const store = createBoardStore({ release: releaseFrom });
    const [a, b, link] = board();
    store.commit({ undo: { remove: ["a", "link"] }, redo: { upsert: [a, link] } });
    store.commit({ undo: { remove: ["b"] }, redo: { upsert: [b] } });
    for (let round = 0; round < 2; round += 1) {
      store.undo();
      const loose = store.getElement("link");
      assert.equal("endId" in loose, false);
      assert.equal(loose.startId, "a");
      near(loose.x2, 300 - EDGE);
      store.redo();
      assert.equal(store.getElement("link").endId, "b", "attached again");
    }
  });

  it("follow a shape moved by someone else, on both screens, without either touching the arrow", () => {
    const [here, there] = [createBoardStore(), createBoardStore()];
    here.setBroadcaster((op) => there.applyRemote(op));
    there.setBroadcaster((op) => here.applyRemote(op));
    const start = board();
    here.commit({ undo: { remove: start.map((element) => element.id) }, redo: { upsert: start } });
    const b = there.getElement("b");
    there.commit({ undo: { upsert: [b] }, redo: { upsert: [{ ...b, y1: 300, y2: 400 }] } });
    for (const store of [here, there]) {
      const drawn = byId(resolveConnectors(store.getElements()), "link");
      assert.ok(drawn.y2 > 250, "the arrow's end went down with the box");
      assert.equal(store.getElement("link").y2, 10, "the stored arrow didn't change");
    }
  });
});

// Each segment of a polyline, as [dx, dy].
const segments = (points) => points.slice(1).map((point, i) => [point.x - points[i].x, point.y - points[i].y]);

describe("connection dots and pinned ends", () => {
  it("pin an end to the middle of a side, turned with its shape", () => {
    const pinned = [
      shape("a", 0, 0, 100, 100),
      shape("b", 300, 0, 400, 100),
      arrow("link", "a", "b", { startAnchor: "bottom", endAnchor: "top" }),
    ];
    const drawn = byId(resolveConnectors(pinned), "link");
    near(drawn.x1, 50);
    near(drawn.y1, 100 + EDGE);
    near(drawn.x2, 350);
    near(drawn.y2, -EDGE);
    // A quarter turn clockwise brings the top round to the right.
    pinned[1] = shape("b", 300, 0, 400, 100, "rectangle", { angle: Math.PI / 2 });
    const turned = byId(resolveConnectors([...pinned]), "link");
    near(turned.x2, 400 + EDGE);
    near(turned.y2, 50);
  });

  it("find the dot under the pointer just outside a shape, and otherwise the shape itself", () => {
    const elements = [shape("a", 0, 0, 100, 100)];
    const dots = connectionDots(elements[0], 1);
    near(dots.right.x, 100 + DOT_GAP + 1, "outside the outline and its stroke");
    near(connectionDots(elements[0], 2).right.x, 100 + DOT_GAP / 2 + 1, "the same distance on screen when zoomed in");
    const at = (x, y) => connectionAt(elements, { x, y }, { zoom: 1, tolerance: 6 });
    assert.deepEqual(at(dots.right.x, 53), { target: elements[0], side: "right" });
    assert.deepEqual(at(50, 50), { target: elements[0], side: null }, "on the shape: floating");
    assert.deepEqual(at(50, dots.bottom.y + 2), { target: elements[0], side: "bottom" });
    assert.deepEqual(at(300, 300), { target: null, side: null });
    assert.deepEqual(
      connectionAt(elements, dots.top, { zoom: 1, tolerance: 6, except: "a" }),
      { target: null, side: null },
      "not the shape the other end is on",
    );
  });

  it("sets and clears the pinned side with the end, and lets go of both together", () => {
    const pinned = attachEnd(arrow("x", null, null), "end", { id: "b" }, "left");
    assert.equal(pinned.endAnchor, "left");
    assert.equal("endAnchor" in attachEnd(pinned, "end", { id: "c" }), false, "dropped on a shape: floating");
    const loose = attachEnd(pinned, "end", null);
    assert.equal("endId" in loose || "endAnchor" in loose, false);
    const [change] = releaseFrom([shape("b", 300, 0, 400, 100), pinned], new Set(["b"]));
    assert.equal("endAnchor" in change.after, false);
  });

  it("face the other end when a curved or elbow connector floats on its shapes", () => {
    const a = shape("a", 0, 0, 100, 100);
    assert.equal(facingSide(a, { x: 500, y: 60 }), "right");
    assert.equal(facingSide(a, { x: 50, y: -400 }), "top");
    const elements = [a, shape("b", 300, 200, 400, 300), arrow("link", "a", "b", { route: "elbow" })];
    const drawn = byId(resolveConnectors(elements), "link");
    near(drawn.x1, 100 + EDGE);
    near(drawn.y1, 50);
    near(drawn.x2, 300 - EDGE);
    near(drawn.y2, 250);
  });
});

describe("connector paths", () => {
  const boxes = (b, extra) => [shape("a", 0, 0, 100, 100), b, arrow("link", "a", "b", extra)];
  const pathOf = (elements) => connectorPath(byId(resolveConnectors(elements), "link"));

  it("are one segment when straight", () => {
    assert.equal(connectorPath(arrow("x", null, null)).points.length, 2);
  });

  it("run elbows at right angles, out of one side and into the other", () => {
    const { points, curved } = pathOf(boxes(shape("b", 300, 200, 400, 300), { route: "elbow" }));
    assert.equal(curved, false);
    assert.equal(points.length, 4, "across, down the middle, and across again");
    for (const [dx, dy] of segments(points)) assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6);
    const steps = segments(points);
    assert.ok(steps[0][0] > 0, "leaves to the right");
    assert.ok(steps.at(-1)[0] > 0, "arrives moving right, into the left side");
  });

  it("go round rather than back through a shape", () => {
    // Out of a's right side and into b's left side, with b behind a.
    const { points } = pathOf(
      boxes(shape("b", -300, 200, -200, 300), { route: "elbow", startAnchor: "right", endAnchor: "left" }),
    );
    const steps = segments(points);
    for (let i = 1; i < steps.length; i += 1) {
      const [[ax, ay], [bx, by]] = [steps[i - 1], steps[i]];
      assert.ok(ax * bx + ay * by >= -1e-6, "never turns straight back");
    }
    assert.ok(steps[0][0] >= ELBOW_GAP - 1e-6, "runs out of the side before turning");
    assert.ok(steps.at(-1)[0] >= ELBOW_GAP - 1e-6, "and straight into the other");
  });

  it("curve out of each end's side and into the other's", () => {
    const { points, curved } = pathOf(boxes(shape("b", 300, 200, 400, 300), { route: "curved" }));
    assert.equal(curved, true);
    const [start, out, into, end] = points;
    near(out.y, start.y, "leaves straight out to the right");
    assert.ok(out.x > start.x);
    near(into.y, end.y, "arrives straight in from the left");
    assert.ok(into.x < end.x);
  });

  it("aim free elbow ends along whichever way is further", () => {
    const free = { ...arrow("x", null, null, { route: "elbow" }), x2: 200, y2: 100 };
    const { points } = connectorPath(free);
    assert.deepEqual(
      points.map(({ x, y }) => [x, y]),
      [
        [0, 0],
        [200, 0],
        [200, 100],
      ],
    );
    assert.deepEqual(pathMiddle(connectorPath(free)), { x: 150, y: 0 });
  });

  it("are what new lines and arrows take from the style, with arrowheads at one end or both", () => {
    const style = { stroke: "#000", strokeWidth: 2, sketchy: false, route: "curved", startHead: true, font: "sans" };
    const made = createElement("arrow", { x: 0, y: 0 }, style);
    assert.equal(made.route, "curved");
    assert.equal(made.startHead, true);
    assert.equal(made.font, "sans");
    assert.equal("startHead" in createElement("line", { x: 0, y: 0 }, style), false, "lines have no heads");
    for (const field of ["route", "startHead"]) assert.deepEqual(FIELD_GROUPS[field], [field]);
    for (const field of ["startAnchor", "endAnchor"]) assert.ok(FIELD_GROUPS.shape.includes(field));
  });
});

describe("connector labels", () => {
  const labelled = { ...arrow("x", null, null), x2: 200, y2: 0, text: "Go", font: "hand" };

  it("sit halfway along, in a box the line leaves a gap around", () => {
    const label = connectorLabel(labelled);
    // 2 characters at 10 units each, a line at 20 × 1.25, with 4 to spare all round.
    assert.deepEqual(
      { x: label.x, y: label.y, width: label.width, height: label.height },
      { x: 86, y: -16.5, width: 28, height: 33 },
    );
    assert.equal(connectorLabel({ ...labelled, text: "" }), null);
  });

  it("are part of the connector, for picking and its bounds", () => {
    assert.ok(hitTest(labelled, 100, 14, 1), "on the label, off the line");
    assert.equal(hitTest({ ...labelled, text: "" }, 100, 14, 1), false);
    assert.ok(getLocalBounds(labelled).y <= -16.5);
  });
});

describe("elbow routes", () => {
  const A = shape("a", 0, 0, 100, 100);
  const pathOf = (b, extra) =>
    connectorPath(byId(resolveConnectors([A, b, arrow("link", "a", "b", { route: "elbow", ...extra })]), "link"));
  // Whether any segment of `points` runs through the inside of `box`.
  const crosses = (points, box) =>
    points.some((point, i) => {
      if (i === 0) return false;
      const [x0, x1] = [Math.min(points[i - 1].x, point.x), Math.max(points[i - 1].x, point.x)];
      const [y0, y1] = [Math.min(points[i - 1].y, point.y), Math.max(points[i - 1].y, point.y)];
      return x1 > box.x1 && x0 < box.x2 && y1 > box.y1 && y0 < box.y2;
    });

  it("go round both shapes in the layouts that used to cut through them", () => {
    const cases = [
      ["right side to a box on the left", shape("b", -300, 20, -200, 80), "right", "left"],
      ["right side to right side", shape("b", 300, 200, 400, 300), "right", "right"],
      ["top to bottom of a box below", shape("b", 20, 300, 80, 400), "top", "bottom"],
      ["left side to a box on the right", shape("b", 300, 20, 400, 80), "left", "right"],
    ];
    for (const [name, b, startAnchor, endAnchor] of cases) {
      const { points } = pathOf(b, { startAnchor, endAnchor });
      assert.equal(crosses(points, A), false, `${name}: not through the first box`);
      assert.equal(crosses(points, b), false, `${name}: not through the second box`);
      for (const [dx, dy] of segments(points)) assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6, name);
    }
  });

  it("avoid both boxes wherever they sit and whichever sides they join", () => {
    const sides = ["top", "right", "bottom", "left"];
    for (const [x, y] of [
      [300, 0],
      [300, 200],
      [-300, 200],
      [0, 300],
      [-300, -250],
      [150, -200],
      [200, 40],
    ]) {
      const b = shape("b", x, y, x + 100, y + 100);
      for (const startAnchor of sides) {
        for (const endAnchor of sides) {
          const { points } = pathOf(b, { startAnchor, endAnchor });
          const where = `${startAnchor} to ${endAnchor} of a box at ${x},${y}`;
          assert.equal(crosses(points, A) || crosses(points, b), false, where);
        }
      }
    }
  });

  it("go round a turned shape rather than back through it", () => {
    const turned = shape("a", 0, 0, 100, 100, "rectangle", { angle: Math.PI / 4 });
    const b = shape("b", 300, 0, 400, 100);
    const drawn = byId(
      resolveConnectors([
        turned,
        b,
        arrow("link", "a", "b", { route: "elbow", startAnchor: "left", endAnchor: "left" }),
      ]),
      "link",
    );
    const { points } = connectorPath(drawn);
    // Each segment checked against the turned square: its corners are (50, -20.7), (120.7, 50), (50, 120.7), (-20.7, 50).
    const inside = ({ x, y }) => Math.abs(x - 50) + Math.abs(y - 50) < 50 * Math.SQRT2 - 1e-6;
    for (let i = 1; i < points.length; i += 1) {
      for (let step = 0; step <= 50; step += 1) {
        const t = step / 50;
        const along = {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
        };
        assert.equal(inside(along), false, `segment ${i} runs through the turned shape at ${along.x},${along.y}`);
      }
    }
  });

  it("still take the plainest route when nothing is in the way", () => {
    const { points } = pathOf(shape("b", 300, 200, 400, 300), { startAnchor: "right", endAnchor: "left" });
    assert.equal(points.length, 4, "across, down the middle, across");
  });
});

describe("curved connector bounds", () => {
  // Out of both boxes' right sides: the control points reach 135 out, the curve itself only three quarters of that.
  const elements = [
    shape("a", 0, 0, 100, 100),
    shape("b", 0, 300, 100, 400),
    arrow("link", "a", "b", { route: "curved", startAnchor: "right", endAnchor: "right", strokeWidth: 1 }),
  ];
  const drawn = byId(resolveConnectors(elements), "link");
  const controlsX = Math.max(...connectorPath(drawn).points.map((point) => point.x));
  const curveX = connectorPath(drawn).points[0].x + (controlsX - connectorPath(drawn).points[0].x) * 0.75;

  it("follow the curve itself, not its control points", () => {
    const bounds = getLocalBounds(drawn);
    assert.ok(bounds.x + bounds.width >= curveX, "reaches the curve");
    assert.ok(bounds.x + bounds.width < controlsX - 20, "not out to the control points");
  });

  it("count a curved arrow inside a frame when the curve is, though its control points are not", () => {
    const frame = { id: "f", type: "frame", x1: -50, y1: -50, x2: curveX + 20, y2: 450, name: "" };
    assert.ok(controlsX > frame.x2, "the control points stick out of the frame");
    assert.ok(frameContents([...elements, frame], frame).some((element) => element.id === "link"));
  });
});

describe("grabbing a connection dot", () => {
  // The dot above a's top side sits 15 out (the gap plus half the stroke): at (50, -15).
  const a = shape("a", 0, 0, 100, 100);
  const dot = { x: 50, y: -15 };
  const options = { zoom: 1, tolerance: 6 };

  it("is a dot of the shape under the pointer", () => {
    assert.equal(dotGrab([a], dot, options)?.side, "top");
    assert.equal(dotGrab([a], { x: 500, y: 500 }, options), null);
  });

  it("goes to a neighbour drawn there instead, which can then be picked", () => {
    const caption = shape("caption", 0, -60, 100, -12, "rectangle");
    assert.equal(connectionAt([caption, a], dot, options).side, "top", "the dot is there");
    assert.equal(dotGrab([caption, a], dot, options), null, "but the caption is picked");
    assert.equal(elementAt([caption, a], dot.x, dot.y, 6)?.id, "caption");
  });

  it("is not taken away by a frame the shape sits in", () => {
    const frame = { id: "f", type: "frame", x1: -200, y1: -200, x2: 400, y2: 400, name: "" };
    assert.equal(dotGrab([frame, a], dot, options)?.side, "top");
  });

  it("starts another arrow from a side that already has one pinned there", () => {
    const b = shape("b", 0, -300, 100, -200);
    const pinned = arrow("link", "a", "b", { startAnchor: "top", endAnchor: "bottom" });
    const elements = [a, b, pinned];
    assert.equal(elementAt(elements, dot.x, dot.y, 6)?.id, "link", "the arrow runs out through the dot");
    assert.deepEqual(dotGrab(elements, dot, options), { target: a, side: "top" });
  });

  it("leaves a press on the arrow beside the dot to the arrow, so it can be selected", () => {
    const b = shape("b", 0, -300, 100, -200);
    const pinned = arrow("link", "a", "b", { startAnchor: "top", endAnchor: "bottom" });
    const elements = [a, b, pinned];
    const core = DOT_CORE;
    assert.equal(dotGrab(elements, { x: 50, y: -15 + core - 1 }, options)?.side, "top", "within the dot's core");
    // Still near the dot (it can be reached there) but off its core, on the arrow's body.
    const beside = { x: 50, y: -15 - core - 2 };
    assert.equal(connectionAt(elements, beside, options).side, "top", "the dot is in reach");
    assert.equal(elementAt(elements, beside.x, beside.y, 6)?.id, "link", "the arrow is there");
    assert.equal(dotGrab(elements, beside, options), null, "so it is the arrow that is pressed");
    assert.equal(dotHover(elements, beside, options), null, "and no dot is shown under the pointer");
    // Zoomed out the core stays the same size on screen.
    const far = { zoom: 0.5, tolerance: 12 };
    assert.equal(dotGrab(elements, { x: 50, y: -30 }, far)?.side, "top");
    assert.equal(dotGrab(elements, { x: 50, y: -30 + (core + 2) / far.zoom }, far), null);
  });

  it("goes to the selected arrow's end handle beside the dot only when nearer it", () => {
    const pinned = byId(
      resolveConnectors([a, arrow("link", "a", null, { startAnchor: "top", x2: 50, y2: -300 })]),
      "link",
    );
    const grab = dotGrab([a, pinned], dot, options);
    // The end sits 7 out, the dot 15: a press on the dot draws a new arrow, one on the end drags it.
    assert.equal(dotBeatsHandle(pinned, "start", grab, dot, 1), true);
    assert.equal(dotBeatsHandle(pinned, "start", grab, { x: 50, y: -8 }, 1), false);
    assert.equal(dotBeatsHandle(pinned, null, grab, dot, 1), true, "no handle there");
    assert.equal(dotBeatsHandle(pinned, "start", null, dot, 1), false, "no dot there");
    // A selected shape's own handles always win over a neighbour's dot.
    assert.equal(dotBeatsHandle(shape("c", 0, -60, 100, -16), "s", grab, dot, 1), false);
  });
});

describe("connection dots shown with the select tool", () => {
  const a = shape("a", 0, 0, 100, 100);
  const options = { zoom: 1, tolerance: 6 };

  it("show on the shape under the pointer, and stay while it goes out to a dot", () => {
    assert.deepEqual(dotHover([a], { x: 50, y: 50 }, options), { target: a, side: null }, "over the shape");
    assert.deepEqual(dotHover([a], { x: 50, y: -15 }, options), { target: a, side: "top" }, "on its top dot");
    assert.equal(dotHover([a], { x: 500, y: 500 }, options), null);
  });

  it("show a dot as the one under the pointer only where a press would start an arrow from it", () => {
    const caption = shape("caption", 0, -60, 100, -12);
    assert.deepEqual(dotHover([caption, a], { x: 50, y: -15 }, options), { target: caption, side: null });
  });
});

describe("undoing a delete that let go of connectors", () => {
  it("puts back the connector's ends, but not an older label or color over someone else's change", () => {
    const [here, there] = [createBoardStore({ release: releaseFrom }), createBoardStore({ release: releaseFrom })];
    here.setBroadcaster((op) => there.applyRemote(op));
    there.setBroadcaster((op) => here.applyRemote(op));
    const start = board();
    here.commit({ undo: { remove: start.map((element) => element.id) }, redo: { upsert: start } });

    here.commit({ undo: { upsert: [here.getElement("b")] }, redo: { remove: ["b"] } });
    const link = there.getElement("link");
    there.commit({ undo: { upsert: [link] }, redo: { upsert: [{ ...link, text: "Yes", stroke: "#ff0000" }] } });

    here.undo();
    for (const store of [here, there]) {
      const back = store.getElement("link");
      assert.equal(back.endId, "b", "attached to the shape again");
      assert.equal(back.text, "Yes", "the label stays");
      assert.equal(back.stroke, "#ff0000", "and so does the color");
    }
    here.redo();
    for (const store of [here, there]) {
      assert.equal("endId" in store.getElement("link"), false);
      assert.equal(store.getElement("link").text, "Yes");
    }
  });
});

describe("arrowheads on elbow routes", () => {
  it("are no longer than the straight run they sit on", () => {
    const target = shape("b", 60, 100, 160, 160);
    // A bold arrow from a free start ends on the top of the box after a run of only 33, short of a full head (44).
    const bold = arrow("link", null, "b", {
      route: "elbow",
      endAnchor: "top",
      strokeWidth: 10,
      startHead: true,
      x2: 110,
      y2: 130,
    });
    const drawn = byId(resolveConnectors([target, { ...bold, x1: 0, y1: 60 }]), "link");
    const { points } = connectorPath(drawn);
    const run = Math.hypot(points.at(-1).x - points.at(-2).x, points.at(-1).y - points.at(-2).y);
    assert.ok(run < 44, `a short last run, ${run}`);
    const [endHead] = arrowHeads(drawn);
    for (const [x, y] of endHead) {
      assert.ok(Math.hypot(x - points.at(-1).x, y - points.at(-1).y) <= run + 1e-6, "barbs stay within the run");
    }
    // An end just beside the bend still has a head, half a full one, pointing along its run.
    const beside = byId(
      resolveConnectors([
        shape("a", 0, 0, 100, 100),
        { ...arrow("link", "a", null, { route: "elbow", startAnchor: "top" }), x2: -125, y2: -30.5 },
      ]),
      "link",
    );
    const shortRun = connectorPath(beside).points;
    assert.ok(Math.abs(shortRun.at(-1).y - shortRun.at(-2).y) < 1, "a run of next to nothing");
    const [shortHead] = arrowHeads(beside);
    near(Math.hypot(shortHead[0][0] - shortHead[1][0], shortHead[0][1] - shortHead[1][1]), 10);
    // Along a straight path the head is as long as ever.
    const straight = { ...arrow("s", null, null, { strokeWidth: 10 }), x2: 400, y2: 0 };
    const [head] = arrowHeads(straight);
    near(Math.hypot(head[0][0] - 400, head[0][1]), 44);
  });
});

describe("built-in templates", () => {
  it("draw their arrows attached to shapes, with every connector field set", async () => {
    const { BUILTIN_TEMPLATES } = await import("../src/features/templates/builtin.ts");
    const { cleanElement } = await import("@inkboard/shared/element-rules");
    for (const template of BUILTIN_TEMPLATES) {
      const elements = template.build();
      for (const element of elements) {
        assert.ok(cleanElement(element), `${template.id}: ${element.type} is a valid element`);
        if (element.type !== "arrow") continue;
        for (const field of ["route", "font", "startHead"])
          assert.ok(field in element, `${template.id}: arrow has ${field}`);
      }
      // No loose pieces: a flowchart or brainstorm connector joins two shapes.
      if (template.id === "flowchart" || template.id === "brainstorm") {
        for (const element of elements.filter((each) => each.type === "arrow" || each.type === "line")) {
          assert.ok(element.startId && element.endId, `${template.id}: every connector is attached at both ends`);
        }
      }
    }
    const flowchart = BUILTIN_TEMPLATES.find((template) => template.id === "flowchart");
    assert.equal(
      flowchart.build().filter((element) => element.type === "arrow").length,
      4,
      "three steps and the way back",
    );
    assert.doesNotMatch(flowchart.detail, /two endings/);
  });
});
