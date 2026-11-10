import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compareStamps,
  groupStamps,
  groupsOf,
  isNonce,
  isStamped,
  isVersion,
  MAX_VERSION,
  MAX_VERSION_JUMP,
  stampOf,
  withStamps,
} from "@inkboard/shared/board-merge";
import { inStackOrder, isOrderKey, keyAbove, topKey } from "@inkboard/shared/board-order";
import { cleanElement, isValidId, withDefaults } from "@inkboard/shared/element-rules";
import { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT } from "@inkboard/shared/limits";
import type { PieceGroup } from "@inkboard/shared/socket";
import { cleanBases, TEXT_FIELDS, withoutBase } from "@inkboard/shared/text-merge";
import type { Element, FieldGroup, MaybeStamped, Removal, Stamp, TextField, Tombstones } from "@inkboard/shared/types";
import mongoose from "mongoose";

// An operation is { upsert, remove }, taken in by the rules in shared/src/board-merge.ts, which browsers apply too.
// Each element is checked and cleaned first (see shared/src/element-rules.ts).

export { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT };

// as a browser sends it: nothing is checked, so either list may be missing and its contents anything
export interface RawOperation {
  upsert?: unknown;
  remove?: unknown;
}

export interface FullOperation {
  upsert: Element[];
  remove: Removal[];
}

export interface SanitizedOperation extends FullOperation {
  changed: Element[];
  refused: string[];
}

// MongoDB refuses documents over 16 MB and a board is one document, so without limits one huge element would make every
// later save fail and lose everyone's work. Sizes are BSON, 2-3x the JSON for a freehand stroke (8 bytes per number).
export const MAX_ELEMENT_BYTES = 500_000;
export const MAX_BOARD_BYTES = 12_000_000;

export const elementBytes = (element: Element) => mongoose.mongo.BSON.calculateObjectSize({ element });

// older browsers send just the id; a removal with an invalid stamp (past MAX_VERSION, say) is stamped as the newest
// edit
function cleanRemoval(entry: string | (MaybeStamped & { id?: unknown }) | null | undefined): Removal | null {
  if (isValidId(entry)) return { id: entry };
  if (!entry || typeof entry !== "object" || !isValidId(entry.id)) return null;
  return isVersion(entry.version) && isNonce(entry.versionNonce)
    ? { id: entry.id, version: entry.version, versionNonce: entry.versionNonce }
    : { id: entry.id };
}

export const isOversized = (op: RawOperation | null | undefined) =>
  (Array.isArray(op?.upsert) && op.upsert.length > MAX_ELEMENTS_PER_BOARD) ||
  (Array.isArray(op?.remove) && op.remove.length > MAX_ELEMENTS_PER_BOARD);

// A change too big for one message goes as pieces of one group, held until the last arrives and taken in together, so a
// change is made whole or not at all.
export const MAX_GROUP_PIECES = 40;
export const MAX_GROUP_BYTES = 16_000_000;

export interface HeldGroup {
  id: string;
  total: number;
  pieces: RawOperation[];
  bytes: number;
  expired?: undefined;
}

export interface ExpiredGroup {
  id: string;
  expired: true;
  total?: undefined;
  pieces?: undefined;
  bytes?: undefined;
}

export type GroupError = "invalid" | "tooLarge" | "expired";

export interface PieceResult {
  held: HeldGroup | null;
  op?: RawOperation;
  error?: GroupError;
}

// `held` is what the connection has of a group (or null); this adds the piece `op` of `group` ({ id, index, total }).
// Pieces come in order from index 0, which abandons any group held before. Returns `{ held }` to keep waiting, `{ held:
// null, op }` with the pieces joined once the last is in, or `{ held: null, error }` when the group is dropped. A held
// `{ id, expired: true }` makes later pieces of that group "expired", so the sender sends it all again.
export function holdPiece(
  held: HeldGroup | ExpiredGroup | null | undefined,
  group: PieceGroup | null | undefined,
  op: RawOperation | null | undefined,
): PieceResult {
  const valid =
    group &&
    typeof group.id === "string" &&
    group.id.length > 0 &&
    group.id.length <= 64 &&
    Number.isInteger(group.total) &&
    group.total >= 2 &&
    group.total <= MAX_GROUP_PIECES &&
    Number.isInteger(group.index) &&
    group.index >= 0 &&
    group.index < group.total &&
    op &&
    typeof op === "object";
  if (!valid) return { held: null, error: "invalid" };
  if (group.index > 0 && held?.expired && held.id === group.id) return { held: null, error: "expired" };
  const state =
    group.index === 0
      ? { id: group.id, total: group.total, pieces: [], bytes: 0 }
      : held?.id === group.id && held.total === group.total
        ? held
        : null;
  if (!state || state.pieces.length !== group.index) return { held: null, error: "invalid" };
  const bytes = state.bytes + JSON.stringify(op).length;
  if (bytes > MAX_GROUP_BYTES) return { held: null, error: "tooLarge" };
  const pieces = [...state.pieces, op];
  if (pieces.length < group.total) return { held: { ...state, pieces, bytes } };
  const listed = (name: "upsert" | "remove") =>
    pieces.flatMap((piece): unknown[] => (Array.isArray(piece[name]) ? piece[name] : []));
  return { held: null, op: { upsert: listed("upsert"), remove: listed("remove") } };
}

// typing is one text at a time, so this is far more than the editor sends; it bounds the server's diffing (see
// sanitizeOperation)
export const MAX_TYPED_PER_CHANGE = 20;

// The sender has only its own text, so it's sent the stored elements whose text merged with someone else's typing.
export function mergedTyping(sent: readonly Element[], stored: (id: string) => Element | undefined): Element[] {
  const merged: Element[] = [];
  for (const element of sent) {
    const now = element.base && stored(element.id);
    if (!now) continue;
    const ours = groupStamps(element);
    const board = groupStamps(now);
    // Object.keys says only "strings"; these are the keys of a change's bases, so they are text fields
    const groups = (Object.keys(element.base!) as TextField[]).map((field) => TEXT_FIELDS[field].group);
    if (groups.some((group) => !board[group] || !ours[group] || compareStamps(board[group], ours[group]) !== 0))
      merged.push(now);
  }
  return merged;
}

// `changed` lists elements as they'll be stored when that differs from what was sent; `refused` lists ids that can't be
// stored.
export function sanitizeOperation(op: RawOperation | null | undefined): SanitizedOperation | null {
  if (!op || typeof op !== "object") return null;
  const upsert: Element[] = [];
  const changed: Element[] = [];
  const refused: string[] = [];
  let typed = 0;
  for (const raw of (Array.isArray(op.upsert) ? op.upsert : []) as (
    { id?: unknown; base?: unknown } | null | undefined
  )[]) {
    const element = cleanElement(raw);
    if (!element) {
      if (isValidId(raw?.id)) refused.push(raw.id);
      continue;
    }
    // past MAX_TYPED_PER_CHANGE the newer text wins as it comes, so one change can't make the server diff for long
    const base = typed < MAX_TYPED_PER_CHANGE ? cleanBases(raw?.base, element) : undefined;
    if (base) typed += 1;
    upsert.push(base ? { ...element, base } : element);
    if (!isDeepStrictEqual(raw, base ? { ...element, base } : element)) changed.push(element);
  }
  // filter(Boolean) drops invalid removals (null), which the type can't see
  const remove = (Array.isArray(op.remove) ? op.remove.map(cleanRemoval).filter(Boolean) : []) as Removal[];
  if (upsert.length === 0 && remove.length === 0) return null;
  return { upsert, remove, changed, refused };
}

// Imports and templates: too-big elements, and everything past what a board can hold (count and bytes), are left out.
export function sanitizeElements(list: unknown): Element[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const elements: Element[] = [];
  let bytes = 0;
  for (const raw of list) {
    const element = cleanElement(raw);
    if (!element || seen.has(element.id)) continue;
    const size = elementBytes(element);
    if (size > MAX_ELEMENT_BYTES || bytes + size > MAX_BOARD_BYTES) continue;
    seen.add(element.id);
    elements.push(element);
    bytes += size;
    if (elements.length >= MAX_ELEMENTS_PER_BOARD) break;
  }
  return elements;
}

// `legacy` browsers don't stamp each property group: their elements are taken whole at their version, and unversioned
// ones are stamped as the newest edit. A stamp further ahead than editing could get (MAX_VERSION_JUMP) is replaced by
// one for the newest edit, or an element could be forged out of reach of every later change. New elements go on top.
export function prepareOperation(
  elements: Element[],
  op: FullOperation,
  tombstones: Tombstones,
  { legacy = false, index = null }: { legacy?: boolean; index?: Map<string, Element> | null } = {},
): FullOperation {
  const ids = new Set([...op.upsert.map((element) => element.id), ...op.remove.map((removal) => removal.id)]);
  const live = new Map<string, Element>();
  if (index) {
    for (const id of ids) if (index.has(id)) live.set(id, index.get(id)!);
  } else {
    for (const element of elements) if (ids.has(element.id)) live.set(element.id, element);
  }
  const newest = (id: string) => Math.max(stampOf(live.get(id)).version, stampOf(tombstones.get(id)).version);
  const fresh = (id: string) => ({ version: Math.min(newest(id) + 1, MAX_VERSION), versionNonce: randomInt(2 ** 31) });
  const believable = (change: Element | Removal) =>
    isStamped(change) && change.version! <= newest(change.id) + MAX_VERSION_JUMP;
  let top = topKey(elements);

  const upsert = op.upsert.map((incoming) => {
    // an older app's typing replaces the text whole (see text-merge.ts)
    let element = legacy && incoming.base ? withoutBase(incoming) : incoming;
    if (legacy || !believable(element)) {
      const stamp = believable(element) ? stampOf(element) : fresh(element.id);
      element = withStamps(
        element,
        Object.fromEntries(groupsOf(element).map((group): [FieldGroup, Stamp] => [group, stamp])),
      );
    }
    if (element.index === undefined) {
      const known = live.get(element.id) ?? tombstones.get(element.id)?.element;
      let position: string | null | undefined = known?.index;
      if (position === undefined) {
        // past the longest keys the board takes (only a forged key gets there), it shares the top's
        const above = keyAbove(top);
        position = isOrderKey(above) ? above : top;
        top = position;
      }
      element = { ...element, index: position! };
    }
    return element;
  });
  const remove = op.remove.map((removal) => (believable(removal) ? removal : { id: removal.id, ...fresh(removal.id) }));
  return { upsert, remove };
}

// Restored elements are stamped as the newest edit of everything, and elements the snapshot lacks are removed by a
// removal just as new, so changes still on their way from before the restore can't undo parts of it. They're stamped
// well ahead: each step of a drag is a new version, so someone mid-drag can have dozens on the way.
export const RESTORE_LEAD = 1000;

export function restoreOver(
  elements: Element[],
  tombstones: Tombstones,
  snapshot: Element[],
): { elements: Element[]; tombstones: Tombstones } {
  let newest = 0;
  for (const stamped of [...elements, ...tombstones.values(), ...snapshot])
    newest = Math.max(newest, stampOf(stamped).version);
  const stamp = () => ({ version: Math.min(newest + RESTORE_LEAD, MAX_VERSION), versionNonce: randomInt(2 ** 31) });

  // fields an older snapshot lacks are filled in and stamped with the rest, so a change still on its way can't win them
  const restored = inStackOrder(snapshot).map((saved) => {
    const now = stamp();
    const element = withDefaults(saved);
    return withStamps(element, Object.fromEntries(groupsOf(element).map((group): [FieldGroup, Stamp] => [group, now])));
  });
  const kept = new Set(restored.map((element) => element.id));
  const graves = new Map([...tombstones].filter(([id]) => !kept.has(id)));
  for (const element of elements) {
    if (!kept.has(element.id)) graves.set(element.id, { ...stamp(), element });
  }
  return { elements: restored, tombstones: graves };
}
