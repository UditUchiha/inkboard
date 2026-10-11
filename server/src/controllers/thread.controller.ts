import type * as Api from "@inkboard/shared/api";
import { COORDINATE_LIMIT } from "@inkboard/shared/element-rules";
import { MAX_THREADS_PER_BOARD, REACTION_EMOJI } from "@inkboard/shared/limits";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { Notification } from "../models/notification.model.ts";
import { Thread } from "../models/thread.model.ts";
import { User } from "../models/user.model.ts";
import { emitToSignedIn } from "../realtime/index.ts";
import {
  canEdit,
  findBoardForViewing,
  idOf,
  isOwner,
  PERSON_FIELDS,
  roleOf,
  serializePerson,
} from "../services/boards.ts";
import type { Person, Ref } from "../services/boards.ts";
import { notify } from "../services/notifications.ts";
import type { BoardRequest } from "./board.controller.ts";

// Comment threads pinned to the canvas. Anyone signed in who can open the board can read them, comment
// and react, people who only view it by its link too. People who can edit the board, and whoever started
// a thread, can resolve and move it. Members can be @mentioned.

const populateThread = [
  { path: "author", select: PERSON_FIELDS },
  { path: "messages.author", select: PERSON_FIELDS },
  { path: "messages.mentions", select: PERSON_FIELDS },
  { path: "messages.reactions.user", select: PERSON_FIELDS },
];

type ThreadDoc = InstanceType<typeof Thread>;

/** A request for one of a board's comment threads, named by the `:threadId` in the route. */
type ThreadRequest<Body = unknown> = Request<{ boardId: string; threadId: string }, unknown, Body | undefined>;

/** The board a thread is on, as `openBoard` finds it. */
type OpenBoard = Awaited<ReturnType<typeof findBoardForViewing>>;

/** A message once populateThread has filled in who wrote it and who it mentions. Accounts that are gone come out as null. */
interface PopulatedMessage {
  id: string;
  author: Person | null;
  body: string;
  mentions: (Person | null)[];
  reactions: { emoji: string; user: Person | null }[];
  createdAt: Date;
}

/** What populateThread turns a thread's people into. */
interface PopulatedPeople {
  author: Person;
  messages: PopulatedMessage[];
}

// A message's reactions by emoji, in the order the picker shows them, with the people whose accounts remain.
function reactionsOf(message: Pick<PopulatedMessage, "reactions">): Api.Reaction[] {
  return REACTION_EMOJI.map((emoji) => ({
    emoji,
    people: message.reactions
      .filter((reaction) => reaction.emoji === emoji && reaction.user)
      .map((reaction) => serializePerson(reaction.user!)), // the filter above left only those with one
  })).filter((reaction) => reaction.people.length > 0);
}

function serializeThread(
  thread: Pick<ThreadDoc, "id" | "x" | "y" | "resolved" | "createdAt"> & PopulatedPeople,
): Api.Thread {
  return {
    id: thread.id,
    x: thread.x,
    y: thread.y,
    resolved: thread.resolved,
    author: serializePerson(thread.author),
    createdAt: thread.createdAt,
    messages: thread.messages
      .filter((message) => message.author)
      .map((message) => ({
        id: message.id,
        author: serializePerson(message.author!), // the filter above left only the messages that have one
        body: message.body,
        // filter(Boolean) drops the mentions of accounts that are gone, which the type can't see.
        mentions: (message.mentions.filter(Boolean) as Person[]).map(serializePerson),
        reactions: reactionsOf(message),
        createdAt: message.createdAt,
      })),
  };
}

// Everyone signed in who can open the board (`requireAuth` comes first) may read, comment and react.
const openBoard = (req: BoardRequest) => findBoardForViewing(req.params.boardId, req.userId);

async function findThread(board: Pick<OpenBoard, "_id">, threadId: string) {
  const thread = mongoose.isValidObjectId(threadId) ? await Thread.findOne({ _id: threadId, board: board._id }) : null;
  if (!thread) throw new HttpError(404, "That comment was deleted.");
  return thread;
}

// A thread is one document, so what goes into it is bounded: 2,000 characters a message, this many messages.
const MAX_MESSAGES = 200;

function readBody(value: unknown) {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new HttpError(400, "Write a comment first.");
  if (body.length > 2000) throw new HttpError(400, "Keep comments under 2,000 characters.");
  return body;
}

// Only the board's members can be mentioned, since only they are notified.
function readMentions(board: OpenBoard, ids: unknown) {
  if (!Array.isArray(ids)) return [];
  const members = new Set([idOf(board.owner), ...board.collaborators.map(idOf)]);
  return [...new Set(ids.map(String))].filter((id) => members.has(id));
}

async function publish(board: OpenBoard, thread: ThreadDoc) {
  await thread.populate(populateThread);
  // `populate` fills in the people on the thread itself, which the types can't see.
  const payload = serializeThread(thread as ThreadDoc & PopulatedPeople);
  emitToSignedIn(board.id, "thread:upsert", payload);
  return payload;
}

// Where a thread was placed: a number the board's drawings could be at.
function readCoordinate(value: unknown) {
  const coordinate = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(coordinate) || Math.abs(coordinate) > COORDINATE_LIMIT) {
    throw new HttpError(400, "Choose where to place the comment.");
  }
  return coordinate;
}

async function notifyAbout(
  board: OpenBoard,
  thread: Pick<ThreadDoc, "_id"> & { messages: { author: Ref }[] },
  { actor, body, mentions }: { actor: Person; body: string; mentions: string[] },
) {
  await notify({ users: mentions, type: "mention", actor, board, thread: thread._id, excerpt: body });
  // Everyone else who took part in the thread hears about replies, unless they can't open the board any more.
  const mentioned = new Set(mentions);
  const participants = thread.messages
    .map((message) => idOf(message.author))
    .filter((id) => !mentioned.has(id) && roleOf(board, id));
  await notify({ users: participants, type: "reply", actor, board, thread: thread._id, excerpt: body });
}

export async function listThreads(req: BoardRequest, res: Response) {
  const board = await openBoard(req);
  const threads = await Thread.find({ board: board._id })
    .sort({ createdAt: 1 })
    .populate<PopulatedPeople>(populateThread);
  res.json({ threads: threads.map(serializeThread) } satisfies Api.ThreadListReply);
}

export async function createThread(
  req: BoardRequest<{ x?: unknown; y?: unknown; body?: unknown; mentions?: unknown }>,
  res: Response,
) {
  const board = await openBoard(req);
  const x = readCoordinate(req.body?.x);
  const y = readCoordinate(req.body?.y);
  const body = readBody(req.body?.body);
  const mentions = readMentions(board, req.body?.mentions);
  // Anyone with a view link can comment, so a board's threads are bounded too.
  if ((await Thread.countDocuments({ board: board._id })) >= MAX_THREADS_PER_BOARD) {
    throw new HttpError(
      400,
      `This board has ${MAX_THREADS_PER_BOARD} comment threads, the most it can hold. Delete some to make room.`,
    );
  }

  const thread = await Thread.create({
    board: board._id,
    author: req.userId,
    x,
    y,
    messages: [{ author: req.userId, body, mentions }],
  });
  const payload = await publish(board, thread);
  // `requireAuth` found this account moments ago.
  const actor = (await User.findById(req.userId))!;
  await notify({ users: mentions, type: "mention", actor, board, thread: thread._id, excerpt: body });
  res.status(201).json({ thread: payload } satisfies Api.ThreadReply);
}

export async function replyToThread(req: ThreadRequest<{ body?: unknown; mentions?: unknown }>, res: Response) {
  const board = await openBoard(req);
  const thread = await findThread(board, req.params.threadId);
  const body = readBody(req.body?.body);
  const mentions = readMentions(board, req.body?.mentions);
  if (thread.messages.length >= MAX_MESSAGES) {
    throw new HttpError(400, `This thread has reached its limit of ${MAX_MESSAGES} messages. Start a new one.`);
  }

  const previous = thread.messages.map((message) => message.toObject());
  thread.messages.push({ author: req.userId, body, mentions });
  thread.resolved = false;
  await thread.save();

  const payload = await publish(board, thread);
  const actor = (await User.findById(req.userId))!; // as in createThread
  await notifyAbout(board, { _id: thread._id, messages: previous }, { actor, body, mentions });
  res.status(201).json({ thread: payload } satisfies Api.ThreadReply);
}

export async function updateThread(
  req: ThreadRequest<{ resolved?: unknown; x?: unknown; y?: unknown }>,
  res: Response,
) {
  const board = await openBoard(req);
  const thread = await findThread(board, req.params.threadId);
  if (!canEdit(roleOf(board, req.userId)) && idOf(thread.author) !== String(req.userId)) {
    throw new HttpError(
      403,
      "Only people who can edit this board, or who started this thread, can resolve or move it.",
    );
  }
  if (typeof req.body?.resolved === "boolean") thread.resolved = req.body.resolved;
  for (const key of ["x", "y"] as const) {
    if (req.body?.[key] !== undefined) thread[key] = readCoordinate(req.body[key]);
  }
  await thread.save();
  res.json({ thread: await publish(board, thread) } satisfies Api.ThreadReply);
}

export async function deleteThread(req: ThreadRequest, res: Response) {
  const board = await openBoard(req);
  const thread = await findThread(board, req.params.threadId);
  if (idOf(thread.author) !== String(req.userId) && !isOwner(board, req.userId)) {
    throw new HttpError(403, "Only the person who started this thread or the board's owner can delete it.");
  }
  await thread.deleteOne();
  // What they pointed at is gone, so don't leave them in anyone's notification list.
  await Notification.deleteMany({ thread: thread._id });
  emitToSignedIn(board.id, "thread:delete", { id: thread.id });
  res.status(204).end();
}

/** A request about one message of a thread, named by the `:messageId` in the route. */
type MessageRequest<Body = unknown> = Request<
  { boardId: string; threadId: string; messageId: string },
  unknown,
  Body | undefined
>;

/** Adds the person's reaction to a message (`on: true`) or takes it away (`on: false`). */
export async function reactToMessage(req: MessageRequest<{ emoji?: unknown; on?: unknown }>, res: Response) {
  const board = await openBoard(req);
  const emoji = req.body?.emoji;
  // `includes` only compares, so it doesn't tell the types that a value that passes is one of the emoji.
  if (typeof emoji !== "string" || !REACTION_EMOJI.includes(emoji as (typeof REACTION_EMOJI)[number])) {
    throw new HttpError(400, `React with one of ${REACTION_EMOJI.join(" ")}.`);
  }
  const { threadId, messageId } = req.params;
  const found = mongoose.isValidObjectId(threadId) && mongoose.isValidObjectId(messageId);
  // One write, so reactions sent at the same moment can't undo each other.
  const reaction = { emoji, user: new mongoose.Types.ObjectId(String(req.userId)) };
  const changed = found
    ? await Thread.updateOne(
        { _id: threadId, board: board._id, "messages._id": messageId },
        req.body?.on === false
          ? { $pull: { "messages.$.reactions": reaction } }
          : { $addToSet: { "messages.$.reactions": reaction } },
      )
    : null;
  if (!changed?.matchedCount) throw new HttpError(404, "That comment was deleted.");
  const thread = await findThread(board, threadId);
  res.json({ thread: await publish(board, thread) } satisfies Api.ThreadReply);
}
