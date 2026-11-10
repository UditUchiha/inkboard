import { compareOrder } from "./board-order.ts";
import { mergeText, TEXT_FIELDS, textBefore, withoutBase } from "./text-merge.ts";
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
  Splice,
  Stamp,
  TextField,
  Tombstone,
  Tombstones,
} from "./types.ts";

// The merge rules, applied by the browser and the server alike so everyone who has seen the same changes has the same
// board in any order (a state-based CRDT: last-writer-wins registers per property group, plus tombstones). Stamps,
// property groups, removals and typing merges are explained in docs/realtime-sync.md. Typing is the one rule that
// depends on
// arrival order, so the server's order counts: it sends the merged text to everyone, the sender included.

export const FIELD_GROUPS: Record<FieldGroup, readonly string[]> = {
  shape: [
    "type",
    "seed",
    "imageId",
    "crop",
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
  text: ["text", "alt"],
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
// a field not listed here doesn't survive a merge

const ALWAYS: readonly FieldGroup[] = ["shape", "index"];
// Object.keys says only "strings"; these are the keys of FIELD_GROUPS
const OPTIONAL = (Object.keys(FIELD_GROUPS) as FieldGroup[]).filter((group) => !ALWAYS.includes(group));
const META = new Set(["id", "version", "versionNonce", "stamps"]);

// far beyond any real board and far below where numbers stop being exact; a version past it is refused, or one change
// could put an element where no later version can follow
export const MAX_VERSION = 2 ** 48;

// far more edits than anyone makes offline, but too few for a forged version to leave an element out of reach (see the
// server's prepareOperation)
export const MAX_VERSION_JUMP = 1_000_000;

// the casts: Number.isSafeInteger and Number.isInteger return a boolean, so TypeScript doesn't narrow `value`
export const isVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VERSION;
export const isNonce = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < 2 ** 31;

export const stampOf = (stamped?: MaybeStamped | null): Stamp => ({
  version: isVersion(stamped?.version) ? stamped.version : 0,
  versionNonce: isNonce(stamped?.versionNonce) ? stamped.versionNonce : 0,
});

export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.version !== b.version) return a.version - b.version;
  return b.versionNonce - a.versionNonce;
}

export const supersedes = (incoming: MaybeStamped, current: MaybeStamped): boolean =>
  compareStamps(stampOf(incoming), stampOf(current)) >= 0;

export const isStamped = (change?: MaybeStamped | null): boolean => isVersion(change?.version);

export function groupsOf(element: Element): FieldGroup[] {
  const groups = [...ALWAYS];
  for (const group of OPTIONAL) {
    if (FIELD_GROUPS[group].some((field) => field in element)) groups.push(group);
  }
  return groups;
}

export function cleanStamps(stamps: unknown): ElementStamps | undefined {
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) return undefined;
  const clean: ElementStamps = {};
  // Object.keys says only "strings"; these are the keys of FIELD_GROUPS
  for (const group of Object.keys(FIELD_GROUPS) as FieldGroup[]) {
    const pair = (stamps as Record<string, unknown>)[group];
    if (Array.isArray(pair) && pair.length === 2 && isVersion(pair[0]) && isNonce(pair[1]))
      clean[group] = [pair[0], pair[1]];
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

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
  // `newest!` is safe: `stamps` always has the "shape" group (see groupsOf), so the loop above set it
  for (const [group, stamp] of Object.entries(stamps) as [FieldGroup, Stamp][]) {
    if (compareStamps(stamp, newest!) !== 0) older[group] = [stamp.version, stamp.versionNonce];
  }
  return {
    id: fields.id,
    ...element,
    version: newest!.version,
    versionNonce: newest!.versionNonce,
    ...(Object.keys(older).length > 0 ? { stamps: older } : {}),
  } as Element;
}

export function copyGroup(target: Fields, source: Fields, group: FieldGroup): void {
  for (const field of FIELD_GROUPS[group]) {
    if (field in source) target[field] = source[field];
    else delete target[field];
  }
}

// Each group comes from whichever copy has it newer. Returns `current` when `incoming` adds nothing, and `incoming`
// when it's
// newer throughout. A copy without a group at all (a connector made without a label, say) has no say in it, so a change
// to
// something else never takes the group away; to clear a field, set it to an empty value ("", null). Text typed against
// an
// older text (its `base`) is merged with what's there (see mergeTyping). The result never has a base.
export function mergeElement(current: Element, incoming: Element): Element {
  const mine = groupStamps(current);
  const theirs = groupStamps(incoming);
  // Object.keys says only "strings"; these are the keys of group stamps
  const groups = new Set([...(Object.keys(mine) as FieldGroup[]), ...(Object.keys(theirs) as FieldGroup[])]);
  const won = new Set<FieldGroup>();
  for (const group of groups) {
    if (theirs[group] && (!mine[group] || compareStamps(theirs[group], mine[group]) > 0)) won.add(group);
  }
  const typed = incoming.base ? mergeTyping(current, incoming, mine, theirs, won) : null;
  const change = incoming.base ? withoutBase(incoming) : incoming;
  if (!typed?.size) {
    if (won.size === 0) return current;
    if (won.size === groups.size) return change;
  }

  const fields: Fields = { id: current.id };
  const stamps: GroupStamps = {};
  for (const group of groups) {
    const fromIncoming = won.has(group);
    copyGroup(fields, fromIncoming ? change : current, group);
    stamps[group] = fromIncoming ? theirs[group] : mine[group];
  }
  for (const [field, { text, stamp }] of typed ?? []) {
    fields[field] = text;
    stamps[TEXT_FIELDS[field].group] = stamp;
  }
  return withStamps(fields, stamps);
}

// The text fields `incoming` typed into where `current` changed since its base, merged (see mergeText) and stamped one
// version past the newer of the two with `incoming`'s nonce, so the same two changes merge to the same element
// anywhere.
// A merge that comes to the newer side's text just keeps that side. Where no merge can be made, the newer change wins.
function mergeTyping(
  current: Element,
  incoming: Element,
  mine: GroupStamps,
  theirs: GroupStamps,
  won: Set<FieldGroup>,
): Map<TextField, { text: string; stamp: Stamp }> {
  const typed = new Map<TextField, { text: string; stamp: Stamp }>();
  // Object.entries says only "strings"; these are the keys of a change's bases
  for (const [field, splice] of Object.entries(incoming.base ?? {}) as [TextField, Splice][]) {
    const { group, max } = TEXT_FIELDS[field];
    const now = (current as Fields)[field];
    const sent = (incoming as Fields)[field];
    const ours = mine[group];
    const others = theirs[group];
    if (typeof now !== "string" || typeof sent !== "string" || !ours || !others) continue;
    const merged = mergeText(textBefore(sent, splice), now, sent, max);
    if (merged === null || (merged === sent && won.has(group)) || (merged === now && !won.has(group))) continue;
    // stamped past both: a copy of either sent again can't replace it
    won.delete(group);
    const newer = compareStamps(ours, others) > 0 ? ours : others;
    typed.set(field, {
      text: merged,
      stamp: { version: Math.min(MAX_VERSION, newer.version + 1), versionNonce: others.versionNonce },
    });
  }
  return typed;
}

const removalOf = (entry: Removal | string): Removal => (typeof entry === "string" ? { id: entry } : entry);

// the board's index with the plan's changes laid over it, which `settle` writes into `index`, so a board that keeps an
// index never builds one per operation
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

// Works out what `op` does to `elements` without changing anything. `live`: every element visible afterwards; `shown`:
// added or changed; `buried`: removed elements whose remembered data changed; `hidden`: removals that took effect;
// `graves`: tombstones to set (null clears); `added`: ids new to the board. `index` is a Map of `elements` the caller
// keeps
// current, which saves building one. `remember` (default true) keeps a removal of an element nobody has seen, so it
// stays
// gone if it turns up late; the server turns it off, or anyone could fill its memory with removals of made-up ids.
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

  for (const change of upsert) {
    const element = change.base ? withoutBase(change) : change;
    const current = live.get(element.id);
    if (current) {
      const merged = mergeElement(current, change);
      if (merged === current) continue;
      live.set(element.id, merged);
      shown.set(element.id, merged);
      continue;
    }
    const tombstone = grave(element.id);
    const data = tombstone?.element ? mergeElement(tombstone.element, change) : element;
    if (!tombstone || compareStamps(stampOf(data), tombstone) >= 0) {
      live.set(element.id, data);
      shown.set(element.id, data);
      buried.delete(element.id);
      added.add(element.id);
      if (tombstone) graves.set(element.id, null);
    } else if (data !== tombstone.element) {
      graves.set(element.id, { ...tombstone, element: data });
      buried.set(element.id, data);
    }
  }

  return { elements, live, shown, buried, hidden, graves, added };
}

// Includes changes to removed elements, so whoever brings one back brings back the same thing everywhere. Each goes
// with its
// removal, so a screen that opened the board since keeps it hidden too.
export function effectOf(plan: Plan): Effect {
  const remove = new Map<string, Stamp>(plan.hidden);
  for (const id of plan.buried.keys()) {
    if (remove.has(id)) continue;
    const { version, versionNonce } = plan.graves.get(id)!;
    remove.set(id, { version, versionNonce });
  }
  return {
    upsert: [...plan.shown.values(), ...plan.buried.values()],
    remove: [...remove].map(([id, stamp]) => ({ id, ...stamp })),
  };
}

// Returns the new sorted elements. At most `limit` are kept: new ones past it are dropped (listed in `dropped`); one
// dropped on its way back from removal stays removed, tombstone and all.
export function commitPlan(plan: Plan, tombstones: Tombstones, { limit = Infinity }: CommitOptions = {}): CommitResult {
  if (plan.shown.size === 0 && plan.hidden.size === 0) {
    setGraves(plan.graves, tombstones);
    plan.live.settle?.();
    return { elements: plan.elements, dropped: [] };
  }
  // what a plan changes is in `shown` and `hidden`, usually small, so the board is gone through once, looking only in
  // those
  const next: Element[] = [];
  let reorder = false;
  for (const element of plan.elements) {
    if (plan.hidden.has(element.id)) continue;
    const now = plan.shown.get(element.id) ?? element;
    if (now.index !== element.index) reorder = true;
    next.push(now);
  }
  // new elements usually go on top, in order, so they're appended rather than the whole board sorted again
  const dropped: string[] = [];
  for (const id of plan.added) {
    if (next.length >= limit) {
      dropped.push(id);
      continue;
    }
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

export function applyOperation(
  elements: Element[],
  op: Operation,
  tombstones: Tombstones = new Map(),
  options: CommitOptions | undefined = undefined,
): Element[] {
  if ((op.upsert?.length ?? 0) === 0 && (op.remove?.length ?? 0) === 0) return elements;
  return commitPlan(planOperation(elements, op, tombstones), tombstones, options).elements;
}
