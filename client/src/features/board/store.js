import { useSyncExternalStore } from "react";
import {
  applyOperation,
  commitPlan,
  copyGroup,
  FIELD_GROUPS,
  groupsOf,
  groupStamps,
  isStamped,
  planOperation,
  stampOf,
  withStamps,
} from "@inkboard/shared/board-merge";
import { inStackOrder, isOrderKey, keyAbove, topKey } from "@inkboard/shared/board-order";

// Every change to a board is an operation: { upsert: Element[], remove: Removal[] }.
// The rules for taking one in, the same in the browser and on the server, are
// in shared/src/board-merge.js: each group of an element's properties (its
// shape, its color, its text, …) carries the stamp of its latest change, the
// newest stamp wins group by group, and removed elements leave a tombstone.
// So everyone ends up with the same board whatever order changes arrive in.
//
// This store stamps the changes made here. A change only stamps the groups it
// actually changed, compared with the element it was made from (its `base`),
// and takes everything else from the element as it is now. So moving a shape
// while someone else recolors it keeps both: the move doesn't carry the old
// color along.

export { applyOperation };

export const newVersionNonce = () => Math.floor(Math.random() * 2 ** 31);

const versionOf = (stamped) => stampOf(stamped).version;
const removalOf = (entry) => (typeof entry === "string" ? { id: entry } : entry);

// Whether `a` and `b` differ in any field of `group`.
const differs = (a, b, group) =>
  FIELD_GROUPS[group].some((field) => field in a !== field in b || a[field] !== b[field]);

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

// Removed elements' last data is kept (see board-merge.js), up to about this
// much of it as JSON. Past it the oldest keep only their stamp, as on the server.
const MAX_BURIED_CHARS = 4_000_000;

/** Tombstones from the stamps the server sends with a board: [{ id, version, versionNonce }]. */
function tombstonesFrom(removed) {
  const tombstones = new Map();
  for (const entry of Array.isArray(removed) ? removed : []) {
    if (typeof entry?.id === "string" && isStamped(entry)) tombstones.set(entry.id, stampOf(entry));
  }
  return tombstones;
}

// Holds a board's elements plus a local undo history. History entries store
// the inverse operation for just the elements a person changed, so undoing
// never wipes out what collaborators drew in the meantime.
export function createBoardStore() {
  let elements = [];
  let tombstones = new Map(); // removed element id -> { version, versionNonce, element }
  let buried = new Map(); // removed element id -> size of the data its tombstone keeps, oldest first
  let buriedChars = 0;
  let undoStack = [];
  let redoStack = [];
  let snapshot = { elements, canUndo: false, canRedo: false };
  let broadcast = () => {};
  const listeners = new Set();

  function publish() {
    snapshot = { elements, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    for (const listener of listeners) listener();
  }

  // Stamps a change made here, or returns null if it changes nothing. `base`
  // holds the elements the change was made from, where that isn't simply what's
  // on the board now (a step of a drag is made from the step before; an undo
  // from the state it undoes).
  function stamp(op, base = []) {
    const upsert = op.upsert ?? [];
    const remove = (op.remove ?? []).map(removalOf);
    const ids = new Set([...upsert.map((element) => element.id), ...remove.map((removal) => removal.id)]);
    const current = new Map();
    for (const element of elements) if (ids.has(element.id)) current.set(element.id, element);
    const before = new Map(base.map((element) => [element.id, element]));
    // One version past the newest this element has had here, with a new nonce.
    const next = (id, ...also) => ({
      version: Math.max(versionOf(current.get(id)), versionOf(tombstones.get(id)), ...also.map(versionOf)) + 1,
      versionNonce: newVersionNonce(),
    });
    let top = topKey(elements);

    const stamped = { upsert: [], remove: remove.map((removal) => ({ id: removal.id, ...next(removal.id) })) };
    for (const element of upsert) {
      const live = current.get(element.id);
      if (!live) {
        // New elements go on top; one coming back (an undo) returns to its place.
        const tombstone = tombstones.get(element.id);
        let index = tombstone ? (element.index ?? tombstone.element?.index) : undefined;
        if (!isOrderKey(index)) index = keyAbove(top);
        if (top === null || index > top) top = index;
        const fields = { ...element, index };
        const stampNow = next(element.id, element);
        stamped.upsert.push(withStamps(fields, Object.fromEntries(groupsOf(fields).map((group) => [group, stampNow]))));
        continue;
      }
      const from = before.get(element.id) ?? live;
      const groups = new Set([...groupsOf(element), ...groupsOf(from)]);
      // The store keeps the stack order; a change that leaves `index` out isn't moving the element in it.
      if (!("index" in element)) groups.delete("index");
      const changed = [...groups].filter((group) => differs(element, from, group));
      if (changed.length === 0) continue;
      const stampNow = next(element.id);
      const stamps = groupStamps(live);
      const fields = { ...live };
      for (const group of changed) {
        copyGroup(fields, element, group);
        stamps[group] = stampNow;
      }
      stamped.upsert.push(withStamps(fields, stamps));
    }
    return stamped.upsert.length > 0 || stamped.remove.length > 0 ? stamped : null;
  }

  // Takes in an operation (see board-merge.js), keeping the data tombstones hold within MAX_BURIED_CHARS.
  function take(op) {
    const plan = planOperation(elements, op, tombstones);
    elements = commitPlan(plan, tombstones).elements;
    for (const [id, tombstone] of plan.graves) {
      buriedChars -= buried.get(id) ?? 0;
      buried.delete(id);
      if (tombstone?.element) {
        const size = JSON.stringify(tombstone.element).length;
        buried.set(id, size);
        buriedChars += size;
      }
    }
    for (const [id, size] of buried) {
      if (buriedChars <= MAX_BURIED_CHARS) break;
      const { element: _data, ...stamp } = tombstones.get(id);
      tombstones.set(id, stamp);
      buried.delete(id);
      buriedChars -= size;
    }
  }

  // The server's copy is the reference: its tombstones (stamps) replace ours.
  function startRemoved(removed) {
    tombstones = tombstonesFrom(removed);
    buried = new Map();
    buriedChars = 0;
  }

  function apply(op, { base } = {}) {
    const stamped = stamp(op, base);
    if (!stamped) return;
    take(stamped);
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

    /**
     * Replace everything and forget history (first load). `removed` are the
     * stamps of what was removed from the board lately, as the server sends them.
     */
    load(next, removed = []) {
      elements = inStackOrder(next);
      startRemoved(removed);
      undoStack = [];
      redoStack = [];
      publish();
    },
    /**
     * Reconnected: the board as the server has it (with `removed`, as for
     * load), with `unsent` (changes made here that it hasn't confirmed) on top.
     * History is kept.
     */
    rejoin(next, unsent = { upsert: [], remove: [] }, removed = []) {
      elements = inStackOrder(next);
      startRemoved(removed);
      take(unsent);
      publish();
    },
    /** Apply a collaborator's change. */
    applyRemote(op) {
      take(op);
      publish();
    },
    /**
     * A live, in-progress change (e.g. mid-stroke): shared, but not in history.
     * Pass `{ base }` when the change wasn't made from the elements as they are
     * now (see stamp).
     */
    apply,
    /** Add a finished change to history (its redo state is already applied). */
    record,
    /** Apply a change and add it to history in one step. */
    commit(entry, options) {
      apply(entry.redo, { base: entry.undo?.upsert });
      record(entry, options);
    },
    // Undo and redo only change what the step changed: undoing a move puts the
    // shape back, but keeps a color someone else picked since.
    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push(entry);
      apply(entry.undo, { base: entry.redo?.upsert });
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push({ ...entry, mergeKey: undefined });
      apply(entry.redo, { base: entry.undo?.upsert });
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
