import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { User } from "../models/user.model.js";
import { Version } from "../models/version.model.js";
import { getLiveElements, replaceElements } from "../realtime/index.js";
import { findBoardForMember, PERSON_FIELDS, serializePerson } from "../services/boards.js";
import { recordVersion } from "../services/versions.js";

// Version history is for members (the owner and invited editors).

const serializeVersion = (version) => ({
  id: version.id,
  kind: version.kind,
  label: version.label,
  author: version.author ? serializePerson(version.author) : null,
  elementCount: version.elementCount,
  createdAt: version.createdAt,
});

async function findVersion(board, versionId) {
  const version = mongoose.isValidObjectId(versionId)
    ? await Version.findOne({ _id: versionId, board: board._id })
    : null;
  if (!version) throw new HttpError(404, "That version doesn't exist anymore.");
  return version;
}

const currentElements = (board) => getLiveElements(board.id) ?? board.elements;

export async function listVersions(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const versions = await Version.find({ board: board._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .select("-elements")
    .populate("author", PERSON_FIELDS);
  res.json({ versions: versions.map(serializeVersion) });
}

export async function getVersion(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  await version.populate("author", PERSON_FIELDS);
  res.json({ version: { ...serializeVersion(version), elements: version.elements } });
}

/** Saves the board as it is now, under a name. */
export async function saveVersion(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const label = String(req.body?.label ?? "").trim();
  if (!label) throw new HttpError(400, "Give this version a name.");
  if (label.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  const version = await recordVersion(board._id, currentElements(board), {
    kind: "named",
    label,
    author: req.userId,
  });
  await version.populate("author", PERSON_FIELDS);
  res.status(201).json({ version: serializeVersion(version) });
}

/**
 * Puts an older version back for everyone. What was there before is saved as a
 * version first, so a restore can itself be undone from the history.
 */
export async function restoreVersion(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  const actor = await User.findById(req.userId);

  await recordVersion(board._id, currentElements(board), {
    kind: "restore",
    label: "Before restoring an earlier version",
    author: req.userId,
  });
  await replaceElements(board.id, version.elements, actor);
  res.json({ elements: version.elements });
}
