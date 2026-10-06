import mongoose from "mongoose";
import { Notification } from "../models/notification.model.js";
import { PERSON_FIELDS } from "../services/boards.js";
import { serializeNotification } from "../services/notifications.js";

export async function listNotifications(req, res) {
  const notifications = await Notification.find({ user: req.userId })
    .sort({ createdAt: -1 })
    .limit(30)
    .populate("actor", PERSON_FIELDS)
    .populate("board", "title deletedAt");
  // Skip notifications about boards or people that are gone.
  const visible = notifications.filter((n) => n.actor && n.board && !n.board.deletedAt);
  const unread = await Notification.countDocuments({ user: req.userId, read: false });
  res.json({ notifications: visible.map((n) => serializeNotification(n)), unread });
}

/** Marks the given notifications as read, or all of them when no ids are sent. */
export async function markRead(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(mongoose.isValidObjectId) : null;
  await Notification.updateMany(
    ids ? { user: req.userId, _id: { $in: ids } } : { user: req.userId, read: false },
    { $set: { read: true } },
  );
  res.status(204).end();
}
