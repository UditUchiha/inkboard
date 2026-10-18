import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, ShapeElement } from "@inkboard/shared/types";
import type { Rect } from "../src/features/board/geometry.ts";
import {
  TILE,
  TILES_MAX_ZOOM,
  changedAreas,
  createTileCache,
  drawsFromTiles,
  tileCount,
  tilesTouching,
} from "../src/features/board/zoomedOutCache.ts";

const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): ShapeElement =>
  ({ id, type: "rectangle", x1: x, y1: y, x2: x + 50, y2: y + 50, ...extra }) as unknown as ShapeElement;
// Where an element is, to the tiles' eyes: just its box.
const areaOf = (element: Element): Rect => {
  const { x1, y1, x2, y2 } = element as ShapeElement;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};
const moved = (element: ShapeElement, dx: number): ShapeElement => ({
  ...element,
  x1: element.x1 + dx,
  x2: element.x2 + dx,
});

describe("when the board is drawn from tiles", () => {
  it("is only when zoomed far out", () => {
    assert.ok(drawsFromTiles(0.1));
    assert.ok(drawsFromTiles(TILES_MAX_ZOOM));
    assert.ok(!drawsFromTiles(TILES_MAX_ZOOM + 0.01));
    assert.ok(!drawsFromTiles(1));
  });
});

describe("the tiles a part of the board reaches", () => {
  it("counts a tile for each square of device pixels, edges included", () => {
    // At 10% of device pixels, a 2,000 unit square is 200 pixels: inside the first tile.
    assert.deepEqual(tilesTouching({ x: 0, y: 0, width: 2000, height: 2000 }, 0.1), { i0: 0, i1: 0, j0: 0, j1: 0 });
    // One that starts a unit before a tile's edge and ends on the next tile's.
    const range = tilesTouching({ x: TILE - 1, y: 0, width: 1, height: 1 }, 1);
    assert.deepEqual(range, { i0: 0, i1: 1, j0: 0, j1: 0 });
    assert.equal(tileCount(range), 2);
  });

  it("reaches the tiles on the left of and above the origin, which are numbered below zero", () => {
    assert.deepEqual(tilesTouching({ x: -10, y: -TILE - 10, width: 5, height: 5 }, 1), {
      i0: -1,
      i1: -1,
      j0: -2,
      j1: -2,
    });
  });

  it("goes by the scale: twice the pixels per unit reach twice the tiles", () => {
    const area = { x: 0, y: 0, width: 2 * TILE, height: 10 };
    assert.equal(tileCount(tilesTouching(area, 1)), 3);
    assert.equal(tileCount(tilesTouching(area, 2)), 5);
  });
});

describe("what changed between two drawings of a board", () => {
  const a = box("a", 0, 0);
  const b = box("b", 500, 0);
  const c = box("c", 900, 900);

  it("is nothing for the same board, or the same elements in a new array", () => {
    const board = [a, b];
    assert.deepEqual(changedAreas(board, board, areaOf), []);
    assert.deepEqual(changedAreas(board, [a, b], areaOf), []);
  });

  it("is where an element was and where it is, when it changed", () => {
    const b2 = moved(b, 100);
    assert.deepEqual(changedAreas([a, b, c], [a, b2, c], areaOf), [areaOf(b), areaOf(b2)]);
  });

  it("is where an element is, when it was added, and where it was, when it was removed", () => {
    assert.deepEqual(changedAreas([a, b], [a, b, c], areaOf), [areaOf(c)]);
    assert.deepEqual(changedAreas([a, b, c], [a, c], areaOf), [areaOf(b)]);
  });

  it("is everything (null) when what is drawn over what has changed", () => {
    assert.equal(changedAreas([a, b, c], [a, c, b], areaOf), null);
    // Even with an element added as well, so that the lengths differ.
    assert.equal(changedAreas([a, b], [b, a, c], areaOf), null);
  });
});

describe("the tiles kept for a board", () => {
  const board = [box("a", 0, 0), box("b", 3 * TILE, 0)]; // at a scale of 1, in the first tile and the fourth
  const sync = (cache: ReturnType<typeof createTileCache<string>>, elements: Element[], key = "look") =>
    cache.sync(key, elements, 1, areaOf);

  const filled = () => {
    const cache = createTileCache<string>();
    sync(cache, board);
    cache.put(0, 0, "first");
    cache.put(1, 0, "between");
    cache.put(3, 0, "fourth");
    return cache;
  };

  it("have a stale one only where something changed", () => {
    const cache = filled();
    assert.equal(sync(cache, [board[0]!, moved(board[1] as ShapeElement, 5)]), true);
    assert.equal(cache.get(0, 0)?.stale, false);
    assert.equal(cache.get(1, 0)?.stale, false);
    assert.equal(cache.get(3, 0)?.stale, true);
  });

  it("are all stale when the elements are in another order", () => {
    const cache = filled();
    sync(cache, [board[1]!, board[0]!]);
    for (const i of [0, 1, 3]) assert.equal(cache.get(i, 0)?.stale, true);
  });

  it("are all let go of when the look changes, which says so so that a zoom is not drawn tile by tile", () => {
    const released: string[] = [];
    const cache = createTileCache<string>((tile) => released.push(tile));
    assert.equal(sync(cache, board), false, "the first look is new");
    cache.put(0, 0, "first");
    assert.equal(sync(cache, board), true);
    assert.equal(sync(cache, board, "zoomed"), false);
    assert.deepEqual(released, ["first"]);
    assert.equal(cache.size, 0);
  });

  it("are at most as many as the cache is for, the least recently used going first", () => {
    const released: string[] = [];
    const cache = createTileCache<string>((tile) => released.push(tile), 2);
    cache.put(0, 0, "a");
    cache.put(1, 0, "b");
    cache.get(0, 0); // now b is the one longest unused
    cache.put(2, 0, "c");
    assert.deepEqual(released, ["b"]);
    assert.equal(cache.size, 2);
    assert.equal(cache.get(1, 0), undefined);
  });

  it("let go of a tile that is drawn again in its place", () => {
    const released: string[] = [];
    const cache = createTileCache<string>((tile) => released.push(tile));
    cache.put(0, 0, "old");
    cache.put(0, 0, "new");
    assert.deepEqual(released, ["old"]);
    assert.equal(cache.get(0, 0)?.tile, "new");
    cache.clear();
    assert.deepEqual(released, ["old", "new"]);
  });
});
