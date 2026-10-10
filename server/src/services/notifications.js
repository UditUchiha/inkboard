import { Notification } from "../models/notification.model.ts";
import { notifyUser } from "../realtime/index.js";
import { idOf, serializePerson } from "./boards.js";

export function serializeNotification(notification, { actor = notification.actor, board = notification.board } = {}) {
  return {
    id: notification.id,
    type: notification.type,
    read: notification.read,
    createdAt: notification.createdAt,
    excerpt: notification.excerpt,
    thread: notification.thread ? String(notification.thread) : null,
    actor: serializePerson(actor),
    board: { id: idOf(board), title: board.title },
  };
}

const EXCERPT_LENGTH = 140;

// The one-line start of a comment, as notifications show it.
const excerptOf = (body) => body.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH);

/**
 * Notifies each person in `users` (except the actor) and pushes it to their open tabs.
 * Someone who still hasn't read an earlier one of the same kind from the same person
 * about the same board and thread isn't sent another, so inviting, removing and
 * inviting again, or a burst of replies, doesn't pile up.
 */
export async function notify({ users, type, actor, board, thread = null, excerpt = null }) {
  const candidates = [...new Set(users.map(idOf))].filter((id) => id !== idOf(actor));
  if (candidates.length === 0) return;
  const unread = await Notification.find({
    user: { $in: candidates },
    type,
    actor: actor._id,
    board: board._id,
    thread,
    read: false,
  })
    .select("user")
    .lean();
  const waiting = new Set(unread.map((notification) => String(notification.user)));
  const recipients = candidates.filter((id) => !waiting.has(id));
  if (recipients.length === 0) return;
  const created = await Notification.insertMany(
    recipients.map((user) => ({
      user,
      type,
      actor: actor._id,
      board: board._id,
      thread,
      excerpt: excerpt ? excerptOf(excerpt) : null,
    })),
  );
  for (const notification of created) {
    notifyUser(idOf(notification.user), serializeNotification(notification, { actor, board }));
  }
}
