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
import type { RemovedStamp } from "@inkboard/shared/socket";
import { mergeText, spliceOf, TEXT_FIELDS, withoutBase } from "@inkboard/shared/text-merge";
import type {
  Element as BoardElement,
  Effect,
  Fields,
  FieldGroup,
  GroupStamps,
  MaybeStamped,
  Operation,
  Removal,
  Stamp,
  TextBases,
  TextField,
  Tombstones,
} from "@inkboard/shared/types";
import type { ConnectorChange } from "../elements/connectors";

// Changes merge per property group by stamp (shared/src/board-merge.ts), so every client converges.
// A change stamps only the groups it changed against its `base`: a move doesn't carry a stale color.

export { applyOperation };

export type PendingChange = (BoardElement & { removal?: undefined }) | { removal: Effect["remove"][number] };

export type HistoryEntry = {
  undo?: Operation;
  redo?: Operation;
  // The elements the undo/redo step was made from, where that isn't the board as it is (see stamp).
  undoBase?: readonly BoardElement[];
  redoBase?: readonly BoardElement[];
};

export type HistoryStep = HistoryEntry & { mergeKey?: string | undefined; at: number };

export type RecordOptions = { mergeKey?: string | undefined };

export type BoardSnapshot = { elements: BoardElement[]; canUndo: boolean; canRedo: boolean };

export type Broadcaster = (op: Effect) => void;

export type Reconciliation = {
  cleaned?: readonly BoardElement[];
  dropped?: readonly string[];
  restored?: readonly BoardElement[];
  sent?: ReadonlyMap<string, Stamp>;
  typed?: Typing;
  typing?: Typing;
};

export type Typing = ReadonlyMap<string, ReadonlySet<FieldGroup>>;

export type BoardStoreOptions = {
  release?: (elements: BoardElement[], ids: Set<string>) => ConnectorChange[];
  maxElements?: number;
  onFull?: (count: number) => void;
};

export type BoardStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardSnapshot;
  historyMark(): HistoryStep | undefined;
  getElements(): BoardElement[];
  getElement(id: string): BoardElement | undefined;
  removedStamps(): RemovedStamp[];
  setBroadcaster(fn: Broadcaster): void;
  load(next: BoardElement[], removed?: unknown): void;
  rejoin(next: BoardElement[], unsent?: Operation, removed?: unknown): void;
  applyRemote(op: Operation, typing?: Typing): void;
  reconcile(reply: Reconciliation): void;
  forgetHistory(): void;
  apply(op: Operation, options?: { base?: readonly BoardElement[] }): ConnectorChange[];
  record(entry: HistoryEntry, options?: RecordOptions): void;
  commit(entry: HistoryEntry, options?: RecordOptions): void;
  undo(): void;
  redo(): void;
};

export const newVersionNonce = (): number => Math.floor(Math.random() * 2 ** 31);

const versionOf = (stamped?: MaybeStamped | null): number => stampOf(stamped).version;
const removalOf = (entry: Removal | string): Removal => (typeof entry === "string" ? { id: entry } : entry);

const differs = (a: Fields, b: Fields, group: FieldGroup): boolean =>
  FIELD_GROUPS[group].some((field) => field in a !== field in b || a[field] !== b[field]);

// Takes the server's copy group by group, only where ours still carries the stamp that was sent (or the same
// change, cleaned). Text the change typed always takes the server's merged copy; text typed since stays.
function mergeServerCopy(
  element: BoardElement,
  theirs: BoardElement,
  sent: Stamp | undefined,
  typed: ReadonlySet<FieldGroup> | undefined,
  typing: ReadonlySet<FieldGroup> | undefined,
): BoardElement {
  const mine = groupStamps(element);
  const server = groupStamps(theirs);
  const same = (a: Stamp | undefined, b: Stamp | undefined) => Boolean(a && b) && compareStamps(a!, b!) === 0;
  const fields: Fields = { id: element.id };
  const stamps: GroupStamps = {};
  let taken = 0;
  let kept = 0;
  for (const group of new Set([...Object.keys(mine), ...Object.keys(server)] as FieldGroup[])) {
    const take =
      server[group] &&
      !typing?.has(group) &&
      (!mine[group] || typed?.has(group) || same(mine[group], server[group]) || same(mine[group], sent));
    copyGroup(fields, take ? theirs : element, group);
    stamps[group] = take ? server[group] : mine[group];
    if (take) taken += 1;
    else kept += 1;
  }
  if (taken === 0) return element;
  if (kept === 0) return theirs;
  return withStamps(fields, stamps);
}

// Merges the text a change typed with typing that reached this screen after its `from`, as the server would.
function typedOnto(fields: Fields, from: Fields, live: Fields, changed: FieldGroup[]): TextBases | undefined {
  let bases: TextBases | undefined;
  for (const [field, { group, max }] of Object.entries(TEXT_FIELDS) as [
    TextField,
    { group: FieldGroup; max: number },
  ][]) {
    const typed = fields[field];
    const now = live[field];
    if (!changed.includes(group) || typeof typed !== "string" || typeof now !== "string") continue;
    const before = from[field];
    const text = typeof before === "string" && before !== now ? (mergeText(before, now, typed, max) ?? typed) : typed;
    fields[field] = text;
    (bases ??= {})[field] = spliceOf(now, text);
  }
  return bases;
}

function keepTyping(
  element: BoardElement,
  before: BoardElement | undefined,
  groups: ReadonlySet<FieldGroup> | undefined,
): BoardElement {
  if (!before || before === element || !groups) return element;
  const now = groupStamps(element);
  const was = groupStamps(before);
  const fields: Fields = { ...element };
  let kept = false;
  for (const group of groups) {
    if (!was[group] || (now[group] && compareStamps(now[group], was[group]) === 0)) continue;
    copyGroup(fields, before, group);
    now[group] = was[group];
    kept = true;
  }
  return kept ? withStamps(fields, now) : element;
}

// Taken as is, not merged: merging typing a second time would type it twice.
function asItIs(op: Operation): Operation {
  if (!op.upsert?.some((element) => element.base)) return op;
  return { ...op, upsert: op.upsert.map((element) => (element.base ? withoutBase(element) : element)) };
}

export function toOperation(pending: ReadonlyMap<string, PendingChange>): Effect {
  const op: Effect = { upsert: [], remove: [] };
  for (const [, value] of pending) {
    if (value.removal) op.remove.push(value.removal);
    else op.upsert.push(value);
  }
  return op;
}

const MAX_HISTORY = 200;
const MERGE_WINDOW_MS = 1000;

// Cap on the JSON size of tombstone data kept (board-merge.ts); older ones keep only their stamp, as on the server.
const MAX_BURIED_CHARS = 4_000_000;

// As many removals as the server remembers for an open board, so a long session doesn't grow forever.
const MAX_TOMBSTONES = MAX_REMOVALS_REMEMBERED;

function tombstonesFrom(removed: unknown): Tombstones {
  const tombstones: Tombstones = new Map();
  for (const entry of (Array.isArray(removed) ? removed : []) as (MaybeStamped & { id?: unknown })[]) {
    if (typeof entry?.id === "string" && isStamped(entry)) tombstones.set(entry.id, stampOf(entry));
  }
  return tombstones;
}

// History entries hold the inverse for just what a person changed, so undo never wipes collaborators' work.
// `release` is injected (not imported) so the store stays free of drawing code and runs in Node tests.
export function createBoardStore({
  release = () => [],
  maxElements = Infinity,
  onFull = () => {},
}: BoardStoreOptions = {}): BoardStore {
  let elements: BoardElement[] = [];
  let index: Map<string, BoardElement> | null = null; // element id -> element, made when first asked for after `elements` changed
  let tombstones: Tombstones = new Map(); // removed element id -> { version, versionNonce, element }
  let buried = new Map<string, number>(); // removed element id -> size of the data its tombstone keeps, oldest first
  let buriedChars = 0;
  // Stamped past this so an undo that revives an element wins over its removal on the server, even after the tombstone
  // is forgotten.
  let removedHere = new Map<string, number>();
  let undoStack: HistoryStep[] = [];
  let redoStack: HistoryStep[] = [];
  let snapshot: BoardSnapshot = { elements, canUndo: false, canRedo: false };
  let broadcast: Broadcaster = () => {};
  const listeners = new Set<() => void>();

  const byId = () => (index ??= new Map(elements.map((element) => [element.id, element])));

  function setElements(next: BoardElement[]) {
    elements = next;
    index = null;
  }

  function publish() {
    snapshot = { elements, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
    for (const listener of listeners) listener();
  }

  // A change that omits a field takes it away and has no say when copies merge, so kind defaults are filled in first
  // (withDefaults).
  // `base` is what the change was made from where that isn't the board now (a drag step, an undo).
  function stamp(op: Operation, base: readonly BoardElement[] = []): Effect | null {
    const upsert = (op.upsert ?? []).map(withDefaults);
    const remove = (op.remove ?? []).map(removalOf);
    const ids = new Set([...upsert.map((element) => element.id), ...remove.map((removal) => removal.id)]);
    const current = new Map<string, BoardElement>();
    for (const id of ids) if (byId().has(id)) current.set(id, byId().get(id)!);
    const before = new Map(base.map((element) => [element.id, withDefaults(element)]));
    const next = (id: string, ...also: MaybeStamped[]): Stamp => ({
      // Never past MAX_VERSION: everyone else refuses a higher one.
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

    const stamped: Effect = { upsert: [], remove: remove.map((removal) => ({ id: removal.id, ...next(removal.id) })) };
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
      const base = typedOnto(fields, from, live, changed);
      stamped.upsert.push(base ? { ...withStamps(fields, stamps), base } : withStamps(fields, stamps));
    }
    return stamped.upsert.length > 0 || stamped.remove.length > 0 ? stamped : null;
  }

  function take(op: Operation) {
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
      const { element: _data, ...stamp } = tombstones.get(id)!;
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

  function startRemoved(removed: unknown) {
    tombstones = tombstonesFrom(removed);
    buried = new Map();
    buriedChars = 0;
  }

  // Connectors on removed shapes are released too, or they would jump back to their drawn position.
  function withReleases(op: Operation): { op: Operation; released: ConnectorChange[] } {
    const removing = new Set((op.remove ?? []).map((entry) => removalOf(entry).id));
    if (removing.size === 0) return { op, released: [] };
    const changing = new Set((op.upsert ?? []).map((element) => element.id));
    const released = release(elements, removing).filter(({ before }) => !changing.has(before.id));
    if (released.length === 0) return { op, released };
    return { op: { ...op, upsert: [...(op.upsert ?? []), ...released.map(({ after }) => after)] }, released };
  }

  function withinLimit(op: Operation): Operation {
    const room = maxElements - elements.length;
    const added = (op.upsert ?? []).filter((element) => !byId().has(element.id));
    if (added.length <= room) return op;
    const refused = new Set(added.slice(Math.max(0, room)).map((element) => element.id));
    onFull(refused.size);
    return { ...op, upsert: op.upsert!.filter((element) => !refused.has(element.id)) };
  }

  function apply(op: Operation, { base }: { base?: readonly BoardElement[] } = {}): ConnectorChange[] {
    const { op: full, released } = withReleases(withinLimit(op));
    const stamped = stamp(full, base);
    if (stamped) {
      take(stamped);
      publish();
      broadcast(stamped);
    }
    return released;
  }

  // Re-attaches released connectors when going back, from the state they were released into, so labels and colors set
  // since stay.
  function attachingBack<Entry extends HistoryEntry>(
    entry: Entry,
    step: "undo" | "redo",
    released: ConnectorChange[],
  ): Entry {
    if (released.length === 0) return entry;
    const other = step === "undo" ? "redo" : "undo";
    const ids = new Set(released.map(({ before }) => before.id));
    const kept = (entry[other]?.upsert ?? []).filter((element) => !ids.has(element.id)); // from a step before
    const upsert = [...kept, ...released.map(({ before }) => before)];
    const baseKey = `${other}Base` as const;
    const base = [
      ...(entry[baseKey] ?? []).filter((element) => !ids.has(element.id)),
      ...released.map(({ after }) => after),
    ];
    return { ...entry, [other]: { ...entry[other], upsert }, [baseKey]: base };
  }

  // Skips what someone else removed since, unless this step's reverse removed it (`revived`).
  function stillApplies(step: Operation = {}, revived: readonly (Removal | string)[] = []): Operation {
    const live = byId();
    const back = new Set(revived.map((entry) => removalOf(entry).id));
    return {
      ...step,
      upsert: (step.upsert ?? []).filter((element) => live.has(element.id) || back.has(element.id)),
      remove: (step.remove ?? []).filter((entry) => live.has(removalOf(entry).id)),
    };
  }

  const hasChanges = (op: Operation = {}) => (op.upsert?.length ?? 0) + (op.remove?.length ?? 0) > 0;

  function record(entry: HistoryEntry, { mergeKey }: RecordOptions = {}) {
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
    historyMark: () => undoStack.at(-1),
    getElements: () => elements,
    getElement: (id) => byId().get(id),
    removedStamps: () => [...tombstones].map(([id, { version, versionNonce }]) => ({ id, version, versionNonce })),
    setBroadcaster(fn) {
      broadcast = fn;
    },

    load(next, removed = []) {
      setElements(inStackOrder(next.map(withDefaults)));
      startRemoved(removed);
      removedHere = new Map();
      undoStack = [];
      redoStack = [];
      publish();
    },
    rejoin(next, unsent = { upsert: [], remove: [] }, removed = []) {
      setElements(inStackOrder(next.map(withDefaults)));
      startRemoved(removed);
      take(asItIs(unsent));
      publish();
    },
    applyRemote(op, typing = new Map()) {
      const before = new Map<string, BoardElement>();
      for (const id of typing.keys()) {
        const element = byId().get(id);
        if (element) before.set(id, element);
      }
      take(asItIs(op));
      // Typed-here text the server hasn't answered yet stays; its answer merges the two.
      if (before.size > 0) {
        setElements(elements.map((element) => keepTyping(element, before.get(element.id), typing.get(element.id)!)));
      }
      publish();
    },
    forgetHistory() {
      undoStack = [];
      redoStack = [];
      publish();
    },
    reconcile({ cleaned = [], dropped = [], restored = [], sent = new Map(), typed = new Map(), typing = new Map() }) {
      const refused = new Set(dropped);
      const stored = new Map(cleaned.map((element) => [element.id, element]));
      const back = restored.filter((element) => !byId().has(element.id));
      for (const element of back) {
        tombstones.delete(element.id);
        removedHere.delete(element.id);
      }
      setElements(
        inStackOrder([
          ...elements.flatMap((element) => {
            if (refused.has(element.id)) return [];
            const theirs = stored.get(element.id);
            if (!theirs) return [element];
            const { id } = element;
            return [mergeServerCopy(element, theirs, sent.get(id), typed.get(id), typing.get(id))];
          }),
          ...back.map(withDefaults),
        ]),
      );
      publish();
    },
    apply,
    record,
    commit(entry, options) {
      const redo = stillApplies(entry.redo, entry.undo?.remove);
      if (!hasChanges(redo) && hasChanges(entry.redo)) return;
      const released = apply(redo, { base: entry.undo?.upsert });
      record(attachingBack({ ...entry, redo }, "redo", released), options);
    },
    // Only what the step changed is undone; a color set by someone else since stays.
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

export function useBoardSnapshot(store: BoardStore): BoardSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

// The server drops connections on messages over 3 MB and a dropped change is resent, so big ones are sent in pieces.
export const MAX_OPERATION_BYTES = 1_000_000;

// A safe over-estimate of an element's JSON size: points and text make one big.
const roughSize = (value: {
  id?: string;
  removal?: unknown;
  points?: readonly unknown[];
  text?: string;
  name?: string;
}) => 1500 + (value.points?.length ?? 0) * 50 + ((value.text?.length ?? 0) + (value.name?.length ?? 0)) * 6;

/** `pending` (id -> element, or { removal }) as operations of at most about `maxBytes` each. */
export function toOperations(pending: ReadonlyMap<string, PendingChange>, maxBytes = MAX_OPERATION_BYTES): Effect[] {
  // Measuring every change (every 40 ms while drawing) is only needed once the rough estimate nears the limit.
  let estimate = 0;
  for (const [, value] of pending) estimate += roughSize(value);
  const measure = estimate > maxBytes / 2;

  const operations: Effect[] = [];
  let op: Effect = { upsert: [], remove: [] };
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
