import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

// Where each element sits in the stack is its `index`: a short string key
// ("a0", "a1", … "b00", …). Boards are kept sorted by key, and drawn in that
// order, so the last element is on top. Ties (two people adding an element at
// the same moment pick the same key) are broken by id, so everyone stacks the
// same board the same way whatever order its changes arrived in. A key can
// always be made above, below or between others, so moving an element in the
// stack only ever changes that element.

const MAX_KEY_LENGTH = 100;
const KEY_CHARACTERS = /^[0-9A-Za-z]+$/;
// A key starts with a letter saying how long its whole-number part is ("a" for 1
// digit, "b" for 2, up to "z" for 26, and "Z" down to "A" for keys below "a0").
// Keys that make real boards never get past "c", but one made up with the longest
// possible number can't be stepped past, only lengthened, until keys are too long
// to take. So whole numbers of more than 13 digits are refused (starting past "m", or before "N").
const KEY_START = /^[N-Za-m]/;

/** Whether `key` is a stacking key this module made (or could have). */
export function isOrderKey(key) {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH || !KEY_CHARACTERS.test(key)) return false;
  if (!KEY_START.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** A key above `key` (or the first key, when there's nothing to go above). */
export const keyAbove = (key) => generateKeyBetween(isOrderKey(key) ? key : null, null);

const keyOf = (element) => element.index ?? "";

/** Sort order for elements: by key, then by id. */
export function compareOrder(a, b) {
  const [keyA, keyB] = [keyOf(a), keyOf(b)];
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The key of the element on top of a sorted board, or null if it's empty. */
export const topKey = (elements) => (elements.length > 0 ? keyOf(elements.at(-1)) || null : null);

export const STACK_MOVES = ["front", "forward", "backward", "back"];

/**
 * The key that moves element `id` in the stack of the sorted board `elements`:
 * to the "front" (top) or "back" (bottom), or a step "forward" or "backward",
 * past the nearest element above or below it that `overlaps` it (stepping past
 * one that doesn't would change nothing anyone can see). Returns null when
 * there's nowhere to move it.
 */
export function keyToMove(elements, id, where, overlaps = () => true) {
  const position = elements.findIndex((element) => element.id === id);
  if (position < 0) return null;
  const keys = elements.map(keyOf);
  if (!keys.every(isOrderKey)) return null;
  let key = null;

  if (where === "front" && position < elements.length - 1) {
    key = generateKeyBetween(keys.at(-1), null);
  } else if (where === "back" && position > 0) {
    key = generateKeyBetween(null, keys[0]);
  } else if (where === "forward") {
    let target = position + 1;
    while (target < elements.length && !overlaps(elements[target])) target += 1;
    if (target === elements.length) return null;
    // Past every element sharing the target's key (ties are broken by id).
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
  // Keys stepped into the same gap again and again grow longer; past the
  // longest the server takes, the move would only happen on this screen.
  return isOrderKey(key) ? key : null;
}

/**
 * `elements` as a board keeps them: each with a key, sorted. Returns the same
 * array when it already is. A board saved before elements had keys is stacked
 * in the order it was stored, so it looks exactly as it did.
 */
export function inStackOrder(elements) {
  if (!elements.every((element) => isOrderKey(element.index))) {
    const keys = generateNKeysBetween(null, null, elements.length);
    return elements.map((element, position) => ({ ...element, index: keys[position] }));
  }
  for (let position = 1; position < elements.length; position += 1) {
    if (compareOrder(elements[position - 1], elements[position]) > 0) return [...elements].sort(compareOrder);
  }
  return elements;
}
