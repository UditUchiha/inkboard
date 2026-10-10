import type { Types } from "mongoose";
import { Notification } from "../models/notification.model.ts";
import { notifyUser } from "../realtime/index.js";
import { idOf, serializePerson } from "./boards.ts";
import type { BoardDoc, Person, Ref } from "./boards.ts";

/** The board a notification is about, as far as it shows it. */
type NotifiedBoard = Pick<BoardDoc, "_id" | "title">;

/** The person and the board a notification is about, looked up. */
interface Links {
  actor: Person;
  board: NotifiedBoard;
}

/** The same as a notification holds them: looked up (populated), or only their ids. */
interface Held {
  actor: Person | Types.ObjectId;
  board: NotifiedBoard | Types.ObjectId;
}

/** What serializeNotification reads of a notification itself. */
type NotificationRow = Pick<
  InstanceType<typeof Notification>,
  "id" | "type" | "read" | "createdAt" | "excerpt" | "thread"
>;

/** A notification as it is sent to the browser. */
export interface SerializedNotification {
  id: string;
  type: string;
  read: boolean;
  createdAt: Date;
  excerpt?: string | null;
  thread: string | null;
  actor: ReturnType<typeof serializePerson>;
  board: { id: string; title: string };
}

// A notification holds its actor and board as ids, or as the people and boards themselves once populated. The
// ones in the second argument are used when given, as for a notification just created (see notify), and otherwise the populated ones.
export function serializeNotification(
  notification: NotificationRow & Held,
  { actor = notification.actor, board = notification.board }: Partial<Held> = {},
): SerializedNotification {
  return {
    id: notification.id,
    type: notification.type,
    read: notification.read,
    createdAt: notification.createdAt,
    excerpt: notification.excerpt,
    thread: notification.thread ? String(notification.thread) : null,
    // Without them, a notification that is read back has been populated, which the type can't know.
    actor: serializePerson(actor as Person),
    board: { id: idOf(board), title: (board as NotifiedBoard).title },
  };
}

const EXCERPT_LENGTH = 140;

// The one-line start of a comment, as notifications show it.
const excerptOf = (body: string) => body.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH);

/** What notify is told: who to notify, and what about. */
interface Notify extends Links {
  users: Ref[];
  type: string;
  thread?: Types.ObjectId | null;
  excerpt?: string | null;
}

/**
 * Notifies each person in `users` (except the actor) and pushes it to their open tabs.
 * Someone who still hasn't read an earlier one of the same kind from the same person
 * about the same board and thread isn't sent another, so inviting, removing and
 * inviting again, or a burst of replies, doesn't pile up.
 */
export async function notify({ users, type, actor, board, thread = null, excerpt = null }: Notify) {
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
