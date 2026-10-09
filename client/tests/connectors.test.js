import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIELD_GROUPS } from "@inkboard/shared/board-merge";
import {
  CONNECT_GAP,
  attachEnd,
  connectTargetAt,
  copyGroup,
  moveGroup,
  outlinePoint,
  readyToMove,
  releaseFrom,
  resolveConnectors,
} from "../src/features/board/connectors.js";
import { elementAt, frameContents, getSceneBounds } from "../src/features/board/elements.js";
import { createBoardStore } from "../src/features/board/store.js";

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
    globalThis.document = {
      createElement: () => ({ getContext: () => ({ measureText: (value) => ({ width: value.length * 10 }) }) }),
    };
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
    const store = createBoardStore();
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
    const store = createBoardStore();
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
