import type { Element as BoardElement } from "@inkboard/shared/types";
import type { Rect } from "./geometry";

// Zoomed far out, a board with everything on screen is thousands of shapes, and drawing them is what a pan or a
// remote edit costs, though almost none of it changes from one frame to the next. So the board is kept as tiles,
// pictures of a square of it each, drawn once and copied to the screen while the view moves. A tile is drawn again
// only when something in it changes (or the zoom, the colors or the pictures do). At 100% a screen shows few
// enough shapes to draw outright, and a tile would only be another thing to keep right, so this is for zoomed out.

/** The most a board can be zoomed to and still be drawn from tiles. */
export const TILES_MAX_ZOOM = 0.3;

/** A tile's side, in device pixels. */
export const TILE = 512;

/** What a tile draws beyond its own square, so a stroke or shadow that spills over its edge isn't cut. Device pixels. */
export const GUTTER = 16;

/** The most tiles kept, which is most of the memory they take: about 1 MB each. A screen needing more is drawn outright. */
export const MAX_TILES = 100;

export const drawsFromTiles = (zoom: number): boolean => zoom <= TILES_MAX_ZOOM;

/** A block of tiles, by column (`i0` to `i1`) and row (`j0` to `j1`), both ends included. */
export type TileRange = { i0: number; i1: number; j0: number; j1: number };

/** The tiles that a rectangle of `scale` device pixels per board unit reaches (x and y in board units). */
export function tilesTouching({ x, y, width, height }: Rect, scale: number): TileRange {
  return {
    i0: Math.floor((x * scale) / TILE),
    i1: Math.floor(((x + width) * scale) / TILE),
    j0: Math.floor((y * scale) / TILE),
    j1: Math.floor(((y + height) * scale) / TILE),
  };
}

/** How many tiles a range has. */
export const tileCount = ({ i0, i1, j0, j1 }: TileRange): number => (i1 - i0 + 1) * (j1 - j0 + 1);

/**
 * Where two drawings of a board differ: a rectangle for each element that was added, removed or changed (where it
 * was and where it is, as `areaOf` gives it), or null if what is drawn over what may have changed everywhere: the
 * elements are in another order. Elements are immutable, so a changed one is a different object.
 */
export function changedAreas(
  before: BoardElement[],
  after: BoardElement[],
  areaOf: (element: BoardElement) => Rect,
): Rect[] | null {
  if (before === after) return [];
  const was = new Map(before.map((element) => [element.id, element]));
  const areas: Rect[] = [];
  const stayed: string[] = [];
  for (const element of after) {
    const old = was.get(element.id);
    if (!old) areas.push(areaOf(element));
    else {
      stayed.push(element.id);
      if (old !== element) areas.push(areaOf(old), areaOf(element));
    }
  }
  const stays = new Set(stayed);
  for (const element of before) if (!stays.has(element.id)) areas.push(areaOf(element));
  // What is drawn on top of what depends on the order, which can change with no element changing.
  const sameOrder = before.filter((element) => stays.has(element.id)).every((element, i) => element.id === stayed[i]);
  return sameOrder ? areas : null;
}

/** A tile as kept: what was drawn for it, and whether something has changed in it since. */
type Entry<Tile> = { tile: Tile; stale: boolean };

/**
 * The tiles drawn so far for a board, the last ones used kept (`max` of them). `sync` says what the board is now,
 * and marks stale the tiles it changed, which are to be drawn again. `release` is called with each tile that is
 * let go of, to free what it holds.
 */
export function createTileCache<Tile>(release: (tile: Tile) => void = () => {}, max = MAX_TILES) {
  const entries = new Map<string, Entry<Tile>>(); // "i,j" -> entry, the least recently used first
  let kept: { key: string; elements: BoardElement[] } | null = null;
  const at = (i: number, j: number) => `${i},${j}`;

  function markStale(range: TileRange) {
    for (let i = range.i0; i <= range.i1; i += 1) {
      for (let j = range.j0; j <= range.j1; j += 1) {
        const entry = entries.get(at(i, j));
        if (entry) entry.stale = true;
      }
    }
  }

  return {
    /**
     * Says how the board is drawn now: `key` is everything but the elements that a tile's picture depends on
     * (the zoom, the colors, ...), `elements` as they are drawn. Tiles the change touches are marked stale; when the
     * key is another one, every tile is let go of. Gives whether the key is the same as at the last call: tiles are
     * only worth drawing for a look that stays, not for each step of a zoom.
     */
    sync(key: string, elements: BoardElement[], scale: number, areaOf: (element: BoardElement) => Rect): boolean {
      const same = kept?.key === key;
      if (!same) this.clear();
      else {
        const areas = changedAreas(kept!.elements, elements, areaOf);
        if (areas) for (const area of areas) markStale(tilesTouching(area, scale));
        else for (const entry of entries.values()) entry.stale = true;
      }
      kept = { key, elements };
      return same;
    },

    /** The tile at column `i` and row `j`, now the most recently used, or undefined if there is none. */
    get(i: number, j: number): Entry<Tile> | undefined {
      const entry = entries.get(at(i, j));
      if (entry) {
        entries.delete(at(i, j));
        entries.set(at(i, j), entry);
      }
      return entry;
    },

    /** Keeps `tile` for column `i` and row `j`, as up to date, in place of the one there; at most `max` are kept, the least recently used go first. */
    put(i: number, j: number, tile: Tile) {
      const replaced = entries.get(at(i, j));
      if (replaced) {
        release(replaced.tile);
        entries.delete(at(i, j));
      } else if (entries.size >= max) {
        const oldest = entries.keys().next().value!;
        release(entries.get(oldest)!.tile);
        entries.delete(oldest);
      }
      entries.set(at(i, j), { tile, stale: false });
    },

    /** Lets go of every tile. */
    clear() {
      for (const { tile } of entries.values()) release(tile);
      entries.clear();
    },

    /** How many tiles are kept. */
    get size() {
      return entries.size;
    },
  };
}

/** The renderer's tile cache: its tiles are a picture, and the ids of the pictures drawn in it. */
export type TileCache = ReturnType<typeof createTileCache<{ bitmap: ImageBitmap; pictures: ReadonlySet<string> }>>;
