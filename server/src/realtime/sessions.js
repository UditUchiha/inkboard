import { commitPlan } from "@inkboard/shared/board-merge";
import { inStackOrder } from "@inkboard/shared/board-order";
import mongoose from "mongoose";
import { Board } from "../models/board.model.js";
import { lastVersionTime, recordVersion } from "../services/versions.js";
import { elementBytes, MAX_BOARD_BYTES, MAX_ELEMENT_BYTES, MAX_ELEMENTS_PER_BOARD, restoreOver } from "./operations.js";

// Boards that are open in at least one browser live in memory, so every
// stroke can be broadcast immediately. Changes are written to MongoDB shortly
// after they happen, and flushed when the last person leaves. A crash can lose
// whatever hasn't been written yet, so small boards (the common case, and cheap
// to write) are saved within a quarter of a second. Saving costs time in
// proportion to the board's size (about 0.4 s per 2 MB), so bigger boards wait
// longer between saves, or a busy one would spend all its time saving.
const BASE_PERSIST_DELAY_MS = 250;
const MAX_PERSIST_DELAY_MS = 5000;
const BYTES_PER_EXTRA_MS = 4000;

const persistDelay = (session) =>
  Math.min(MAX_PERSIST_DELAY_MS, BASE_PERSIST_DELAY_MS + Math.round(session.bytes / BYTES_PER_EXTRA_MS));

// Before the first change after a quiet spell of this long, the board is saved
// as a version, so version history has a checkpoint from before each burst of work.
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

const sessions = new Map();

export function getSession(boardId) {
  return sessions.get(boardId);
}

// How big each element is, and the total, so a board can't outgrow what the database can store.
function measure(session) {
  session.sizes = new Map(session.elements.map((element) => [element.id, elementBytes(element)]));
  session.bytes = [...session.sizes.values()].reduce((sum, size) => sum + size, 0);
}

/**
 * Decides whether a change can be accepted. Returns null when it fits, or why it
 * doesn't: "element" (one element is too big) or "board" (the board would be too
 * big). Changes that make a board smaller are always accepted. When it fits, the
 * board's size tracking is updated, so call updateSession with the same change next.
 */
export function admit(session, op) {
  const updates = new Map(op.upsert.map((element) => [element.id, elementBytes(element)]));
  const removals = new Set(op.remove.map((removal) => removal.id).filter((id) => !updates.has(id)));

  let bytes = session.bytes;
  for (const [id, size] of updates) {
    if (size > MAX_ELEMENT_BYTES) return "element";
    bytes += size - (session.sizes.get(id) ?? 0);
  }
  for (const id of removals) bytes -= session.sizes.get(id) ?? 0;
  if (bytes > MAX_BOARD_BYTES && bytes > session.bytes) return "board";

  for (const [id, size] of updates) session.sizes.set(id, size);
  for (const id of removals) session.sizes.delete(id);
  session.bytes = bytes;
  return null;
}

// Removed elements are remembered with their last data while the board is open
// (see shared/src/board-merge.js), up to this much. Past it the oldest keep only
// their stamp, which still stops older changes bringing them back.
const MAX_BURIED_BYTES = MAX_BOARD_BYTES;

// Tombstones are also saved with the board (their stamps, not their data), so
// a change made long ago, by someone who was offline while everyone else left,
// can't bring back what was removed since. Kept this long, and this many.
export const REMOVED_LIMITS = { ageMs: 30 * 24 * 3600 * 1000, count: 2000 };

const isStampNumber = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Saved tombstones (`removed` on a board) as a session keeps them, leaving out any for elements on the board. */
export function readRemoved(removed, elements) {
  const live = new Set(elements.map((element) => element.id));
  const cutoff = Date.now() - REMOVED_LIMITS.ageMs;
  const entries = (Array.isArray(removed) ? removed : [])
    .filter(
      (entry) =>
        typeof entry?.id === "string" &&
        !live.has(entry.id) &&
        isStampNumber(entry.version) &&
        isStampNumber(entry.versionNonce, 2 ** 31 - 1) &&
        Number.isFinite(entry.at) &&
        entry.at > cutoff,
    )
    .sort((a, b) => a.at - b.at)
    .slice(-REMOVED_LIMITS.count);
  return {
    tombstones: new Map(entries.map(({ id, version, versionNonce }) => [id, { version, versionNonce }])),
    removedAt: new Map(entries.map(({ id, at }) => [id, at])),
  };
}

// The session's tombstones as they're saved, oldest first. Ones past the limits are forgotten here too.
function removedList(session) {
  const cutoff = Date.now() - REMOVED_LIMITS.ageMs;
  const excess = session.removedAt.size - REMOVED_LIMITS.count;
  let position = 0;
  for (const [id, at] of session.removedAt) {
    if (position >= excess && at > cutoff) break;
    position += 1;
    forget(session, id);
  }
  return [...session.removedAt].map(([id, at]) => {
    const { version, versionNonce } = session.tombstones.get(id);
    return { id, version, versionNonce, at };
  });
}

function forget(session, id) {
  session.tombstones.delete(id);
  session.removedAt.delete(id);
  session.buriedBytes -= session.buried.get(id) ?? 0;
  session.buried.delete(id);
}

/** The open board `boardId`, opening it with `elements` and saved tombstones (`removed`) if it isn't open yet. */
export function openSession(boardId, elements, removed = []) {
  let session = sessions.get(boardId);
  if (!session) {
    // A board saved before elements had places in the stack gets them now, in the order it was saved.
    const ordered = inStackOrder(elements);
    session = {
      boardId,
      elements: ordered,
      ...readRemoved(removed, ordered), // tombstones (removed id -> { version, versionNonce, element }) and removedAt (id -> time)
      buried: new Map(), // removed id -> bytes of the data its tombstone keeps, oldest first
      buriedBytes: 0,
      dirty: false,
      timer: null,
      lastVersionAt: null,
    };
    measure(session);
    sessions.set(boardId, session);
    lastVersionTime(boardId)
      .then((time) => {
        session.lastVersionAt ??= time;
      })
      .catch(() => {});
  }
  return session;
}

function checkpoint(session) {
  // Unknown until the lookup in openSession finishes; skip rather than guess.
  if (session.lastVersionAt === null) return;
  if (Date.now() - session.lastVersionAt < CHECKPOINT_INTERVAL_MS) return;
  if (session.elements.length === 0) return;
  session.lastVersionAt = Date.now();
  recordVersion(session.boardId, session.elements).catch((error) =>
    console.error(`Could not save a version of board ${session.boardId}: ${error.message}`),
  );
}

/**
 * Carries out a plan (see planOperation) on an open board. Returns the ids of
 * new elements left out because the board has as many as it can hold.
 */
export function updateSession(session, plan) {
  const changes = plan.shown.size > 0 || plan.hidden.size > 0;
  if (changes) checkpoint(session);
  const { elements, dropped } = commitPlan(plan, session.tombstones, { limit: MAX_ELEMENTS_PER_BOARD });
  session.elements = elements;
  for (const id of dropped) {
    session.bytes -= session.sizes.get(id) ?? 0;
    session.sizes.delete(id);
  }
  bury(session, plan.graves);
  const now = Date.now();
  for (const [id, tombstone] of plan.graves) {
    if (!tombstone) session.removedAt.delete(id);
    else if (plan.hidden.has(id)) {
      session.removedAt.delete(id); // so the map stays oldest first
      session.removedAt.set(id, now);
    }
  }
  if (changes) markDirty(session);
  return dropped;
}

// Keeps count of the data tombstones hold, and lets the oldest go past MAX_BURIED_BYTES.
function bury(session, graves) {
  for (const [id, tombstone] of graves) {
    session.buriedBytes -= session.buried.get(id) ?? 0;
    session.buried.delete(id);
    if (tombstone?.element) {
      const bytes = elementBytes(tombstone.element);
      session.buried.set(id, bytes);
      session.buriedBytes += bytes;
    }
  }
  for (const [id, bytes] of session.buried) {
    if (session.buriedBytes <= MAX_BURIED_BYTES) break;
    const { element: _data, ...stamp } = session.tombstones.get(id);
    session.tombstones.set(id, stamp);
    session.buried.delete(id);
    session.buriedBytes -= bytes;
  }
}

/**
 * Puts `snapshot` (an earlier version) back on an open board, stamped as the
 * newest edit (see restoreOver). Returns the board's elements as restored.
 */
export function resetSession(session, snapshot) {
  const now = Date.now();
  const before = new Set(session.tombstones.keys());
  const { elements, tombstones } = restoreOver(session.elements, session.tombstones, snapshot);
  session.elements = elements;
  session.tombstones = tombstones;
  for (const id of session.removedAt.keys()) if (!tombstones.has(id)) session.removedAt.delete(id);
  for (const id of tombstones.keys()) if (!before.has(id)) session.removedAt.set(id, now);
  session.buried = new Map();
  session.buriedBytes = 0;
  bury(session, [...tombstones].filter(([id]) => !before.has(id)));
  measure(session);
  session.lastVersionAt = now;
  markDirty(session);
  return elements;
}

function markDirty(session) {
  session.dirty = true;
  session.timer ??= setTimeout(() => persist(session), persistDelay(session));
}

async function persist(session) {
  clearTimeout(session.timer);
  session.timer = null;
  if (!session.dirty) return;

  session.dirty = false;
  try {
    // The plain driver is two to three times faster than Mongoose for a big array of
    // elements, so it is used here; updatedAt is kept current by hand.
    await Board.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(session.boardId) },
      { $set: { elements: session.elements, removed: removedList(session), updatedAt: new Date() } },
    );
  } catch (error) {
    console.error(`Could not save board ${session.boardId}: ${error.message}`);
    session.dirty = true;
    session.timer ??= setTimeout(() => persist(session), MAX_PERSIST_DELAY_MS);
  }
}

export async function closeSession(boardId) {
  const session = sessions.get(boardId);
  if (!session) return;
  await persist(session);
  sessions.delete(boardId);
}

export function discardSession(boardId) {
  const session = sessions.get(boardId);
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(boardId);
}

export function flushAllSessions() {
  return Promise.all([...sessions.values()].map(persist));
}
