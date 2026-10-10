import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIELD_GROUPS, MAX_VERSION } from "@inkboard/shared/board-merge";
import { createElement, createImage, createNote, duplicate, stackKey } from "../src/features/board/elements.ts";
import { applyOperation, createBoardStore } from "../src/features/board/store.js";

const rect = (id, x = 0) => ({
  id,
  type: "rectangle",
  x1: x,
  y1: 0,
  x2: x + 10,
  y2: 10,
  stroke: "#000000",
  fill: null,
});
const ids = (store) => store.getElements().map((element) => element.id);
const stamped = (element, version, versionNonce = 0) => ({ ...element, version, versionNonce });

/** Two stores that pass every change straight to each other, like two people on a board. */
function pair() {
  const [a, b] = [createBoardStore(), createBoardStore()];
  const outbox = { a: [], b: [] };
  a.setBroadcaster((op) => outbox.a.push(op));
  b.setBroadcaster((op) => outbox.b.push(op));
  const deliver = () => {
    for (const op of outbox.a.splice(0)) b.applyRemote(op);
    for (const op of outbox.b.splice(0)) a.applyRemote(op);
  };
  return { a, b, deliver };
}

describe("applyOperation", () => {
  it("replaces in place, adds new elements and removes by id", () => {
    const next = applyOperation([stamped(rect("a"), 1), stamped(rect("b"), 1)], {
      upsert: [stamped(rect("a", 5), 2), stamped(rect("c"), 1)],
      remove: [{ id: "b", version: 2, versionNonce: 0 }],
    });
    assert.deepEqual(
      next.map((element) => element.id),
      ["a", "c"],
    );
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
    store.applyRemote({ upsert: [{ ...stamped(rect("theirs"), 1), index: "b0" }], remove: [] });

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
      const current = store.getElement("a");
      store.commit({ undo: { upsert: [current] }, redo: { upsert: [{ ...current, x1: x }] } }, { mergeKey: "nudge:a" });
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
    assert.deepEqual(sent[1].upsert, []);
    assert.deepEqual(
      sent[1].remove.map((removal) => [removal.id, removal.version]),
      [["a", 2]],
      "the undo is the element's second edit",
    );
  });

  it("doesn't broadcast changes that came from collaborators, the first load or a reconnect", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([rect("loaded")]);
    store.applyRemote({ upsert: [stamped(rect("remote"), 1)], remove: [] });
    store.rejoin([rect("rejoined")]);
    assert.equal(sent.length, 0);
  });

  it("doesn't broadcast a change that changes nothing", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.apply({ upsert: [rect("a")] });
    const current = store.getElement("a");
    store.commit({ undo: { upsert: [current] }, redo: { upsert: [{ ...current }] } });
    assert.equal(sent.length, 1);
  });

  it("load forgets history, while a reconnect keeps it and puts unsent changes on top of the server's board", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });
    const unsent = { upsert: [store.getElement("a")], remove: [] };

    store.rejoin([{ ...stamped(rect("server-side"), 1), index: "a0" }], unsent);
    assert.equal(store.getSnapshot().canUndo, true);
    assert.deepEqual(ids(store).sort(), ["a", "server-side"]);

    store.load([rect("fresh")]);
    assert.equal(store.getSnapshot().canUndo, false);
    assert.deepEqual(ids(store), ["fresh"]);
  });

  it("undoes a removal after a reconnect: the undo wins over the removal, and the element goes back where it was", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    for (const id of ["a", "b", "c"]) store.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id)] } });
    const a = store.getElement("a");
    store.commit({ undo: { upsert: [a] }, redo: { remove: ["a"] } });
    const [removal] = sent.at(-1).remove;

    // The server has the removal; the connection drops and comes back.
    const server = store.getElements();
    store.rejoin(server, undefined, [removal]);
    store.undo();
    const [back] = sent.at(-1).upsert;
    assert.ok(back.version > removal.version, "stamped past the removal, so the server takes it too");
    assert.deepEqual(ids(store), ["a", "b", "c"]);
    const tombstones = new Map([["a", { version: removal.version, versionNonce: removal.versionNonce }]]);
    assert.deepEqual(
      applyOperation(server, sent.at(-1), tombstones).map((element) => element.id),
      ["a", "b", "c"],
    );
  });

  it("keeps something removed while this screen was offline removed, even with an unsent change to it", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([{ ...stamped(rect("x"), 1), index: "a0" }]);
    const x = store.getElement("x");
    store.commit({ undo: { upsert: [x] }, redo: { upsert: [{ ...x, stroke: "#ff0000" }] } });

    // Meanwhile someone else removed it, after the version this change was made from.
    store.rejoin([], sent.at(-1), [{ id: "x", version: 5, versionNonce: 0 }]);
    assert.deepEqual(ids(store), []);
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

describe("stacking order", () => {
  it("puts each new element on top, with a key that says so", () => {
    const store = createBoardStore();
    for (const id of ["a", "b", "c"]) store.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id)] } });
    assert.deepEqual(ids(store), ["a", "b", "c"]);
    const keys = store.getElements().map((element) => element.index);
    assert.deepEqual([...keys].sort(), keys);
    assert.equal(new Set(keys).size, 3);
  });

  it("gives a board saved without keys some, in the order it was saved", () => {
    const store = createBoardStore();
    store.load([rect("z"), rect("y"), rect("x")]);
    assert.deepEqual(ids(store), ["z", "y", "x"]);
    assert.ok(store.getElements().every((element) => typeof element.index === "string"));
  });

  it("puts an element brought back by undo where it was, not on top", () => {
    const store = createBoardStore();
    for (const id of ["a", "b", "c"]) store.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id)] } });
    const a = store.getElement("a");
    store.commit({ undo: { upsert: [a] }, redo: { remove: ["a"] } });
    assert.deepEqual(ids(store), ["b", "c"]);
    store.undo();
    assert.deepEqual(ids(store), ["a", "b", "c"]);
  });

  it("stacks two elements added at the same moment the same way for both people", () => {
    const { a, b, deliver } = pair();
    a.commit({ undo: { remove: ["from-a"] }, redo: { upsert: [rect("from-a")] } });
    b.commit({ undo: { remove: ["from-b"] }, redo: { upsert: [rect("from-b")] } });
    deliver();
    assert.deepEqual(ids(a), ids(b));
  });

  /** Moves element `id` in the stack the way the editor does: one undo step changing only its key. */
  function moveInStack(store, id, where) {
    const element = store.getElement(id);
    const index = stackKey(store.getElements(), element, where);
    if (index) store.commit({ undo: { upsert: [element] }, redo: { upsert: [{ ...element, index }] } });
    return index;
  }

  it("brings an element to the front and sends it back, one undo step each", () => {
    const store = createBoardStore();
    for (const id of ["a", "b", "c"]) store.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id)] } });
    moveInStack(store, "a", "front");
    assert.deepEqual(ids(store), ["b", "c", "a"]);
    moveInStack(store, "c", "back");
    assert.deepEqual(ids(store), ["c", "b", "a"]);
    store.undo();
    assert.deepEqual(ids(store), ["b", "c", "a"]);
    store.undo();
    assert.deepEqual(ids(store), ["a", "b", "c"]);
    store.redo();
    assert.deepEqual(ids(store), ["b", "c", "a"]);
  });

  it("steps forward past the next element it overlaps, not one far away", () => {
    const store = createBoardStore();
    for (const [id, x] of [
      ["a", 0],
      ["far", 500],
      ["b", 5],
    ]) {
      store.commit({ undo: { remove: [id] }, redo: { upsert: [{ ...rect(id, x), strokeWidth: 2 }] } });
    }
    moveInStack(store, "a", "forward");
    assert.deepEqual(ids(store), ["far", "b", "a"]);
    assert.equal(moveInStack(store, "far", "forward"), null, "nothing above it overlaps");
  });

  it("keeps a reorder and a recolor made at the same time, and the same order for both people", () => {
    const { a, b, deliver } = pair();
    for (const id of ["x", "y"]) a.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id)] } });
    deliver();
    moveInStack(a, "x", "front");
    const fromB = b.getElement("x");
    b.commit({ undo: { upsert: [fromB] }, redo: { upsert: [{ ...fromB, stroke: "#ff0000" }] } });
    deliver();
    for (const store of [a, b]) {
      assert.deepEqual(ids(store), ["y", "x"]);
      assert.equal(store.getElement("x").stroke, "#ff0000");
    }

    a.undo();
    deliver();
    for (const store of [a, b]) {
      assert.deepEqual(ids(store), ["x", "y"], "the reorder is undone");
      assert.equal(store.getElement("x").stroke, "#ff0000", "the other person's color stays");
    }
  });
});

describe("changes that cross", () => {
  function shared() {
    const { a, b, deliver } = pair();
    a.commit({ undo: { remove: ["s"] }, redo: { upsert: [rect("s")] } });
    deliver();
    return { a, b, deliver };
  }

  it("keep both a move and a recolor made at the same time", () => {
    const { a, b, deliver } = shared();
    const fromA = a.getElement("s");
    a.commit({ undo: { upsert: [fromA] }, redo: { upsert: [{ ...fromA, x1: 50, x2: 60 }] } });
    const fromB = b.getElement("s");
    b.commit({ undo: { upsert: [fromB] }, redo: { upsert: [{ ...fromB, stroke: "#ff0000" }] } });
    deliver();
    for (const store of [a, b]) {
      assert.equal(store.getElement("s").x1, 50, "the move is kept");
      assert.equal(store.getElement("s").stroke, "#ff0000", "and so is the color");
    }
    assert.deepEqual(a.getElement("s"), b.getElement("s"));
  });

  it("keep a recolor made while someone is still dragging", () => {
    const { a, b, deliver } = shared();
    const original = a.getElement("s");
    let previous = null;
    for (const dx of [10, 20, 30]) {
      const moved = { ...original, x1: original.x1 + dx, x2: original.x2 + dx };
      a.apply({ upsert: [moved] }, { base: [previous ?? original] });
      previous = moved;
      if (dx === 10) {
        const fromB = b.getElement("s");
        b.commit({ undo: { upsert: [fromB] }, redo: { upsert: [{ ...fromB, stroke: "#00ff00" }] } });
      }
      deliver();
    }
    a.record({ undo: { upsert: [original] }, redo: { upsert: [previous] } });
    deliver();
    for (const store of [a, b]) {
      assert.equal(store.getElement("s").x1, 30);
      assert.equal(store.getElement("s").stroke, "#00ff00");
    }
  });

  it("let an undo put back only what it changed", () => {
    const { a, b, deliver } = shared();
    const before = a.getElement("s");
    a.commit({ undo: { upsert: [before] }, redo: { upsert: [{ ...before, x1: 99, x2: 109 }] } });
    deliver();
    const fromB = b.getElement("s");
    b.commit({ undo: { upsert: [fromB] }, redo: { upsert: [{ ...fromB, fill: "#0000ff" }] } });
    deliver();

    a.undo();
    deliver();
    for (const store of [a, b]) {
      assert.equal(store.getElement("s").x1, 0, "the move is undone");
      assert.equal(store.getElement("s").fill, "#0000ff", "the other person's fill stays");
    }
  });

  it("pick one winner for both people when they change the same thing", () => {
    const { a, b, deliver } = shared();
    const fromA = a.getElement("s");
    a.commit({ undo: { upsert: [fromA] }, redo: { upsert: [{ ...fromA, stroke: "#111111" }] } });
    const fromB = b.getElement("s");
    b.commit({ undo: { upsert: [fromB] }, redo: { upsert: [{ ...fromB, stroke: "#222222" }] } });
    deliver();
    assert.equal(a.getElement("s").stroke, b.getElement("s").stroke);
  });
});

describe("property groups", () => {
  it("cover every field the editor gives an element, so none is lost when changes merge", () => {
    const style = {
      stroke: "#000000",
      fill: "#ffffff",
      strokeWidth: 2,
      sketchy: true,
      penSize: 8,
      fontSize: 32,
      font: "hand",
      noteFill: "#ffec99",
    };
    const grouped = new Set(Object.values(FIELD_GROUPS).flat());
    const kinds = ["pen", "text", "line", "arrow", "rectangle", "ellipse", "frame"].map((type) =>
      createElement(type, { x: 0, y: 0 }, style, 0.5),
    );
    for (const element of [
      ...kinds,
      createImage("a".repeat(32), { x: 0, y: 0 }, { width: 10, height: 10 }),
      createNote({ x: 0, y: 0 }, style),
      duplicate(kinds[4]),
    ]) {
      for (const field of Object.keys({ ...element, angle: 1, index: "a0" })) {
        assert.ok(field === "id" || grouped.has(field), `${element.type}.${field} isn't in a group`);
      }
    }
  });
});

describe("what the server answers to a change", () => {
  it("shows an element as the server stored it, unless it changed since", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a", "b"] }, redo: { upsert: [rect("a"), rect("b")] } });
    const [a, b] = store.getElements();
    store.reconcile({
      cleaned: [
        { ...a, stroke: "#111111" },
        { ...b, stroke: "#222222" },
      ],
    });
    assert.equal(store.getElement("a").stroke, "#111111");
    assert.equal(store.getElement("b").stroke, "#222222");

    store.commit({
      undo: { upsert: [store.getElement("b")] },
      redo: { upsert: [{ ...store.getElement("b"), x1: 5 }] },
    });
    // An older version of b: its move is the change since, and stays.
    store.reconcile({ cleaned: [{ ...b, x1: 0, stroke: "#222222" }] });
    assert.equal(store.getElement("b").stroke, "#222222");
    assert.equal(store.getElement("b").x1, 5);
  });

  it("takes away the elements the server refused because the board is full", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a", "b"] }, redo: { upsert: [rect("a"), rect("b")] } });
    store.reconcile({ dropped: ["b"] });
    assert.deepEqual(ids(store), ["a"]);
    assert.equal(store.getElement("b"), undefined);
  });
});

describe("the element limit", () => {
  it("leaves out new elements past maxElements and says how many", () => {
    const refused = [];
    const store = createBoardStore({ maxElements: 2, onFull: (count) => refused.push(count) });
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.commit({ undo: { remove: ["a", "b", "c"] }, redo: { upsert: [rect("a"), rect("b"), rect("c")] } });
    assert.deepEqual(ids(store), ["a", "b"]);
    assert.deepEqual(refused, [1]);
    assert.deepEqual(
      sent[0].upsert.map((element) => element.id),
      ["a", "b"],
    );
    // Changing what is there is always fine.
    store.apply({ upsert: [{ ...store.getElement("a"), x1: 5 }] });
    assert.equal(store.getElement("a").x1, 5);
    assert.deepEqual(refused, [1]);
  });
});

describe("looking elements up", () => {
  it("finds elements by id after every kind of change", () => {
    const store = createBoardStore();
    store.load([stamped(rect("a"), 1)]);
    assert.equal(store.getElement("a").id, "a");
    store.applyRemote({ upsert: [stamped(rect("b"), 1)], remove: [{ id: "a", version: 2, versionNonce: 0 }] });
    assert.equal(store.getElement("a"), undefined);
    assert.equal(store.getElement("b").id, "b");
    store.rejoin([stamped(rect("c"), 1)]);
    assert.equal(store.getElement("b"), undefined);
    assert.equal(store.getElement("c").id, "c");
  });
});

describe("changes to what someone else has removed", () => {
  function shared() {
    const { a, b, deliver } = pair();
    a.commit({ undo: { remove: ["s"] }, redo: { upsert: [rect("s")] } });
    deliver();
    return { a, b, deliver };
  }

  it("do not bring it back: not an edit made from what it was, not an undo of a move", () => {
    const { a, b, deliver } = shared();
    const s = a.getElement("s");
    a.commit({ undo: { upsert: [s] }, redo: { upsert: [{ ...s, x1: 50, x2: 60 }] } });
    deliver();
    b.commit({ undo: { upsert: [b.getElement("s")] }, redo: { remove: ["s"] } });
    deliver();
    assert.deepEqual(ids(a), []);

    // A note being typed into, committed when it loses focus.
    a.commit({ undo: { upsert: [s] }, redo: { upsert: [{ ...s, stroke: "#ff0000" }] } });
    deliver();
    assert.deepEqual([ids(a), ids(b)], [[], []], "the edit is dropped");

    a.undo();
    deliver();
    assert.deepEqual([ids(a), ids(b)], [[], []], "undoing the move does not put the shape back");
    a.redo();
    deliver();
    assert.deepEqual([ids(a), ids(b)], [[], []], "nor does redoing it");
  });

  it("still let undo put back what the step itself removed, and redo what it made", () => {
    const { a, b, deliver } = shared();
    a.commit({ undo: { upsert: [a.getElement("s")] }, redo: { remove: ["s"] } });
    deliver();
    a.undo();
    deliver();
    assert.deepEqual([ids(a), ids(b)], [["s"], ["s"]]);
    a.undo();
    a.redo();
    deliver();
    assert.deepEqual([ids(a), ids(b)], [["s"], ["s"]], "redo makes it again");
  });
});

describe("a store's stamps", () => {
  it("never go past the largest version others accept", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([{ ...stamped(rect("a"), MAX_VERSION - 1), index: "a0" }]);
    for (const stroke of ["#111111", "#222222", "#333333"]) {
      const a = store.getElement("a");
      store.commit({ undo: { upsert: [a] }, redo: { upsert: [{ ...a, stroke }] } });
    }
    assert.ok(sent.length > 0);
    assert.ok(sent.every((op) => op.upsert.every((element) => element.version <= MAX_VERSION)));
  });
});

describe("history marks", () => {
  it("change when anything is committed, undone or redone, so a toast's Undo can tell it is stale", () => {
    const store = createBoardStore();
    store.commit({ undo: { remove: ["a"] }, redo: { upsert: [rect("a")] } });
    const mark = store.historyMark();
    assert.equal(store.historyMark(), mark);
    store.commit({ undo: { remove: ["b"] }, redo: { upsert: [rect("b")] } });
    assert.notEqual(store.historyMark(), mark);
    store.undo();
    assert.equal(store.historyMark(), mark);
  });
});

describe("lines and arrows saved before they had every field", () => {
  // As boards saved them before every line and arrow had a label, a route, a label font and arrowheads.
  const oldArrow = () => ({
    ...stamped(rect("c"), 3, 7),
    type: "arrow",
    seed: 1,
    strokeWidth: 2.5,
    sketchy: true,
    index: "a0",
  });

  it("can have a label, a route and a start head undone back to none, here and for everyone", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([oldArrow()]);
    const before = store.getElement("c");
    store.commit({
      undo: { upsert: [before] },
      redo: { upsert: [{ ...before, text: "yes", route: "elbow", startHead: true }] },
    });
    store.undo();
    const after = store.getElement("c");
    assert.deepEqual([after.text, after.route, after.startHead], ["", "straight", false]);
    // Someone else, or the server, who had the arrow as it was saved.
    let elsewhere = [oldArrow()];
    for (const op of sent) elsewhere = applyOperation(elsewhere, op);
    assert.deepEqual([elsewhere[0].text, elsewhere[0].route, elsewhere[0].startHead], ["", "straight", false]);
  });
});

describe("undoing a removal", () => {
  it("stamps the element newer than the removal, even once the board forgot the removal", () => {
    const store = createBoardStore();
    const sent = [];
    store.setBroadcaster((op) => sent.push(op));
    store.load([{ ...stamped(rect("a"), 5), index: "a0" }]);
    const a = store.getElement("a");
    store.commit({ undo: { upsert: [a] }, redo: { remove: ["a"] } });
    const removal = sent.at(-1).remove[0];
    // Reconnected: the server's list of removals doesn't have it (it sends what it still keeps).
    store.rejoin([], { upsert: [], remove: [] }, []);
    store.undo();
    const back = sent.at(-1).upsert[0];
    assert.ok(back.version > removal.version, `${back.version} after ${removal.version}`);
    const tombstones = new Map([["a", { version: removal.version, versionNonce: removal.versionNonce }]]);
    assert.deepEqual(
      applyOperation([], { upsert: [back] }, tombstones).map((element) => element.id),
      ["a"],
      "the server, which still has the removal, brings it back too",
    );
  });
});

describe("a change the server refused", () => {
  it("puts back the server's copy of an element it has, older than what was sent", () => {
    const store = createBoardStore();
    store.load([{ ...stamped(rect("a"), 2), index: "a0" }]);
    const stored = store.getElement("a");
    store.commit({ undo: { upsert: [stored] }, redo: { upsert: [{ ...stored, x2: 99 }] } });
    const sent = store.getElement("a");
    store.reconcile({
      cleaned: [stored],
      sent: new Map([["a", { version: sent.version, versionNonce: sent.versionNonce }]]),
    });
    assert.equal(store.getElement("a").x2, 10);
  });

  it("keeps a group someone else changed since, while putting back the groups that were sent", () => {
    const store = createBoardStore();
    store.load([{ ...stamped(rect("a"), 3), index: "a0" }]);
    const stored = store.getElement("a");
    // Moved here (stroke keeps its older stamp), and the server hands its own copy back.
    store.commit({ undo: { upsert: [stored] }, redo: { upsert: [{ ...stored, x2: 99 }] } });
    const sent = store.getElement("a");
    // Someone's recolor is merged in before the reply: newer than the stroke it replaces, not than the move.
    store.applyRemote({
      upsert: [
        { ...stored, stroke: "#ff0000", version: sent.version, versionNonce: 2 ** 31 - 1, stamps: { shape: [0, 0] } },
      ],
      remove: [],
    });
    assert.equal(store.getElement("a").stroke, "#ff0000");
    store.reconcile({
      cleaned: [stored],
      sent: new Map([["a", { version: sent.version, versionNonce: sent.versionNonce }]]),
    });
    assert.equal(store.getElement("a").x2, 10, "the refused move is put back");
    assert.equal(store.getElement("a").stroke, "#ff0000", "the recolor isn't undone with it");
  });
});
