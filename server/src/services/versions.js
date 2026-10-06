import { Version } from "../models/version.model.js";

// Automatic versions beyond this many per board are pruned, oldest first.
// Named versions and "before restore" snapshots are kept.
const MAX_AUTO_VERSIONS = 50;

export async function recordVersion(boardId, elements, { kind = "auto", label = null, author = null } = {}) {
  const version = await Version.create({
    board: boardId,
    kind,
    label,
    author,
    elements,
    elementCount: elements.length,
  });
  if (kind === "auto") await pruneAutoVersions(boardId);
  return version;
}

async function pruneAutoVersions(boardId) {
  const stale = await Version.find({ board: boardId, kind: "auto" })
    .sort({ createdAt: -1 })
    .skip(MAX_AUTO_VERSIONS)
    .select("_id");
  if (stale.length > 0) await Version.deleteMany({ _id: { $in: stale.map((v) => v._id) } });
}

export async function lastVersionTime(boardId) {
  const latest = await Version.findOne({ board: boardId }).sort({ createdAt: -1 }).select("createdAt");
  return latest?.createdAt.getTime() ?? 0;
}
