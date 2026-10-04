import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyToken } from "../lib/tokens.js";
import { User } from "../models/user.model.js";
import { findBoardForMember, serializeBoard } from "../services/boards.js";
import { sanitizeOperation } from "./operations.js";
import {
  closeSession,
  discardSession,
  flushAllSessions,
  getSession,
  openSession,
  updateSession,
} from "./sessions.js";

let io;

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigins },
    maxHttpBufferSize: 2e6,
  });
  io.use(authenticate);
  io.on("connection", handleConnection);
  return io;
}

export { flushAllSessions };

async function authenticate(socket, next) {
  try {
    const { sub } = verifyToken(socket.handshake.auth?.token ?? "");
    const user = await User.findById(sub);
    if (!user) throw new Error("User not found");
    socket.data.user = user.toPublic();
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

function handleConnection(socket) {
  socket.on("board:join", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = String(payload?.boardId ?? "");
    try {
      const board = await findBoardForMember(boardId, socket.data.user.id);
      await leaveBoard(socket);

      const session = openSession(boardId, board.elements);
      socket.join(boardId);
      socket.data.boardId = boardId;

      reply({ ok: true, board: serializeBoard(board, socket.data.user.id, session.elements) });
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
    const op = sanitizeOperation(payload?.op);
    if (!session || !op) return reply({ ok: false });

    updateSession(session, op);
    socket.to(boardId).emit("board:op", { op });
    reply({ ok: true });
  });

  socket.on("cursor", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId) return;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const visible = Number.isFinite(x) && Number.isFinite(y);
    socket
      .to(boardId)
      .volatile.emit("cursor", visible ? { socketId: socket.id, x, y } : { socketId: socket.id });
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
    sockets.map((s) => ({ socketId: s.id, userId: s.data.user.id, name: s.data.user.name })),
  );
}

// Hooks used by the REST API so open boards react to changes immediately.

export function getLiveElements(boardId) {
  return getSession(boardId)?.elements;
}

export function notifyMetaChanged(boardId, meta) {
  io?.to(boardId).emit("board:meta", meta);
}

export async function revokeAccess(boardId, userId) {
  if (!io) return;
  const sockets = await io.in(boardId).fetchSockets();
  const removed = sockets.filter((s) => s.data.user.id === String(userId));
  if (removed.length === 0) return;

  for (const remote of removed) {
    const socket = io.sockets.sockets.get(remote.id);
    socket?.emit("board:revoked");
    socket?.leave(boardId);
    if (socket) socket.data.boardId = null;
  }
  await handleDeparture(boardId);
}

export async function closeBoard(boardId) {
  if (!io) return;
  io.to(boardId).emit("board:deleted");
  const sockets = await io.in(boardId).fetchSockets();
  for (const remote of sockets) {
    const socket = io.sockets.sockets.get(remote.id);
    if (socket) socket.data.boardId = null;
  }
  io.in(boardId).socketsLeave(boardId);
  discardSession(boardId);
}
