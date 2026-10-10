import mongoose from "mongoose";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { PERSON_FIELDS, roleOf } from "../services/boards.js";
import { serializeNotification } from "../services/notifications.js";

const PAGE_SIZE = 30;

// The boards this person has notifications about and can still open. Notifications about any
// other board (deleted, or they were removed from it) are never shown or counted, so they
// can't leak the board's title or what was said on it.
async function openableBoards(userId) {
  const ids = await Notification.distinct("board", { user: userId });
  const boards = await Board.find({ _id: { $in: ids }, deletedAt: null }).select("owner collaborators linkAccess");
  return boards.filter((board) => roleOf(board, userId)).map((board) => board._id);
}

/** The newest notifications, 30 at a time: pass `before` (the id of the last one seen) for the next page. */
export async function listNotifications(req, res) {
  const boards = await openableBoards(req.userId);
  const before = mongoose.isValidObjectId(req.query.before) ? { _id: { $lt: req.query.before } } : {};
  const found = await Notification.find({ user: req.userId, board: { $in: boards }, ...before })
    .sort({ _id: -1 })
    .limit(PAGE_SIZE + 1)
    .populate("actor", PERSON_FIELDS)
    .populate("board", "title");
  const unread = await Notification.countDocuments({ user: req.userId, board: { $in: boards }, read: false });
  const page = found.slice(0, PAGE_SIZE);
  const more = found.length > PAGE_SIZE;
  res.json({
    // Skip notifications about people who are gone.
    notifications: page.filter((n) => n.actor).map((n) => serializeNotification(n)),
    more,
    // Where the next page starts (pass it as `before`): the oldest notification looked at, shown or
    // skipped, so a page whose every notification was skipped still moves on. Null on the last page.
    next: more ? page.at(-1).id : null,
    unread,
  });
}

/** Marks the given notifications as read, or all of them when no ids are sent. */
export async function markRead(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(mongoose.isValidObjectId) : null;
  await Notification.updateMany(ids ? { user: req.userId, _id: { $in: ids } } : { user: req.userId, read: false }, {
    $set: { read: true },
  });
  res.status(204).end();
}
