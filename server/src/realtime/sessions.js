import { Board } from "../models/board.model.js";
import { lastVersionTime, recordVersion } from "../services/versions.js";
import { applyOperation } from "./operations.js";

// Boards that are open in at least one browser live in memory, so every
// stroke can be broadcast immediately. Changes are written to MongoDB at most
// once per PERSIST_DELAY_MS, and flushed when the last person leaves.
const PERSIST_DELAY_MS = 1000;

// Before the first change after a quiet spell of this long, the board is saved
// as a version, so version history has a checkpoint from before each burst of work.
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

const sessions = new Map();

export function getSession(boardId) {
  return sessions.get(boardId);
}

export function openSession(boardId, elements) {
  let session = sessions.get(boardId);
  if (!session) {
    session = { boardId, elements, dirty: false, timer: null, lastVersionAt: null };
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
  session.lastVersionAt = Date.now();
  markDirty(session);
}

function markDirty(session) {
  session.dirty = true;
  session.timer ??= setTimeout(() => persist(session), PERSIST_DELAY_MS);
}

async function persist(session) {
  clearTimeout(session.timer);
  session.timer = null;
  if (!session.dirty) return;

  session.dirty = false;
  try {
    await Board.updateOne({ _id: session.boardId }, { $set: { elements: session.elements } });
  } catch (error) {
    console.error(`Could not save board ${session.boardId}: ${error.message}`);
    session.dirty = true;
    session.timer ??= setTimeout(() => persist(session), PERSIST_DELAY_MS * 5);
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
