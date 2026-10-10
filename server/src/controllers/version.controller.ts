import type { Request, Response } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { User } from "../models/user.model.ts";
import { Version } from "../models/version.model.ts";
import { replaceElements } from "../realtime/index.ts";
import {
  currentElements,
  drawingBytes,
  findBoardForMember,
  idOf,
  isOwner,
  PERSON_FIELDS,
  serializePerson,
  withRoom,
} from "../services/boards.ts";
import type { BoardDoc, Person } from "../services/boards.ts";
import { recordVersion, VERSION_LIMITS } from "../services/versions.ts";
import type { BoardRequest } from "./board.controller.ts";

// Version history is for members (the owner and invited editors).

type VersionDoc = InstanceType<typeof Version>;

/** A request for one of a board's saved versions, named by the `:versionId` in the route. */
type VersionRequest = Request<{ boardId: string; versionId: string }>;

/** A version once its author has been looked up (populated). The author is null for automatic versions. */
interface PopulatedAuthor {
  author: Person | null;
}

const serializeVersion = (
  version: Pick<VersionDoc, "id" | "kind" | "label" | "elementCount" | "createdAt"> & PopulatedAuthor,
) => ({
  id: version.id,
  kind: version.kind,
  label: version.label,
  author: version.author ? serializePerson(version.author) : null,
  elementCount: version.elementCount,
  createdAt: version.createdAt,
});

async function findVersion(board: Pick<BoardDoc, "_id">, versionId: string) {
  const version = mongoose.isValidObjectId(versionId)
    ? await Version.findOne({ _id: versionId, board: board._id })
    : null;
  if (!version) throw new HttpError(404, "That version doesn't exist anymore.");
  return version;
}

export async function listVersions(req: BoardRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const versions = await Version.find({ board: board._id })
    .sort({ createdAt: -1 })
    // A board can keep this many (see VERSION_LIMITS), and the history shows all of them.
    .limit(VERSION_LIMITS.auto + VERSION_LIMITS.restore + VERSION_LIMITS.named)
    .select("-elements")
    .populate<PopulatedAuthor>("author", PERSON_FIELDS);
  res.json({ versions: versions.map(serializeVersion) });
}

export async function getVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  await version.populate("author", PERSON_FIELDS);
  // `populate` fills in the author on the version itself, which the types can't see.
  res.json({
    version: { ...serializeVersion(version as typeof version & PopulatedAuthor), elements: version.elements },
  });
}

/** Saves the board as it is now, under a name. */
export async function saveVersion(req: BoardRequest<{ label?: unknown }>, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!label) throw new HttpError(400, "Give this version a name.");
  if (label.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  const elements = await currentElements(board.id);
  // A saved version counts towards the space of the board's owner, whoever saves it. (recordVersion
  // holds it to the board's own count and budget, one write at a time per board.)
  const full = isOwner(board, req.userId)
    ? undefined
    : "The board's owner has used up their space, so it can't keep another saved version. Ask them to make room.";
  // Only an automatic version can come back null (skipped); a named one that doesn't fit is refused with an error.
  const version = (await withRoom(idOf(board.owner), { bytes: drawingBytes(elements), full }, () =>
    recordVersion(board._id, elements, { kind: "named", label, author: req.userId }),
  ))!;
  await version.populate("author", PERSON_FIELDS);
  // `populate` fills in the author on the version itself, which the types can't see.
  res.status(201).json({ version: serializeVersion(version as typeof version & PopulatedAuthor) });
}

/**
 * Puts an older version back for everyone. What was there before is saved as a
 * version first, so a restore can itself be undone from the history.
 */
export async function restoreVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  const actor = await User.findById(req.userId);

  await recordVersion(board._id, await currentElements(board.id), {
    kind: "restore",
    label: "Before restoring an earlier version",
    author: req.userId,
  });
  const elements = await replaceElements(board.id, version.elements, actor);
  res.json({ elements });
}

/**
 * Deletes a saved (named) version, to make room for new ones. Automatic and
 * before-restore versions are cleared on their own as the history fills up.
 */
export async function deleteVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  if (version.kind !== "named") {
    throw new HttpError(400, "Only versions saved by name can be deleted. Autosaves are cleared on their own.");
  }
  await version.deleteOne();
  res.status(204).end();
}
