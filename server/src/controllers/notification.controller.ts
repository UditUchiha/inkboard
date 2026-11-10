import type { NotificationPage } from "@inkboard/shared/api";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { ACCESS_FIELDS, PERSON_FIELDS, roleOf } from "../services/boards.ts";
import { serializeNotification } from "../services/notifications.ts";

const PAGE_SIZE = 30;

// Notifications about boards they can no longer open (deleted, or they were removed) are never shown or counted, so
// they
// can't leak the board's title or what was said; the notice that a board they're invited to is in the trash is shown
// while it is.
async function visibleNotifications(userId: string | undefined) {
  const ids = await Notification.distinct("board", { user: userId });
  const boards = await Board.find({ _id: { $in: ids }, purgingAt: null }).select(`${ACCESS_FIELDS} deletedAt`);
  const open = boards.filter((board) => !board.deletedAt && roleOf(board, userId)).map((board) => board._id);
  const trashed = boards.filter((board) => board.deletedAt && roleOf(board, userId) === "editor").map((b) => b._id);
  return { user: userId, $or: [{ board: { $in: open } }, { type: "trashed", board: { $in: trashed } }] };
}

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
    // a suggestion's maker can be a guest, who has no account
    notifications: page.filter((n) => n.actor || n.actorName).map((n) => serializeNotification(n)),
    more,
    // the oldest notification looked at, shown or skipped, so a page whose every item was skipped still moves on; null
    // on the last page
    next: more ? page.at(-1)!.id : null,
    unread,
  } satisfies NotificationPage);
}

export async function markRead(req: Request<{}, unknown, { ids?: unknown } | undefined>, res: Response) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(mongoose.isValidObjectId) : null;
  await Notification.updateMany(ids ? { user: req.userId, _id: { $in: ids } } : { user: req.userId, read: false }, {
    $set: { read: true },
  });
  res.status(204).end();
}
