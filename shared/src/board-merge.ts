import { compareOrder } from "./board-order.ts";
import type {
  CommitOptions,
  CommitResult,
  Effect,
  Element,
  ElementStamps,
  Fields,
  FieldGroup,
  GroupStamps,
  LiveElements,
  MaybeStamped,
  Operation,
  Plan,
  PlanOptions,
  Removal,
  Stamp,
  Tombstone,
  Tombstones,
} from "./types.ts";

// How a board takes in changes. The browser and the server both apply these
// rules, so everyone who has seen the same changes has the same board, whatever
// order the changes arrived in. (In the literature this is a state-based CRDT:
// a map of last-writer-wins registers, with tombstones for removed entries.)
//
// Every change is an operation: { upsert: Element[], remove: Removal[] }.
//
// Stamps. Each change is stamped with a `version` (one past the newest the
// person making it had seen) and a random `versionNonce`. Of two stamps, the
// higher version is newer, and for the same version the lower nonce.
//
// Property groups. An element's properties are split into groups that change
// independently: where it is and how big (its shape), its text, its stroke
// color, its fill, and so on. Each group carries its own stamp, so when one
// person moves a shape while another recolors it, both changes are kept. The
// fields of a group always change together: a move never mixes one person's
// corners with another's.
//
// An element stores its newest stamp as `version` / `versionNonce`, and lists
// in `stamps` ({ group: [version, nonce] }) only the groups whose stamp is older.
//
// Removals. A removal ({ id, version, versionNonce }) hides an element if it's
// newer than everything in the element. The element is then kept as a
// tombstone, with the removal's stamp and its last data, so that a change
// made before the removal and arriving after it can't bring it back, while a
// newer change (an undo, say) can, and merges with what was there.

export const FIELD_GROUPS: Record<FieldGroup, readonly string[]> = {
  // A connector's ends and the shapes (and sides) they're attached to change together.
  shape: [
    "type",
    "seed",
    "imageId",
    "x1",
    "y1",
    "x2",
    "y2",
    "startId",
    "endId",
    "startAnchor",
    "endAnchor",
    "points",
    "pressure",
    "angle",
    "fontSize",
  ],
  text: ["text"],
  stroke: ["stroke"],
  fill: ["fill"],
  strokeWidth: ["strokeWidth"],
  penSize: ["penSize"],
  sketchy: ["sketchy"],
  font: ["font"],
  name: ["name"],
  route: ["route"],
  startHead: ["startHead"],
  index: ["index"],
};
// Every field an element can have belongs to exactly one group. A field that
// isn't listed here doesn't survive a merge.

const ALWAYS: readonly FieldGroup[] = ["shape", "index"];
// Object.keys can only say "strings"; these are the keys of FIELD_GROUPS, so they are field groups.
const OPTIONAL = (Object.keys(FIELD_GROUPS) as FieldGroup[]).filter((group) => !ALWAYS.includes(group));
const META = new Set(["id", "version", "versionNonce", "stamps"]);

// Far beyond any real board (each edit adds one), and far below where numbers
// stop being exact. A version past it is refused, or one change could put an
// element where no later version can follow it.
export const MAX_VERSION = 2 ** 48;

// How far ahead of what a board knows of an element a change to it may be stamped
// (see the server's prepareOperation): far more edits than anyone makes while
// offline, but too few for a forged version to leave an element out of reach.
export const MAX_VERSION_JUMP = 1_000_000;

// Number.isSafeInteger and Number.isInteger only return a boolean, so TypeScript doesn't learn from them that
// `value` is a number; the casts say what the first check has already settled.
export const isVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VERSION;
export const isNonce = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < 2 ** 31;

/** The stamp of an element (its newest), or of a removal. Missing parts count as 0. */
export const stampOf = (stamped?: MaybeStamped | null): Stamp => ({
  version: isVersion(stamped?.version) ? stamped.version : 0,
  versionNonce: isNonce(stamped?.versionNonce) ? stamped.versionNonce : 0,
});

/** Positive when stamp `a` is newer than `b`, negative when older, 0 when they're the same stamp. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.version !== b.version) return a.version - b.version;
  return b.versionNonce - a.versionNonce;
}

/** Whether the change `incoming` wins over `current`, by their newest stamps. */
export const supersedes = (incoming: MaybeStamped, current: MaybeStamped): boolean =>
  compareStamps(stampOf(incoming), stampOf(current)) >= 0;

/** Whether a removal or element carries a stamp (changes from older browsers don't). */
export const isStamped = (change?: MaybeStamped | null): boolean => isVersion(change?.version);

/** The groups an element has: its shape, its place in the stack, and whichever others it uses. */
export function groupsOf(element: Element): FieldGroup[] {
  const groups = [...ALWAYS];
  for (const group of OPTIONAL) {
    if (FIELD_GROUPS[group].some((field) => field in element)) groups.push(group);
  }
  return groups;
}

/** `stamps` as an element may list them, or undefined if there's nothing valid. */
export function cleanStamps(stamps: unknown): ElementStamps | undefined {
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) return undefined;
  const clean: ElementStamps = {};
  // Object.keys can only say "strings"; these are the keys of FIELD_GROUPS, so they are field groups.
  for (const group of Object.keys(FIELD_GROUPS) as FieldGroup[]) {
    // Only an object that isn't an array got this far, and each entry is checked below before it's used.
    const pair = (stamps as Record<string, unknown>)[group];
    if (Array.isArray(pair) && pair.length === 2 && isVersion(pair[0]) && isNonce(pair[1]))
      clean[group] = [pair[0], pair[1]];
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** The stamp of each of an element's groups: { group: { version, versionNonce } }. */
export function groupStamps(element: Element): GroupStamps {
  const newest = stampOf(element);
  const listed = element.stamps;
  const stamps: GroupStamps = {};
  for (const group of groupsOf(element)) {
    const pair = listed?.[group];
    stamps[group] =
      Array.isArray(pair) && isVersion(pair[0]) && isNonce(pair[1])
        ? { version: pair[0], versionNonce: pair[1] }
        : newest;
  }
  return stamps;
}

/** The element made of `fields` with each group stamped as in `stamps`. */
export function withStamps(fields: Fields, stamps: GroupStamps): Element {
  let newest: Stamp | null = null;
  for (const stamp of Object.values(stamps)) {
    if (!newest || compareStamps(stamp, newest) > 0) newest = stamp;
  }
  const element: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!META.has(key)) element[key] = value;
  }
  const older: ElementStamps = {};
  // Each `newest!` below is safe because `stamps` always has the "shape" group (see groupsOf), so the loop
  // above set `newest`.
  // Object.entries can only say "strings"; these are the keys of `stamps`, so they are field groups.
  for (const [group, stamp] of Object.entries(stamps) as [FieldGroup, Stamp][]) {
    if (compareStamps(stamp, newest!) !== 0) older[group] = [stamp.version, stamp.versionNonce];
  }
  // Built up field by field from `fields`, which is how any element is kept, so it can't be shown to be one.
  return {
    id: fields.id,
    ...element,
    version: newest!.version,
    versionNonce: newest!.versionNonce,
    ...(Object.keys(older).length > 0 ? { stamps: older } : {}),
  } as Element;
}

/** Copies the fields of `group` from `source` onto `target` (removing those `source` doesn't have). */
export function copyGroup(target: Fields, source: Fields, group: FieldGroup): void {
  for (const field of FIELD_GROUPS[group]) {
    if (field in source) target[field] = source[field];
    else delete target[field];
  }
}

/**
 * Two copies of the same element merged: each group from whichever copy has
 * it newer. Returns `current` when `incoming` adds nothing, and `incoming`
 * when it's newer throughout. A copy that doesn't have a group at all (a
 * connector made without a label, say) has no say in it, so a change to
 * something else never takes the group away; to clear a field, set it to an
 * empty value ("", null) rather than leaving it out.
 */
export function mergeElement(current: Element, incoming: Element): Element {
  const mine = groupStamps(current);
  const theirs = groupStamps(incoming);
  // Object.keys can only say "strings"; these are the keys of group stamps, so they are field groups.
  const groups = new Set([...(Object.keys(mine) as FieldGroup[]), ...(Object.keys(theirs) as FieldGroup[])]);
  const won = new Set();
  for (const group of groups) {
    if (theirs[group] && (!mine[group] || compareStamps(theirs[group], mine[group]) > 0)) won.add(group);
  }
  if (won.size === 0) return current;
  if (won.size === groups.size) return incoming;

  const fields: Fields = { id: current.id };
  const stamps: GroupStamps = {};
  for (const group of groups) {
    const fromIncoming = won.has(group);
    copyGroup(fields, fromIncoming ? incoming : current, group);
    stamps[group] = fromIncoming ? theirs[group] : mine[group];
  }
  return withStamps(fields, stamps);
}

const removalOf = (entry: Removal | string): Removal => (typeof entry === "string" ? { id: entry } : entry);

// The elements by id as a plan sees them: `index` (the board as it was) with the
// plan's changes laid over it, which `settle` then writes into `index`, so a
// board that keeps an index never has to build one per operation.
class Overlay implements LiveElements {
  declare index: Map<string, Element>;
  declare changes: Map<string, Element | null>;

  constructor(index: Map<string, Element>) {
    this.index = index;
    this.changes = new Map();
  }

  get(id: string): Element | undefined {
    return this.changes.has(id) ? (this.changes.get(id) ?? undefined) : this.index.get(id);
  }

  set(id: string, element: Element): void {
    this.changes.set(id, element);
  }

  delete(id: string): void {
    this.changes.set(id, null);
  }

  settle(): void {
    for (const [id, element] of this.changes) {
      if (element) this.index.set(id, element);
      else this.index.delete(id);
    }
  }
}

/**
 * Works out what `op` does to `elements`, without changing anything:
 *
 * - `live`: every element visible afterwards, by id
 * - `shown`: elements added or changed (as they now are)
 * - `buried`: removed elements whose remembered data changed (as it now is)
 * - `hidden`: removals that took effect, by id (their stamps)
 * - `graves`: tombstones to set (or null to clear) in `tombstones`
 * - `added`: ids of elements that weren't on the board before
 *
 * `tombstones` maps a removed element's id to { version, versionNonce, element? }.
 *
 * Options: `index`, a Map of `elements` by id that the caller keeps up to date,
 * which saves building one (commitPlan brings it up to date); and `remember`,
 * which says whether a removal of an element nobody has seen is remembered
 * (it is by default, so the element stays gone if it turns up late; the server,
 * which sees every element before anyone can remove it, turns this off, or
 * anyone could fill its memory with removals of made-up ids).
 */
export function planOperation(
  elements: Element[],
  { upsert = [], remove = [] }: Operation,
  tombstones: Tombstones = new Map(),
  { index = null, remember = true }: PlanOptions = {},
): Plan {
  const live: LiveElements = index
    ? new Overlay(index)
    : new Map<string, Element>(elements.map((element) => [element.id, element]));
  const graves = new Map<string, Tombstone | null>();
  const grave = (id: string) => (graves.has(id) ? graves.get(id) : tombstones.get(id));
  const shown = new Map<string, Element>();
  const buried = new Map<string, Element>();
  const hidden = new Map<string, Stamp>();
  const added = new Set<string>();

  for (const entry of remove) {
    const removal = removalOf(entry);
    const current = live.get(removal.id);
    if (current) {
      // A removal from an older browser has no stamp: it removes whatever is there.
      const stamp = isStamped(removal) ? stampOf(removal) : { version: stampOf(current).version + 1, versionNonce: 0 };
      if (compareStamps(stamp, stampOf(current)) < 0) continue;
      live.delete(removal.id);
      shown.delete(removal.id);
      added.delete(removal.id);
      hidden.set(removal.id, stamp);
      graves.set(removal.id, { ...stamp, element: current });
    } else if (isStamped(removal) && (remember || grave(removal.id))) {
      const tombstone = grave(removal.id);
      const stamp = stampOf(removal);
      if (tombstone && compareStamps(stamp, tombstone) <= 0) continue;
      hidden.set(removal.id, stamp);
      graves.set(removal.id, { ...stamp, element: tombstone?.element });
    }
  }

  for (const element of upsert) {
    const current = live.get(element.id);
    if (current) {
      const merged = mergeElement(current, element);
      if (merged === current) continue;
      live.set(element.id, merged);
      shown.set(element.id, merged);
      continue;
    }
    const tombstone = grave(element.id);
    const data = tombstone?.element ? mergeElement(tombstone.element, element) : element;
    if (!tombstone || compareStamps(stampOf(data), tombstone) >= 0) {
      live.set(element.id, data);
      shown.set(element.id, data);
      buried.delete(element.id);
      added.add(element.id);
      if (tombstone) graves.set(element.id, null);
    } else if (data !== tombstone.element) {
      // Still removed, but remembered, in case a newer change brings it back.
      graves.set(element.id, { ...tombstone, element: data });
      buried.set(element.id, data);
    }
  }

  return { elements, live, shown, buried, hidden, graves, added };
}

/**
 * What a plan changed, as an operation to pass on to everyone else. That
 * includes changes to removed elements: if one comes back later, everyone must
 * bring back the same thing. Each goes with its removal, so a screen that
 * doesn't know about the removal (it opened the board since) keeps it hidden too.
 */
export function effectOf(plan: Plan): Effect {
  const remove = new Map<string, Stamp>(plan.hidden);
  for (const id of plan.buried.keys()) {
    if (remove.has(id)) continue;
    // Every buried element had its tombstone set in the same plan (see planOperation), so there is one.
    const { version, versionNonce } = plan.graves.get(id)!;
    remove.set(id, { version, versionNonce });
  }
  return {
    upsert: [...plan.shown.values(), ...plan.buried.values()],
    remove: [...remove].map(([id, stamp]) => ({ id, ...stamp })),
  };
}

/**
 * Carries out a plan: updates `tombstones` and returns the board's new
 * elements, sorted. At most `limit` elements are kept: new ones past it are
 * dropped (and listed in `dropped`). One dropped on its way back from being
 * removed stays removed, tombstone and all, and its entry leaves `plan.graves`.
 */
export function commitPlan(plan: Plan, tombstones: Tombstones, { limit = Infinity }: CommitOptions = {}): CommitResult {
  if (plan.shown.size === 0 && plan.hidden.size === 0) {
    setGraves(plan.graves, tombstones);
    plan.live.settle?.();
    return { elements: plan.elements, dropped: [] };
  }
  // What a plan changes is in `shown` and `hidden`, which are usually small, so the board is gone
  // through once looking only in those. (An element removed and brought back by the same change is
  // in `hidden` and in `added`, and goes with the new ones.)
  const next: Element[] = [];
  let reorder = false;
  for (const element of plan.elements) {
    if (plan.hidden.has(element.id)) continue;
    const now = plan.shown.get(element.id) ?? element;
    if (now.index !== element.index) reorder = true;
    next.push(now);
  }
  // New elements usually go on top, above everything, in order: then they're added at the end
  // rather than the whole board sorted again.
  const dropped: string[] = [];
  for (const id of plan.added) {
    if (next.length >= limit) {
      dropped.push(id);
      continue;
    }
    // An added element is live, and `.at(-1)` finds the last one because `next` isn't empty (checked first).
    const element = plan.live.get(id)!;
    if (next.length > 0 && compareOrder(next.at(-1)!, element) > 0) reorder = true;
    next.push(element);
  }
  for (const id of dropped) {
    plan.graves.delete(id);
    plan.live.delete(id);
  }
  setGraves(plan.graves, tombstones);
  plan.live.settle?.();
  if (reorder) next.sort(compareOrder);
  return { elements: next, dropped };
}

function setGraves(graves: Map<string, Tombstone | null>, tombstones: Tombstones): void {
  for (const [id, tombstone] of graves) {
    if (tombstone) tombstones.set(id, tombstone);
    else tombstones.delete(id);
  }
}

/**
 * Applies `op` to `elements` and returns the new list (the old one isn't
 * changed). `tombstones` is read and updated.
 */
export function applyOperation(
  elements: Element[],
  op: Operation,
  tombstones: Tombstones = new Map(),
  options: CommitOptions | undefined = undefined,
): Element[] {
  if ((op.upsert?.length ?? 0) === 0 && (op.remove?.length ?? 0) === 0) return elements;
  return commitPlan(planOperation(elements, op, tombstones), tombstones, options).elements;
}
