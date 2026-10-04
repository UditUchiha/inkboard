import { Board } from "../models/board.model.js";
import { applyOperation } from "./operations.js";

// Boards that are open in at least one browser live in memory, so every
// stroke can be broadcast immediately. Changes are written to MongoDB at most
// once per PERSIST_DELAY_MS, and flushed when the last person leaves.
const PERSIST_DELAY_MS = 1000;

const sessions = new Map();

export function getSession(boardId) {
  return sessions.get(boardId);
}

export function openSession(boardId, elements) {
  let session = sessions.get(boardId);
  if (!session) {
    session = { boardId, elements, dirty: false, timer: null };
    sessions.set(boardId, session);
  }
  return session;
}

export function updateSession(session, op) {
  session.elements = applyOperation(session.elements, op);
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
