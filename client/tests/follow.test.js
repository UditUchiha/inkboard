import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followedViewport, sameView } from "../src/features/board/useFollow.js";

const canvas = { width: 1000, height: 600 };

describe("following someone's view", () => {
  it("fits the part of the board they see into our canvas", () => {
    const view = followedViewport(
      { x: 0, y: 0, zoom: 1 },
      { x: -100, y: -50, zoom: 2, width: 1000, height: 600 },
      canvas,
    );
    // They see 500 x 300 units from (100, 50); we show the same area.
    assert.equal(view.zoom, 2);
    assert.equal(view.x, -100);
    assert.equal(view.y, -50);
  });

  it("keeps our own view, untouched, when theirs makes no difference", () => {
    const current = { x: -100, y: -50, zoom: 2 };
    const same = followedViewport(current, { x: -100, y: -50, zoom: 2, width: 1000, height: 600 }, canvas);
    assert.equal(same, current);
    const nearly = followedViewport(current, { x: -100.1, y: -50.1, zoom: 2, width: 1000, height: 600 }, canvas);
    assert.equal(nearly, current);
  });

  it("recognises a view it took from someone, so it isn't passed on", () => {
    const taken = followedViewport(
      { x: 0, y: 0, zoom: 1 },
      { x: -10, y: -10, zoom: 1, width: 800, height: 500 },
      canvas,
    );
    assert.equal(sameView({ ...taken }, taken), true);
    assert.equal(sameView({ ...taken, x: taken.x + 1 }, taken), false);
    assert.equal(sameView(taken, null), false);
  });
});
