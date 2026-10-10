import type { Element } from "@inkboard/shared/types";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { Board } from "../models/board.model.ts";
import { Version } from "../models/version.model.ts";
import type { ObjectIdLike } from "./boards.ts";

/** What a version is for: "auto" ones are taken while people draw, "named" ones are saved on purpose, and "restore" ones keep the state from before a restore. */
export type VersionKind = "auto" | "named" | "restore";

/** What recordVersion is told about a version besides its elements. */
export interface VersionOptions {
  kind?: VersionKind;
  label?: string | null;
  author?: ObjectIdLike | null;
}

// What the history's budget needs of a version: how big it is and what kind. `_id` is INCOMING for the one being added.
interface Entry {
  _id: Types.ObjectId | string;
  kind: VersionKind;
  bytes: number;
}

// What makeRoom says when the history can't be made to fit: a saved version is one too many (`named`, with
// how many are kept), or the saved versions leave no room (`alone` when the new one is the only one).
type Refused = { full: true; named: true; count: number } | { full: true; alone: boolean };

// What makeRoom says otherwise: which versions to delete, and `full` if even that isn't enough.
interface Fits {
  doomed: Set<string>;
  full: boolean;
}

// Every version is a full copy of the board (up to 12 MB), and the free
// database holds 512 MB for everything, so each board's history has a budget.
// Tests lower these.
export const VERSION_LIMITS = {
  // Automatic checkpoints: at most this many, fewer when the history is over
  // its budget. Over budget the newest `keepAuto` go last; a new automatic version
  // pushes the older ones out before them, and so does a new saved version if
  // there is no room otherwise (saving on purpose matters more than a spare autosave).
  auto: 50,
  keepAuto: 3,
  // "Before restoring" snapshots, which let a restore be undone.
  restore: 10,
  // Versions people saved on purpose. They are never removed automatically, so
  // instead a new one is refused once there are this many, or they'd take more
  // than the whole budget; people can delete old ones.
  named: 50,
  // All of a board's versions together, as MongoDB stores them. The history is
  // never left bigger than this. Only the saved (named) versions count towards their
  // owner's space (see ownerBytes in services/boards.ts); the automatic ones are bounded
  // by this alone, per board.
  bytes: 30_000_000,
};

const sizeOf = (elements: Element[]) => mongoose.mongo.BSON.calculateObjectSize({ elements });

// Writing a version looks at the whole history, decides what goes to make room, and then
// writes; for one board at a time, so autosaves, restores and saves arriving together can't
// each find room that only one of them fits in.
const writing = keyedQueue();

// Versions saved before sizes were recorded are measured once, by the database, the same way new
// ones are. `only` limits it to one kind.
async function measureOldVersions(boards: ObjectIdLike[], only: { kind?: VersionKind } = {}) {
  await Version.updateMany(
    { board: { $in: boards }, bytes: null, ...only },
    [{ $set: { bytes: { $bsonSize: { elements: "$elements" } } } }],
    { updatePipeline: true },
  );
}

// Newest first, without the drawings.
const historyOf = (boardId: ObjectIdLike) =>
  Version.find({ board: boardId }).sort({ createdAt: -1, _id: -1 }).select("kind bytes").lean<Entry[]>();

// Sorts a history (newest first) into the automatic and before-restore versions that are over
// their counts (`doomed`), those that go first when the history is over budget (`removable`,
// newest first), and the few that go last (`kept`, newest first): the newest few autosaves and
// the newest before-restore one. Saved (named) versions are in none of these.
function sortHistory(versions: Entry[]) {
  const doomed = new Set<string>();
  const removable: Entry[] = [];
  const kept: Entry[] = [];
  const counts = { auto: 0, restore: 0 };
  for (const version of versions) {
    if (version.kind === "named") continue;
    counts[version.kind] += 1;
    if (counts[version.kind] > VERSION_LIMITS[version.kind]) doomed.add(String(version._id));
    else if (version.kind === "auto" ? counts.auto > VERSION_LIMITS.keepAuto : counts.restore > 1)
      removable.push(version);
    else kept.push(version);
  }
  return { doomed, removable, kept };
}

const totalBytes = (versions: Entry[]) => versions.reduce((sum, version) => sum + version.bytes, 0);

const INCOMING = "incoming";

/**
 * What to delete so that the history (newest first), with `incoming` added if given, is within
 * its counts and its budget: `{ doomed }`, with `full: true` if it can't be. Over budget, the
 * oldest of the versions beyond the few usually kept go first, then those few, oldest first, so
 * the newest survive as long as they fit. Saved versions are never deleted here, so `full` means
 * they alone (a new saved one included) take the whole budget, or are too many (`named: true`).
 * Every automatic version can be evicted to make room for the incoming one, whatever its kind:
 * a new saved version is refused only when the saved versions leave no room for it, never because
 * of autosaves, which people can't delete themselves.
 */
function makeRoom(history: Entry[], incoming: Pick<Entry, "kind" | "bytes"> | null): Refused | Fits {
  const versions = incoming ? [{ ...incoming, _id: INCOMING }, ...history] : history;
  const { doomed, removable, kept } = sortHistory(versions);
  const named = versions.filter((version) => version.kind === "named");
  if (incoming?.kind === "named") {
    if (named.length > VERSION_LIMITS.named) return { full: true, named: true, count: named.length - 1 };
    if (totalBytes(named) > VERSION_LIMITS.bytes) return { full: true, alone: named.length === 1 };
  }

  let total = totalBytes(versions.filter((version) => !doomed.has(String(version._id))));
  const lastToGo = kept.filter((version) => version._id !== INCOMING);
  for (const version of [...removable.reverse(), ...lastToGo.reverse()]) {
    if (total <= VERSION_LIMITS.bytes) break;
    doomed.add(String(version._id));
    total -= version.bytes;
  }
  return { doomed, full: total > VERSION_LIMITS.bytes };
}

/**
 * Saves `elements` as a version of the board and deletes whatever has to go to keep its history
 * within its counts and budget (see makeRoom). When there's no room, a saved (named) or
 * before-restore version is refused (400, with the reason); an automatic one is skipped, and
 * this resolves with null (the caller decides whether to say so). That only happens when the
 * board's saved versions and this copy of the board together fill the budget, since all other
 * automatic history gives way. A board that is being erased, or is gone, gets no new versions
 * (see removeVersions).
 */
export function recordVersion(
  boardId: ObjectIdLike,
  elements: Element[],
  { kind = "auto", label = null, author = null }: VersionOptions = {},
) {
  const bytes = sizeOf(elements);
  return writing(String(boardId), async () => {
    // Checked inside the queue: erasing the board waits behind writes already running, and one that
    // starts later finds the board marked as being erased, so no version can outlive its board.
    if (!(await Board.exists({ _id: boardId, purgingAt: null }))) {
      if (kind === "auto") return null;
      throw new HttpError(404, "This board doesn't exist or has been deleted.");
    }
    await measureOldVersions([boardId]);
    const room = makeRoom(await historyOf(boardId), { kind, bytes });
    if (room.full) {
      if (kind === "auto") return null;
      throw new HttpError(400, fullMessage(kind, room));
    }
    const version = await Version.create({
      board: boardId,
      kind,
      label,
      author,
      elements,
      elementCount: elements.length,
      bytes,
    });
    // Written first and pruned after, so a failure in between leaves an extra version (pruned
    // on the next write) rather than a history missing what was meant to replace it.
    if (room.doomed.size > 0) await Version.deleteMany({ _id: { $in: [...room.doomed] } });
    return version;
  });
}

function fullMessage(kind: VersionKind, room: { full: boolean; named?: boolean; count?: number; alone?: boolean }) {
  if (room.named) {
    return `This board already has ${room.count} saved versions, the most it can keep. Delete one to save another.`;
  }
  if (kind === "named") {
    if (room.alone) return "This board is too big to keep a saved version of.";
    return "This board's saved versions use up its history space. Delete an older saved version to save this one.";
  }
  return "This board's saved versions and its current drawing leave no room to keep a copy of it from before the restore, which is what lets a restore be undone. Delete a saved version, then try again.";
}

/**
 * Deletes every version of a board, after any write to its history that is already running, so
 * one in flight can't land after the delete and be left behind with no board.
 */
export function removeVersions(boardId: ObjectIdLike) {
  return writing(String(boardId), () => Version.deleteMany({ board: boardId }));
}

/** Brings the board's history within its counts and budget, as each new version does. */
export function pruneVersions(boardId: ObjectIdLike) {
  return writing(String(boardId), async () => {
    await measureOldVersions([boardId]);
    // Only a version being added can be refused, and none is.
    const { doomed } = makeRoom(await historyOf(boardId), null) as Fits;
    if (doomed.size > 0) await Version.deleteMany({ _id: { $in: [...doomed] } });
  });
}

/**
 * Bytes the saved (named) versions of some boards take, as MongoDB stores them. Automatic and
 * before-restore versions are left out on purpose: people can't delete them, so counting them
 * would let ordinary use fill an owner's space for good. They're bounded without it: each board
 * keeps at most VERSION_LIMITS.bytes of history, and an owner has at most BOARD_LIMITS.perOwner boards.
 */
export async function savedVersionBytes(boardIds: Types.ObjectId[]) {
  if (boardIds.length === 0) return 0;
  await measureOldVersions(boardIds, { kind: "named" });
  const [total] = await Version.aggregate<{ bytes: number }>([
    { $match: { board: { $in: boardIds }, kind: "named" } },
    { $group: { _id: null, bytes: { $sum: "$bytes" } } },
  ]);
  return total?.bytes ?? 0;
}

export async function lastVersionTime(boardId: ObjectIdLike) {
  const latest = await Version.findOne({ board: boardId }).sort({ createdAt: -1 }).select("createdAt");
  return latest?.createdAt.getTime() ?? 0;
}
