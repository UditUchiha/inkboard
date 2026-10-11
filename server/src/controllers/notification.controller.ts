import type { NotificationPage } from "@inkboard/shared/api";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { ACCESS_FIELDS, PERSON_FIELDS, roleOf } from "../services/boards.ts";
import { serializeNotification } from "../services/notifications.ts";

const PAGE_SIZE = 30;

// Which of this person's notifications can be shown: those about boards they can still open, and the
// notice that a board they are invited to went to the trash (while it is there and they are still invited).
// Notifications about any other board (deleted, or they were removed from it) are never shown or counted,
// so they can't leak the board's title or what was said on it.
async function visibleNotifications(userId: string | undefined) {
  const ids = await Notification.distinct("board", { user: userId });
  const boards = await Board.find({ _id: { $in: ids }, purgingAt: null }).select(`${ACCESS_FIELDS} deletedAt`);
  const open = boards.filter((board) => !board.deletedAt && roleOf(board, userId)).map((board) => board._id);
  const trashed = boards.filter((board) => board.deletedAt && roleOf(board, userId) === "editor").map((b) => b._id);
  return { user: userId, $or: [{ board: { $in: open } }, { type: "trashed", board: { $in: trashed } }] };
}

/** The newest notifications, 30 at a time: pass `before` (the id of the last one seen) for the next page. */
export async function listNotifications(req: Request, res: Response) {
  const visible = await visibleNotifications(req.userId);
  const before = mongoose.isValidObjectId(req.query.before) ? { _id: { $lt: req.query.before } } : {};
  const found = await Notification.find({ ...visible, ...before })
    .sort({ _id: -1 })
    .limit(PAGE_SIZE + 1)
    .populate("actor", PERSON_FIELDS)
    .populate("board", "title");
  const unread = await Notification.countDocuments({ ...visible, read: false });
  const page = found.slice(0, PAGE_SIZE);
  const more = found.length > PAGE_SIZE;
  res.json({
    // Skip notifications about people who are gone. (A suggestion's maker can be a guest, who has no account.)
    notifications: page.filter((n) => n.actor || n.actorName).map((n) => serializeNotification(n)),
    more,
    // Where the next page starts (pass it as `before`): the oldest notification looked at, shown or
    // skipped, so a page whose every notification was skipped still moves on. Null on the last page.
    // `more` is only true when the page has notifications in it.
    next: more ? page.at(-1)!.id : null,
    unread,
  } satisfies NotificationPage);
}

/** Marks the given notifications as read, or all of them when no ids are sent. */
export async function markRead(req: Request<{}, unknown, { ids?: unknown } | undefined>, res: Response) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(mongoose.isValidObjectId) : null;
  await Notification.updateMany(ids ? { user: req.userId, _id: { $in: ids } } : { user: req.userId, read: false }, {
    $set: { read: true },
  });
  res.status(204).end();
}
