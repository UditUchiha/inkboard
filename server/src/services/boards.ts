import type { Element } from "@inkboard/shared/types";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { BoardState } from "../models/board-state.model.ts";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { Template } from "../models/template.model.ts";
import { Thread } from "../models/thread.model.ts";
import type { UserDoc } from "../models/user.model.ts";
import { getSession } from "../realtime/sessions.ts";
import { deleteBoardImages } from "./image-storage.ts";
import { removeVersions, savedVersionBytes } from "./versions.ts";

/** A board as Mongoose returns it from the database. */
export type BoardDoc = InstanceType<typeof Board>;

/** An id as a string or as the ObjectId it's stored as, which is how ids arrive from requests and from documents. */
export type ObjectIdLike = string | Types.ObjectId;

/** Something that points at a document: the document itself (once populated), its ObjectId, or its id as text. */
export type Ref = { _id?: unknown; toString(): string } | null | undefined;

/** What a person can do on a board (see roleOf). */
export type Role = "owner" | "editor" | "contributor" | "viewer";

/** Who made a board, who is invited to it and how the link opens it: all that roleOf and isMember read. */
interface Access {
  owner: Ref;
  collaborators: readonly Ref[];
  linkAccess: string;
}

/** A person as other people see them: what PERSON_FIELDS selects. */
export type Person = Pick<UserDoc, "_id" | "name" | "color" | "avatarUrl">;

/** A person a board lists as its owner or a collaborator, who is populated with MEMBER_FIELDS. */
type Member = Person & Pick<UserDoc, "email">;

/** What a board's owner and collaborators become once they are populated (see populateMembers). */
export interface PopulatedMembers {
  owner: Member;
  collaborators: Member[];
}

/** What serializeMeta reads of a board whose owner and collaborators are populated (see populateMembers). */
interface BoardMeta extends Access {
  id: string;
  title: string;
  owner: Member;
  collaborators: (Member | null)[];
  createdAt: Date;
  updatedAt: Date;
}

/** What serializeBoard reads of a board: the above, and who starred it. */
interface BoardView extends BoardMeta {
  starredBy: readonly Ref[];
  elements: Element[];
}

/** What a person has done with a board (see BoardState), as far as the dashboard shows it. */
type Filing = Pick<InstanceType<typeof BoardState>, "lastOpenedAt" | "archived">;

/** What the limits of BOARD_LIMITS have to say about a write (see withRoom). */
export interface RoomNeeded {
  /** Whether the write adds a board. */
  board?: boolean;
  /** How much space the write adds. */
  bytes?: number;
  /** The reason to give when the space runs out. */
  full?: string;
}

export const PERSON_FIELDS = "name color avatarUrl";
const MEMBER_FIELDS = `${PERSON_FIELDS} email`;

export const populateMembers = [
  { path: "owner", select: MEMBER_FIELDS },
  { path: "collaborators", select: MEMBER_FIELDS },
];

export const idOf = (ref: Ref) => String(ref?._id ?? ref);

export const isOwner = (board: Pick<Access, "owner">, userId: unknown) => idOf(board.owner) === String(userId);

export const isMember = (board: Pick<Access, "owner" | "collaborators">, userId: unknown) =>
  isOwner(board, userId) || board.collaborators.some((member) => idOf(member) === String(userId));

/**
 * What a person can do on a board. "owner" and "editor" (invited) are members:
 * they can change the board and see who has access. "contributor" can draw
 * because the link allows anyone to edit, and "viewer" can only look. Both of
 * those apply to anyone with the link, signed in or not. Null means no access.
 * `userId` is null for guests.
 */
export function roleOf(board: Access, userId: unknown): Role | null {
  if (userId && isOwner(board, userId)) return "owner";
  if (userId && isMember(board, userId)) return "editor";
  if (board.linkAccess === "edit") return "contributor";
  if (board.linkAccess === "view") return "viewer";
  return null;
}

export const isMemberRole = (role: Role | null) => role === "owner" || role === "editor";

export const canEdit = (role: Role | null) => isMemberRole(role) || role === "contributor";

// A drawing can be megabytes, and most requests only need to know who can open the board,
// so its elements come only when asked for (`elements: true`, or see currentElements).
async function loadBoard(boardId: ObjectIdLike, { elements = false }: { elements?: boolean } = {}) {
  if (!mongoose.isValidObjectId(boardId)) {
    throw new HttpError(404, "This board doesn't exist.");
  }
  const query = Board.findOne({ _id: boardId, deletedAt: null });
  const board = await (elements ? query : query.select("-elements")).populate<PopulatedMembers>(populateMembers);
  if (!board) {
    throw new HttpError(404, "This board doesn't exist or has been deleted.");
  }
  return board;
}

/** For changing a board: only the owner and invited collaborators get through. */
export async function findBoardForMember(boardId: ObjectIdLike, userId: unknown, options?: { elements?: boolean }) {
  const board = await loadBoard(boardId, options);
  if (!isMember(board, userId)) {
    throw new HttpError(403, "You don't have access to this board. Ask its owner to invite you.");
  }
  return board;
}

/** For opening a board: members, plus anyone when the owner shares the link. */
export async function findBoardForViewing(boardId: ObjectIdLike, userId: unknown, options?: { elements?: boolean }) {
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
export const drawingBytes = (elements: Element[]) => mongoose.mongo.BSON.calculateObjectSize({ elements });

const asObjectId = (id: ObjectIdLike) => new mongoose.Types.ObjectId(String(id));

// Boards and templates saved before their size was recorded are measured once, by the database,
// the way new ones are measured.
async function measureUnsized(owner: Types.ObjectId) {
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
export async function ownerBytes(ownerId: ObjectIdLike) {
  const owner = asObjectId(ownerId);
  await measureUnsized(owner);
  const [[boards], [templates]] = await Promise.all([
    Board.aggregate<{ bytes: number; ids: Types.ObjectId[] }>([
      { $match: { owner } },
      { $group: { _id: null, bytes: { $sum: "$bytes" }, ids: { $push: "$_id" } } },
    ]),
    Template.aggregate<{ bytes: number }>([
      { $match: { owner } },
      { $group: { _id: null, bytes: { $sum: "$bytes" } } },
    ]),
  ]);
  return (boards?.bytes ?? 0) + (templates?.bytes ?? 0) + (await savedVersionBytes(boards?.ids ?? []));
}

/** Bytes `ownerId` can still add before what they keep is full (negative when it's over). */
export async function roomLeft(ownerId: ObjectIdLike) {
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
export function withRoom<Result>(
  ownerId: ObjectIdLike,
  { board = false, bytes = 0, full = SPACE_USED_UP }: RoomNeeded,
  write: () => Result | PromiseLike<Result>,
) {
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
export async function currentElements(boardId: ObjectIdLike) {
  const live: Element[] | undefined = getSession(String(boardId))?.elements;
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
export async function destroyBoard(boardId: ObjectIdLike, { trashedBefore }: { trashedBefore?: Date } = {}) {
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

export const serializePerson = (user: Person) => ({
  id: idOf(user),
  name: user.name,
  color: user.color ?? null,
  avatarUrl: user.avatarUrl ?? null,
});

const serializeMember = (user: Member) => ({ ...serializePerson(user), email: user.email });

// People who aren't members never see anyone's email address or the invite list.
export function serializeMeta(board: BoardMeta, { redact = false }: { redact?: boolean } = {}) {
  return {
    id: board.id,
    title: board.title,
    owner: redact ? serializePerson(board.owner) : serializeMember(board.owner),
    // filter(Boolean) drops the collaborators whose account is gone (they populate as null), which the type can't see.
    collaborators: redact ? [] : (board.collaborators.filter(Boolean) as Member[]).map(serializeMember),
    linkAccess: board.linkAccess,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

// Pass `state` (a BoardState or null) to include this person's own filing, as the dashboard does.
export function serializeBoard(
  board: BoardView,
  userId: unknown,
  elements: Element[] = board.elements,
  state: Filing | null | undefined = undefined,
) {
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
export function serializeListed(board: BoardView, userId: unknown, state: Filing | null | undefined = undefined) {
  const { elements: _elements, ...listed } = serializeBoard(board, userId, [], state);
  return listed;
}

/**
 * Remembers that this person opened the board. For a board shared by link this is
 * what puts it on their dashboard. Best effort: failing to record never blocks opening.
 */
export async function recordOpen(userId: ObjectIdLike, boardId: ObjectIdLike) {
  try {
    await BoardState.updateOne(
      { user: userId, board: boardId },
      { $set: { lastOpenedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // Two tabs opening the same board at once can race on the unique index; the other one wins.
    // Whatever was thrown, a failed write carries the server's error code.
    if ((error as { code?: unknown }).code !== 11000) console.error("Couldn't record a board visit:", error);
  }
}
