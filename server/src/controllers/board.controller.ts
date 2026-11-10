import type * as Api from "@inkboard/shared/api";
import type { Element } from "@inkboard/shared/types";
import { LINK_EXPIRY_MAX_MS, LINK_PASSWORD_MAX, LINK_PASSWORD_MIN } from "@inkboard/shared/limits";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { emailLinkUrlFor } from "../lib/app-url.ts";
import { HttpError } from "../lib/http-error.ts";
import { hashPassword, verifyPasswordHash } from "../lib/passwords.ts";
import { BoardState } from "../models/board-state.model.ts";
import { Board, LINK_ACCESS } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { Template } from "../models/template.model.ts";
import { User } from "../models/user.model.ts";
import { sanitizeElements } from "../realtime/operations.ts";
import { closeBoard, notifyMetaChanged, syncAccess, watchLinkExpiry } from "../realtime/index.ts";
import {
  ACCESS_FIELDS,
  currentElements,
  destroyBoard,
  drawingBytes,
  findBoardForMember,
  findBoardForViewing,
  idOf,
  isMemberRole,
  isOwner,
  LinkLockedError,
  populateMembers,
  rememberUnlock,
  roleOf,
  serializeBoard,
  serializeListed,
  serializeMeta,
  withRoom,
} from "../services/boards.ts";
import type { BoardDoc, PopulatedMembers } from "../services/boards.ts";
import { sendAccessRequestEmail } from "../services/account-emails.ts";
import { emailConfigured } from "../services/email.ts";
import { newLinkKey, passFor } from "../services/link-pass.ts";
import { deleteImages } from "../services/image-storage.ts";
import { copyBoardImages, ownerImageUsage } from "../services/images.ts";
import type { ImageLimit } from "../services/images.ts";
import { notify } from "../services/notifications.ts";
import { boardPreviews } from "../services/previews.ts";
import { TRASH_DAYS } from "../services/trash.ts";

const DAY_MS = 24 * 3600 * 1000;

// a body comes from anyone, so its fields are unknown until checked, and it is missing when nothing was sent
export type BoardRequest<Body = unknown> = Request<{ boardId: string }, unknown, Body | undefined>;

function readTitle(value: unknown) {
  if (value != null && typeof value !== "string") throw new HttpError(400, "The title must be text.");
  const title = (value ?? "").trim();
  if (title.length > 80) throw new HttpError(400, "Use 80 characters or fewer for the title.");
  return title;
}

const MAX_BULK_BOARDS = 100;

export async function listBoards(req: Request, res: Response) {
  const states = await BoardState.find({ user: req.userId });
  const stateByBoard = new Map(states.map((state) => [String(state.board), state]));

  const boards = await Board.find({
    deletedAt: null,
    $or: [
      { owner: req.userId },
      { collaborators: req.userId },
      { _id: { $in: states.map((state) => state.board) }, linkAccess: { $in: ["view", "suggest", "edit"] } },
    ],
  })
    .select("-elements")
    .sort({ updatedAt: -1 })
    .populate<PopulatedMembers>(populateMembers);

  res.json({
    boards: boards
      // an expired link, or a changed password, no longer opens the board
      .filter((board) => roleOf(board, req.userId))
      .map((board) => serializeListed(board, req.userId, stateByBoard.get(board.id) ?? null)),
  } satisfies Api.BoardListReply);
}

export async function archiveBoards(
  req: Request<{}, unknown, { ids?: unknown; archived?: unknown } | undefined>,
  res: Response,
) {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > MAX_BULK_BOARDS || !ids.every((id) => mongoose.isValidObjectId(id))) {
    throw new HttpError(400, `Choose between 1 and ${MAX_BULK_BOARDS} boards.`);
  }
  if (typeof req.body?.archived !== "boolean") throw new HttpError(400, "archived must be true or false.");
  const { archived } = req.body;

  // only boards this person can open; anything else is skipped rather than failing the batch
  const boards = await Board.find({ _id: { $in: ids }, deletedAt: null }).select(ACCESS_FIELDS);
  const allowed = boards.filter((board) => roleOf(board, req.userId)).map((board) => board.id);

  if (allowed.length > 0) {
    await BoardState.bulkWrite(
      allowed.map((id) => ({
        updateOne: { filter: { user: req.userId, board: id }, update: { $set: { archived } }, upsert: true },
      })),
    );
  }
  res.json({ ids: allowed, archived } satisfies Api.ArchiveReply);
}

// for a board shared by link that means forgetting they opened it; opening the link again brings it back
export async function forgetBoard(req: BoardRequest, res: Response) {
  if (!mongoose.isValidObjectId(req.params.boardId)) throw new HttpError(404, "This board doesn't exist.");
  await BoardState.deleteOne({ user: req.userId, board: req.params.boardId });
  res.status(204).end();
}

export async function createBoard(
  req: Request<{}, unknown, { title?: unknown; elements?: unknown; templateId?: unknown } | undefined>,
  res: Response,
) {
  let title = readTitle(req.body?.title);
  let elements: Element[] = sanitizeElements(req.body?.elements);

  const { templateId } = req.body ?? {};
  if (templateId) {
    const template = mongoose.isValidObjectId(templateId)
      ? await Template.findOne({ _id: templateId, owner: req.userId })
      : null;
    if (!template) throw new HttpError(404, "That template doesn't exist anymore.");
    elements = template.elements;
    title ||= template.title;
  }

  const bytes = drawingBytes(elements);
  // a blank board is tiny, so only one that starts with a drawing is held to the owner's space
  const board = await withRoom(req.userId!, { board: true, bytes: elements.length > 0 ? bytes : 0 }, () =>
    Board.create({ title: title || "Untitled board", owner: req.userId, elements, bytes }),
  );
  await board.populate(populateMembers);
  res
    .status(201)
    .json({ board: serializeBoard(board as typeof board & PopulatedMembers, req.userId) } satisfies Api.BoardReply);
}

const COPY_FULL: Record<ImageLimit, string> = {
  board: "This board has more pictures than a board can hold, so it can't be copied.",
  owner:
    "Your boards are out of image space, so this board's pictures don't fit. Remove pictures you don't need and try again.",
  total: "Image storage is full for now, so this board's pictures can't be copied. Try again later.",
};

// The drawing as people see it now, with its own copies of the pictures (so it survives the original's deletion), but
// none
// of the comments, history, suggestions or people. Anyone signed in who can open the board can copy it, viewers too.
export async function copyBoard(req: BoardRequest, res: Response) {
  const source = await findBoardForViewing(req.params.boardId, req.userId);
  const elements = structuredClone(await currentElements(source._id));
  const imageIds = [...new Set(elements.flatMap((element) => (element.type === "image" ? [element.imageId] : [])))];
  const id = new mongoose.Types.ObjectId();
  const owner = req.userId!;
  const board = await withRoom(owner, { board: true, bytes: drawingBytes(elements) }, async () => {
    const copied = imageIds.length
      ? await copyBoardImages({ from: source._id, to: id, ids: imageIds, owner, uploadedBy: owner })
      : { copies: new Map<string, string>() };
    if ("full" in copied) {
      const verify = copied.unverified ? " Confirm your email address (see Settings) to get more room." : "";
      throw new HttpError(400, COPY_FULL[copied.full] + verify);
    }
    for (const element of elements) {
      if (element.type === "image") element.imageId = copied.copies.get(element.imageId) ?? element.imageId;
    }
    const title = `Copy of ${source.title}`.slice(0, 80).trim();
    try {
      return await Board.create({ _id: id, title, owner, elements, bytes: drawingBytes(elements) });
    } catch (error) {
      await deleteImages([...copied.copies.values()]);
      throw error;
    }
  });
  await board.populate(populateMembers);
  res
    .status(201)
    .json({ board: serializeBoard(board as typeof board & PopulatedMembers, owner) } satisfies Api.BoardReply);
}

export async function getBoard(req: BoardRequest, res: Response) {
  const board = await findBoardForViewing(req.params.boardId, req.userId);
  res.json({ board: serializeBoard(board, req.userId, await currentElements(board.id)) } satisfies Api.BoardReply);
}

export async function renameBoard(req: BoardRequest<{ title?: unknown }>, res: Response) {
  const title = readTitle(req.body?.title);
  if (!title) throw new HttpError(400, "Enter a title for the board.");

  const board = await findBoardForMember(req.params.boardId, req.userId);
  board.title = title;
  await board.save();

  notifyMetaChanged(board);
  res.json({ board: serializeMeta(board) } satisfies Api.BoardMetaReply);
}

function readLinkPassword(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length < LINK_PASSWORD_MIN || value.length > LINK_PASSWORD_MAX) {
    throw new HttpError(400, `Use between ${LINK_PASSWORD_MIN} and ${LINK_PASSWORD_MAX} characters for the password.`);
  }
  return value;
}

function readLinkExpiry(value: unknown) {
  if (value === null) return null;
  const at = typeof value === "string" ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) throw new HttpError(400, "Choose when the link should expire.");
  if (at.getTime() <= Date.now()) throw new HttpError(400, "Choose a time that hasn't passed yet.");
  if (at.getTime() > Date.now() + LINK_EXPIRY_MAX_MS) {
    throw new HttpError(400, "A link can expire at most a year from now.");
  }
  return at;
}

// A new password, or none, ends every pass given for the old one, so people opening by the link are asked again;
// invited people never are.
export async function setLinkAccess(
  req: BoardRequest<{ linkAccess?: unknown; password?: unknown; expiresAt?: unknown; linkReplay?: unknown }>,
  res: Response,
) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can change who can open the link.");
  }

  const body = req.body ?? {};
  if ("linkAccess" in body) {
    if (!LINK_ACCESS.includes(body.linkAccess as string)) {
      throw new HttpError(400, `Choose one of: ${LINK_ACCESS.join(", ")}.`);
    }
    board.linkAccess = body.linkAccess as string;
  }
  if ("password" in body) {
    const password = readLinkPassword(body.password);
    board.linkPassword = password && (await hashPassword(password));
    board.linkKey = password && newLinkKey();
    board.set("linkUnlocked", []);
  }
  if ("expiresAt" in body) board.linkExpiresAt = readLinkExpiry(body.expiresAt);
  if ("linkReplay" in body) board.linkReplay = body.linkReplay === true;
  // sharing isn't editing, so it doesn't move the board up the dashboard
  await board.save({ timestamps: false });

  await syncAccess(board);
  watchLinkExpiry(board);
  res.json({ board: serializeMeta(board) } satisfies Api.BoardMetaReply);
}

// Answers with the pass that opens the link from now on (see link-pass.ts); someone signed in is also remembered, so
// the board stays on their dashboard. Open to guests.
export async function unlockBoard(req: BoardRequest<{ password?: unknown }>, res: Response) {
  const { boardId } = req.params;
  const board = mongoose.isValidObjectId(boardId)
    ? await Board.findOne({ _id: boardId, deletedAt: null }).select(`${ACCESS_FIELDS} +linkPassword`)
    : null;
  if (!board || board.linkAccess === "restricted") {
    throw new HttpError(404, "This board doesn't exist, or its link doesn't open it.");
  }
  if (board.linkExpiresAt && board.linkExpiresAt.getTime() <= Date.now()) throw new LinkLockedError("expired");
  if (!board.linkKey || !board.linkPassword) {
    res.json({ pass: "" } satisfies Api.LinkPassReply);
    return;
  }
  const password = req.body?.password;
  const given = typeof password === "string" ? password.slice(0, 200) : "";
  const { ok } = await verifyPasswordHash(given, board.linkPassword);
  if (!ok) throw new HttpError(403, "That password isn't right.");
  await rememberUnlock(board, req.userId);
  res.json({ pass: passFor(board) } satisfies Api.LinkPassReply);
}

export async function starBoard(req: BoardRequest<{ starred?: unknown }>, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  const starred = req.body?.starred ?? true;
  if (typeof starred !== "boolean") throw new HttpError(400, "starred must be true or false.");
  // starring is personal, so it doesn't count as editing
  await Board.updateOne(
    { _id: board._id },
    starred ? { $addToSet: { starredBy: req.userId } } : { $pull: { starredBy: req.userId } },
    { timestamps: false },
  );
  res.json({ starred } satisfies Api.StarReply);
}

// Everyone loses access until the owner restores it, so the invited are told: a board vanishing without a word looks
// like a bug.
export async function deleteBoard(req: BoardRequest, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can delete this board.");
  }

  board.deletedAt = new Date();
  await board.save();
  await closeBoard(board.id, { keepChanges: true });
  await notify({ users: board.collaborators, type: "trashed", actor: board.owner, board });
  res.status(204).end();
}

const serializeTrashed = (
  board: Parameters<typeof serializeListed>[0] & Pick<BoardDoc, "deletedAt">,
  userId: unknown,
): Api.TrashedBoard => ({
  ...serializeListed(board, userId),
  deletedAt: board.deletedAt!,
  purgeAt: new Date(board.deletedAt!.getTime() + TRASH_DAYS * DAY_MS),
});

// boards being deleted for good (see destroyBoard) are on their way out
export async function listTrash(req: Request, res: Response) {
  const boards = await Board.find({ owner: req.userId, deletedAt: { $ne: null }, purgingAt: null })
    .select("-elements")
    .sort({ deletedAt: -1 })
    .populate<PopulatedMembers>(populateMembers);
  res.json({ boards: boards.map((board) => serializeTrashed(board, req.userId)) } satisfies Api.TrashListReply);
}

export async function imageUsage(req: Request, res: Response) {
  res.json((await ownerImageUsage(req.userId!)) satisfies Api.ImageUsage);
}

const MAX_PREVIEWS = 24;

// up to 24 boards the person can open, as { [boardId]: elements }; boards that are gone or off limits are left out, and
// a deleted board is only for its owner
export async function listPreviews(req: Request, res: Response) {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_PREVIEWS || !ids.every((id) => mongoose.isValidObjectId(id))) {
    throw new HttpError(400, `Ask for between 1 and ${MAX_PREVIEWS} boards.`);
  }
  const found = await Board.find({ _id: { $in: ids } }).select(`${ACCESS_FIELDS} updatedAt deletedAt`);
  const boards = found.filter((board) => roleOf(board, req.userId) && (!board.deletedAt || isOwner(board, req.userId)));
  res.json({ previews: Object.fromEntries(await boardPreviews(boards)) } satisfies Api.PreviewsReply);
}

async function findTrashed(boardId: string, userId: string | undefined) {
  const board = mongoose.isValidObjectId(boardId)
    ? await Board.findOne({ _id: boardId, owner: userId, deletedAt: { $ne: null } })
    : null;
  if (!board) throw new HttpError(404, "That board isn't in your trash.");
  return board;
}

// takes no room: a trashed board still counts against its owner's limits (see withRoom)
export async function restoreBoard(req: BoardRequest, res: Response) {
  const board = await findTrashed(req.params.boardId, req.userId);
  // one write that only takes a board nobody has started deleting for good, so a restore and a purge can't both go
  // ahead (see destroyBoard)
  const restored = await Board.updateOne(
    { _id: board._id, deletedAt: { $ne: null }, purgingAt: null },
    { $set: { deletedAt: null } },
  );
  if (restored.modifiedCount === 0) {
    if (await Board.exists({ _id: board._id, purgingAt: { $ne: null } })) {
      throw new HttpError(409, "This board is being deleted for good, so it can't be restored.");
    }
    throw new HttpError(404, "That board isn't in your trash.");
  }
  // it's back, so being told it went is no longer true (a later trash can tell them again)
  await Notification.deleteMany({ board: board._id, type: "trashed" });
  const updated = await Board.findById(board._id).populate<PopulatedMembers>(populateMembers);
  res.json({ board: serializeBoard(updated!, req.userId) } satisfies Api.BoardReply);
}

export async function purgeBoard(req: BoardRequest, res: Response) {
  const board = await findTrashed(req.params.boardId, req.userId);
  // false when the board was restored after it was looked up
  if (!(await destroyBoard(board._id))) {
    throw new HttpError(409, "This board was restored just now, so it wasn't deleted.");
  }
  res.status(204).end();
}

export async function emptyTrash(req: Request, res: Response) {
  const boards = await Board.find({ owner: req.userId, deletedAt: { $ne: null } }).select("_id");
  await Promise.all(boards.map((board) => destroyBoard(board._id)));
  res.status(204).end();
}

const reload = (board: Pick<BoardDoc, "_id">) =>
  Board.findById(board._id).select("-elements").populate<PopulatedMembers>(populateMembers);

export async function addCollaborator(req: BoardRequest<{ email?: unknown }>, res: Response) {
  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can invite people.");
  }

  const email = String(req.body?.email ?? "")
    .trim()
    .toLowerCase();
  if (!email) throw new HttpError(400, "Enter the email address of the person to invite.");

  const invitee = await User.findOne({ email });
  if (!invitee) {
    throw new HttpError(404, "No account uses that email yet. Ask them to sign up, then invite them again.");
  }
  if (idOf(invitee) === idOf(board.owner)) {
    throw new HttpError(400, "You already own this board.");
  }
  // anyone can sign up with any address, so only an address shown to be theirs gets boards shared with it (needs email
  // set up to send the link)
  if (emailConfigured() && !invitee.emailVerified) {
    throw new HttpError(
      409,
      "That person hasn't verified their email yet. Ask them to click the link we sent them (or send a new one from Settings), then invite them again.",
    );
  }

  // one write that adds them only if they aren't there yet, so invites sent at once can't add or notify twice;
  // `updatedAt` stays, as sharing isn't editing
  const added = await Board.updateOne(
    { _id: board._id, deletedAt: null, collaborators: { $ne: invitee._id } },
    { $addToSet: { collaborators: invitee._id } },
    { timestamps: false },
  );
  if (added.modifiedCount === 0) {
    if (!(await Board.exists({ _id: board._id, deletedAt: null }))) {
      throw new HttpError(404, "This board doesn't exist or has been deleted.");
    }
    throw new HttpError(409, `${invitee.name} already has access.`);
  }
  const updated = (await reload(board))!;

  await syncAccess(updated);
  await notify({ users: [invitee._id], type: "invite", actor: updated.owner, board: updated });
  res.status(201).json({ board: serializeMeta(updated) } satisfies Api.BoardMetaReply);
}

// The owner is notified with the asker's email, which the notification's link fills into the Share dialog. An unread
// request isn't sent again. With email set up, only a verified owner is emailed (only an address shown to be theirs is
// sent the asker's).
export async function requestAccess(req: BoardRequest, res: Response) {
  const { boardId } = req.params;
  const board = mongoose.isValidObjectId(boardId)
    ? await Board.findOne({ _id: boardId, deletedAt: null }).select(`${ACCESS_FIELDS} title`)
    : null;
  if (!board) throw new HttpError(404, "This board doesn't exist or has been deleted.");
  if (isMemberRole(roleOf(board, req.userId))) throw new HttpError(409, "You already have access to this board.");
  const user = await User.findById(req.userId);
  if (!user) throw new HttpError(401, "Log in to ask for access.");
  // the owner couldn't invite an unconfirmed address (see addCollaborator), so asking would get nowhere
  if (emailConfigured() && !user.emailVerified) {
    throw new HttpError(409, "Confirm your email address first (see Settings), so the owner can invite you.");
  }
  const notified = await notify({ users: [board.owner], type: "access", actor: user, board, excerpt: user.email });
  res.status(204).end();
  if (notified.length === 0 || !emailConfigured()) return;
  const owner = await User.findById(board.owner).select("name email emailVerified");
  if (!owner?.emailVerified) return;
  // after the answer, as in auth.controller: a slow or failing mail service doesn't hold up the request
  sendAccessRequestEmail(owner, user, board, emailLinkUrlFor(req)).catch((error: Error) =>
    console.error(`Couldn't send the access request email: ${error.message}`),
  );
}

export async function removeCollaborator(req: Request<{ boardId: string; userId: string }>, res: Response) {
  const removingSelf = req.params.userId === "me" || req.params.userId === String(req.userId);
  const targetId = removingSelf ? String(req.userId) : req.params.userId;
  if (!mongoose.isValidObjectId(targetId)) throw new HttpError(404, "That person isn't on this board.");

  const board = await findBoardForMember(req.params.boardId, req.userId);
  if (!removingSelf && !isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the owner can remove people.");
  }
  if (isOwner(board, targetId)) {
    throw new HttpError(400, "The owner can't leave their own board. Delete it instead.");
  }

  // one write that takes them off (and drops their star), so removals sent at once can't clash
  const removed = await Board.updateOne(
    { _id: board._id, collaborators: targetId },
    { $pull: { collaborators: targetId, starredBy: targetId } },
    { timestamps: false },
  );
  if (removed.modifiedCount === 0) throw new HttpError(404, "That person isn't on this board.");
  // forget their filing too, so a board with an open link doesn't linger on their dashboard
  await BoardState.deleteOne({ user: targetId, board: board._id });

  const updated = (await reload(board))!;
  await syncAccess(updated);
  // someone who left may still see the board through its link, so they get what any visitor would
  res.json({ board: serializeMeta(updated, { redact: removingSelf }) } satisfies Api.BoardMetaReply);
}
