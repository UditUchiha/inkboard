import { useSyncExternalStore } from "react";
import {
  applyOperation,
  commitPlan,
  compareStamps,
  copyGroup,
  FIELD_GROUPS,
  groupsOf,
  groupStamps,
  isStamped,
  MAX_VERSION,
  planOperation,
  stampOf,
  withStamps,
} from "@inkboard/shared/board-merge";
import { inStackOrder, isOrderKey, keyAbove, topKey } from "@inkboard/shared/board-order";
import { withDefaults } from "@inkboard/shared/element-rules";
import { MAX_REMOVALS_REMEMBERED } from "@inkboard/shared/limits";

// Every change to a board is an operation: { upsert: Element[], remove: Removal[] }.
// The rules for taking one in, the same in the browser and on the server, are
// in shared/src/board-merge.ts: each group of an element's properties (its
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

/**
 * `element` (ours) with the server's copy of it (`theirs`, in a reply to a change) taken in group by
 * group: a group is replaced when ours still has the stamp it was sent with (`sent`, the newest stamp
 * of the change) or the stamp the server's copy has (the same change, which it only cleaned). A group
 * that someone else's change has replaced since has a newer stamp, and stays as it is.
 */
function mergeServerCopy(element, theirs, sent) {
  const mine = groupStamps(element);
  const server = groupStamps(theirs);
  const same = (a, b) => Boolean(a && b) && compareStamps(a, b) === 0;
  const fields = { id: element.id };
  const stamps = {};
  let taken = 0;
  let kept = 0;
  for (const group of new Set([...Object.keys(mine), ...Object.keys(server)])) {
    const take = server[group] && (!mine[group] || same(mine[group], server[group]) || same(mine[group], sent));
    copyGroup(fields, take ? theirs : element, group);
    stamps[group] = take ? server[group] : mine[group];
    if (take) taken += 1;
    else kept += 1;
  }
  if (taken === 0) return element;
  if (kept === 0) return theirs;
  return withStamps(fields, stamps);
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

// Removed elements' last data is kept (see board-merge.js), up to about this
// much of it as JSON. Past it the oldest keep only their stamp, as on the server.
const MAX_BURIED_CHARS = 4_000_000;

// Of the removals seen, the newest this many are remembered, as many as the server keeps
// for an open board; the oldest are forgotten, so a long session on a busy board doesn't
// keep growing. (Removals made here are also remembered apart: see `removedHere`.)
const MAX_TOMBSTONES = MAX_REMOVALS_REMEMBERED;

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
//
// `release(elements, ids)` says what else a change made here that removes
// `ids` must change: the editor passes connectors.js's releaseFrom, so
// connectors let go of shapes that go (see withReleases). It's handed in
// rather than imported so the store stays free of drawing code, and runs
// as it is in Node (the server's tests play it against the server's rules).
//
// `maxElements` is how many elements the board may hold: a change that would
// add more leaves the extra ones out, and `onFull(count)` says how many.
export function createBoardStore({ release = () => [], maxElements = Infinity, onFull = () => {} } = {}) {
  let elements = [];
  let index = null; // element id -> element, made when first asked for after `elements` changed
  let tombstones = new Map(); // removed element id -> { version, versionNonce, element }
  let buried = new Map(); // removed element id -> size of the data its tombstone keeps, oldest first
  let buriedChars = 0;
  // The version of each removal made here (id -> version, latest last). Bringing an element back
  // (an undo) is stamped past the removal it undoes from this, even once its tombstone is forgotten:
  // stamped no newer, it would lose to the removal on the server, while showing here.
  let removedHere = new Map();
  let undoStack = [];
  let redoStack = [];
  let snapshot = { elements, canUndo: false, canRedo: false };
  let broadcast = () => {};
  const listeners = new Set();

  const byId = () => (index ??= new Map(elements.map((element) => [element.id, element])));

  function setElements(next) {
    elements = next;
    index = null;
  }

  function publish() {
    snapshot = { elements, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    for (const listener of listeners) listener();
  }

  // Stamps a change made here, or returns null if it changes nothing. `base`
  // holds the elements the change was made from, where that isn't simply what's
  // on the board now (a step of a drag is made from the step before; an undo
  // from the state it undoes).
  //
  // A change that leaves out a field the element has takes it away, and a copy
  // without a field has no say in it when copies merge (see mergeElement). So
  // fields an element's kind always has are filled in first (see withDefaults):
  // undoing a label on an arrow that had none sends an empty one, not none.
  function stamp(op, base = []) {
    const upsert = (op.upsert ?? []).map(withDefaults);
    const remove = (op.remove ?? []).map(removalOf);
    const ids = new Set([...upsert.map((element) => element.id), ...remove.map((removal) => removal.id)]);
    const current = new Map();
    for (const id of ids) if (byId().has(id)) current.set(id, byId().get(id));
    const before = new Map(base.map((element) => [element.id, withDefaults(element)]));
    // One version past the newest this element has had here, with a new nonce.
    const next = (id, ...also) => ({
      // Never past MAX_VERSION: a version beyond it is refused by everyone else.
      version: Math.min(
        MAX_VERSION,
        Math.max(
          versionOf(current.get(id)),
          versionOf(tombstones.get(id)),
          removedHere.get(id) ?? 0,
          ...also.map(versionOf),
        ) + 1,
      ),
      versionNonce: newVersionNonce(),
    });
    let top = topKey(elements);

    const stamped = { upsert: [], remove: remove.map((removal) => ({ id: removal.id, ...next(removal.id) })) };
    for (const removal of stamped.remove) {
      removedHere.delete(removal.id);
      removedHere.set(removal.id, removal.version);
    }
    for (const id of removedHere.keys()) {
      if (removedHere.size <= MAX_TOMBSTONES) break;
      removedHere.delete(id);
    }
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
    // The plan works from the index (rather than building one) and commitPlan brings it up to date.
    const plan = planOperation(elements, op, tombstones, { index: byId() });
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
    for (const id of tombstones.keys()) {
      if (tombstones.size <= MAX_TOMBSTONES) break;
      tombstones.delete(id);
      buriedChars -= buried.get(id) ?? 0;
      buried.delete(id);
    }
  }

  // The server's copy is the reference: its tombstones (stamps) replace ours.
  function startRemoved(removed) {
    tombstones = tombstonesFrom(removed);
    buried = new Map();
    buriedChars = 0;
  }

  // A change made here that removes shapes also lets go of the connectors
  // attached to them, where they're drawn (see connectors.js), unless it
  // changes those connectors itself. Otherwise they'd jump back to where they
  // were first drawn. Returns `op` with them, and them: [{ before, after }].
  function withReleases(op) {
    const removing = new Set((op.remove ?? []).map((entry) => removalOf(entry).id));
    if (removing.size === 0) return { op, released: [] };
    const changing = new Set((op.upsert ?? []).map((element) => element.id));
    const released = release(elements, removing).filter(({ before }) => !changing.has(before.id));
    if (released.length === 0) return { op, released };
    return { op: { ...op, upsert: [...(op.upsert ?? []), ...released.map(({ after }) => after)] }, released };
  }

  // `op` without the new elements that don't fit on the board.
  function withinLimit(op) {
    const room = maxElements - elements.length;
    const added = (op.upsert ?? []).filter((element) => !byId().has(element.id));
    if (added.length <= room) return op;
    const refused = new Set(added.slice(Math.max(0, room)).map((element) => element.id));
    onFull(refused.size);
    return { ...op, upsert: op.upsert.filter((element) => !refused.has(element.id)) };
  }

  // Returns the connectors it let go of (see withReleases).
  function apply(op, { base } = {}) {
    const { op: full, released } = withReleases(withinLimit(op));
    const stamped = stamp(full, base);
    if (stamped) {
      take(stamped);
      publish();
      broadcast(stamped);
    }
    return released;
  }

  // `entry` with the connectors its `step` ("undo" or "redo") let go of put
  // back in the other step, so going back attaches them again. The step itself
  // works them out afresh each time, from where they're drawn then. They're
  // put back from the state they were let go into (`undoBase` / `redoBase`),
  // so going back changes only what letting go changed, not a label or color
  // someone gave them since.
  function attachingBack(entry, step, released) {
    if (released.length === 0) return entry;
    const other = step === "undo" ? "redo" : "undo";
    const ids = new Set(released.map(({ before }) => before.id));
    const kept = (entry[other]?.upsert ?? []).filter((element) => !ids.has(element.id)); // from a step before
    const upsert = [...kept, ...released.map(({ before }) => before)];
    const baseKey = `${other}Base`;
    const base = [
      ...(entry[baseKey] ?? []).filter((element) => !ids.has(element.id)),
      ...released.map(({ after }) => after),
    ];
    return { ...entry, [other]: { ...entry[other], upsert }, [baseKey]: base };
  }

  // `step` without what someone else has removed since: that isn't brought back
  // or removed again. An element a step puts back is the exception when the
  // step it reverses (or, for a new shape, the step itself) is what removed it:
  // those ids are `revived`.
  function stillApplies(step = {}, revived = []) {
    const live = byId();
    const back = new Set(revived.map((entry) => removalOf(entry).id));
    return {
      ...step,
      upsert: (step.upsert ?? []).filter((element) => live.has(element.id) || back.has(element.id)),
      remove: (step.remove ?? []).filter((entry) => live.has(removalOf(entry).id)),
    };
  }

  const hasChanges = (op = {}) => (op.upsert?.length ?? 0) + (op.remove?.length ?? 0) > 0;

  function record(entry, { mergeKey } = {}) {
    const last = undoStack.at(-1);
    const now = Date.now();
    if (mergeKey && last?.mergeKey === mergeKey && now - last.at < MERGE_WINDOW_MS) {
      last.redo = entry.redo;
      last.redoBase = entry.redoBase;
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
    /** Identifies the latest step in history, for telling whether anything has been done since. */
    historyMark: () => undoStack.at(-1),
    getElements: () => elements,
    getElement: (id) => byId().get(id),
    setBroadcaster(fn) {
      broadcast = fn;
    },

    /**
     * Replace everything and forget history (first load). `removed` are the
     * stamps of what was removed from the board lately, as the server sends them.
     */
    load(next, removed = []) {
      setElements(inStackOrder(next.map(withDefaults)));
      startRemoved(removed);
      removedHere = new Map();
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
      setElements(inStackOrder(next.map(withDefaults)));
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
     * What the server answered to a change sent from here: the elements as it
     * stored them where that differs from what was sent (`cleaned`; text cut to
     * its limit, say), and the ids of new ones it refused because the board is full
     * (`dropped`). Those are shown as the server has them, unless they've been changed since.
     * `sent` (id -> stamp) are the stamps they were sent with: a change the server refused to
     * an element it has comes back as its own, older copy, which replaces ours if ours is still
     * the one that was sent, or this screen would keep a change nobody else has. That's decided
     * group by group (see mergeServerCopy), so a change merged in from someone else since, to a
     * group that wasn't part of what was sent, isn't undone along with it.
     */
    reconcile({ cleaned = [], dropped = [], sent = new Map() }) {
      const refused = new Set(dropped);
      const stored = new Map(cleaned.map((element) => [element.id, element]));
      // (Sorted again: their copy may sit elsewhere in the stack.)
      setElements(
        inStackOrder(
          elements.flatMap((element) => {
            if (refused.has(element.id)) return [];
            const theirs = stored.get(element.id);
            return [theirs ? mergeServerCopy(element, theirs, sent.get(element.id)) : element];
          }),
        ),
      );
      publish();
    },
    /**
     * A live, in-progress change (e.g. mid-stroke): shared, but not in history.
     * Pass `{ base }` when the change wasn't made from the elements as they are
     * now (see stamp). Returns the connectors it let go of, as they were and
     * are now ([{ before, after }]), for the history entry that's recorded.
     */
    apply,
    /** Add a finished change to history (its redo state is already applied). */
    record,
    /**
     * Apply a change and add it to history in one step. An element someone
     * removed meanwhile isn't brought back by a change to it (unless the change
     * is the one making it: `undo` removes it), and if nothing is left of it, it's dropped.
     */
    commit(entry, options) {
      const redo = stillApplies(entry.redo, entry.undo?.remove);
      if (!hasChanges(redo) && hasChanges(entry.redo)) return;
      const released = apply(redo, { base: entry.undo?.upsert });
      record(attachingBack({ ...entry, redo }, "redo", released), options);
    },
    // Undo and redo only change what the step changed: undoing a move puts the
    // shape back, but keeps a color someone else picked since. Shapes someone
    // else has removed since stay removed.
    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push(entry);
      const base = [...(entry.undoBase ?? []), ...(entry.redo?.upsert ?? [])];
      const released = apply(stillApplies(entry.undo, entry.redo?.remove), { base });
      redoStack[redoStack.length - 1] = attachingBack(entry, "undo", released);
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      const again = { ...entry, mergeKey: undefined };
      undoStack.push(again);
      const base = [...(entry.redoBase ?? []), ...(entry.undo?.upsert ?? [])];
      const released = apply(stillApplies(entry.redo, entry.undo?.remove), { base });
      undoStack[undoStack.length - 1] = attachingBack(again, "redo", released);
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

// A safe over-estimate of an element's size as JSON: points and text are what make one big.
const roughSize = (value) =>
  1500 + (value.points?.length ?? 0) * 50 + ((value.text?.length ?? 0) + (value.name?.length ?? 0)) * 6;

/** `pending` (id -> element, or { removal }) as operations of at most about `maxBytes` each. */
export function toOperations(pending, maxBytes = MAX_OPERATION_BYTES) {
  // Measuring every change (this runs every 40 ms while someone draws) is only
  // needed when a rough estimate says they might not fit in one piece.
  let estimate = 0;
  for (const [, value] of pending) estimate += roughSize(value);
  const measure = estimate > maxBytes / 2;

  const operations = [];
  let op = { upsert: [], remove: [] };
  let bytes = 0;
  for (const [, value] of pending) {
    const size = measure ? JSON.stringify(value).length : roughSize(value);
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
