import { HttpError } from "../lib/http-error.js";
import { Board } from "../models/board.model.js";
import { User } from "../models/user.model.js";
import { closeBoard, getLiveElements, notifyMetaChanged, revokeAccess } from "../realtime/index.js";
import {
  findBoardForMember,
  idOf,
  isOwner,
  populateMembers,
  serializeBoard,
  serializeMeta,
} from "../services/boards.js";

function readTitle(value) {
  const title = String(value ?? "").trim();
  if (title.length > 80) throw new HttpError(400, "Use 80 characters or fewer for the title.");
  return title;
}

export async function listBoards(req, res) {
  const boards = await Board.find({ $or: [{ owner: req.userId }, { collaborators: req.userId }] })
    .sort({ updatedAt: -1 })
    .populate(populateMembers);

  res.json({
    boards: boards.map((board) =>
      serializeBoard(board, req.userId, getLiveElements(board.id) ?? board.elements),
    ),
  });
}

export async function createBoard(req, res) {
  const title = readTitle(req.body?.title) || "Untitled board";
  const board = await Board.create({ title, owner: req.userId });
  await board.populate(populateMembers);
  res.status(201).json({ board: serializeBoard(board, req.userId) });
}

export async function getBoard(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  res.json({ board: serializeBoard(board, req.userId, getLiveElements(board.id) ?? board.elements) });
}

export async function renameBoard(req, res) {
  const title = readTitle(req.body?.title);
  if (!title) throw new HttpError(400, "Enter a title for the board.");

  const board = await findBoardForMember(req.params.boardId, req.userId);
  board.title = title;
  await board.save();

  notifyMetaChanged(board.id, serializeMeta(board));
  res.json({ board: serializeMeta(board) });
}

export async function deleteBoard(req, res) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can delete this board.");
  }

  await board.deleteOne();
  await closeBoard(board.id);
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

  notifyMetaChanged(board.id, serializeMeta(board));
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

  await revokeAccess(board.id, targetId);
  notifyMetaChanged(board.id, serializeMeta(board));
  res.json({ board: serializeMeta(board) });
}
