import { useSyncExternalStore } from "react";

// Every change to a board is an operation: { upsert: Element[], remove: Removal[] }.
// Upserts replace an element with the same id in place, or append it.
//
// Two people can change the same element at once, and their changes reach the
// server and each other in different orders. So every change is stamped: each
// upserted element carries its `version` (one more than the copy it was made
// from) and a random `versionNonce`, and so does each removal ({ id, version,
// versionNonce }). A change only takes effect over a state of the element it
// supersedes: the higher version wins, and for two changes made from the same
// copy, the lower nonce. Removed elements leave a tombstone (their removal's
// stamp), so an older edit arriving late can't bring them back, while a newer
// one (undo, say) can. Everyone, the server included, applies this same rule,
// so everyone ends up with the same board whatever order changes arrive in.
// Unstamped elements count as version 0, which is plain "last write wins".

const versionOf = (stamped) => (Number.isInteger(stamped?.version) ? stamped.version : 0);
const nonceOf = (stamped) => (Number.isInteger(stamped?.versionNonce) ? stamped.versionNonce : 0);

/** Whether the change `incoming` should win over `current`, an earlier state of the same element. */
export function supersedes(incoming, current) {
  const difference = versionOf(incoming) - versionOf(current);
  return difference !== 0 ? difference > 0 : nonceOf(incoming) <= nonceOf(current);
}

export const newVersionNonce = () => Math.floor(Math.random() * 2 ** 31);

// A removal from an older browser is just an id: it removes whatever is there.
const removalOf = (entry) => (typeof entry === "string" ? { id: entry } : entry);
const stampOf = (removal, current) =>
  Number.isInteger(removal.version)
    ? { version: removal.version, versionNonce: nonceOf(removal) }
    : { version: versionOf(current) + 1, versionNonce: 0 };

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
    const removal = removalOf(entry);
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
  for (const element of added.values()) next.push(element);
  return next;
}

/** Changes waiting to be sent (id -> element, or { removal }) as one operation. */
export function toOperation(pending) {
  const op = { upsert: [], remove: [] };
  for (const [, value] of pending) {
    if (value.removal) op.remove.push(value.removal);
    else op.upsert.push(value);
  }
  return op;
}

const MAX_HISTORY = 200;
const MERGE_WINDOW_MS = 1000;

// Holds a board's elements plus a local undo history. History entries store
// the inverse operation for just the elements a person changed, so undoing
// never wipes out what collaborators drew in the meantime.
export function createBoardStore() {
  let elements = [];
  let tombstones = new Map(); // removed element id -> stamp of its removal
  let undoStack = [];
  let redoStack = [];
  let snapshot = { elements, canUndo: false, canRedo: false };
  let broadcast = () => {};
  const listeners = new Set();

  function publish() {
    snapshot = { elements, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    for (const listener of listeners) listener();
  }

  // A change made here is a new edit of each element it touches: one version
  // past its current state (on screen, or its tombstone, or the copy an undo
  // brings back, whichever is newest), with a new nonce.
  function stamp(op) {
    const upsert = op.upsert ?? [];
    const remove = (op.remove ?? []).map(removalOf);
    if (upsert.length === 0 && remove.length === 0) return op;
    const ids = new Set([...upsert.map((element) => element.id), ...remove.map((removal) => removal.id)]);
    const current = new Map();
    for (const element of elements) if (ids.has(element.id)) current.set(element.id, element);
    const next = (id, ...also) =>
      Math.max(versionOf(current.get(id)), versionOf(tombstones.get(id)), ...also.map(versionOf)) + 1;
    return {
      upsert: upsert.map((element) => ({ ...element, version: next(element.id, element), versionNonce: newVersionNonce() })),
      remove: remove.map((removal) => ({ id: removal.id, version: next(removal.id), versionNonce: newVersionNonce() })),
    };
  }

  function apply(op) {
    const stamped = stamp(op);
    elements = applyOperation(elements, stamped, tombstones);
    publish();
    broadcast(stamped);
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
      tombstones = new Map();
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
      elements = applyOperation(elements, op, tombstones);
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

/** `pending` (id -> element, or { removal }) as operations of at most about `maxBytes` each. */
export function toOperations(pending, maxBytes = MAX_OPERATION_BYTES) {
  const operations = [];
  let op = { upsert: [], remove: [] };
  let bytes = 0;
  for (const [, value] of pending) {
    const size = JSON.stringify(value).length;
    if (bytes > 0 && bytes + size > maxBytes) {
      operations.push(op);
      op = { upsert: [], remove: [] };
      bytes = 0;
    }
    if (value.removal) op.remove.push(value.removal);
    else op.upsert.push(value);
    bytes += size;
  }
  if (bytes > 0) operations.push(op);
  return operations;
}
