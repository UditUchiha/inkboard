import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  groupsOf,
  isNonce,
  isStamped,
  isVersion,
  MAX_VERSION,
  MAX_VERSION_JUMP,
  stampOf,
  withStamps,
} from "@inkboard/shared/board-merge";
import { inStackOrder, isOrderKey, keyAbove, topKey } from "@inkboard/shared/board-order";
import { cleanElement, isValidId, withDefaults } from "@inkboard/shared/element-rules";
import { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT } from "@inkboard/shared/limits";
import mongoose from "mongoose";

// Boards change through operations: { upsert: Element[], remove: Removal[] },
// taken in by the rules in shared/src/board-merge.ts, which the browser applies
// too. Each element is checked and cleaned first (see shared/src/element-rules.ts).

// Shared with the browser (shared/src/limits.ts); re-exported for the rest of the server.
export { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT };

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

/** Whether an operation names more elements, or removals, than a board can hold (either list alone). */
export const isOversized = (op) =>
  (Array.isArray(op?.upsert) && op.upsert.length > MAX_ELEMENTS_PER_BOARD) ||
  (Array.isArray(op?.remove) && op.remove.length > MAX_ELEMENTS_PER_BOARD);

// A change too big for one message is sent as pieces of one group, which are
// held until the last arrives and then taken in together, so a change is made
// whole or not at all: a piece that is refused takes the whole group with it.
export const MAX_GROUP_PIECES = 40;
export const MAX_GROUP_BYTES = 16_000_000;

/**
 * `held` (what this connection has of a group so far, or null) with the piece
 * `op` of `group` ({ id, index, total }) added. Pieces come in order, starting
 * with index 0, which abandons any group held before. Returns `{ held }` to hold
 * for now, `{ held: null, op }` with the pieces joined once the last is in, or
 * `{ held: null, error }` ("invalid" or "tooLarge") when the group is dropped.
 * `held` may also be `{ id, expired: true }`: a group the server stopped waiting
 * for, whose later pieces are refused as "expired" (the sender sends it all again).
 */
export function holdPiece(held, group, op) {
  const valid =
    group &&
    typeof group.id === "string" &&
    group.id.length > 0 &&
    group.id.length <= 64 &&
    Number.isInteger(group.total) &&
    group.total >= 2 &&
    group.total <= MAX_GROUP_PIECES &&
    Number.isInteger(group.index) &&
    group.index >= 0 &&
    group.index < group.total &&
    op &&
    typeof op === "object";
  if (!valid) return { held: null, error: "invalid" };
  if (group.index > 0 && held?.expired && held.id === group.id) return { held: null, error: "expired" };
  const state =
    group.index === 0
      ? { id: group.id, total: group.total, pieces: [], bytes: 0 }
      : held?.id === group.id && held.total === group.total
        ? held
        : null;
  if (!state || state.pieces.length !== group.index) return { held: null, error: "invalid" };
  const bytes = state.bytes + JSON.stringify(op).length;
  if (bytes > MAX_GROUP_BYTES) return { held: null, error: "tooLarge" };
  const pieces = [...state.pieces, op];
  if (pieces.length < group.total) return { held: { ...state, pieces, bytes } };
  const listed = (name) => pieces.flatMap((piece) => (Array.isArray(piece[name]) ? piece[name] : []));
  return { held: null, op: { upsert: listed("upsert"), remove: listed("remove") } };
}

/**
 * The operation as it may be taken in, or null if nothing in it is valid. Along
 * with `upsert` and `remove` it lists what the sender should hear about:
 * `changed`, elements as they'll be stored when that isn't how they were sent,
 * and `refused`, the ids of elements that can't be stored at all.
 */
export function sanitizeOperation(op) {
  if (!op || typeof op !== "object") return null;
  const upsert = [];
  const changed = [];
  const refused = [];
  for (const raw of Array.isArray(op.upsert) ? op.upsert : []) {
    const element = cleanElement(raw);
    if (!element) {
      if (isValidId(raw?.id)) refused.push(raw.id);
      continue;
    }
    upsert.push(element);
    if (!isDeepStrictEqual(raw, element)) changed.push(element);
  }
  const remove = Array.isArray(op.remove) ? op.remove.map(cleanRemoval).filter(Boolean) : [];
  if (upsert.length === 0 && remove.length === 0) return null;
  return { upsert, remove, changed, refused };
}

/**
 * A whole board's worth of elements sent in one go (imports and templates),
 * cleaned. Elements too big to store are left out, and so is everything past
 * what a board can hold (in count and in bytes).
 */
export function sanitizeElements(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const elements = [];
  let bytes = 0;
  for (const raw of list) {
    const element = cleanElement(raw);
    if (!element || seen.has(element.id)) continue;
    const size = elementBytes(element);
    if (size > MAX_ELEMENT_BYTES || bytes + size > MAX_BOARD_BYTES) continue;
    seen.add(element.id);
    elements.push(element);
    bytes += size;
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
 * stack: the one it has, or, for a new element, the top. A stamp that's further
 * ahead of the board's than anyone could get by editing (MAX_VERSION_JUMP) is
 * replaced by one for the newest edit, or an element could be forged out of
 * reach of every later change. `index` is the board's elements by id, if kept.
 */
export function prepareOperation(elements, op, tombstones, { legacy = false, index = null } = {}) {
  const ids = new Set([...op.upsert.map((element) => element.id), ...op.remove.map((removal) => removal.id)]);
  const live = new Map();
  if (index) {
    for (const id of ids) if (index.has(id)) live.set(id, index.get(id));
  } else {
    for (const element of elements) if (ids.has(element.id)) live.set(element.id, element);
  }
  const newest = (id) => Math.max(stampOf(live.get(id)).version, stampOf(tombstones.get(id)).version);
  const fresh = (id) => ({ version: Math.min(newest(id) + 1, MAX_VERSION), versionNonce: randomInt(2 ** 31) });
  const believable = (change) => isStamped(change) && change.version <= newest(change.id) + MAX_VERSION_JUMP;
  let top = topKey(elements);

  const upsert = op.upsert.map((incoming) => {
    let element = incoming;
    if (legacy || !believable(element)) {
      const stamp = believable(element) ? stampOf(element) : fresh(element.id);
      element = withStamps(element, Object.fromEntries(groupsOf(element).map((group) => [group, stamp])));
    }
    if (element.index === undefined) {
      const known = live.get(element.id) ?? tombstones.get(element.id)?.element;
      let position = known?.index;
      if (position === undefined) {
        // Past the longest keys the board takes (only a forged key gets there), it shares the top's.
        const above = keyAbove(top);
        position = isOrderKey(above) ? above : top;
        top = position;
      }
      element = { ...element, index: position };
    }
    return element;
  });
  const remove = op.remove.map((removal) => (believable(removal) ? removal : { id: removal.id, ...fresh(removal.id) }));
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
  for (const stamped of [...elements, ...tombstones.values(), ...snapshot])
    newest = Math.max(newest, stampOf(stamped).version);
  const stamp = () => ({ version: Math.min(newest + RESTORE_LEAD, MAX_VERSION), versionNonce: randomInt(2 ** 31) });

  // Fields an older snapshot's elements lack are filled in first and stamped with the rest, so a change
  // still on its way from before the restore (a label on an arrow that had none then) can't win them.
  const restored = inStackOrder(snapshot).map((saved) => {
    const now = stamp();
    const element = withDefaults(saved);
    return withStamps(element, Object.fromEntries(groupsOf(element).map((group) => [group, now])));
  });
  const kept = new Set(restored.map((element) => element.id));
  const graves = new Map([...tombstones].filter(([id]) => !kept.has(id)));
  for (const element of elements) {
    if (!kept.has(element.id)) graves.set(element.id, { ...stamp(), element });
  }
  return { elements: restored, tombstones: graves };
}
