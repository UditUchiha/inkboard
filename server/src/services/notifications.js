import { Notification } from "../models/notification.model.js";
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

/** Notifies each person in `users` (except the actor) and pushes it to their open tabs. */
export async function notify({ users, type, actor, board, thread = null, excerpt = null }) {
  const recipients = [...new Set(users.map(idOf))].filter((id) => id !== idOf(actor));
  if (recipients.length === 0) return;
  const created = await Notification.insertMany(
    recipients.map((user) => ({
      user,
      type,
      actor: actor._id,
      board: board._id,
      thread,
      excerpt: excerpt ? excerpt.slice(0, 140) : null,
    })),
  );
  for (const notification of created) {
    notifyUser(idOf(notification.user), serializeNotification(notification, { actor, board }));
  }
}
