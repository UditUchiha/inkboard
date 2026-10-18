import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element } from "@inkboard/shared/types";
import {
  emptyLinkWatch,
  LINK_VISITORS_WARNING,
  MASS_REMOVAL,
  noteRemovals,
  noteVisitor,
  REMOVAL_WINDOW_MS,
} from "../src/realtime/link-watch.ts";

const board = (name: string) => [{ id: name }] as unknown as Element[];

describe("noteVisitor", () => {
  it("says so once, when the people from the link reach the warning, counting each person once", () => {
    const watch = emptyLinkWatch();
    const said = [];
    for (let i = 1; i <= LINK_VISITORS_WARNING + 3; i += 1) {
      said.push(noteVisitor(watch, `guest${i}`));
      noteVisitor(watch, `guest${i}`); // the same person again
    }
    assert.deepEqual(said.map((yes, i) => (yes ? i + 1 : 0)).filter(Boolean), [LINK_VISITORS_WARNING]);
  });
});

describe("noteRemovals", () => {
  it("gives the board from before the first removal once they add up, and only once a window", () => {
    const watch = emptyLinkWatch();
    assert.equal(noteRemovals(watch, MASS_REMOVAL - 1, board("start"), 0), null);
    assert.deepEqual(noteRemovals(watch, 1, board("later"), 1000), board("start"));
    assert.equal(noteRemovals(watch, 50, board("later still"), 2000), null, "said already");
  });

  it("starts counting again after the window", () => {
    const watch = emptyLinkWatch();
    noteRemovals(watch, MASS_REMOVAL - 1, board("old"), 0);
    assert.equal(noteRemovals(watch, 1, board("new"), REMOVAL_WINDOW_MS + 1), null, "the old ones no longer count");
    assert.deepEqual(noteRemovals(watch, MASS_REMOVAL, board("newer"), REMOVAL_WINDOW_MS + 2), board("new"));
  });
});
