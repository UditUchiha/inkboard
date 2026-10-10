import { COORDINATE_LIMIT } from "@inkboard/shared/element-rules";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.ts";
import { Notification } from "../models/notification.model.ts";
import { Thread } from "../models/thread.model.ts";
import { User } from "../models/user.model.ts";
import { emitToSignedIn } from "../realtime/index.js";
import {
  canEdit,
  findBoardForViewing,
  idOf,
  isOwner,
  PERSON_FIELDS,
  roleOf,
  serializePerson,
} from "../services/boards.ts";
import { notify } from "../services/notifications.ts";

// Comment threads pinned to the canvas. Anyone signed in who can open the board
// can read them; people who can edit it can comment. Members can be @mentioned.

const populateThread = [
  { path: "author", select: PERSON_FIELDS },
  { path: "messages.author", select: PERSON_FIELDS },
  { path: "messages.mentions", select: PERSON_FIELDS },
];

function serializeThread(thread) {
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
        author: serializePerson(message.author),
        body: message.body,
        mentions: message.mentions.filter(Boolean).map(serializePerson),
        createdAt: message.createdAt,
      })),
  };
}

async function openBoard(req, { toComment = false } = {}) {
  const board = await findBoardForViewing(req.params.boardId, req.userId);
  if (toComment && !canEdit(roleOf(board, req.userId))) {
    throw new HttpError(403, "Only people who can edit this board can comment on it.");
  }
  return board;
}

async function findThread(board, threadId) {
  const thread = mongoose.isValidObjectId(threadId) ? await Thread.findOne({ _id: threadId, board: board._id }) : null;
  if (!thread) throw new HttpError(404, "That comment was deleted.");
  return thread;
}

// A thread is one document, so what goes into it is bounded: 2,000 characters a message, this many messages.
const MAX_MESSAGES = 200;

function readBody(value) {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new HttpError(400, "Write a comment first.");
  if (body.length > 2000) throw new HttpError(400, "Keep comments under 2,000 characters.");
  return body;
}

// Only the board's members can be mentioned, since only they are notified.
function readMentions(board, ids) {
  if (!Array.isArray(ids)) return [];
  const members = new Set([idOf(board.owner), ...board.collaborators.map(idOf)]);
  return [...new Set(ids.map(String))].filter((id) => members.has(id));
}

async function publish(board, thread) {
  await thread.populate(populateThread);
  const payload = serializeThread(thread);
  emitToSignedIn(board.id, "thread:upsert", payload);
  return payload;
}

// Where a thread was placed: a number the board's drawings could be at.
function readCoordinate(value) {
  const coordinate = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(coordinate) || Math.abs(coordinate) > COORDINATE_LIMIT) {
    throw new HttpError(400, "Choose where to place the comment.");
  }
  return coordinate;
}

async function notifyAbout(board, thread, { actor, body, mentions }) {
  await notify({ users: mentions, type: "mention", actor, board, thread: thread._id, excerpt: body });
  // Everyone else who took part in the thread hears about replies, unless they can't open the board any more.
  const mentioned = new Set(mentions);
  const participants = thread.messages
    .map((message) => idOf(message.author))
    .filter((id) => !mentioned.has(id) && roleOf(board, id));
  await notify({ users: participants, type: "reply", actor, board, thread: thread._id, excerpt: body });
}

export async function listThreads(req, res) {
  const board = await openBoard(req);
  const threads = await Thread.find({ board: board._id }).sort({ createdAt: 1 }).populate(populateThread);
  res.json({ threads: threads.map(serializeThread) });
}

export async function createThread(req, res) {
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
  const actor = await User.findById(req.userId);
  await notify({ users: mentions, type: "mention", actor, board, thread: thread._id, excerpt: body });
  res.status(201).json({ thread: payload });
}

export async function replyToThread(req, res) {
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
  const actor = await User.findById(req.userId);
  await notifyAbout(board, { _id: thread._id, messages: previous }, { actor, body, mentions });
  res.status(201).json({ thread: payload });
}

export async function updateThread(req, res) {
  const board = await openBoard(req, { toComment: true });
  const thread = await findThread(board, req.params.threadId);
  if (typeof req.body?.resolved === "boolean") thread.resolved = req.body.resolved;
  for (const key of ["x", "y"]) {
    if (req.body?.[key] !== undefined) thread[key] = readCoordinate(req.body[key]);
  }
  await thread.save();
  res.json({ thread: await publish(board, thread) });
}

export async function deleteThread(req, res) {
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
