import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { Board } from "../models/board.model.js";

const MEMBER_FIELDS = "name email";

export const populateMembers = [
  { path: "owner", select: MEMBER_FIELDS },
  { path: "collaborators", select: MEMBER_FIELDS },
];

export const idOf = (ref) => String(ref?._id ?? ref);

export const isOwner = (board, userId) => idOf(board.owner) === String(userId);

export const isMember = (board, userId) =>
  isOwner(board, userId) || board.collaborators.some((member) => idOf(member) === String(userId));

export async function findBoardForMember(boardId, userId) {
  if (!mongoose.isValidObjectId(boardId)) {
    throw new HttpError(404, "This board doesn't exist.");
  }
  const board = await Board.findById(boardId).populate(populateMembers);
  if (!board) {
    throw new HttpError(404, "This board doesn't exist or has been deleted.");
  }
  if (!isMember(board, userId)) {
    throw new HttpError(403, "You don't have access to this board. Ask its owner to invite you.");
  }
  return board;
}

const serializeMember = (user) => ({ id: idOf(user), name: user.name, email: user.email });

export function serializeMeta(board) {
  return {
    id: board.id,
    title: board.title,
    owner: serializeMember(board.owner),
    collaborators: board.collaborators.filter(Boolean).map(serializeMember),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

export function serializeBoard(board, userId, elements = board.elements) {
  return {
    ...serializeMeta(board),
    role: isOwner(board, userId) ? "owner" : "editor",
    elements,
  };
}
