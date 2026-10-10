import { COORDINATE_LIMIT } from "@inkboard/shared/element-rules";
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

// Comment threads pinned to the canvas. Anyone signed in who can open the board
// can read them; people who can edit it can comment. Members can be @mentioned.

const populateThread = [
  { path: "author", select: PERSON_FIELDS },
  { path: "messages.author", select: PERSON_FIELDS },
  { path: "messages.mentions", select: PERSON_FIELDS },
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
  createdAt: Date;
}

/** What populateThread turns a thread's people into. */
interface PopulatedPeople {
  author: Person;
  messages: PopulatedMessage[];
}

function serializeThread(thread: Pick<ThreadDoc, "id" | "x" | "y" | "resolved" | "createdAt"> & PopulatedPeople) {
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
        createdAt: message.createdAt,
      })),
  };
}

async function openBoard(req: BoardRequest, { toComment = false } = {}) {
  const board = await findBoardForViewing(req.params.boardId, req.userId);
  if (toComment && !canEdit(roleOf(board, req.userId))) {
    throw new HttpError(403, "Only people who can edit this board can comment on it.");
  }
  return board;
}

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
  res.json({ threads: threads.map(serializeThread) });
}

export async function createThread(
  req: BoardRequest<{ x?: unknown; y?: unknown; body?: unknown; mentions?: unknown }>,
  res: Response,
) {
  const board = await openBoard(req, { toComment: true });
  const x = readCoordinate(req.body?.x);
  const y = readCoordinate(req.body?.y);
  const body = readBody(req.body?.body);
  const mentions = readMentions(board, req.body?.mentions);

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
  res.status(201).json({ thread: payload });
}

export async function replyToThread(req: ThreadRequest<{ body?: unknown; mentions?: unknown }>, res: Response) {
  const board = await openBoard(req, { toComment: true });
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
  res.status(201).json({ thread: payload });
}

export async function updateThread(
  req: ThreadRequest<{ resolved?: unknown; x?: unknown; y?: unknown }>,
  res: Response,
) {
  const board = await openBoard(req, { toComment: true });
  const thread = await findThread(board, req.params.threadId);
  if (typeof req.body?.resolved === "boolean") thread.resolved = req.body.resolved;
  for (const key of ["x", "y"] as const) {
    if (req.body?.[key] !== undefined) thread[key] = readCoordinate(req.body[key]);
  }
  await thread.save();
  res.json({ thread: await publish(board, thread) });
}

export async function deleteThread(req: ThreadRequest, res: Response) {
  const board = await openBoard(req, { toComment: true });
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
