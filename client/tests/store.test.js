import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOperation, createBoardStore } from "../src/features/board/store.js";

const rect = (id, x = 0) => ({ id, type: "rectangle", x1: x, y1: 0, x2: x + 10, y2: 10 });
const ids = (store) => store.getElements().map((element) => element.id);

describe("applyOperation", () => {
  it("replaces in place, appends new elements and removes by id", () => {
    const next = applyOperation([rect("a"), rect("b")], { upsert: [rect("a", 5), rect("c")], remove: ["b"] });
    assert.deepEqual(next.map((element) => element.id), ["a", "c"]);
    assert.equal(next[0].x1, 5);
  });

  it("returns the same array when there is nothing to do", () => {
    const board = [rect("a")];
    assert.equal(applyOperation(board, {}), board);
    assert.equal(applyOperation(board, { upsert: [], remove: [] }), board);
  });
});

describe("a board store", () => {
  it("undoes and redoes a change", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });
    assert.deepEqual(ids(store), ["a"]);
    assert.equal(store.getSnapshot().canUndo, true);

    store.undo();
    assert.deepEqual(ids(store), []);
    assert.equal(store.getSnapshot().canRedo, true);

    store.redo();
    assert.deepEqual(ids(store), ["a"]);
    assert.equal(store.getSnapshot().canRedo, false);
  });

  it("only undoes your own changes, leaving what collaborators drew in the meantime", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["mine"] }, redo: { upsert: [rect("mine")] } });
    store.applyRemote({ upsert: [rect("theirs")], remove: [] });

    store.undo();
    assert.deepEqual(ids(store), ["theirs"]);
  });

  it("forgets the redo history after a new change", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });
    store.undo();
    assert.equal(store.getSnapshot().canRedo, true);
    store.commit({ undo: { remove: ["b"] }, redo: { upsert: [rect("b")] } });
    assert.equal(store.getSnapshot().canRedo, false);
  });

  it("merges rapid changes that share a key into one undo step", () => {
    const store = createBoardStore();
    store.apply({ upsert: [rect("a", 0)] });
    for (const x of [1, 2, 3]) {
      store.commit({ undo: { upsert: [rect("a", x - 1)] }, redo: { upsert: [rect("a", x)] } }, { mergeKey: "nudge:a" });
    }
    assert.equal(store.getElements()[0].x1, 3);
    store.undo();
    assert.equal(store.getElements()[0].x1, 0, "one undo reverts the whole nudge");
    assert.equal(store.getSnapshot().canUndo, false);
  });

  it("tells the broadcaster about every live change, including undo", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });
    store.undo();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], { remove: ["a"] });
  });

  it("doesn't broadcast changes that came from collaborators, the first load or a reconnect", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([rect("loaded")]);
    store.applyRemote({ upsert: [rect("remote")], remove: [] });
    store.replace([rect("replaced")]);
    assert.equal(sent.length, 0);
  });

  it("load forgets history, while replace (a reconnect) keeps it", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });

    store.replace([rect("a"), rect("server-side")]);
    assert.equal(store.getSnapshot().canUndo, true);

    store.load([rect("fresh")]);
    assert.equal(store.getSnapshot().canUndo, false);
    assert.deepEqual(ids(store), ["fresh"]);
  });

  it("notifies subscribers when something changes, and stops after unsubscribing", () => {
    const store = createBoardStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.apply({ upsert: [rect("a")] });
    assert.equal(calls, 1);
    unsubscribe();
    store.apply({ upsert: [rect("b")] });
    assert.equal(calls, 1);
  });
});
