import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareOrder, inStackOrder, isOrderKey, keyToMove } from "../src/board-order.js";

const board = (...ids) => inStackOrder(ids.map((id) => ({ id })));
const ids = (elements) => elements.map((element) => element.id);

/** The board with element `id` given `key`, sorted as a board keeps it. */
function moved(elements, id, key) {
  return elements.map((element) => (element.id === id ? { ...element, index: key } : element)).sort(compareOrder);
}

function move(elements, id, where, overlaps) {
  const key = keyToMove(elements, id, where, overlaps);
  assert.ok(isOrderKey(key), `${where} gave ${key}`);
  return moved(elements, id, key);
}

describe("moving an element in the stack", () => {
  it("brings it to the front or sends it to the back", () => {
    const elements = board("a", "b", "c", "d");
    assert.deepEqual(ids(move(elements, "b", "front")), ["a", "c", "d", "b"]);
    assert.deepEqual(ids(move(elements, "c", "back")), ["c", "a", "b", "d"]);
  });

  it("steps it forward or backward by one", () => {
    const elements = board("a", "b", "c", "d");
    assert.deepEqual(ids(move(elements, "b", "forward")), ["a", "c", "b", "d"]);
    assert.deepEqual(ids(move(elements, "c", "backward")), ["a", "c", "b", "d"]);
    assert.deepEqual(ids(move(elements, "c", "forward")), ["a", "b", "d", "c"]);
    assert.deepEqual(ids(move(elements, "b", "backward")), ["b", "a", "c", "d"]);
  });

  it("returns null when it's already there", () => {
    const elements = board("a", "b", "c");
    assert.equal(keyToMove(elements, "c", "front"), null);
    assert.equal(keyToMove(elements, "c", "forward"), null);
    assert.equal(keyToMove(elements, "a", "back"), null);
    assert.equal(keyToMove(elements, "a", "backward"), null);
    assert.equal(keyToMove(elements, "missing", "front"), null);
    assert.equal(keyToMove(elements, "b", "sideways"), null);
  });

  it("steps past elements it doesn't overlap", () => {
    const elements = board("a", "b", "c", "d", "e");
    const overlapsD = (other) => other.id === "d";
    assert.deepEqual(ids(move(elements, "b", "forward", overlapsD)), ["a", "c", "d", "b", "e"]);
    assert.deepEqual(ids(move(elements, "e", "backward", (other) => other.id === "b")), ["a", "e", "b", "c", "d"]);
    // Nothing above it overlaps, so stepping forward changes nothing visible.
    assert.equal(
      keyToMove(elements, "d", "forward", (other) => other.id === "a"),
      null,
    );
    assert.equal(
      keyToMove(elements, "b", "backward", () => false),
      null,
    );
  });

  it("steps past every element tied on the same key", () => {
    // Elements added at the same moment by two people can share a key.
    const elements = [
      { id: "a", index: "a0" },
      { id: "b", index: "a1" },
      { id: "c", index: "a1" },
      { id: "d", index: "a2" },
    ].sort(compareOrder);
    assert.deepEqual(ids(move(elements, "a", "forward")), ["b", "c", "a", "d"]);
    assert.deepEqual(ids(move(elements, "d", "backward")), ["a", "d", "b", "c"]);
    // Tied with the element above: still moves above it.
    assert.deepEqual(ids(move(elements, "b", "forward")), ["a", "c", "b", "d"]);
  });

  it("keeps working after many moves into the same gap", () => {
    let elements = board("a", "b", "c", "d", "e", "f");
    let moves = 0;
    for (let round = 0; round < 200; round += 1) {
      const id = ids(elements)[round % elements.length];
      const where = ["forward", "backward", "front", "back"][round % 4];
      const key = keyToMove(elements, id, where);
      if (!key) continue;
      const before = ids(elements).indexOf(id);
      elements = moved(elements, id, key);
      const after = ids(elements).indexOf(id);
      assert.ok(where === "forward" || where === "front" ? after > before : after < before);
      moves += 1;
    }
    assert.ok(moves > 100);
    assert.ok(Math.max(...elements.map((element) => element.index.length)) < 20);
  });

  it("refuses a key longer than the server keeps", () => {
    const long = "a" + "V".repeat(100);
    assert.equal(isOrderKey(long), false);
    const elements = [
      { id: "a", index: "a0" },
      { id: "b", index: "a1" },
    ];
    // A board with a key it couldn't have made is left alone rather than guessed at.
    assert.equal(keyToMove([{ id: "x", index: long }, ...elements], "a", "back"), null);
  });
});
