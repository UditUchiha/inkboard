import { randomInt } from "node:crypto";
import { groupsOf, isNonce, isStamped, isVersion, stampOf, withStamps } from "@inkboard/shared/board-merge";
import { inStackOrder, keyAbove, topKey } from "@inkboard/shared/board-order";
import mongoose from "mongoose";
import { cleanElement, isValidId } from "./element-rules.js";

// Boards change through operations: { upsert: Element[], remove: Removal[] },
// taken in by the rules in shared/src/board-merge.js, which the browser applies
// too. Each element is checked and cleaned first (see element-rules.js).

export const MAX_ELEMENTS_PER_BOARD = 5000;

// The rules for merging changes the current app follows (it says so when it
// joins a board): 2, each element's property groups carry their own stamps.
export const SYNC_FORMAT = 2;

// MongoDB refuses documents over 16 MB, and a board is one document. Without
// limits, one huge element (or enough of them) makes every later save fail and
// loses everyone's work until the server restarts. Sizes are measured as MongoDB
// stores them (BSON), which is two to three times bigger than the JSON for a
// freehand stroke, because every number takes eight bytes plus its position.
// A long stroke is tens of kilobytes, so these leave plenty of room.
export const MAX_ELEMENT_BYTES = 500_000;
export const MAX_BOARD_BYTES = 12_000_000;

export const elementBytes = (element) => mongoose.mongo.BSON.calculateObjectSize({ element });

// A removal is { id, version, versionNonce }; older browsers send just the id.
// One whose stamp isn't valid (past MAX_VERSION, say) is stamped as the newest edit.
function cleanRemoval(entry) {
  if (isValidId(entry)) return { id: entry };
  if (!entry || typeof entry !== "object" || !isValidId(entry.id)) return null;
  return isVersion(entry.version) && isNonce(entry.versionNonce)
    ? { id: entry.id, version: entry.version, versionNonce: entry.versionNonce }
    : { id: entry.id };
}

export function sanitizeOperation(op) {
  if (!op || typeof op !== "object") return null;
  const upsert = Array.isArray(op.upsert) ? op.upsert.map(cleanElement).filter(Boolean) : [];
  const remove = Array.isArray(op.remove) ? op.remove.map(cleanRemoval).filter(Boolean) : [];
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

/**
 * Gets an operation ready to be taken in. Changes from browsers still running
 * an older version of the app (`legacy`) don't stamp each property group: an
 * element from one is taken as a whole, at its version, and one without a
 * version (older still) is stamped here as the newest edit, so those people's
 * changes keep working as they always did. Every element gets a place in the
 * stack: the one it has, or, for a new element, the top.
 */
export function prepareOperation(elements, op, tombstones, { legacy = false } = {}) {
  const ids = new Set([...op.upsert.map((element) => element.id), ...op.remove.map((removal) => removal.id)]);
  const live = new Map();
  for (const element of elements) if (ids.has(element.id)) live.set(element.id, element);
  const newest = (id) => Math.max(stampOf(live.get(id)).version, stampOf(tombstones.get(id)).version);
  const fresh = (id) => ({ version: newest(id) + 1, versionNonce: randomInt(2 ** 31) });
  let top = topKey(elements);

  const upsert = op.upsert.map((incoming) => {
    let element = incoming;
    if (legacy || !isStamped(element)) {
      const stamp = isStamped(element) ? stampOf(element) : fresh(element.id);
      element = withStamps(element, Object.fromEntries(groupsOf(element).map((group) => [group, stamp])));
    }
    if (element.index === undefined) {
      const known = live.get(element.id) ?? tombstones.get(element.id)?.element;
      let index = known?.index;
      if (index === undefined) {
        index = keyAbove(top);
        top = index;
      }
      element = { ...element, index };
    }
    return element;
  });
  const remove = op.remove.map((removal) => (isStamped(removal) ? removal : { id: removal.id, ...fresh(removal.id) }));
  return { upsert, remove };
}

/**
 * The board after restoring `snapshot` (an earlier version) over `elements`.
 * Restored elements are stamped as the newest edit of everything, and elements
 * the snapshot doesn't have are removed by a removal just as new, so changes
 * still on their way from before the restore can't undo parts of it. They're
 * stamped well ahead: each step of a drag is a new version, so someone in the
 * middle of one can have dozens on the way. Returns { elements, tombstones }.
 */
export const RESTORE_LEAD = 1000;

export function restoreOver(elements, tombstones, snapshot) {
  let newest = 0;
  for (const stamped of [...elements, ...tombstones.values(), ...snapshot]) newest = Math.max(newest, stampOf(stamped).version);
  const stamp = () => ({ version: newest + RESTORE_LEAD, versionNonce: randomInt(2 ** 31) });

  const restored = inStackOrder(snapshot).map((element) => {
    const now = stamp();
    return withStamps(element, Object.fromEntries(groupsOf(element).map((group) => [group, now])));
  });
  const kept = new Set(restored.map((element) => element.id));
  const graves = new Map([...tombstones].filter(([id]) => !kept.has(id)));
  for (const element of elements) {
    if (!kept.has(element.id)) graves.set(element.id, { ...stamp(), element });
  }
  return { elements: restored, tombstones: graves };
}
