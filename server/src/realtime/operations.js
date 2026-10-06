import mongoose from "mongoose";

// Boards change through operations: { upsert: Element[], remove: string[] }.
// Upserted elements replace the element with the same id in place, or are
// appended when new. The client applies the exact same rules.

const ELEMENT_TYPES = new Set(["pen", "line", "rectangle", "ellipse", "arrow", "text"]);
export const MAX_ELEMENTS_PER_BOARD = 5000;

// MongoDB refuses documents over 16 MB, and a board is one document. Without
// limits, one huge element (or enough of them) makes every later save fail and
// loses everyone's work until the server restarts. Sizes are measured as MongoDB
// stores them (BSON), which is two to three times bigger than the JSON for a
// freehand stroke, because every number takes eight bytes plus its position.
// A long stroke is tens of kilobytes, so these leave plenty of room.
export const MAX_ELEMENT_BYTES = 500_000;
export const MAX_BOARD_BYTES = 12_000_000;

export const elementBytes = (element) => mongoose.mongo.BSON.calculateObjectSize({ element });

const isValidId = (id) => typeof id === "string" && id.length > 0 && id.length <= 64;

const isValidElement = (element) =>
  element !== null &&
  typeof element === "object" &&
  !Array.isArray(element) &&
  isValidId(element.id) &&
  ELEMENT_TYPES.has(element.type);

export function sanitizeOperation(op) {
  if (!op || typeof op !== "object") return null;
  const upsert = Array.isArray(op.upsert) ? op.upsert.filter(isValidElement) : [];
  const remove = Array.isArray(op.remove) ? op.remove.filter(isValidId) : [];
  if (upsert.length === 0 && remove.length === 0) return null;
  return { upsert, remove };
}

/** A whole board's worth of elements sent in one go (imports and templates). */
export function sanitizeElements(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const elements = [];
  for (const element of list) {
    if (!isValidElement(element) || seen.has(element.id)) continue;
    seen.add(element.id);
    elements.push(element);
    if (elements.length >= MAX_ELEMENTS_PER_BOARD) break;
  }
  return elements;
}

export function applyOperation(elements, { upsert = [], remove = [] }) {
  const removed = new Set(remove);
  const updates = new Map(upsert.map((element) => [element.id, element]));
  const next = [];

  for (const element of elements) {
    if (removed.has(element.id)) continue;
    if (updates.has(element.id)) {
      next.push(updates.get(element.id));
      updates.delete(element.id);
    } else {
      next.push(element);
    }
  }

  for (const element of updates.values()) {
    if (next.length >= MAX_ELEMENTS_PER_BOARD) break;
    next.push(element);
  }

  return next;
}
