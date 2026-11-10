import type * as Api from "@inkboard/shared/api";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { User } from "../models/user.model.ts";
import { Version } from "../models/version.model.ts";
import { replaceElements } from "../realtime/index.ts";
import {
  currentElements,
  findBoardForMember,
  idOf,
  isOwner,
  PERSON_FIELDS,
  serializePerson,
  withRoom,
} from "../services/boards.ts";
import type { BoardDoc, Person } from "../services/boards.ts";
import { packElements, recordVersion, VERSION_LIMITS, versionElements } from "../services/versions.ts";
import type { BoardRequest } from "./board.controller.ts";

type VersionDoc = InstanceType<typeof Version>;

type VersionRequest = Request<{ boardId: string; versionId: string }>;

interface PopulatedAuthor {
  author: Person | null;
}

const serializeVersion = (
  version: Pick<VersionDoc, "id" | "kind" | "label" | "elementCount" | "createdAt"> & PopulatedAuthor,
): Api.VersionSummary => ({
  id: version.id,
  kind: version.kind as Api.VersionKind,
  label: version.label as string | null,
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
    .limit(VERSION_LIMITS.auto + VERSION_LIMITS.restore + VERSION_LIMITS.named)
    .select("-elements -packed -imageIds")
    .populate<PopulatedAuthor>("author", PERSON_FIELDS);
  res.json({ versions: versions.map(serializeVersion) } satisfies Api.VersionListReply);
}

export async function getVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  await version.populate("author", PERSON_FIELDS);
  res.json({
    version: {
      ...serializeVersion(version as typeof version & PopulatedAuthor),
      elements: await versionElements(version),
    },
  } satisfies Api.FullVersionReply);
}

export async function saveVersion(req: BoardRequest<{ label?: unknown }>, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!label) throw new HttpError(400, "Give this version a name.");
  if (label.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");

  // packed first, so the owner's space is checked against what the version will take, compressed
  const drawing = await packElements(await currentElements(board.id));
  // counts towards the board owner's space, whoever saves it (recordVersion holds it to the board's own count and budget)
  const full = isOwner(board, req.userId)
    ? undefined
    : "The board's owner has used up their space, so it can't keep another saved version. Ask them to make room.";
  // only an automatic version can come back null (skipped)
  const version = (await withRoom(idOf(board.owner), { bytes: drawing.bytes, full }, () =>
    recordVersion(board._id, drawing, { kind: "named", label, author: req.userId }),
  ))!;
  await version.populate("author", PERSON_FIELDS);
  res
    .status(201)
    .json({ version: serializeVersion(version as typeof version & PopulatedAuthor) } satisfies Api.VersionReply);
}

// what was there before is saved as a version first, so a restore can itself be undone
export async function restoreVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  const actor = await User.findById(req.userId);

  await recordVersion(board._id, await currentElements(board.id), {
    kind: "restore",
    label: "Before restoring an earlier version",
    author: req.userId,
  });
  const elements = await replaceElements(board.id, await versionElements(version), actor);
  res.json({ elements } satisfies Api.RestoredVersionReply);
}

// frees room: automatic and before-restore versions clear on their own as the history fills
export async function deleteVersion(req: VersionRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const version = await findVersion(board, req.params.versionId);
  if (version.kind !== "named") {
    throw new HttpError(400, "Only versions saved by name can be deleted. Autosaves are cleared on their own.");
  }
  await version.deleteOne();
  res.status(204).end();
}
