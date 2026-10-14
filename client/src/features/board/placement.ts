import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds, getSceneBounds, isFrame, translate } from "./elements";
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
 * `element`, put down from the keyboard, where it is if that's clear, or else the nearest clear spot beside it, so
 * it doesn't hide what's already there. A shape may still go inside a frame; a frame keeps clear of everything.
 */
export function placeFree(elements: BoardElement[], element: BoardElement): BoardElement {
  const others = isFrame(element) ? elements : elements.filter((other) => !isFrame(other));
  const box = getBounds(element);
  if (!others.some((other) => rectsOverlap(getBounds(other), box))) return element;
  const [dx, dy] = copyOffset(others, [element], 24);
  return translate(element, dx, dy);
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

/**
 * Where `count` copies of `frame` (made for a class, see ClassroomPanels) go: rows of them to the right of everything
 * on the board, `gap` apart, as near square as can be. Returns each one's offset `[dx, dy]` from the frame.
 */
export function copyGrid(elements: BoardElement[], frame: BoardElement, count: number, gap = 80): Pair[] {
  const box = getBounds(frame);
  // The non-null assertion: the frame is on the board, so the board has bounds.
  const scene = getSceneBounds(elements)!;
  const columns = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, i): Pair => [
    scene.x + scene.width + gap + (i % columns) * (box.width + gap) - box.x,
    scene.y + Math.floor(i / columns) * (box.height + gap) - box.y,
  ]);
}

/** `count` names for copies of a frame called `name`: "Group 1", "Group 2", …, skipping any a frame on the board has. */
export function copyNames(elements: BoardElement[], name: string, count: number): string[] {
  const base = name.replace(/\s*\d+$/, "") || "Frame";
  const taken = new Set(elements.flatMap((element) => (element.type === "frame" ? [element.name] : [])));
  const names: string[] = [];
  for (let number = 1; names.length < count; number += 1) {
    if (!taken.has(`${base} ${number}`)) names.push(`${base} ${number}`);
  }
  return names;
}
