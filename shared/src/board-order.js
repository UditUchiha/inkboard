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

/** Whether `key` is a stacking key this module made (or could have). */
export function isOrderKey(key) {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH || !KEY_CHARACTERS.test(key)) return false;
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
