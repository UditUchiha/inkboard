import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyToken } from "../lib/tokens.js";
import { Board } from "../models/board.model.js";
import { User } from "../models/user.model.js";
import {
  canEdit,
  findBoardForViewing,
  isMemberRole,
  recordOpen,
  roleOf,
  serializeBoard,
  serializeMeta,
} from "../services/boards.js";
import { detectImageType, IMAGE_LIMITS, storeImage } from "../services/images.js";
import { effectOf, planOperation } from "@inkboard/shared/board-merge";
import { prepareOperation, sanitizeOperation, SYNC_FORMAT } from "./operations.js";
import {
  closeSession,
  discardSession,
  flushAllSessions,
  getSession,
  admit,
  openSession,
  removedStamps,
  resetSession,
  restoreSaved,
  updateSession,
} from "./sessions.js";

let io;

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigins },
    // Room for an uploaded image (up to IMAGE_LIMITS.image), its small copy, and the message around them.
    maxHttpBufferSize: 3e6,
  });
  io.use(authenticate);
  io.on("connection", handleConnection);
  return io;
}

export { flushAllSessions };

const GUEST_ID = /^g_[a-z0-9]{6,32}$/i;

export function cleanGuestName(value) {
  const name = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
  return name || "Guest";
}

// Connecting without a token is allowed: guests can open boards whose link is
// shared. They pick a name (and keep a random id) so others can see who they are.
async function authenticate(socket, next) {
  const { token, guest } = socket.handshake.auth ?? {};
  if (!token) {
    socket.data.user = null;
    socket.data.guest = {
      id: GUEST_ID.test(String(guest?.id ?? "")) ? guest.id : `g_${socket.id.replace(/[^a-z0-9]/gi, "")}`,
      name: cleanGuestName(guest?.name),
    };
    return next();
  }
  try {
    const { sub } = verifyToken(token);
    const user = await User.findById(sub);
    if (!user) throw new Error("User not found");
    socket.data.user = user.toPublic();
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

function personOf(socket) {
  const { user, guest } = socket.data;
  if (user) {
    return { userId: user.id, name: user.name, color: user.color, avatarUrl: user.avatarUrl, guest: false };
  }
  return { userId: guest.id, name: guest.name, color: null, avatarUrl: null, guest: true };
}

const finite = (value) => Number.isFinite(Number(value));

// The small copy sent with an image for thumbnails, or null. It's optional:
// without one, thumbnails show the image itself, so a bad one is just dropped.
function readSmallCopy(data) {
  if (!Buffer.isBuffer(data) || data.length > IMAGE_LIMITS.small) return null;
  const mime = detectImageType(data);
  return mime ? { buffer: data, mime } : null;
}

// Why an image didn't fit, for the person who tried to add it.
function spaceMessage(limit, role) {
  const freeing = "Pictures you remove free their space once no saved version of the board shows them.";
  if (limit === "board") return `This board is out of image space. ${freeing}`;
  if (limit === "owner") {
    return role === "owner"
      ? `Your boards are out of image space. ${freeing}`
      : "This board's owner is out of image space. Ask them to remove pictures they don't need.";
  }
  return "Image storage is full for now. Try again later.";
}

function handleConnection(socket) {
  // A private room per account, for notifications and profile changes.
  if (socket.data.user) socket.join(`user:${socket.data.user.id}`);

  socket.on("board:join", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = String(payload?.boardId ?? "");
    try {
      const userId = socket.data.user?.id ?? null;
      const board = await findBoardForViewing(boardId, userId);
      await leaveBoard(socket);

      // The first person to open the board brings in what was removed from it lately, too.
      const removed = getSession(boardId)
        ? []
        : ((await Board.findById(boardId).select("removed").lean())?.removed ?? []);
      const session = openSession(boardId, board.elements, removed);
      socket.join(boardId);
      socket.data.boardId = boardId;
      socket.data.role = roleOf(board, userId);
      // Browsers still running an older version of the app merge changes by older rules (see prepareOperation).
      socket.data.legacy = payload?.sync !== SYNC_FORMAT;
      if (userId) recordOpen(userId, boardId);

      // With the stamps of what was removed lately, so a change to one of those
      // that's still on its way can't bring it back on this screen.
      reply({
        ok: true,
        board: serializeBoard(board, userId, session.elements),
        removed: removedStamps(session.tombstones),
      });
      await broadcastPresence(boardId);
    } catch (error) {
      if (!error.status) console.error(error);
      reply({
        ok: false,
        status: error.status ?? 500,
        error: error.status ? error.message : "This board couldn't be opened. Try again.",
      });
    }
  });

  socket.on("board:leave", () => leaveBoard(socket));

  socket.on("board:op", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    const session = boardId && payload?.boardId === boardId ? getSession(boardId) : null;
    if (session && !canEdit(socket.data.role)) return reply({ ok: false, readOnly: true });
    const sanitized = sanitizeOperation(payload?.op);
    if (!session || !sanitized) return reply({ ok: false });
    const op = prepareOperation(session.elements, sanitized, session.tombstones, { legacy: socket.data.legacy });
    const plan = planOperation(session.elements, op, session.tombstones);
    // What actually changes: edits that newer ones already replaced are left out.
    // Others are sent each element as the server now has it, merged.
    const effect = effectOf(plan);
    if (admit(session, { upsert: [...plan.shown.values()], remove: effect.remove }, [...plan.buried.values()])) {
      return reply({ ok: false, tooLarge: true });
    }

    const dropped = new Set(updateSession(session, plan));
    if (dropped.size > 0) effect.upsert = effect.upsert.filter((element) => !dropped.has(element.id));
    if (effect.upsert.length > 0 || effect.remove.length > 0) socket.to(boardId).emit("board:op", { op: effect });
    reply({ ok: true });
  });

  // Uploading goes over the socket, not HTTP, so it is checked exactly like a
  // drawing change: guests with an edit link can add images, viewers can't.
  socket.on("board:image", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    if (!boardId || payload?.boardId !== boardId) return reply({ ok: false, error: "Open the board first." });
    if (!canEdit(socket.data.role)) return reply({ ok: false, readOnly: true });

    const buffer = payload?.data;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0)
      return reply({ ok: false, error: "That file couldn't be read." });
    if (buffer.length > IMAGE_LIMITS.image)
      return reply({ ok: false, tooLarge: true, error: "That image is too big." });
    const mime = detectImageType(buffer);
    if (!mime) return reply({ ok: false, error: "Use a PNG, JPEG, WebP or GIF image." });

    try {
      const small = readSmallCopy(payload.small);
      const stored = await storeImage({ boardId, buffer, mime, small, uploadedBy: socket.data.user?.id });
      if (stored.missing) return reply({ ok: false, error: "This board doesn't exist any more." });
      if (stored.full)
        return reply({ ok: false, full: stored.full, error: spaceMessage(stored.full, socket.data.role) });
      reply({ ok: true, id: stored.id });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: "The image couldn't be saved. Try again." });
    }
  });

  socket.on("cursor", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId) return;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const visible = Number.isFinite(x) && Number.isFinite(y);
    socket.to(boardId).volatile.emit("cursor", visible ? { socketId: socket.id, x, y } : { socketId: socket.id });
  });

  // What part of the board someone is looking at, so others can follow along.
  socket.on("viewport", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !["x", "y", "zoom", "width", "height"].every((key) => finite(payload?.[key]))) return;
    const zoom = Number(payload.zoom);
    if (zoom <= 0) return;
    socket.to(boardId).volatile.emit("viewport", {
      socketId: socket.id,
      x: Number(payload.x),
      y: Number(payload.y),
      zoom,
      width: Number(payload.width),
      height: Number(payload.height),
    });
  });

  // Someone started following this person: ask them to send their view right away.
  socket.on("viewport:request", (payload) => {
    const boardId = socket.data.boardId;
    const target = io.sockets.sockets.get(String(payload?.socketId ?? ""));
    if (boardId && target?.data.boardId === boardId) target.emit("viewport:request");
  });

  socket.on("guest:rename", async (payload) => {
    if (socket.data.user) return;
    socket.data.guest.name = cleanGuestName(payload?.name);
    if (socket.data.boardId) await broadcastPresence(socket.data.boardId);
  });

  socket.on("disconnect", () => handleDeparture(socket.data.boardId));
}

async function leaveBoard(socket) {
  const boardId = socket.data.boardId;
  if (!boardId) return;
  socket.leave(boardId);
  socket.data.boardId = null;
  await handleDeparture(boardId);
}

async function handleDeparture(boardId) {
  if (!boardId) return;
  const remaining = io.sockets.adapter.rooms.get(boardId)?.size ?? 0;
  if (remaining === 0) {
    await closeSession(boardId);
  } else {
    await broadcastPresence(boardId);
  }
}

async function broadcastPresence(boardId) {
  const sockets = await io.in(boardId).fetchSockets();
  io.to(boardId).emit(
    "presence",
    sockets.map((s) => ({ socketId: s.id, ...personOf(s) })),
  );
}

function socketsIn(room) {
  const ids = io?.sockets.adapter.rooms.get(room) ?? [];
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

// Hooks used by the REST API so open boards react to changes immediately.

export function getLiveElements(boardId) {
  return getSession(boardId)?.elements;
}

// Each person gets the details their role allows: only members see email addresses.
export function notifyMetaChanged(board) {
  for (const socket of socketsIn(board.id)) {
    socket.emit("board:meta", serializeMeta(board, { redact: !isMemberRole(socket.data.role) }));
  }
}

/**
 * Re-checks everyone who has the board open after its access changed (an invite,
 * a removal, or the link setting): drops people who lost access, upgrades or
 * downgrades the rest, then sends fresh board details.
 */
export async function syncAccess(board) {
  if (!io) return;
  let dropped = false;
  for (const socket of socketsIn(board.id)) {
    const role = roleOf(board, socket.data.user?.id ?? null);
    if (!role) {
      socket.emit("board:revoked");
      socket.leave(board.id);
      socket.data.boardId = null;
      dropped = true;
    } else if (role !== socket.data.role) {
      socket.data.role = role;
      socket.emit("board:role", { role });
    }
  }
  if (dropped) await handleDeparture(board.id);
  notifyMetaChanged(board);
}

/**
 * Puts an earlier version's elements back on a board, for everyone who has it
 * open. Resolves with the board's elements as restored.
 */
export async function replaceElements(boardId, snapshot, actor) {
  const session = getSession(boardId);
  let elements;
  let removed;
  if (session) {
    elements = resetSession(session, snapshot);
    removed = removedStamps(session.tombstones);
  } else {
    const board = await Board.findById(boardId).select("+removed").lean();
    const saved = restoreSaved(board, snapshot);
    elements = saved.elements;
    removed = saved.removed.map(({ id, version, versionNonce }) => ({ id, version, versionNonce }));
    await Board.updateOne({ _id: boardId }, { $set: { elements, removed: saved.removed } });
  }
  io?.to(boardId).emit("board:reset", { elements, removed, by: actor?.name ?? null });
  return elements;
}

/** Comments are only shown to signed-in people. */
export function emitToSignedIn(boardId, event, payload) {
  for (const socket of socketsIn(boardId)) {
    if (socket.data.user) socket.emit(event, payload);
  }
}

export function notifyUser(userId, notification) {
  io?.to(`user:${userId}`).emit("notification", notification);
}

/** Someone changed their name or color: update their open connections and boards. */
export async function refreshUser(user) {
  const boards = new Set();
  for (const socket of socketsIn(`user:${user.id}`)) {
    socket.data.user = user.toPublic();
    if (socket.data.boardId) boards.add(socket.data.boardId);
  }
  await Promise.all([...boards].map(broadcastPresence));
}

/**
 * Sends everyone off a board that was deleted. A board moved to the trash keeps
 * its latest changes so it can be restored as it was.
 */
export async function closeBoard(boardId, { keepChanges = false } = {}) {
  if (!io) return;
  io.to(boardId).emit("board:deleted");
  const sockets = await io.in(boardId).fetchSockets();
  for (const remote of sockets) {
    const socket = io.sockets.sockets.get(remote.id);
    if (socket) socket.data.boardId = null;
  }
  io.in(boardId).socketsLeave(boardId);
  if (keepChanges) await closeSession(boardId);
  else discardSession(boardId);
}
