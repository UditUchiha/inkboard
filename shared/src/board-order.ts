import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { Element, StackMove } from "./types.ts";

// An element's place in the stack is its `index`, a fractional-indexing key ("a0", "a1", … "b00"); boards are sorted by
// key, then by id (two people adding at once pick the same key), and the last element is on top.

const MAX_KEY_LENGTH = 100;
const KEY_CHARACTERS = /^[0-9A-Za-z]+$/;
// The leading letter says how long the whole-number part is ("a" 1 digit … "z" 26, "Z" down to "A" below "a0"). Real
// boards never pass "c", but a made-up longest key can only be lengthened, until keys are too long to take.
const KEY_START = /^[N-Za-m]/;

export function isOrderKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH || !KEY_CHARACTERS.test(key)) return false;
  if (!KEY_START.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

export const keyAbove = (key: unknown): string => generateKeyBetween(isOrderKey(key) ? key : null, null);

const keyOf = (element: Pick<Element, "index">): string => element.index ?? "";

export function compareOrder(a: Pick<Element, "id" | "index">, b: Pick<Element, "id" | "index">): number {
  const [keyA, keyB] = [keyOf(a), keyOf(b)];
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export const topKey = (elements: readonly Pick<Element, "index">[]): string | null =>
  elements.length > 0 ? keyOf(elements.at(-1)!) || null : null;

export const STACK_MOVES: readonly StackMove[] = ["front", "forward", "backward", "back"];

// stepping past an element that doesn't overlap would change nothing anyone can see; null when there's nowhere to move
// it
export function keyToMove(
  elements: readonly Element[],
  id: string,
  where: StackMove,
  overlaps: (element: Element) => boolean = () => true,
): string | null {
  const position = elements.findIndex((element) => element.id === id);
  if (position < 0) return null;
  const keys = elements.map(keyOf);
  if (!keys.every(isOrderKey)) return null;
  let key: string | null = null;

  if (where === "front" && position < elements.length - 1) {
    key = generateKeyBetween(keys.at(-1), null);
  } else if (where === "back" && position > 0) {
    key = generateKeyBetween(null, keys[0]);
  } else if (where === "forward") {
    let target = position + 1;
    while (target < elements.length && !overlaps(elements[target])) target += 1;
    if (target === elements.length) return null;
    let next = target + 1;
    while (next < elements.length && keys[next] === keys[target]) next += 1;
    key = generateKeyBetween(keys[target], next < elements.length ? keys[next] : null);
  } else if (where === "backward") {
    let target = position - 1;
    while (target >= 0 && !overlaps(elements[target])) target -= 1;
    if (target < 0) return null;
    let previous = target - 1;
    while (previous >= 0 && keys[previous] === keys[target]) previous -= 1;
    key = generateKeyBetween(previous >= 0 ? keys[previous] : null, keys[target]);
  }
  // keys stepped into the same gap again and again grow; past the longest the server takes, the move would only happen
  // on this screen
  return isOrderKey(key) ? key : null;
}

// a board saved before keys is stacked in stored order, so it looks exactly as it did
export function inStackOrder(elements: Element[]): Element[] {
  if (!elements.every((element) => isOrderKey(element.index))) {
    const keys = generateNKeysBetween(null, null, elements.length);
    return elements.map((element, position) => ({ ...element, index: keys[position] }));
  }
  for (let position = 1; position < elements.length; position += 1) {
    if (compareOrder(elements[position - 1], elements[position]) > 0) return [...elements].sort(compareOrder);
  }
  return elements;
}
