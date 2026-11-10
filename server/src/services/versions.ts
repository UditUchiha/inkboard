import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Element } from "@inkboard/shared/types";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { Board } from "../models/board.model.ts";
import { Version } from "../models/version.model.ts";
import type { ObjectIdLike } from "./boards.ts";

export type VersionKind = "auto" | "named" | "restore";

export interface VersionOptions {
  kind?: VersionKind;
  label?: string | null;
  author?: ObjectIdLike | null;
}

interface Entry {
  _id: Types.ObjectId | string;
  kind: VersionKind;
  bytes: number;
}

// a saved version is one too many (`named`, with how many are kept), or the saved versions leave no room (`alone`)
type Refused = { full: true; named: true; count: number } | { full: true; alone: boolean };

interface Fits {
  doomed: Set<string>;
  full: boolean;
}

// Every version is a full copy of the board (up to 12 MB, a fifth of that compressed) and the free database holds 512 MB
// for everything, so each board's history has a budget. Tests lower these.
export const VERSION_LIMITS = {
  // Over budget the newest `keepAuto` go last; a new automatic version, or a new saved one when there is no other room,
  // pushes the older ones out first (saving on purpose matters more than a spare autosave).
  auto: 50,
  keepAuto: 3,
  restore: 10,
  // never removed automatically, so a new one is refused past this count or when they'd take the whole budget
  named: 50,
  // as MongoDB stores them (compressed); the history is never left bigger. Only saved versions count towards their owner's
  // space (see ownerBytes); automatic ones are bounded by this alone, per board.
  bytes: 30_000_000,
};

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface PackedElements {
  packed: Buffer;
  imageIds: string[];
  elementCount: number;
  bytes: number;
}

// gzipped JSON, with the pictures it shows listed beside it and its size as MongoDB stores that: about a fifth of the
// board's size (brotli is a little smaller but takes seconds). The biggest boards take a fifth of a second, so it runs on
// zlib's own threads; stringifying first takes the copy at once, so changes made meanwhile don't reach it.
export async function packElements(elements: Element[]): Promise<PackedElements> {
  const json = JSON.stringify(elements);
  const imageIds = [...new Set(elements.flatMap((element) => (element.type === "image" ? [element.imageId] : [])))];
  const packed = await gzip(json);
  const bytes = mongoose.mongo.BSON.calculateObjectSize({ packed, imageIds });
  return { packed, imageIds, elementCount: elements.length, bytes };
}

export async function versionElements(version: { elements: Element[]; packed?: Buffer | null }) {
  return version.packed ? (JSON.parse(String(await gunzip(version.packed))) as Element[]) : version.elements;
}

// one board at a time: a write looks at the whole history, decides what goes, then writes, so writes arriving together
// can't each find room that only one of them fits in
const writing = keyedQueue();

// measured once, by the database, the way new ones are
async function measureOldVersions(boards: ObjectIdLike[], only: { kind?: VersionKind } = {}) {
  await Version.updateMany(
    { board: { $in: boards }, bytes: null, ...only },
    [{ $set: { bytes: { $bsonSize: { elements: "$elements" } } } }],
    { updatePipeline: true },
  );
}

const historyOf = (boardId: ObjectIdLike) =>
  Version.find({ board: boardId }).sort({ createdAt: -1, _id: -1 }).select("kind bytes").lean<Entry[]>();

// `doomed`: automatic and before-restore versions over their counts; `removable`: those that go first when over budget;
// `kept`: the few that go last (newest autosaves, newest before-restore). Saved versions are in none of these.
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

// Over budget, the oldest beyond the few usually kept go first, then those few, oldest first. Saved versions are never
// deleted here, so `full` means they alone (the incoming one included) fill the budget, or are too many (`named: true`).
// Any automatic version can be evicted for the incoming one, so a new saved version is refused only for lack of room
// among saved versions, never because of autosaves, which people can't delete.
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

// A saved (named) or before-restore version is refused (400, with the reason) when there's no room; an automatic one is
// skipped and this resolves null. That only happens when saved versions plus this copy fill the budget. A board being
// erased or gone gets no new versions (see removeVersions). `drawing` may arrive packed, from a caller that needed its size.
export async function recordVersion(
  boardId: ObjectIdLike,
  drawing: Element[] | PackedElements,
  { kind = "auto", label = null, author = null }: VersionOptions = {},
) {
  const { packed, imageIds, elementCount, bytes } = Array.isArray(drawing) ? await packElements(drawing) : drawing;
  return writing(String(boardId), async () => {
    // checked inside the queue: erasing waits behind writes running, and a later write finds the board marked, so no version outlives its board
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
      packed,
      imageIds,
      elementCount,
      bytes,
    });
    // written first and pruned after, so a failure leaves an extra version (pruned next write), not a history missing its replacement
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

// waits behind a write to the history already running, so it can't land after the delete and be left with no board
export function removeVersions(boardId: ObjectIdLike) {
  return writing(String(boardId), () => Version.deleteMany({ board: boardId }));
}

export function pruneVersions(boardId: ObjectIdLike) {
  return writing(String(boardId), async () => {
    await measureOldVersions([boardId]);
    const { doomed } = makeRoom(await historyOf(boardId), null) as Fits;
    if (doomed.size > 0) await Version.deleteMany({ _id: { $in: [...doomed] } });
  });
}

// Automatic and before-restore versions are left out on purpose: people can't delete them, so counting them would let
// ordinary use fill an owner's space for good. They're bounded by VERSION_LIMITS.bytes per board and BOARD_LIMITS.perOwner.
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

// For the one-off script (scripts/compress-versions.ts). Each is rewritten in one update, so the server, which reads
// both forms, can keep running. Resolves with how many were compressed.
export async function compressOldVersions(onProgress?: (count: number) => void) {
  let count = 0;
  for await (const version of Version.find({ packed: null }).select("elements").lean()) {
    const { packed, imageIds, elementCount, bytes } = await packElements(version.elements);
    await Version.updateOne({ _id: version._id }, { $set: { packed, imageIds, elementCount, bytes, elements: [] } });
    count += 1;
    onProgress?.(count);
  }
  return count;
}
