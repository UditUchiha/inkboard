import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { BoardState } from "../models/board-state.model.js";
import { Board, LINK_ACCESS } from "../models/board.model.js";
import { Template } from "../models/template.model.js";
import { User } from "../models/user.model.js";
import { sanitizeElements } from "../realtime/operations.js";
import { closeBoard, getLiveElements, notifyMetaChanged, syncAccess } from "../realtime/index.js";
import {
  destroyBoard,
  findBoardForMember,
  findBoardForViewing,
  idOf,
  isOwner,
  populateMembers,
  roleOf,
  serializeBoard,
  serializeListed,
  serializeMeta,
} from "../services/boards.js";
import { notify } from "../services/notifications.js";
import { boardPreviews } from "../services/previews.js";

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

function readTitle(value) {
  const title = String(value ?? "").trim();
  if (title.length > 80) throw new HttpError(400, "Use 80 characters or fewer for the title.");
  return title;
}

const MAX_BULK_BOARDS = 100;

// Everything the person can open: their own boards, boards they were invited to, and
// boards they opened through a link that is still shared.
export async function listBoards(req, res) {
  const states = await BoardState.find({ user: req.userId });
  const stateByBoard = new Map(states.map((state) => [String(state.board), state]));

  const boards = await Board.find({
    deletedAt: null,
    $or: [
      { owner: req.userId },
      { collaborators: req.userId },
      { _id: { $in: states.map((state) => state.board) }, linkAccess: { $in: ["view", "edit"] } },
    ],
  })
    // Drawings can be megabytes each; the dashboard only needs previews of them.
    .select("-elements")
    .sort({ updatedAt: -1 })
    .populate(populateMembers);
  const previews = await boardPreviews(boards);

  res.json({
    boards: boards.map((board) =>
      serializeListed(board, req.userId, previews.get(board.id) ?? [], stateByBoard.get(board.id) ?? null),
    ),
  });
}

// Archive or unarchive several boards at once, for this person only.
export async function archiveBoards(req, res) {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > MAX_BULK_BOARDS || !ids.every((id) => mongoose.isValidObjectId(id))) {
    throw new HttpError(400, `Choose between 1 and ${MAX_BULK_BOARDS} boards.`);
  }
  if (typeof req.body?.archived !== "boolean") throw new HttpError(400, "archived must be true or false.");
  const { archived } = req.body;

  // Only boards this person can open; anything else is skipped rather than failing the batch.
  const boards = await Board.find({ _id: { $in: ids }, deletedAt: null }).select("owner collaborators linkAccess");
  const allowed = boards.filter((board) => roleOf(board, req.userId)).map((board) => board.id);

  if (allowed.length > 0) {
    await BoardState.bulkWrite(
      allowed.map((id) => ({
        updateOne: { filter: { user: req.userId, board: id }, update: { $set: { archived } }, upsert: true },
      })),
    );
  }
  res.json({ ids: allowed, archived });
}

// Drops a board from this person's dashboard. For a board shared by link that means
// forgetting they ever opened it; opening the link again brings it back.
export async function forgetBoard(req, res) {
  if (!mongoose.isValidObjectId(req.params.boardId)) throw new HttpError(404, "This board doesn't exist.");
  await BoardState.deleteOne({ user: req.userId, board: req.params.boardId });
  res.status(204).end();
}

/**
 * Creates a board: blank, from a saved template (`templateId`), or with
 * drawings sent along (`elements`), e.g. a built-in template or a board a
 * guest drew before signing up.
 */
export async function createBoard(req, res) {
  let title = readTitle(req.body?.title);
  let elements = sanitizeElements(req.body?.elements);

  const { templateId } = req.body ?? {};
  if (templateId) {
    const template = mongoose.isValidObjectId(templateId)
      ? await Template.findOne({ _id: templateId, owner: req.userId })
      : null;
    if (!template) throw new HttpError(404, "That template doesn't exist anymore.");
    elements = template.elements;
    title ||= template.title;
  }

  const board = await Board.create({ title: title || "Untitled board", owner: req.userId, elements });
  await board.populate(populateMembers);
  res.status(201).json({ board: serializeBoard(board, req.userId) });
}

export async function getBoard(req, res) {
  const board = await findBoardForViewing(req.params.boardId, req.userId);
  res.json({ board: serializeBoard(board, req.userId, getLiveElements(board.id) ?? board.elements) });
}

export async function renameBoard(req, res) {
  const title = readTitle(req.body?.title);
  if (!title) throw new HttpError(400, "Enter a title for the board.");

  const board = await findBoardForMember(req.params.boardId, req.userId);
  board.title = title;
  await board.save();

  notifyMetaChanged(board);
  res.json({ board: serializeMeta(board) });
}

export async function setLinkAccess(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can change who can open the link.");
  }

  const { linkAccess } = req.body ?? {};
  if (!LINK_ACCESS.includes(linkAccess)) {
    throw new HttpError(400, `Choose one of: ${LINK_ACCESS.join(", ")}.`);
  }

  board.linkAccess = linkAccess;
  await board.save();

  await syncAccess(board);
  res.json({ board: serializeMeta(board) });
}

export async function starBoard(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const starred = req.body?.starred !== false;
  // Starring is personal, so it shouldn't count as editing the board.
  await Board.updateOne(
    { _id: board._id },
    starred ? { $addToSet: { starredBy: req.userId } } : { $pull: { starredBy: req.userId } },
    { timestamps: false },
  );
  res.json({ starred });
}

/** Moves a board to the trash. Everyone loses access until the owner restores it. */
export async function deleteBoard(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can delete this board.");
  }

  board.deletedAt = new Date();
  await board.save();
  await closeBoard(board.id, { keepChanges: true });
  res.status(204).end();
}

const serializeTrashed = (board, userId, preview) => ({
  ...serializeListed(board, userId, preview),
  deletedAt: board.deletedAt,
  purgeAt: new Date(board.deletedAt.getTime() + TRASH_DAYS * DAY_MS),
});

export async function listTrash(req, res) {
  const boards = await Board.find({ owner: req.userId, deletedAt: { $ne: null } })
    .select("-elements")
    .sort({ deletedAt: -1 })
    .populate(populateMembers);
  const previews = await boardPreviews(boards);
  res.json({ boards: boards.map((board) => serializeTrashed(board, req.userId, previews.get(board.id) ?? [])) });
}

async function findTrashed(boardId, userId) {
  const board = mongoose.isValidObjectId(boardId)
    ? await Board.findOne({ _id: boardId, owner: userId, deletedAt: { $ne: null } })
    : null;
  if (!board) throw new HttpError(404, "That board isn't in your trash.");
  return board;
}

export async function restoreBoard(req, res) {
  const board = await findTrashed(req.params.boardId, req.userId);
  board.deletedAt = null;
  await board.save();
  await board.populate(populateMembers);
  res.json({ board: serializeBoard(board, req.userId) });
}

export async function purgeBoard(req, res) {
  const board = await findTrashed(req.params.boardId, req.userId);
  await destroyBoard(board._id);
  res.status(204).end();
}

export async function emptyTrash(req, res) {
  const boards = await Board.find({ owner: req.userId, deletedAt: { $ne: null } }).select("_id");
  await Promise.all(boards.map((board) => destroyBoard(board._id)));
  res.status(204).end();
}

export async function addCollaborator(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can invite people.");
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "Enter the email address of the person to invite.");

  const invitee = await User.findOne({ email });
  if (!invitee) {
    throw new HttpError(
      404,
      "No account uses that email yet. Ask them to sign up, then invite them again.",
    );
  }
  if (idOf(invitee) === idOf(board.owner)) {
    throw new HttpError(400, "You already own this board.");
  }
  if (board.collaborators.some((member) => idOf(member) === idOf(invitee))) {
    throw new HttpError(409, `${invitee.name} already has access.`);
  }

  board.collaborators.push(invitee._id);
  await board.save();
  await board.populate(populateMembers);

  await syncAccess(board);
  await notify({ users: [invitee._id], type: "invite", actor: board.owner, board });
  res.status(201).json({ board: serializeMeta(board) });
}

export async function removeCollaborator(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const targetId = req.params.userId === "me" ? String(req.userId) : req.params.userId;

  const removingSelf = targetId === String(req.userId);
  if (!removingSelf && !isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can remove people.");
  }
  if (isOwner(board, targetId)) {
    throw new HttpError(400, "The owner can't leave their own board. Delete it instead.");
  }

  board.collaborators = board.collaborators.filter((member) => idOf(member) !== targetId);
  await board.save();
  await board.populate(populateMembers);
  // Forget their filing too, so a board with an open link doesn't linger on their dashboard.
  await BoardState.deleteOne({ user: targetId, board: board._id });

  await syncAccess(board);
  res.json({ board: serializeMeta(board) });
}
