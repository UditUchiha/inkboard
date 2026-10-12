import type { NotificationItem, NotificationType } from "@inkboard/shared/api";
import type { Participant } from "@inkboard/shared/socket";
import type { Types } from "mongoose";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { notifyUser } from "../realtime/index.ts";
import { idOf, serializePerson } from "./boards.ts";
import type { BoardDoc, Person, Ref } from "./boards.ts";

/** The board a notification is about, as far as it shows it. */
type NotifiedBoard = Pick<BoardDoc, "_id" | "title">;

/** The person and the board a notification is about, looked up. */
interface Links {
  actor: Person;
  board: NotifiedBoard;
}

/** The same as a notification holds them: looked up (populated), or only their ids. A guest is no one (null). */
interface Held {
  actor?: Person | Types.ObjectId | null;
  board: NotifiedBoard | Types.ObjectId;
}

/** What serializeNotification reads of a notification itself. */
type NotificationRow = Pick<
  InstanceType<typeof Notification>,
  "id" | "type" | "read" | "createdAt" | "excerpt" | "thread" | "actorName"
>;

// A notification holds its actor and board as ids, or as the people and boards themselves once populated. The
// ones in the second argument are used when given, as for a notification just created (see notify), and otherwise the populated ones.
export function serializeNotification(
  notification: NotificationRow & Held,
  { actor = notification.actor, board = notification.board }: Partial<Held> = {},
): NotificationItem {
  return {
    id: notification.id,
    // The schema only lets the kinds there are through, which Mongoose reads as a string.
    type: notification.type as NotificationType,
    read: notification.read,
    createdAt: notification.createdAt,
    // The schema fills in null when there is no excerpt, which the type can't see.
    excerpt: notification.excerpt as string | null,
    thread: notification.thread ? String(notification.thread) : null,
    // Without them, a notification that is read back has been populated, which the type can't know. A guest
    // (someone suggesting changes without an account) is known only by the name they went by.
    actor: actor
      ? serializePerson(actor as Person)
      : { id: "guest", name: notification.actorName ?? "Someone", color: null, avatarUrl: null },
    board: { id: idOf(board), title: (board as NotifiedBoard).title },
  };
}

/**
 * Tells a board's owner that `author` suggested changes on it (see docs/suggest-mode.md). While an earlier
 * notification about suggestions on the board is still unread, they aren't sent another, whoever suggests.
 */
export async function notifySuggestion(boardId: string, author: Participant) {
  const board = await Board.findById(boardId).select("title owner").lean();
  if (!board || (!author.guest && author.userId === String(board.owner))) return;
  const waiting = await Notification.exists({ user: board.owner, type: "suggestion", board: board._id, read: false });
  if (waiting) return;
  const notification = await Notification.create({
    user: board.owner,
    type: "suggestion",
    actor: author.guest ? null : author.userId,
    actorName: author.name,
    board: board._id,
  });
  // A signed-in author as a person (the notification holds only their id); a guest as no one.
  const actor = author.guest
    ? null
    : ({
        _id: author.userId,
        name: author.name,
        color: author.color,
        avatarUrl: author.avatarUrl,
      } as unknown as Person);
  notifyUser(String(board.owner), serializeNotification(notification, { actor, board }));
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
      // An email address is kept whole, so the owner can invite the person who asked.
      excerpt: excerpt && (type === "access" ? excerpt : excerptOf(excerpt)),
    })),
  );
  for (const notification of created) {
    notifyUser(idOf(notification.user), serializeNotification(notification, { actor, board }));
  }
}
