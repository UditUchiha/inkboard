import type { NotificationItem, NotificationType } from "@inkboard/shared/api";
import type { Participant } from "@inkboard/shared/socket";
import type { Types } from "mongoose";
import { Board } from "../models/board.model.ts";
import { Notification } from "../models/notification.model.ts";
import { notifyUser } from "../realtime/index.ts";
import { idOf, serializePerson } from "./boards.ts";
import type { BoardDoc, Person, Ref } from "./boards.ts";

type NotifiedBoard = Pick<BoardDoc, "_id" | "title">;

interface Links {
  actor: Person;
  board: NotifiedBoard;
}

interface Held {
  actor?: Person | Types.ObjectId | null;
  board: NotifiedBoard | Types.ObjectId;
}

type NotificationRow = Pick<
  InstanceType<typeof Notification>,
  "id" | "type" | "read" | "createdAt" | "excerpt" | "thread" | "actorName"
>;

// the actor and board arrive as ids or populated; the second argument's are used when given (a notification just created, see notify)
export function serializeNotification(
  notification: NotificationRow & Held,
  { actor = notification.actor, board = notification.board }: Partial<Held> = {},
): NotificationItem {
  return {
    id: notification.id,
    type: notification.type as NotificationType,
    read: notification.read,
    createdAt: notification.createdAt,
    excerpt: notification.excerpt as string | null,
    thread: notification.thread ? String(notification.thread) : null,
    // a guest (suggesting without an account) is known only by the name they went by
    actor: actor
      ? serializePerson(actor as Person)
      : { id: "guest", name: notification.actorName ?? "Someone", color: null, avatarUrl: null },
    board: { id: idOf(board), title: (board as NotifiedBoard).title },
  };
}

// they also expire after 60 days (see the model), but anyone can invite or mention someone as often as they like, and listing reads them all
export const MAX_NOTIFICATIONS_PER_PERSON = 500;

async function trimNotifications(userIds: string[]) {
  await Promise.all(
    userIds.map(async (user) => {
      const extra = await Notification.find({ user })
        .sort({ createdAt: -1 })
        .skip(MAX_NOTIFICATIONS_PER_PERSON)
        .select("_id")
        .lean();
      if (extra.length > 0) await Notification.deleteMany({ _id: { $in: extra.map((old) => old._id) } });
    }),
  );
}

// While an earlier notification about suggestions on the board is unread, no other is sent, whoever suggests.
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
  const actor = author.guest
    ? null
    : ({
        _id: author.userId,
        name: author.name,
        color: author.color,
        avatarUrl: author.avatarUrl,
      } as unknown as Person);
  notifyUser(String(board.owner), serializeNotification(notification, { actor, board }));
  await trimNotifications([String(board.owner)]);
}

// Warns about what people from its link did there (see realtime/link-watch.ts); `excerpt` says what. Not resent while one of the same kind about the board is unread.
export async function warnOwner(boardId: string, type: "visitors" | "removals", excerpt: string) {
  const board = await Board.findById(boardId).select("title owner").lean();
  if (!board) return;
  if (await Notification.exists({ user: board.owner, type, board: board._id, read: false })) return;
  // named for whom it's about, as a guest is: the list leaves out notifications with no one behind them
  const notification = await Notification.create({
    user: board.owner,
    type,
    actorName: "People from its edit link",
    board: board._id,
    excerpt,
  });
  notifyUser(String(board.owner), serializeNotification(notification, { actor: null, board }));
  await trimNotifications([String(board.owner)]);
}

const EXCERPT_LENGTH = 140;

const excerptOf = (body: string) => body.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH);

interface Notify extends Links {
  users: Ref[];
  type: string;
  thread?: Types.ObjectId | null;
  excerpt?: string | null;
}

// Not sent to someone who hasn't read an earlier one of the same kind from the same person about the same board and
// thread, so inviting, removing and inviting again, or a burst of replies, doesn't pile up. Resolves with the ids notified.
export async function notify({ users, type, actor, board, thread = null, excerpt = null }: Notify) {
  const candidates = [...new Set(users.map(idOf))].filter((id) => id !== idOf(actor));
  if (candidates.length === 0) return [];
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
  if (recipients.length === 0) return [];
  const created = await Notification.insertMany(
    recipients.map((user) => ({
      user,
      type,
      actor: actor._id,
      board: board._id,
      thread,
      // an email address is kept whole, so the owner can invite the person who asked
      excerpt: excerpt && (type === "access" ? excerpt : excerptOf(excerpt)),
    })),
  );
  for (const notification of created) {
    notifyUser(idOf(notification.user), serializeNotification(notification, { actor, board }));
  }
  await trimNotifications(recipients);
  return recipients;
}
