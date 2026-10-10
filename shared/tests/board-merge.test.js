import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyOperation,
  cleanStamps,
  commitPlan,
  compareStamps,
  effectOf,
  groupStamps,
  mergeElement,
  planOperation,
  supersedes,
  withStamps,
} from "../src/board-merge.ts";

// A small seeded generator, so a failure can be reproduced from its seed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const rect = (id, fields = {}) => ({
  id,
  type: "rectangle",
  x1: 0,
  y1: 0,
  x2: 10,
  y2: 10,
  stroke: "#000000",
  fill: null,
  index: "a0",
  ...fields,
});
const at = (version, versionNonce = 0) => ({ version, versionNonce });
const everyGroup = (element, stamp) =>
  withStamps(element, Object.fromEntries(Object.keys(groupStamps(element)).map((group) => [group, stamp])));

describe("stamps", () => {
  it("count the higher version as newer, and for the same version the lower nonce", () => {
    assert.ok(compareStamps(at(2), at(1)) > 0);
    assert.ok(compareStamps(at(2, 3), at(2, 7)) > 0);
    assert.equal(compareStamps(at(2, 3), at(2, 3)), 0);
    assert.ok(supersedes({ version: 1 }, {}), "something unstamped counts as version 0");
  });

  it("are stored as the newest, with only older groups listed", () => {
    const element = withStamps(rect("a"), { shape: at(3, 1), index: at(1, 5), stroke: at(3, 1), fill: at(2, 0) });
    assert.equal(element.version, 3);
    assert.equal(element.versionNonce, 1);
    assert.deepEqual(element.stamps, { index: [1, 5], fill: [2, 0] });
    assert.deepEqual(groupStamps(element), { shape: at(3, 1), index: at(1, 5), stroke: at(3, 1), fill: at(2, 0) });
  });

  it("drop listed stamps that aren't well formed", () => {
    assert.deepEqual(cleanStamps({ shape: [1, 2], stroke: [-1, 0], fill: [1, 2 ** 31], nope: [1, 1], text: "x" }), {
      shape: [1, 2],
    });
    assert.equal(cleanStamps([1, 2]), undefined);
    assert.equal(cleanStamps(null), undefined);
  });
});

describe("merging two copies of an element", () => {
  const base = everyGroup(rect("a"), at(1, 9));

  it("keeps each group from the copy that changed it last", () => {
    const moved = withStamps({ ...base, x1: 50, x2: 60 }, { ...groupStamps(base), shape: at(2, 4) });
    const recolored = withStamps({ ...base, stroke: "#ff0000" }, { ...groupStamps(base), stroke: at(2, 8) });
    for (const merged of [mergeElement(moved, recolored), mergeElement(recolored, moved)]) {
      assert.equal(merged.x1, 50);
      assert.equal(merged.x2, 60);
      assert.equal(merged.stroke, "#ff0000");
      assert.equal(merged.version, 2);
      assert.equal(merged.versionNonce, 4, "its newest stamp is the move's");
    }
    assert.deepEqual(mergeElement(moved, recolored), mergeElement(recolored, moved));
  });

  it("never mixes the fields of one group from two copies", () => {
    const one = withStamps({ ...base, x1: -5, y1: -5 }, { ...groupStamps(base), shape: at(2, 1) });
    const two = withStamps({ ...base, x2: 99, y2: 99 }, { ...groupStamps(base), shape: at(2, 2) });
    const merged = mergeElement(two, one);
    assert.deepEqual([merged.x1, merged.y1, merged.x2, merged.y2], [-5, -5, 10, 10]);
  });

  it("returns the copy it has when the other adds nothing, and the other when it's newer throughout", () => {
    const newer = everyGroup({ ...base, x1: 3 }, at(5));
    assert.equal(mergeElement(newer, base), newer);
    assert.equal(mergeElement(base, newer), newer);
    assert.equal(mergeElement(base, base), base);
  });

  it("keeps a group the newer copy doesn't have at all, such as a label on a connector that was only moved", () => {
    // A connector made without a label, moved by one person while another labels it (and the other way round).
    const arrow = { ...rect("c"), type: "arrow", x2: 80, y2: 0 };
    const plain = everyGroup(arrow, at(1, 9));
    const labelled = withStamps(
      { ...plain, text: "yes", font: "hand", route: "elbow" },
      { ...groupStamps(plain), text: at(2, 1), font: at(2, 1), route: at(2, 1) },
    );
    const dragged = withStamps({ ...plain, x2: 200 }, { ...groupStamps(plain), shape: at(3, 5) });
    for (const merged of [mergeElement(labelled, dragged), mergeElement(dragged, labelled)]) {
      assert.equal(merged.x2, 200);
      assert.deepEqual([merged.text, merged.font, merged.route], ["yes", "hand", "elbow"]);
    }
    assert.deepEqual(mergeElement(labelled, dragged), mergeElement(dragged, labelled));
  });

  it("clears a field set to an empty value, since leaving it out says nothing", () => {
    const labelled = everyGroup({ ...rect("c"), type: "arrow", text: "yes" }, at(1, 9));
    const cleared = withStamps({ ...labelled, text: "" }, { ...groupStamps(labelled), text: at(2) });
    assert.equal(mergeElement(labelled, cleared).text, "");
  });

  it("drops fields the winning copy doesn't have, like an angle that was reset", () => {
    const turned = withStamps({ ...base, angle: 1 }, { ...groupStamps(base), shape: at(2) });
    const straightened = withStamps({ ...base }, { ...groupStamps(base), shape: at(3) });
    assert.equal("angle" in mergeElement(turned, straightened), false);
  });
});

describe("removals of elements nobody has seen", () => {
  const removal = { id: "ghost", version: 5, versionNonce: 0 };

  it("are remembered by default, so the element stays gone if it turns up late", () => {
    const tombstones = new Map();
    applyOperation([], { upsert: [], remove: [removal] }, tombstones);
    assert.deepEqual([...tombstones.keys()], ["ghost"]);
    assert.deepEqual(applyOperation([], { upsert: [everyGroup(rect("ghost"), at(2))], remove: [] }, tombstones), []);
  });

  it("can be left out, so made-up ids don't fill a board's memory", () => {
    const tombstones = new Map([["known", { ...at(1) }]]);
    const plan = planOperation([], { upsert: [], remove: [removal, { id: "known", ...at(4) }] }, tombstones, {
      remember: false,
    });
    assert.deepEqual([...plan.graves.keys()], ["known"], "only one that was already removed is brought up to date");
  });
});

describe("keeping an index of the elements by id", () => {
  it("is brought up to date by commitPlan, and gives the same board", () => {
    const board = [everyGroup(rect("a", { index: "a0" }), at(1)), everyGroup(rect("b", { index: "a1" }), at(1))];
    const index = new Map(board.map((element) => [element.id, element]));
    const op = {
      upsert: [everyGroup(rect("a", { index: "a0", x1: 7 }), at(2)), everyGroup(rect("c", { index: "a2" }), at(1))],
      remove: [{ id: "b", ...at(3) }],
    };
    const plan = planOperation(board, op, new Map(), { index });
    const { elements } = commitPlan(plan, new Map());
    assert.deepEqual(elements, applyOperation(board, op, new Map()));
    assert.deepEqual([...index.keys()].sort(), ["a", "c"]);
    assert.equal(index.get("a").x1, 7);
  });

  it("adds new elements on top without sorting, and still sorts those that go lower, or a removal and return", () => {
    const board = [everyGroup(rect("a", { index: "a1" }), at(1)), everyGroup(rect("b", { index: "a2" }), at(1))];
    const sorted = (elements) => [...elements].sort((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : 0));
    const onTop = applyOperation(board, {
      upsert: [everyGroup(rect("c", { index: "a3" }), at(1)), everyGroup(rect("d", { index: "a4" }), at(1))],
    });
    assert.deepEqual(
      onTop.map((element) => element.id),
      ["a", "b", "c", "d"],
    );
    const below = applyOperation(board, {
      upsert: [everyGroup(rect("e", { index: "a3" }), at(1)), everyGroup(rect("f", { index: "a0" }), at(1))],
    });
    assert.deepEqual(below, sorted(below));
    assert.deepEqual(
      below.map((element) => element.id),
      ["f", "a", "b", "e"],
    );
    // Removed and brought back by one change: once, in its place.
    const back = applyOperation(board, {
      remove: [{ id: "a", ...at(2) }],
      upsert: [everyGroup(rect("a", { index: "a1", x1: 3 }), at(3))],
    });
    assert.deepEqual(
      back.map((element) => [element.id, element.x1]),
      [
        ["a", 3],
        ["b", 0],
      ],
    );
  });

  it("leaves out new elements past the cap", () => {
    const index = new Map();
    const plan = planOperation([], { upsert: [everyGroup(rect("x"), at(1))], remove: [] }, new Map(), { index });
    commitPlan(plan, new Map(), { limit: 0 });
    assert.equal(index.size, 0);
  });
});

describe("applying operations", () => {
  it("keeps the board sorted by place in the stack, then by id", () => {
    const board = applyOperation([], {
      upsert: [
        rect("c", { index: "a1", version: 1 }),
        rect("b", { index: "a0", version: 1 }),
        rect("a", { index: "a1", version: 1 }),
      ],
    });
    assert.deepEqual(
      board.map((element) => element.id),
      ["b", "a", "c"],
    );
    const moved = applyOperation(board, { upsert: [rect("b", { index: "a2", version: 2 })] });
    assert.deepEqual(
      moved.map((element) => element.id),
      ["a", "c", "b"],
    );
  });

  it("hides a removed element, keeps it out against older changes, and brings it back for newer ones", () => {
    const tombstones = new Map();
    let board = applyOperation([], { upsert: [everyGroup(rect("a"), at(1))] }, tombstones);
    board = applyOperation(board, { remove: [{ id: "a", ...at(3) }] }, tombstones);
    assert.deepEqual(board, []);
    board = applyOperation(board, { upsert: [everyGroup(rect("a", { x1: 7 }), at(2))] }, tombstones);
    assert.deepEqual(board, [], "an edit made before the removal");
    assert.equal(tombstones.get("a").element.x1, 7, "is remembered, though");
    board = applyOperation(board, { upsert: [everyGroup(rect("a", { x1: 8 }), at(4))] }, tombstones);
    assert.equal(board[0].x1, 8);
    assert.equal(tombstones.has("a"), false);
  });

  it("doesn't let an older removal hide a newer edit", () => {
    const board = applyOperation([everyGroup(rect("a"), at(5))], { remove: [{ id: "a", ...at(4) }] });
    assert.equal(board.length, 1);
  });

  it("removes whatever is there for a removal without a stamp (from an older browser)", () => {
    assert.deepEqual(applyOperation([everyGroup(rect("a"), at(5))], { remove: ["a"] }), []);
  });

  it("don't change the board or elements they were given", () => {
    const start = Object.freeze([Object.freeze(everyGroup(rect("a"), at(1)))]);
    const tombstones = new Map();
    assert.doesNotThrow(() =>
      applyOperation(start, { upsert: [everyGroup(rect("a", { x1: 4 }), at(2))], remove: [] }, tombstones),
    );
    assert.doesNotThrow(() => applyOperation(start, { remove: [{ id: "a", ...at(9) }] }, tombstones));
    assert.equal(start[0].x1, 0);
  });

  it("report what changed: merged elements, and removals that took effect", () => {
    const board = [everyGroup(rect("a"), at(2)), everyGroup(rect("b"), at(2))];
    const plan = planOperation(board, {
      upsert: [everyGroup(rect("a", { x1: 1 }), at(1)), everyGroup(rect("b", { x1: 1 }), at(3))],
      remove: [
        { id: "a", ...at(1) },
        { id: "c", ...at(1) },
      ],
    });
    const effect = effectOf(plan);
    assert.deepEqual(
      effect.upsert.map((element) => element.id),
      ["b"],
      "the older edit of a changes nothing",
    );
    assert.deepEqual(
      effect.remove.map((removal) => removal.id),
      ["c"],
      "c wasn't there, but the removal is news to others",
    );
  });

  it("stops at a limit on how many elements a board can have", () => {
    const board = applyOperation(
      [],
      { upsert: [rect("a", { version: 1 }), rect("b", { version: 1, index: "a1" })] },
      new Map(),
      { limit: 1 },
    );
    assert.deepEqual(
      board.map((element) => element.id),
      ["a"],
    );
  });

  it("pass on a change to a removed element with its removal, so a screen that never saw the removal keeps it hidden", () => {
    const tombstones = new Map();
    let board = applyOperation([], { upsert: [everyGroup(rect("a"), at(1))] }, tombstones);
    board = applyOperation(board, { remove: [{ id: "a", ...at(3) }] }, tombstones);
    const effect = effectOf(planOperation(board, { upsert: [everyGroup(rect("a", { x1: 7 }), at(2))] }, tombstones));
    assert.deepEqual(
      effect.upsert.map((element) => element.x1),
      [7],
      "the change is passed on",
    );
    assert.deepEqual(effect.remove, [{ id: "a", ...at(3) }], "with the removal");
    assert.deepEqual(applyOperation([], effect, new Map()), [], "a screen that opened the board after the removal");
  });

  it("keeps an element removed when it's left out at the limit on its way back", () => {
    const tombstones = new Map();
    let board = applyOperation([], { upsert: [everyGroup(rect("a"), at(1))] }, tombstones);
    board = applyOperation(board, { remove: [{ id: "a", ...at(2) }] }, tombstones);
    board = applyOperation(board, { upsert: [everyGroup(rect("b", { index: "a1" }), at(1))] }, tombstones);
    board = applyOperation(board, { upsert: [everyGroup(rect("a"), at(3))] }, tombstones, { limit: 1 });
    assert.deepEqual(
      board.map((element) => element.id),
      ["b"],
    );
    assert.equal(tombstones.get("a")?.version, 2, "its tombstone still stops older changes");
  });
});

// The property that matters: whatever order the same changes arrive in,
// everyone ends up with the same board. Changes here are random edits of
// random groups, removals and returns, each stamped once, so a stamp always
// carries the same data, as it does in the app.
describe("whatever order changes arrive in", () => {
  const IDS = ["a", "b", "c"];
  const GROUP_FIELDS = {
    shape: (n) => ({ x1: n, y1: -n, x2: n + 10, y2: n + 5 }),
    stroke: (n) => ({ stroke: `#${String(n).padStart(6, "0")}` }),
    fill: (n) => ({ fill: n % 2 ? null : `#${String(n).padStart(6, "0")}` }),
    index: (n) => ({ index: `a${"0123456789"[n % 10]}` }),
  };

  function changes(next) {
    let nonce = 0;
    const stamp = () => at(1 + Math.floor(next() * 6), (nonce += 1));
    const list = [];
    for (let i = 0; i < 14; i += 1) {
      const id = IDS[Math.floor(next() * IDS.length)];
      if (next() < 0.25) {
        list.push({ remove: [{ id, ...stamp() }] });
        continue;
      }
      // A copy of the element in which each group was last written by some change.
      const stamps = {};
      let fields = rect(id);
      for (const group of Object.keys(GROUP_FIELDS)) {
        const s = stamp();
        stamps[group] = s;
        fields = { ...fields, ...GROUP_FIELDS[group](s.versionNonce) };
      }
      list.push({ upsert: [withStamps(fields, stamps)] });
    }
    return list;
  }

  function shuffled(list, next) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  const play = (ops) => {
    const tombstones = new Map();
    return ops.reduce((board, op) => applyOperation(board, op, tombstones), []);
  };

  it("ends with the same board, in the same stacking order (500 random sets of changes, 6 orders each)", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const next = random(seed);
      const list = changes(next);
      const expected = play(list);
      for (let order = 0; order < 6; order += 1) {
        assert.deepEqual(play(shuffled(list, next)), expected, `seed ${seed}, order ${order}`);
      }
    }
  });

  it("and getting a change twice changes nothing", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed);
      const list = changes(next);
      const twice = list.flatMap((op) => (next() < 0.5 ? [op, op] : [op]));
      assert.deepEqual(play(twice), play(list), `seed ${seed}`);
    }
  });
});
