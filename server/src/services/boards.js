import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { BoardState } from "../models/board-state.model.js";
import { Board } from "../models/board.model.js";
import { Notification } from "../models/notification.model.js";
import { Thread } from "../models/thread.model.js";
import { Version } from "../models/version.model.js";

export const PERSON_FIELDS = "name color avatarUrl";
const MEMBER_FIELDS = `${PERSON_FIELDS} email`;

export const populateMembers = [
  { path: "owner", select: MEMBER_FIELDS },
  { path: "collaborators", select: MEMBER_FIELDS },
];

export const idOf = (ref) => String(ref?._id ?? ref);

export const isOwner = (board, userId) => idOf(board.owner) === String(userId);

export const isMember = (board, userId) =>
  isOwner(board, userId) || board.collaborators.some((member) => idOf(member) === String(userId));

/**
 * What a person can do on a board. "owner" and "editor" (invited) are members:
 * they can change the board and see who has access. "contributor" can draw
 * because the link allows anyone to edit, and "viewer" can only look. Both of
 * those apply to anyone with the link, signed in or not. Null means no access.
 * `userId` is null for guests.
 */
export function roleOf(board, userId) {
  if (userId && isOwner(board, userId)) return "owner";
  if (userId && isMember(board, userId)) return "editor";
  if (board.linkAccess === "edit") return "contributor";
  if (board.linkAccess === "view") return "viewer";
  return null;
}

export const isMemberRole = (role) => role === "owner" || role === "editor";

export const canEdit = (role) => isMemberRole(role) || role === "contributor";

async function loadBoard(boardId) {
  if (!mongoose.isValidObjectId(boardId)) {
    throw new HttpError(404, "This board doesn't exist.");
  }
  const board = await Board.findOne({ _id: boardId, deletedAt: null }).populate(populateMembers);
  if (!board) {
    throw new HttpError(404, "This board doesn't exist or has been deleted.");
  }
  return board;
}

/** For changing a board: only the owner and invited collaborators get through. */
export async function findBoardForMember(boardId, userId) {
  const board = await loadBoard(boardId);
  if (!isMember(board, userId)) {
    throw new HttpError(403, "You don't have access to this board. Ask its owner to invite you.");
  }
  return board;
}

/** For opening a board: members, plus anyone when the owner shares the link. */
export async function findBoardForViewing(boardId, userId) {
  const board = await loadBoard(boardId);
  if (!roleOf(board, userId)) {
    throw userId
      ? new HttpError(403, "You don't have access to this board. Ask its owner to invite you.")
      : new HttpError(401, "This board is private. Log in to open it.");
  }
  return board;
}

/** Deletes a board for good, with everything that belongs to it. */
export async function destroyBoard(boardId) {
  await Promise.all([
    Board.deleteOne({ _id: boardId }),
    Version.deleteMany({ board: boardId }),
    Thread.deleteMany({ board: boardId }),
    Notification.deleteMany({ board: boardId }),
    BoardState.deleteMany({ board: boardId }),
  ]);
}

export const serializePerson = (user) => ({
  id: idOf(user),
  name: user.name,
  color: user.color ?? null,
  avatarUrl: user.avatarUrl ?? null,
});

const serializeMember = (user) => ({ ...serializePerson(user), email: user.email });

// People who aren't members never see anyone's email address or the invite list.
export function serializeMeta(board, { redact = false } = {}) {
  return {
    id: board.id,
    title: board.title,
    owner: redact ? serializePerson(board.owner) : serializeMember(board.owner),
    collaborators: redact ? [] : board.collaborators.filter(Boolean).map(serializeMember),
    linkAccess: board.linkAccess,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

// Pass `state` (a BoardState or null) to include this person's own filing, as the dashboard does.
export function serializeBoard(board, userId, elements = board.elements, state = undefined) {
  const role = roleOf(board, userId);
  const filing = state === undefined ? {} : { lastOpenedAt: state?.lastOpenedAt ?? null, archived: state?.archived ?? false };
  return {
    ...serializeMeta(board, { redact: !isMemberRole(role) }),
    ...filing,
    role,
    starred: Boolean(userId) && board.starredBy.some((id) => idOf(id) === String(userId)),
    elements,
  };
}

/**
 * Remembers that this person opened the board. For a board shared by link this is
 * what puts it on their dashboard. Best effort: failing to record never blocks opening.
 */
export async function recordOpen(userId, boardId) {
  try {
    await BoardState.updateOne(
      { user: userId, board: boardId },
      { $set: { lastOpenedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // Two tabs opening the same board at once can race on the unique index; the other one wins.
    if (error.code !== 11000) console.error("Couldn't record a board visit:", error);
  }
}
