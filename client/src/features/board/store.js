import { useSyncExternalStore } from "react";

// Every change to a board is an operation: { upsert: Element[], remove: id[] }.
// Upserts replace an element with the same id in place, or append it.
export function applyOperation(elements, { upsert = [], remove = [] }) {
  if (upsert.length === 0 && remove.length === 0) return elements;
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
  for (const element of updates.values()) next.push(element);
  return next;
}

const MAX_HISTORY = 200;
const MERGE_WINDOW_MS = 1000;

// Holds a board's elements plus a local undo history. History entries store
// the inverse operation for just the elements a person changed, so undoing
// never wipes out what collaborators drew in the meantime.
export function createBoardStore() {
  let elements = [];
  let undoStack = [];
  let redoStack = [];
  let snapshot = { elements, canUndo: false, canRedo: false };
  let broadcast = () => {};
  const listeners = new Set();

  function publish() {
    snapshot = { elements, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    for (const listener of listeners) listener();
  }

  function apply(op) {
    elements = applyOperation(elements, op);
    publish();
    broadcast(op);
  }

  function record(entry, { mergeKey } = {}) {
    const last = undoStack.at(-1);
    const now = Date.now();
    if (mergeKey && last?.mergeKey === mergeKey && now - last.at < MERGE_WINDOW_MS) {
      last.redo = entry.redo;
      last.at = now;
    } else {
      undoStack.push({ ...entry, mergeKey, at: now });
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
    }
    redoStack = [];
    publish();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getElements: () => elements,
    getElement: (id) => elements.find((element) => element.id === id),
    setBroadcaster(fn) {
      broadcast = fn;
    },

    /** Replace everything and forget history (first load). */
    load(next) {
      elements = next;
      undoStack = [];
      redoStack = [];
      publish();
    },
    /** Replace elements but keep history (reconnects). */
    replace(next) {
      elements = next;
      publish();
    },
    /** Apply a collaborator's change. */
    applyRemote(op) {
      elements = applyOperation(elements, op);
      publish();
    },
    /** A live, in-progress change (e.g. mid-stroke): shared, but not in history. */
    apply,
    /** Add a finished change to history (its redo state is already applied). */
    record,
    /** Apply a change and add it to history in one step. */
    commit(entry, options) {
      apply(entry.redo);
      record(entry, options);
    },
    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push(entry);
      apply(entry.undo);
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push({ ...entry, mergeKey: undefined });
      apply(entry.redo);
    },
  };
}

export function useBoardSnapshot(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

// The server drops the connection on any message over 3 MB, and a dropped
// change is sent again on reconnect, so a big one (undoing "clear board",
// importing a file) would never get through. Changes are sent in pieces of
// about this size instead, in order.
export const MAX_OPERATION_BYTES = 1_000_000;

/** `pending` (id -> element, or null for removed) as operations of at most about `maxBytes` each. */
export function toOperations(pending, maxBytes = MAX_OPERATION_BYTES) {
  const operations = [];
  let op = { upsert: [], remove: [] };
  let bytes = 0;
  for (const [id, element] of pending) {
    const size = element ? JSON.stringify(element).length : id.length + 3;
    if (bytes > 0 && bytes + size > maxBytes) {
      operations.push(op);
      op = { upsert: [], remove: [] };
      bytes = 0;
    }
    if (element) op.upsert.push(element);
    else op.remove.push(id);
    bytes += size;
  }
  if (bytes > 0) operations.push(op);
  return operations;
}
