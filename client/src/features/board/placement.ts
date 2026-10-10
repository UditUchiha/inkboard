import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds, getSceneBounds } from "./elements";
import { rectsOverlap } from "./geometry";
import type { Pair, Rect, Size, Viewport } from "./geometry";

const TRIES = 10;

/**
 * Where a copy of `group` (a frame and what is in it) goes: the nearest spot beside the original, to
 * the right, below, to the left or above, that has nothing else on it. Returns the offset `[dx, dy]`.
 * A copy put a fixed distance to the right would land on the next column of a Kanban board.
 */
export function copyOffset(elements: BoardElement[], group: BoardElement[], gap = 80): Pair {
  const taken = new Set(group.map((element) => element.id));
  const others = elements.filter((element) => !taken.has(element.id)).map(getBounds);
  // The non-null assertions: a group has something in it, and what's in it is on the board.
  const box = getSceneBounds(group)!;
  const free = (dx: number, dy: number) => {
    const spot = { x: box.x + dx - gap / 2, y: box.y + dy - gap / 2, width: box.width + gap, height: box.height + gap };
    return !others.some((other) => rectsOverlap(spot, other));
  };
  const stepX = box.width + gap;
  const stepY = box.height + gap;
  for (let step = 1; step <= TRIES; step += 1) {
    for (const [dx, dy] of [
      [step * stepX, 0],
      [0, step * stepY],
      [-step * stepX, 0],
      [0, -step * stepY],
    ]) {
      if (free(dx, dy)) return [dx, dy];
    }
  }
  // Crowded all round: beyond everything.
  const scene = getSceneBounds(elements)!;
  return [scene.x + scene.width + gap - box.x, 0];
}

/**
 * The view that brings `bounds` (a rectangle of the board) into sight: `viewport` itself if any of it is
 * already showing, otherwise the same zoom with the rectangle's centre in the middle of the canvas.
 */
export function viewToReveal(viewport: Viewport, canvasSize: Size, bounds: Rect): Viewport {
  const visible = {
    x: -viewport.x,
    y: -viewport.y,
    width: canvasSize.width / viewport.zoom,
    height: canvasSize.height / viewport.zoom,
  };
  if (rectsOverlap(visible, bounds)) return viewport;
  return {
    ...viewport,
    x: visible.width / 2 - (bounds.x + bounds.width / 2),
    y: visible.height / 2 - (bounds.y + bounds.height / 2),
  };
}
