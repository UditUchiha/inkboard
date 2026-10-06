import mongoose from "mongoose";
import { Board } from "../models/board.model.js";
import { lastVersionTime, recordVersion } from "../services/versions.js";
import { applyOperation, elementBytes, MAX_BOARD_BYTES, MAX_ELEMENT_BYTES } from "./operations.js";

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
  const removals = new Set(op.remove.filter((id) => !updates.has(id)));

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

export function openSession(boardId, elements) {
  let session = sessions.get(boardId);
  if (!session) {
    session = { boardId, elements, dirty: false, timer: null, lastVersionAt: null };
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

export function updateSession(session, op) {
  checkpoint(session);
  session.elements = applyOperation(session.elements, op);
  markDirty(session);
}

/** Replaces everything on an open board (restoring a version). */
export function resetSession(session, elements) {
  session.elements = elements;
  measure(session);
  session.lastVersionAt = Date.now();
  markDirty(session);
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
      { $set: { elements: session.elements, updatedAt: new Date() } },
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
