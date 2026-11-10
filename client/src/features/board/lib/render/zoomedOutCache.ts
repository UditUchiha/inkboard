import type { Element as BoardElement } from "@inkboard/shared/types";
import type { Rect } from "../elements/geometry";

// Zoomed far out a pan or remote edit redraws thousands of shapes that barely change, so the board is kept as tiles
// drawn once and copied while the view moves; a tile is redrawn only when something in it (or the zoom, colors or
// pictures) changes.

export const TILES_MAX_ZOOM = 0.3;

export const TILE = 512;

export const GUTTER = 16;

// Memory is mostly these (about 1 MB each); a screen needing more is drawn outright.
export const MAX_TILES = 100;

export const drawsFromTiles = (zoom: number): boolean => zoom <= TILES_MAX_ZOOM;

export type TileRange = { i0: number; i1: number; j0: number; j1: number };

export function tilesTouching({ x, y, width, height }: Rect, scale: number): TileRange {
  return {
    i0: Math.floor((x * scale) / TILE),
    i1: Math.floor(((x + width) * scale) / TILE),
    j0: Math.floor((y * scale) / TILE),
    j1: Math.floor(((y + height) * scale) / TILE),
  };
}

export const tileCount = ({ i0, i1, j0, j1 }: TileRange): number => (i1 - i0 + 1) * (j1 - j0 + 1);

// A rectangle per element added, removed or changed; null when the order changed, as that changes what covers what
// everywhere.
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
  const sameOrder = before.filter((element) => stays.has(element.id)).every((element, i) => element.id === stayed[i]);
  return sameOrder ? areas : null;
}

type Entry<Tile> = { tile: Tile; stale: boolean };

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
    // Returns whether `key` (everything but the elements that a tile depends on: zoom, colors…) is unchanged: tiles are
    // only worth drawing for a look that stays.
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

    get(i: number, j: number): Entry<Tile> | undefined {
      const entry = entries.get(at(i, j));
      if (entry) {
        entries.delete(at(i, j));
        entries.set(at(i, j), entry);
      }
      return entry;
    },

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

    clear() {
      for (const { tile } of entries.values()) release(tile);
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}

export type TileCache = ReturnType<typeof createTileCache<{ bitmap: ImageBitmap; pictures: ReadonlySet<string> }>>;
