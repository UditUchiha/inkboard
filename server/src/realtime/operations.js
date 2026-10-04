// Boards change through operations: { upsert: Element[], remove: string[] }.
// Upserted elements replace the element with the same id in place, or are
// appended when new. The client applies the exact same rules.

const ELEMENT_TYPES = new Set(["pen", "line", "rectangle", "ellipse", "arrow", "text"]);
const MAX_ELEMENTS_PER_BOARD = 5000;

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
