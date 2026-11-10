import { keyToMove } from "@inkboard/shared/board-order";
import type { Element as BoardElement, FrameElement, StackMove } from "@inkboard/shared/types";
import { resolveConnectors } from "./connectors";
import { frameContents, getBounds, isFrame } from "./elements";
import { rectsOverlap } from "./geometry";

export function slideFrames(elements: BoardElement[]): FrameElement[] {
  const frames = elements
    .filter(isFrame)
    .map((frame) => ({ frame, box: getBounds(frame) }))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: (typeof frames)[] = [];
  for (const item of frames) {
    const row = rows.at(-1);
    if (row && item.box.y < row[0].box.y + row[0].box.height / 2) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x).map(({ frame }) => frame));
}

export type OutlineNode = { element: BoardElement; children: OutlineNode[] };

export function boardOutline(elements: BoardElement[], limit = Infinity): OutlineNode[] {
  const parent = new Map<string, string>();
  // Smallest frame first, so each element is claimed by the innermost frame around it.
  const size = (frame: FrameElement) => Math.abs((frame.x2 - frame.x1) * (frame.y2 - frame.y1));
  const frames = elements.filter(isFrame).sort((a, b) => size(a) - size(b));
  for (const frame of frames) {
    for (const inside of frameContents(elements, frame)) if (!parent.has(inside.id)) parent.set(inside.id, frame.id);
  }
  const children = new Map<string | null, BoardElement[]>();
  for (const element of elements) {
    const key = parent.get(element.id) ?? null;
    children.set(key, [...(children.get(key) ?? []), element]);
  }
  let left = limit;
  const build = (key: string | null): OutlineNode[] => {
    const level = (children.get(key) ?? [])
      .map((element) => ({ element, box: getBounds(element) }))
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const nodes: OutlineNode[] = [];
    for (const { element } of level) {
      if (left <= 0) break;
      left -= 1;
      nodes.push({ element, children: isFrame(element) ? build(element.id) : [] });
    }
    return nodes;
  };
  return build(null);
}

// Frames draw beneath everything else, so they only move among frames and everything else among the rest.
export function stackKey(board: BoardElement[], element: BoardElement, where: StackMove): string | null {
  const elements = resolveConnectors(board);
  const bounds = getBounds(elements.find((other) => other.id === element.id) ?? element);
  const peers = elements.filter((other) => isFrame(other) === isFrame(element));
  return keyToMove(peers, element.id, where, (other) => rectsOverlap(bounds, getBounds(other)));
}
