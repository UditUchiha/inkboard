import { randomInt } from "node:crypto";
import mongoose from "mongoose";
import { cleanElement, isValidId } from "./element-rules.js";

// Boards change through operations: { upsert: Element[], remove: Removal[] }.
// Upserted elements replace the element with the same id in place, or are
// appended when new. The client applies the exact same rules (including the
// version rules below). Each element is checked and cleaned first (see element-rules.js).

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

const isStamp = (version, nonce) =>
  Number.isSafeInteger(version) && version >= 0 && Number.isInteger(nonce) && nonce >= 0 && nonce < 2 ** 31;

// A removal is { id, version, versionNonce }; older browsers send just the id.
function cleanRemoval(entry) {
  if (isValidId(entry)) return { id: entry };
  if (!entry || typeof entry !== "object" || !isValidId(entry.id)) return null;
  return isStamp(entry.version, entry.versionNonce)
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

// Two people can change the same element at once, and their changes arrive in
// different orders. Every change is stamped: an upserted element, and a removal,
// carry a `version` (one past the state they were made from) and a random
// `versionNonce`. A change only takes effect over a state it supersedes: the
// higher version wins, and for the same version the lower nonce. Removed
// elements leave a tombstone (their removal's stamp) so an older edit arriving
// late can't bring them back. The client applies the identical rules
// (client/src/features/board/store.js), so everyone ends up with the same board.
const versionOf = (stamped) => (Number.isInteger(stamped?.version) ? stamped.version : 0);
const nonceOf = (stamped) => (Number.isInteger(stamped?.versionNonce) ? stamped.versionNonce : 0);

/** Whether the change `incoming` should win over `current`, an earlier state of the same element. */
export function supersedes(incoming, current) {
  const difference = versionOf(incoming) - versionOf(current);
  return difference !== 0 ? difference > 0 : nonceOf(incoming) <= nonceOf(current);
}

const stampOf = (removal, current) =>
  Number.isInteger(removal.version)
    ? { version: removal.version, versionNonce: nonceOf(removal) }
    : { version: versionOf(current) + 1, versionNonce: 0 };

/**
 * The part of `op` that changes the board: upserts and removals that don't
 * supersede the element's current state (or its tombstone) are dropped, so
 * they're neither stored, counted against the board's size, nor passed on.
 * Changes without a stamp come from a browser still running an older version
 * of the app; they're stamped as the newest edit, so they work as they always did.
 */
export function keepNewer(elements, op, tombstones = new Map()) {
  const ids = new Set([...op.upsert.map((element) => element.id), ...op.remove.map((removal) => removal.id)]);
  const live = new Map();
  for (const element of elements) if (ids.has(element.id)) live.set(element.id, element);
  const newest = (id) => live.get(id) ?? tombstones.get(id);
  const stamped = (change) =>
    Number.isInteger(change.version) ? change : { ...change, version: versionOf(newest(change.id)) + 1, versionNonce: randomInt(2 ** 31) };

  const upsert = [];
  for (const element of op.upsert.map(stamped)) {
    const current = newest(element.id);
    if (!current || supersedes(element, current)) upsert.push(element);
  }
  const remove = [];
  for (const removal of op.remove.map(stamped)) {
    const current = newest(removal.id);
    if (!current || supersedes(removal, current)) remove.push(removal);
  }
  return { upsert, remove };
}

/**
 * Applies `op` to `elements` and returns the new list (the old one isn't
 * changed). `tombstones` (id -> stamp of its removal) is read and updated.
 */
export function applyOperation(elements, { upsert = [], remove = [] }, tombstones = new Map()) {
  if (upsert.length === 0 && remove.length === 0) return elements;
  const live = new Map(elements.map((element) => [element.id, element]));
  const changed = new Map(); // id -> its new state, kept in its place
  const added = new Map(); // id -> element appended at the end, in order

  for (const entry of remove) {
    const removal = typeof entry === "string" ? { id: entry } : entry;
    const current = live.get(removal.id);
    if (current) {
      if (!Number.isInteger(removal.version) || supersedes(removal, current)) {
        live.delete(removal.id);
        changed.delete(removal.id);
        tombstones.set(removal.id, stampOf(removal, current));
      }
    } else if (Number.isInteger(removal.version)) {
      const tombstone = tombstones.get(removal.id);
      if (!tombstone || supersedes(removal, tombstone)) tombstones.set(removal.id, stampOf(removal));
    }
  }

  for (const element of upsert) {
    const current = added.get(element.id) ?? changed.get(element.id) ?? live.get(element.id);
    if (current) {
      if (!supersedes(element, current)) continue;
      if (added.has(element.id)) added.set(element.id, element);
      else changed.set(element.id, element);
    } else {
      const tombstone = tombstones.get(element.id);
      if (tombstone && !supersedes(element, tombstone)) continue;
      tombstones.delete(element.id);
      added.set(element.id, element);
    }
  }

  const next = [];
  for (const element of elements) {
    if (!live.has(element.id)) continue;
    next.push(changed.get(element.id) ?? element);
  }
  for (const element of added.values()) {
    if (next.length >= MAX_ELEMENTS_PER_BOARD) break;
    next.push(element);
  }
  return next;
}
