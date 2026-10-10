import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { BoardState } from "../models/board-state.model.ts";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { Template } from "../models/template.model.ts";
import { Thread } from "../models/thread.model.ts";
import { getSession } from "../realtime/sessions.js";
import { deleteBoardImages } from "./image-storage.js";
import { removeVersions, savedVersionBytes } from "./versions.js";

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

// A drawing can be megabytes, and most requests only need to know who can open the board,
// so its elements come only when asked for (`elements: true`, or see currentElements).
async function loadBoard(boardId, { elements = false } = {}) {
  if (!mongoose.isValidObjectId(boardId)) {
    throw new HttpError(404, "This board doesn't exist.");
  }
  const query = Board.findOne({ _id: boardId, deletedAt: null });
  const board = await (elements ? query : query.select("-elements")).populate(populateMembers);
  if (!board) {
    throw new HttpError(404, "This board doesn't exist or has been deleted.");
  }
  return board;
}

/** For changing a board: only the owner and invited collaborators get through. */
export async function findBoardForMember(boardId, userId, options) {
  const board = await loadBoard(boardId, options);
  if (!isMember(board, userId)) {
    throw new HttpError(403, "You don't have access to this board. Ask its owner to invite you.");
  }
  return board;
}

/** For opening a board: members, plus anyone when the owner shares the link. */
export async function findBoardForViewing(boardId, userId, options) {
  const board = await loadBoard(boardId, options);
  if (!roleOf(board, userId)) {
    throw userId
      ? new HttpError(403, "You don't have access to this board. Ask its owner to invite you.")
      : new HttpError(401, "This board is private. Log in to open it.");
  }
  return board;
}

// The free database holds 512 MB for everyone, so what one person keeps is limited: how many
// boards (trashed ones included, until they're erased), and how much space their boards, those
// boards' saved versions and their templates take together, as MongoDB stores them. Writes that
// add to it on purpose (a new board with a drawing, a saved version, a template) are checked;
// drawing on a board is held to the board's own limit (12 MB), and counts towards this once written.
// Automatic versions (autosaves and before-restore copies) don't count: people can't delete
// them, so they could fill the space for good. They are bounded anyway, by VERSION_LIMITS.bytes
// for each board, so at most that times `perOwner` boards. Tests lower these.
export const BOARD_LIMITS = { perOwner: 200, ownerBytes: 100_000_000 };

/** How much space a drawing takes as MongoDB stores it, the way boards, versions and templates are measured. */
export const drawingBytes = (elements) => mongoose.mongo.BSON.calculateObjectSize({ elements });

const asObjectId = (id) => new mongoose.Types.ObjectId(String(id));

// Boards and templates saved before their size was recorded are measured once, by the database,
// the way new ones are measured.
async function measureUnsized(owner) {
  const measure = [{ $set: { bytes: { $bsonSize: { elements: "$elements" } } } }];
  const options = { updatePipeline: true, timestamps: false };
  await Promise.all([
    Board.updateMany({ owner, bytes: null }, measure, options),
    Template.updateMany({ owner, bytes: null }, measure, options),
  ]);
}

/**
 * Bytes of what `ownerId` keeps that they can delete: their boards (trashed ones included), the
 * saved (named) versions of those boards, and their templates. Automatic versions are left out
 * (see BOARD_LIMITS). Read from the sizes stored with each, so it doesn't read the
 * drawings themselves.
 */
export async function ownerBytes(ownerId) {
  const owner = asObjectId(ownerId);
  await measureUnsized(owner);
  const [[boards], [templates]] = await Promise.all([
    Board.aggregate([
      { $match: { owner } },
      { $group: { _id: null, bytes: { $sum: "$bytes" }, ids: { $push: "$_id" } } },
    ]),
    Template.aggregate([{ $match: { owner } }, { $group: { _id: null, bytes: { $sum: "$bytes" } } }]),
  ]);
  return (boards?.bytes ?? 0) + (templates?.bytes ?? 0) + (await savedVersionBytes(boards?.ids ?? []));
}

/** Bytes `ownerId` can still add before what they keep is full (negative when it's over). */
export async function roomLeft(ownerId) {
  return BOARD_LIMITS.ownerBytes - (await ownerBytes(ownerId));
}

const SPACE_USED_UP =
  "Your boards have used up their space. Delete a board, saved version or template you don't need, and empty the trash, to make room.";

// Checks that add up what an owner keeps and then write more are run for one owner at a time,
// so writes sent together can't all pass a check that only one of them fits in.
const forOwner = keyedQueue();

/**
 * Runs `write` (and resolves with what it does) once `ownerId` is found to have room for it:
 * for another board when `board` is true, and for `bytes` more. Throws (400) if there isn't,
 * with `full` as the reason when space runs out. A blank board is tiny, so `bytes: 0` skips
 * adding up the space.
 */
export function withRoom(ownerId, { board = false, bytes = 0, full = SPACE_USED_UP }, write) {
  return forOwner(String(ownerId), async () => {
    if (board && (await Board.countDocuments({ owner: ownerId })) >= BOARD_LIMITS.perOwner) {
      throw new HttpError(
        400,
        `You already have ${BOARD_LIMITS.perOwner} boards, the most you can keep. Delete some, and empty the trash, to make room.`,
      );
    }
    if (bytes > 0 && (await ownerBytes(ownerId)) + bytes > BOARD_LIMITS.ownerBytes) throw new HttpError(400, full);
    return write();
  });
}

/**
 * A board's drawing as people see it right now: the open session's, or else the saved one.
 * (`board` itself is loaded without its elements.)
 */
export async function currentElements(boardId) {
  const live = getSession(String(boardId))?.elements;
  if (live) return live;
  const saved = await Board.findById(boardId).select("elements").lean();
  return saved?.elements ?? [];
}

/**
 * Deletes a trashed board for good, with everything that belongs to it, and says
 * whether it did. Pass `trashedBefore` to leave a board alone that was restored,
 * or trashed again, after the caller looked at it.
 *
 * The board is claimed first, in one write that marks it as being deleted: from then
 * on it can't be restored (see restoreBoard), so nobody gets back a board whose pictures,
 * comments and history are on their way out. Everything that belongs to it goes next and
 * the board itself last, so a failure part-way leaves a marked board, not versions and
 * comments nobody can reach, and the next trash sweep (or another try) finishes it.
 */
export async function destroyBoard(boardId, { trashedBefore } = {}) {
  const trashed = { deletedAt: trashedBefore ? { $ne: null, $lt: trashedBefore } : { $ne: null } };
  const claimed = await Board.updateOne(
    { _id: boardId, $or: [trashed, { purgingAt: { $ne: null } }] },
    { $set: { purgingAt: new Date() } },
    { timestamps: false },
  );
  if (claimed.matchedCount === 0) return false;
  await Promise.all([
    removeVersions(boardId),
    Thread.deleteMany({ board: boardId }),
    Notification.deleteMany({ board: boardId }),
    BoardState.deleteMany({ board: boardId }),
    deleteBoardImages(boardId),
  ]);
  return (await Board.deleteOne({ _id: boardId, purgingAt: { $ne: null } })).deletedCount > 0;
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
  const filing =
    state === undefined ? {} : { lastOpenedAt: state?.lastOpenedAt ?? null, archived: state?.archived ?? false };
  return {
    ...serializeMeta(board, { redact: !isMemberRole(role) }),
    ...filing,
    role,
    starred: Boolean(userId) && board.starredBy.some((id) => idOf(id) === String(userId)),
    elements,
  };
}

/**
 * A board as the dashboard lists it: without its elements, and without a preview to draw either.
 * Previews are fetched a page of cards at a time (see listPreviews and previews.js).
 */
export function serializeListed(board, userId, state = undefined) {
  const { elements: _elements, ...listed } = serializeBoard(board, userId, [], state);
  return listed;
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
