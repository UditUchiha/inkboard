import { commitPlan } from "@inkboard/shared/board-merge";
import { inStackOrder } from "@inkboard/shared/board-order";
import { withDefaults } from "@inkboard/shared/element-rules";
import { MAX_REMOVALS_REMEMBERED } from "@inkboard/shared/limits";
import mongoose from "mongoose";
import { Board } from "../models/board.model.ts";
import { lastVersionTime, recordVersion } from "../services/versions.ts";
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
const SKIP_WARNING_INTERVAL_MS = 60 * 60 * 1000;

const sessions = new Map();

export function getSession(boardId) {
  return sessions.get(boardId);
}

// Boards being opened right now, so people who open one together share a single read.
const opening = new Map();

/**
 * The open board `boardId`, opened from the database (with its saved tombstones)
 * if it isn't open yet. The saved board is read here, after any earlier session
 * for it has finished saving, so what comes back is never older than what people
 * last saw. Whoever calls this must join the board in the same turn they get the
 * session (see enterBoard in index.js), or it could be closed before they do.
 */
export function acquireSession(boardId) {
  const open = sessions.get(boardId);
  if (open) return Promise.resolve(open);
  let pending = opening.get(boardId);
  if (!pending) {
    pending = Board.findById(boardId)
      .select("elements removed owner")
      .lean()
      .then((saved) => openSession(boardId, saved?.elements ?? [], saved?.removed, saved?.owner))
      .finally(() => opening.delete(boardId));
    opening.set(boardId, pending);
  }
  return pending;
}

/**
 * Takes a session that's (still) open back from being closed. Call it right
 * after `acquireSession`, in the same turn, and acquire again when it says no:
 * the session was closed (and saved) in between.
 */
export function holdSession(session) {
  if (sessions.get(session.boardId) !== session) return false;
  session.closing = false;
  return true;
}

// How big each element is, and the total, so a board can't outgrow what the database can store.
// Also the elements by id, which updateSession keeps up to date.
function measure(session) {
  session.index = new Map(session.elements.map((element) => [element.id, element]));
  session.sizes = new Map(session.elements.map((element) => [element.id, elementBytes(element)]));
  session.bytes = [...session.sizes.values()].reduce((sum, size) => sum + size, 0);
}

/**
 * Decides whether a change can be accepted. Returns null when it fits, or why it
 * doesn't: "element" (one element is too big), "board" (the board would be too
 * big) or "owner" (it would grow the board by more than `room`, the bytes its
 * owner has left). Changes that don't make a board bigger are always accepted.
 * `buried` are changes to removed elements: they don't add to the board, but each
 * must fit as an element, since it's passed on and could come back. When it fits,
 * the board's size tracking is updated, so call updateSession with the same change next.
 */
export function admit(session, op, buried = [], room = Infinity) {
  if (buried.some((element) => elementBytes(element) > MAX_ELEMENT_BYTES)) return "element";
  const updates = new Map(op.upsert.map((element) => [element.id, elementBytes(element)]));
  const removals = new Set(op.remove.map((removal) => removal.id).filter((id) => !updates.has(id)));

  let bytes = session.bytes;
  for (const [id, size] of updates) {
    if (size > MAX_ELEMENT_BYTES) return "element";
    bytes += size - (session.sizes.get(id) ?? 0);
  }
  for (const id of removals) bytes -= session.sizes.get(id) ?? 0;
  if (bytes > MAX_BOARD_BYTES && bytes > session.bytes) return "board";
  if (bytes - session.bytes > Math.max(0, room)) return "owner";

  for (const [id, size] of updates) session.sizes.set(id, size);
  for (const id of removals) session.sizes.delete(id);
  session.bytes = bytes;
  return null;
}

// Removed elements are remembered with their last data while the board is open
// (see shared/src/board-merge.ts), up to this much. Past it the oldest keep only
// their stamp, which still stops older changes bringing them back.
const MAX_BURIED_BYTES = MAX_BOARD_BYTES;

// Tombstones are also saved with the board (their stamps, not their data), so
// a change made long ago, by someone who was offline while everyone else left,
// can't bring back what was removed since. Saved for this long, and this many
// (enough to clear a full board). A board that's open keeps more than it saves,
// up to MAX_REMOVED_IN_MEMORY (as many as browsers keep), so a long session doesn't lose any early.
export const REMOVED_LIMITS = { ageMs: 30 * 24 * 3600 * 1000, count: MAX_ELEMENTS_PER_BOARD };
const MAX_REMOVED_IN_MEMORY = MAX_REMOVALS_REMEMBERED;

const isStampNumber = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;

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

// The session's tombstones as they're saved, oldest first: the newest ones, within the age limit.
function removedList(session) {
  const cutoff = Date.now() - REMOVED_LIMITS.ageMs;
  const recent = [...session.removedAt].filter(([, at]) => at > cutoff).slice(-REMOVED_LIMITS.count);
  return recent.map(([id, at]) => {
    const { version, versionNonce } = session.tombstones.get(id);
    return { id, version, versionNonce, at };
  });
}

// Lets the oldest tombstones go when an open board has more than it should keep.
function trimRemoved(session) {
  let excess = session.removedAt.size - MAX_REMOVED_IN_MEMORY;
  for (const id of session.removedAt.keys()) {
    if (excess-- <= 0) break;
    forget(session, id);
  }
}

/** The stamps of a board's tombstones, for a browser opening it: [{ id, version, versionNonce }]. */
export function removedStamps(tombstones) {
  return [...tombstones].map(([id, { version, versionNonce }]) => ({ id, version, versionNonce }));
}

function forget(session, id) {
  session.tombstones.delete(id);
  session.removedAt.delete(id);
  session.buriedBytes -= session.buried.get(id) ?? 0;
  session.buried.delete(id);
}

// Opens the board `boardId` with `elements` and its saved tombstones (`removed`).
function openSession(boardId, elements, removed = [], owner = null) {
  // A board saved before elements had places in the stack gets them now, in the order it was saved,
  // and elements saved before they had every field their kind has now get those (see withDefaults).
  const ordered = inStackOrder(elements.map(withDefaults));
  const session = {
    boardId,
    owner: owner ? String(owner) : null, // whose space the board takes (see ownerRoom in index.js)
    elements: ordered,
    ...readRemoved(removed, ordered), // tombstones (removed id -> { version, versionNonce, element }) and removedAt (id -> time)
    buried: new Map(), // removed id -> bytes of the data its tombstone keeps, oldest first
    buriedBytes: 0,
    dirty: false, // changes not saved yet
    timer: null, // the save (or its retry) that's due
    saving: null, // the save in progress, a promise
    closing: false, // everyone has left: it goes once it's saved, unless someone opens it first
    discarded: false,
    lastVersionAt: null,
    skipWarnedAt: null, // when the log last said a checkpoint was skipped for want of room
  };
  measure(session);
  sessions.set(boardId, session);
  lastVersionTime(boardId)
    .then((time) => {
      session.lastVersionAt ??= time;
    })
    .catch(() => {});
  return session;
}

function checkpoint(session) {
  // Unknown until the lookup in openSession finishes; skip rather than guess.
  if (session.lastVersionAt === null) return;
  if (Date.now() - session.lastVersionAt < CHECKPOINT_INTERVAL_MS) return;
  if (session.elements.length === 0) return;
  session.lastVersionAt = Date.now();
  recordVersion(session.boardId, session.elements)
    .then((version) => version === null && warnCheckpointSkipped(session))
    .catch((error) => console.error(`Could not save a version of board ${session.boardId}: ${error.message}`));
}

// A skipped autosave means the board's saved versions leave no room for one (see recordVersion),
// so history quietly stops growing until someone deletes a saved version. Say so in the log, but
// no more than once an hour per board, not at every checkpoint.
function warnCheckpointSkipped(session) {
  const now = Date.now();
  if (now - (session.skipWarnedAt ?? 0) < SKIP_WARNING_INTERVAL_MS) return;
  session.skipWarnedAt = now;
  console.warn(
    `Skipped the automatic version of board ${session.boardId}: its saved versions leave no room in its history budget.`,
  );
}

/**
 * Carries out a plan (see planOperation) on an open board. Returns the ids of
 * new elements left out because the board has as many as it can hold.
 */
export function updateSession(session, plan) {
  const changes = plan.shown.size > 0 || plan.hidden.size > 0;
  if (changes) checkpoint(session);
  // (The plan was made with session.index, which this brings up to date.)
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
  trimRemoved(session);
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

// After a restore: tombstones the restore cleared are forgotten, and new ones dated now.
function dateRestored(removedAt, before, tombstones, now) {
  for (const id of removedAt.keys()) if (!tombstones.has(id)) removedAt.delete(id);
  for (const id of tombstones.keys()) if (!before.has(id)) removedAt.set(id, now);
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
  dateRestored(session.removedAt, before, tombstones, now);
  session.buried = new Map();
  session.buriedBytes = 0;
  bury(
    session,
    [...tombstones].filter(([id]) => !before.has(id)),
  );
  measure(session);
  session.lastVersionAt = now;
  markDirty(session);
  return elements;
}

function markDirty(session) {
  session.dirty = true;
  session.timer ??= setTimeout(() => persist(session), persistDelay(session));
}

/**
 * Saves the board, resolving once nothing is left unsaved (or a save failed,
 * which is tried again soon). Only one save runs at a time per board, so an
 * older copy can't land after a newer one: changes made during a save are
 * written by the next round of the same save, and callers share the one promise.
 */
function persist(session) {
  clearTimeout(session.timer);
  session.timer = null;
  session.saving ??= save(session).finally(() => {
    session.saving = null;
  });
  return session.saving;
}

async function save(session) {
  while (session.dirty && !session.discarded) {
    session.dirty = false;
    try {
      // The plain driver is two to three times faster than Mongoose for a big array of
      // elements, so it is used here; updatedAt is kept current by hand.
      await Board.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(session.boardId) },
        {
          $set: {
            elements: session.elements,
            removed: removedList(session),
            // What the board takes of its owner's space, measured as boards are (drawingBytes in
            // services/boards.ts), which adds up a little differently from session.bytes.
            bytes: mongoose.mongo.BSON.calculateObjectSize({ elements: session.elements }),
            updatedAt: new Date(),
          },
        },
      );
    } catch (error) {
      console.error(`Could not save board ${session.boardId}: ${error.message}`);
      session.dirty = true;
      if (!session.discarded) session.timer ??= setTimeout(() => persist(session), MAX_PERSIST_DELAY_MS);
      return;
    }
  }
  // Saved, and nobody came back to it meanwhile: it can go.
  if (session.closing && !session.dirty && sessions.get(session.boardId) === session) sessions.delete(session.boardId);
}

/** Saves the board and lets it go from memory, unless someone opens it again first (see holdSession). */
export async function closeSession(boardId) {
  const session = sessions.get(boardId);
  if (!session) return;
  session.closing = true;
  await persist(session);
}

/** Forgets the board without saving what's left, for a board that's gone. */
export function discardSession(boardId) {
  const session = sessions.get(boardId);
  if (!session) return;
  session.discarded = true;
  clearTimeout(session.timer);
  session.timer = null;
  sessions.delete(boardId);
}

/** Saves every open board, waiting for saves already under way. */
export function flushAllSessions() {
  return Promise.all([...sessions.values()].map(persist));
}
