import type * as Api from "@inkboard/shared/api";
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
import { isPassFor } from "./link-pass.ts";
import type { Keyed } from "./link-pass.ts";
import { removeReplay } from "./replay.ts";
import { removeVersions, savedVersionBytes } from "./versions.ts";

export type BoardDoc = InstanceType<typeof Board>;

export type ObjectIdLike = string | Types.ObjectId;

export type Ref = { _id?: unknown; toString(): string } | null | undefined;

export type Role = Api.Role;

interface Access {
  _id?: unknown;
  owner: Ref;
  collaborators: readonly Ref[];
  linkAccess: string;
  linkKey?: string | null;
  linkUnlocked?: readonly Ref[];
  linkExpiresAt?: Date | null;
}

export const ACCESS_FIELDS = "owner collaborators linkAccess linkKey linkUnlocked linkExpiresAt";

export type Person = Pick<UserDoc, "_id" | "name" | "color" | "avatarUrl">;

type Member = Person & Pick<UserDoc, "email">;

export interface PopulatedMembers {
  owner: Member;
  collaborators: Member[];
}

interface BoardMeta extends Access {
  id: string;
  title: string;
  owner: Member;
  collaborators: (Member | null)[];
  linkReplay?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BoardView extends BoardMeta {
  starredBy: readonly Ref[];
  elements: Element[];
}

type Filing = Pick<InstanceType<typeof BoardState>, "lastOpenedAt" | "archived">;

export interface RoomNeeded {
  board?: boolean;
  bytes?: number;
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

// "owner" and "editor" (invited) are members: they change the board and see who has access. "contributor" draws because
// the link lets anyone edit, "suggester" proposes changes a member accepts or rejects, "viewer" only looks; those three
// apply to anyone with the link, signed in or not. Null means no access. `userId` is null for guests.
export function roleOf(board: Access, userId: unknown, pass?: unknown): Role | null {
  if (userId && isOwner(board, userId)) return "owner";
  if (userId && isMember(board, userId)) return "editor";
  if (linkLock(board, userId, pass)) return null;
  if (board.linkAccess === "edit") return "contributor";
  if (board.linkAccess === "suggest") return "suggester";
  if (board.linkAccess === "view") return "viewer";
  return null;
}

// Why the link doesn't open the board for a non-member: it has expired, or asks for a password they haven't given (as a
// signed-in person, or with `pass`). Null when the link would open it.
export function linkLock(board: Access, userId: unknown, pass?: unknown): Api.LinkLock | null {
  if (board.linkExpiresAt && board.linkExpiresAt.getTime() <= Date.now()) return "expired";
  if (!board.linkKey) return null;
  const unlocked = Boolean(userId) && (board.linkUnlocked ?? []).some((id) => idOf(id) === String(userId));
  return unlocked || isPassFor(board as Keyed, pass) ? null : "password";
}

// So the board stays on their dashboard and its comments open for them without a pass. Only while the password is still
// the one in `board`, and for at most the latest 500 people.
export async function rememberUnlock(board: Access, userId: unknown) {
  if (!userId || !board.linkKey) return;
  const user = String(userId);
  await Board.updateOne(
    { _id: String(board._id), linkKey: board.linkKey, linkUnlocked: { $ne: user } },
    { $push: { linkUnlocked: { $each: [user], $slice: -500 } } },
    { timestamps: false },
  );
}

const LOCKED: Record<Api.LinkLock, string> = {
  password: "This board's link asks for a password.",
  expired: "This link has expired. Ask the board's owner for a new one.",
};

export class LinkLockedError extends HttpError {
  declare locked: Api.LinkLock;

  constructor(locked: Api.LinkLock) {
    super(403, LOCKED[locked]);
    this.locked = locked;
  }
}

export const isMemberRole = (role: Role | null) => role === "owner" || role === "editor";

export const canEdit = (role: Role | null) => isMemberRole(role) || role === "contributor";

// a drawing can be megabytes and most requests only need to know who can open the board, so elements come only when asked for
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

export async function findBoardForMember(boardId: ObjectIdLike, userId: unknown, options?: { elements?: boolean }) {
  const board = await loadBoard(boardId, options);
  if (!isMember(board, userId)) {
    throw new HttpError(403, "You don't have access to this board. Ask its owner to invite you.");
  }
  return board;
}

export async function findBoardForViewing(
  boardId: ObjectIdLike,
  userId: unknown,
  { pass, ...options }: { elements?: boolean; pass?: unknown } = {},
) {
  const board = await loadBoard(boardId, options);
  if (!roleOf(board, userId, pass)) {
    // a link that would open the board but for its password or expiry says so, so the person can act on it
    const locked = board.linkAccess !== "restricted" && linkLock(board, userId, pass);
    if (locked) throw new LinkLockedError(locked);
    throw userId
      ? new HttpError(403, "You don't have access to this board. Ask its owner to invite you.")
      : new HttpError(401, "This board is private. Log in to open it.");
  }
  return board;
}

// The free database holds 512 MB for everyone, so what one person keeps is limited: boards (trashed ones included, until
// erased), and the space their boards, those boards' saved versions and their templates take together, as MongoDB stores
// them. Writes that add on purpose (a new board with a drawing, a saved version, a template) are checked; drawing on a
// board is held to the board's own limit (12 MB) and counts once written. Automatic versions don't count: people can't
// delete them, so they could fill the space for good. VERSION_LIMITS.bytes bounds them per board. Tests lower these.
export const BOARD_LIMITS = { perOwner: 200, ownerBytes: 100_000_000 };

// BSON size, the way boards and templates are measured (versions are measured compressed: see packElements)
export const drawingBytes = (elements: Element[]) => mongoose.mongo.BSON.calculateObjectSize({ elements });

const asObjectId = (id: ObjectIdLike) => new mongoose.Types.ObjectId(String(id));

// measured once, by the database, the way new ones are
async function measureUnsized(owner: Types.ObjectId) {
  const measure = [{ $set: { bytes: { $bsonSize: { elements: "$elements" } } } }];
  const options = { updatePipeline: true, timestamps: false };
  await Promise.all([
    Board.updateMany({ owner, bytes: null }, measure, options),
    Template.updateMany({ owner, bytes: null }, measure, options),
  ]);
}

// Boards (trashed included), their saved (named) versions and their templates; automatic versions are left out (see
// BOARD_LIMITS). Read from stored sizes, not the drawings.
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

export async function roomLeft(ownerId: ObjectIdLike) {
  return BOARD_LIMITS.ownerBytes - (await ownerBytes(ownerId));
}

const SPACE_USED_UP =
  "Your boards have used up their space. Delete a board, saved version or template you don't need, and empty the trash, to make room.";

// one owner at a time, so writes sent together can't all pass a check that only one of them fits in
const forOwner = keyedQueue();

// Runs `write` once `ownerId` has room for it: for another board when `board` is true, and for `bytes` more. Throws (400)
// otherwise, with `full` as the reason when space runs out. A blank board is tiny, so `bytes: 0` skips the sum.
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

// the open session's, or else the saved one (`board` itself is loaded without its elements)
export async function currentElements(boardId: ObjectIdLike) {
  const live: Element[] | undefined = getSession(String(boardId))?.elements;
  if (live) return live;
  const saved = await Board.findById(boardId).select("elements").lean();
  return saved?.elements ?? [];
}

// Pass `trashedBefore` to leave a board alone that was restored or trashed again meanwhile. The board is claimed first, in
// one write marking it as being deleted, after which it can't be restored (see restoreBoard); everything that belongs to it
// goes next and the board last, so a failure part-way leaves a marked board, not unreachable versions and comments, and
// the next trash sweep (or another try) finishes it.
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
    removeReplay(boardId),
    Thread.deleteMany({ board: boardId }),
    Notification.deleteMany({ board: boardId }),
    BoardState.deleteMany({ board: boardId }),
    deleteBoardImages(boardId),
  ]);
  return (await Board.deleteOne({ _id: boardId, purgingAt: { $ne: null } })).deletedCount > 0;
}

export const serializePerson = (user: Person): Api.Person => ({
  id: idOf(user),
  name: user.name,
  color: user.color ?? null,
  avatarUrl: user.avatarUrl ?? null,
});

const serializeMember = (user: Member): Api.Member => ({ ...serializePerson(user), email: user.email });

// non-members never see anyone's email address or the invite list
export function serializeMeta(board: BoardMeta, { redact = false }: { redact?: boolean } = {}): Api.BoardMeta {
  return {
    id: board.id,
    title: board.title,
    owner: redact ? serializePerson(board.owner) : serializeMember(board.owner),
    // filter(Boolean) drops collaborators whose account is gone (they populate as null)
    collaborators: redact ? [] : (board.collaborators.filter(Boolean) as Member[]).map(serializeMember),
    // the schema only lets the three through, which Mongoose reads as a string
    linkAccess: board.linkAccess as Api.LinkAccess,
    linkPassword: Boolean(board.linkKey),
    linkExpiresAt: board.linkExpiresAt ?? null,
    linkReplay: board.linkReplay ?? false,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

// `state` includes this person's own filing (the dashboard); `role` is for when it was worked out with a link-password pass
export function serializeBoard(
  board: BoardView,
  userId: unknown,
  elements: Element[] = board.elements,
  state: Filing | null | undefined = undefined,
  role: Role = roleOf(board, userId)!,
): Api.BoardDetails & Partial<Api.BoardFiling> {
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

// without elements, and without a preview: those are fetched a page of cards at a time (see listPreviews)
export function serializeListed(board: BoardView, userId: unknown): Api.BoardSummary;
export function serializeListed(board: BoardView, userId: unknown, state: Filing | null): Api.ListedBoard;
export function serializeListed(board: BoardView, userId: unknown, state: Filing | null | undefined = undefined) {
  const { elements: _elements, ...listed } = serializeBoard(board, userId, [], state);
  return listed;
}

// For a board shared by link this is what puts it on their dashboard. Best effort: failing to record never blocks opening.
export async function recordOpen(userId: ObjectIdLike, boardId: ObjectIdLike) {
  try {
    await BoardState.updateOne(
      { user: userId, board: boardId },
      { $set: { lastOpenedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // two tabs opening the same board at once can race on the unique index; the other one wins
    if ((error as { code?: unknown }).code !== 11000) console.error("Couldn't record a board visit:", error);
  }
}
