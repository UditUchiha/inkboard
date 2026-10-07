import mongoose from "mongoose";
import { cleanElement, isValidId } from "./element-rules.js";

// Boards change through operations: { upsert: Element[], remove: string[] }.
// Upserted elements replace the element with the same id in place, or are
// appended when new. The client applies the exact same rules. Each element is
// checked and cleaned first (see element-rules.js).

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

export function sanitizeOperation(op) {
  if (!op || typeof op !== "object") return null;
  const upsert = Array.isArray(op.upsert) ? op.upsert.map(cleanElement).filter(Boolean) : [];
  const remove = Array.isArray(op.remove) ? op.remove.filter(isValidId) : [];
  if (upsert.length === 0 && remove.length === 0) return null;
  return { upsert, remove };
}

/** A whole board's worth of elements sent in one go (imports and templates). */
export function sanitizeElements(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const elements = [];
  for (const raw of list) {
    const element = cleanElement(raw);
    if (!element || seen.has(element.id)) continue;
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
