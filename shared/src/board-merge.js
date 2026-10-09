import { compareOrder } from "./board-order.js";

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

export const FIELD_GROUPS = {
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

const ALWAYS = ["shape", "index"];
const OPTIONAL = Object.keys(FIELD_GROUPS).filter((group) => !ALWAYS.includes(group));
const META = new Set(["id", "version", "versionNonce", "stamps"]);

// Far beyond any real board (each edit adds one), and far below where numbers
// stop being exact. A version past it is refused, or one change could put an
// element where no later version can follow it.
export const MAX_VERSION = 2 ** 48;

export const isVersion = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_VERSION;
export const isNonce = (value) => Number.isInteger(value) && value >= 0 && value < 2 ** 31;

/** The stamp of an element (its newest), or of a removal. Missing parts count as 0. */
export const stampOf = (stamped) => ({
  version: isVersion(stamped?.version) ? stamped.version : 0,
  versionNonce: isNonce(stamped?.versionNonce) ? stamped.versionNonce : 0,
});

/** Positive when stamp `a` is newer than `b`, negative when older, 0 when they're the same stamp. */
export function compareStamps(a, b) {
  if (a.version !== b.version) return a.version - b.version;
  return b.versionNonce - a.versionNonce;
}

/** Whether the change `incoming` wins over `current`, by their newest stamps. */
export const supersedes = (incoming, current) => compareStamps(stampOf(incoming), stampOf(current)) >= 0;

/** Whether a removal or element carries a stamp (changes from older browsers don't). */
export const isStamped = (change) => isVersion(change?.version);

/** The groups an element has: its shape, its place in the stack, and whichever others it uses. */
export function groupsOf(element) {
  const groups = [...ALWAYS];
  for (const group of OPTIONAL) {
    if (FIELD_GROUPS[group].some((field) => field in element)) groups.push(group);
  }
  return groups;
}

/** `stamps` as an element may list them, or undefined if there's nothing valid. */
export function cleanStamps(stamps) {
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) return undefined;
  const clean = {};
  for (const group of Object.keys(FIELD_GROUPS)) {
    const pair = stamps[group];
    if (Array.isArray(pair) && pair.length === 2 && isVersion(pair[0]) && isNonce(pair[1]))
      clean[group] = [pair[0], pair[1]];
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** The stamp of each of an element's groups: { group: { version, versionNonce } }. */
export function groupStamps(element) {
  const newest = stampOf(element);
  const listed = element.stamps;
  const stamps = {};
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
export function withStamps(fields, stamps) {
  let newest = null;
  for (const stamp of Object.values(stamps)) {
    if (!newest || compareStamps(stamp, newest) > 0) newest = stamp;
  }
  const element = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!META.has(key)) element[key] = value;
  }
  const older = {};
  for (const [group, stamp] of Object.entries(stamps)) {
    if (compareStamps(stamp, newest) !== 0) older[group] = [stamp.version, stamp.versionNonce];
  }
  return {
    id: fields.id,
    ...element,
    version: newest.version,
    versionNonce: newest.versionNonce,
    ...(Object.keys(older).length > 0 ? { stamps: older } : {}),
  };
}

/** Copies the fields of `group` from `source` onto `target` (removing those `source` doesn't have). */
export function copyGroup(target, source, group) {
  for (const field of FIELD_GROUPS[group]) {
    if (field in source) target[field] = source[field];
    else delete target[field];
  }
}

/**
 * Two copies of the same element merged: each group from whichever copy has
 * it newer. Returns `current` when `incoming` adds nothing, and `incoming`
 * when it's newer throughout.
 */
export function mergeElement(current, incoming) {
  const mine = groupStamps(current);
  const theirs = groupStamps(incoming);
  const groups = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  const won = new Set();
  for (const group of groups) {
    const a = theirs[group] ?? stampOf(incoming);
    const b = mine[group] ?? stampOf(current);
    if (compareStamps(a, b) > 0) won.add(group);
  }
  if (won.size === 0) return current;
  if (won.size === groups.size) return incoming;

  const fields = { id: current.id };
  const stamps = {};
  for (const group of groups) {
    const fromIncoming = won.has(group);
    copyGroup(fields, fromIncoming ? incoming : current, group);
    stamps[group] = fromIncoming ? (theirs[group] ?? stampOf(incoming)) : (mine[group] ?? stampOf(current));
  }
  return withStamps(fields, stamps);
}

const removalOf = (entry) => (typeof entry === "string" ? { id: entry } : entry);

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
 */
export function planOperation(elements, { upsert = [], remove = [] }, tombstones = new Map()) {
  const live = new Map(elements.map((element) => [element.id, element]));
  const graves = new Map();
  const grave = (id) => (graves.has(id) ? graves.get(id) : tombstones.get(id));
  const shown = new Map();
  const buried = new Map();
  const hidden = new Map();
  const added = new Set();

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
    } else if (isStamped(removal)) {
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
export function effectOf(plan) {
  const remove = new Map(plan.hidden);
  for (const id of plan.buried.keys()) {
    if (remove.has(id)) continue;
    const { version, versionNonce } = plan.graves.get(id);
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
export function commitPlan(plan, tombstones, { limit = Infinity } = {}) {
  if (plan.shown.size === 0 && plan.hidden.size === 0) {
    setGraves(plan.graves, tombstones);
    return { elements: plan.elements, dropped: [] };
  }
  const next = [];
  let reorder = false;
  for (const element of plan.elements) {
    const now = plan.live.get(element.id);
    if (!now || plan.added.has(element.id)) continue;
    if (now.index !== element.index) reorder = true;
    next.push(now);
  }
  const dropped = [];
  for (const id of plan.added) {
    if (next.length >= limit) dropped.push(id);
    else next.push(plan.live.get(id));
    reorder = true;
  }
  for (const id of dropped) plan.graves.delete(id);
  setGraves(plan.graves, tombstones);
  if (reorder) next.sort(compareOrder);
  return { elements: next, dropped };
}

function setGraves(graves, tombstones) {
  for (const [id, tombstone] of graves) {
    if (tombstone) tombstones.set(id, tombstone);
    else tombstones.delete(id);
  }
}

/**
 * Applies `op` to `elements` and returns the new list (the old one isn't
 * changed). `tombstones` is read and updated.
 */
export function applyOperation(elements, op, tombstones = new Map(), options = undefined) {
  if ((op.upsert?.length ?? 0) === 0 && (op.remove?.length ?? 0) === 0) return elements;
  return commitPlan(planOperation(elements, op, tombstones), tombstones, options).elements;
}
