import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOperation as clientApply } from "../../client/src/features/board/store.js";
import { MAX_ELEMENTS_PER_BOARD as clientMaxElements } from "../../client/src/features/board/constants.js";
import { applyOperation as serverApply, MAX_ELEMENTS_PER_BOARD } from "../src/realtime/operations.js";

// Every change is applied by the browser and, separately, by the server. If the
// two ever disagree, people's screens drift apart from what gets saved. This runs
// the same random operations through both and expects identical boards.

// A small seeded generator, so a failure can be reproduced from its seed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const element = (id, version) => ({ id, type: "rectangle", x1: version, y1: 0, x2: 10, y2: 10 });

function randomOperation(next, ids) {
  const pick = () => ids[Math.floor(next() * ids.length)];
  const upsert = Array.from({ length: Math.floor(next() * 4) }, () => element(pick(), Math.floor(next() * 1000)));
  const remove = Array.from({ length: Math.floor(next() * 3) }, pick);
  return { upsert, remove };
}

describe("client and server apply operations the same way", () => {
  it("agree on 300 random sequences of upserts and removals", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `el-${index}`);
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      let client = [];
      let server = [];
      for (let step = 0; step < 25; step += 1) {
        const op = randomOperation(next, ids);
        client = clientApply(client, op);
        server = serverApply(server, op);
        assert.deepEqual(client, server, `diverged at seed ${seed}, step ${step}`);
      }
    }
  });

  it("agree on edge cases: the same id twice in one operation, removing and upserting the same id, and empty operations", () => {
    const start = [element("a", 1), element("b", 2)];
    const cases = [
      { upsert: [element("a", 9), element("a", 10)], remove: [] },
      { upsert: [element("c", 3)], remove: ["c"] },
      { upsert: [element("a", 5)], remove: ["a"] },
      { upsert: [], remove: [] },
      { upsert: [], remove: ["missing"] },
      { upsert: [element("z", 1), element("y", 2)], remove: ["b"] },
    ];
    for (const op of cases) {
      assert.deepEqual(clientApply(start, op), serverApply(start, op), JSON.stringify(op));
    }
  });

  it("don't mutate the board they were given", () => {
    const start = Object.freeze([Object.freeze(element("a", 1))]);
    const op = { upsert: [element("a", 2), element("b", 3)], remove: [] };
    assert.doesNotThrow(() => clientApply(start, op));
    assert.doesNotThrow(() => serverApply(start, op));
    assert.equal(start[0].x1, 1);
  });

  it("share the same cap on elements per board", () => {
    assert.equal(clientMaxElements, MAX_ELEMENTS_PER_BOARD);
  });
});
