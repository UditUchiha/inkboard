import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { Version } from "../models/version.model.js";

// Every version is a full copy of the board (up to 12 MB), and the free
// database holds 512 MB for everything, so each board's history has a budget.
// Tests lower these.
export const VERSION_LIMITS = {
  // Automatic checkpoints: at most this many, fewer when the history is over
  // its budget, but never fewer than `keepAuto`.
  auto: 50,
  keepAuto: 3,
  // "Before restoring" snapshots, which let a restore be undone.
  restore: 10,
  // Versions people saved on purpose. They are never removed automatically, so
  // instead a new one is refused once there are this many, or they'd take more
  // than the whole budget; people can delete old ones.
  named: 50,
  // All of a board's versions together, as MongoDB stores them.
  bytes: 30_000_000,
};

const sizeOf = (elements) => mongoose.mongo.BSON.calculateObjectSize({ elements });

export async function recordVersion(boardId, elements, { kind = "auto", label = null, author = null } = {}) {
  const version = await Version.create({
    board: boardId,
    kind,
    label,
    author,
    elements,
    elementCount: elements.length,
    bytes: sizeOf(elements),
  });
  await pruneVersions(boardId);
  return version;
}

// Versions saved before sizes were recorded are measured once, by the database.
async function measureOldVersions(boardId) {
  await Version.updateMany({ board: boardId, bytes: null }, [{ $set: { bytes: { $bsonSize: "$$ROOT" } } }], {
    updatePipeline: true,
  });
}

// Newest first, without the drawings.
const historyOf = (boardId) =>
  Version.find({ board: boardId }).sort({ createdAt: -1, _id: -1 }).select("kind bytes").lean();

/**
 * Removes the automatic and before-restore versions that are over their counts,
 * then the oldest of them until the history fits its budget. The newest few
 * automatic ones and the newest before-restore one are always kept, and saved
 * (named) versions are never removed here.
 */
export async function pruneVersions(boardId) {
  await measureOldVersions(boardId);
  const versions = await historyOf(boardId);

  const doomed = new Set();
  const counts = { auto: 0, restore: 0 };
  const removable = []; // newest first
  for (const version of versions) {
    if (version.kind === "named") continue;
    counts[version.kind] += 1;
    if (counts[version.kind] > VERSION_LIMITS[version.kind]) doomed.add(String(version._id));
    else if (version.kind === "auto" ? counts.auto > VERSION_LIMITS.keepAuto : counts.restore > 1) removable.push(version);
  }

  let total = versions.filter((version) => !doomed.has(String(version._id))).reduce((sum, version) => sum + version.bytes, 0);
  for (const version of removable.reverse()) {
    if (total <= VERSION_LIMITS.bytes) break;
    doomed.add(String(version._id));
    total -= version.bytes;
  }

  if (doomed.size > 0) await Version.deleteMany({ _id: { $in: [...doomed] } });
}

/** Throws (400) if the board has no room for another saved version of `elements`. */
export async function checkRoomForNamedVersion(boardId, elements) {
  await measureOldVersions(boardId);
  const named = await Version.find({ board: boardId, kind: "named" }).select("bytes").lean();
  if (named.length >= VERSION_LIMITS.named) {
    throw new HttpError(400, `This board already has ${named.length} saved versions, the most it can keep. Delete one to save another.`);
  }
  const used = named.reduce((sum, version) => sum + version.bytes, 0);
  if (used + sizeOf(elements) > VERSION_LIMITS.bytes) {
    throw new HttpError(400, "Saved versions of this board have used up their space. Delete an older one to save this one.");
  }
}

export async function lastVersionTime(boardId) {
  const latest = await Version.findOne({ board: boardId }).sort({ createdAt: -1 }).select("createdAt");
  return latest?.createdAt.getTime() ?? 0;
}
