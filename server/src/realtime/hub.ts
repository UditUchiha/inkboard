import type { Server as HttpServer } from "node:http";
import type { Participant } from "@inkboard/shared/socket";
import { Server } from "socket.io";
import { env } from "../config/env.ts";
import { closeSession } from "./sessions.ts";
import type { RealtimeServer, RealtimeSocket } from "./types.ts";

// The Socket.IO server and what every area needs from it: who is connected where, and telling a board's room about it.

// the REST hooks use `io?.` because they can run before attachRealtime
export let io: RealtimeServer;

export function createHub(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigins },
    // room for an image (IMAGE_LIMITS.image), its small copy, and the message around them
    maxHttpBufferSize: 3e6,
    // big joins compress well; small messages (cursors, most changes) cost more to compress than they save
    perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 1 } },
  });
  return io;
}

export function personOf(socket: Pick<RealtimeSocket, "data">): Participant {
  const { user, guest } = socket.data;
  if (user) {
    return { userId: user.id, name: user.name, color: user.color, avatarUrl: user.avatarUrl, guest: false };
  }
  return { userId: guest!.id, name: guest!.name, color: null, avatarUrl: null, guest: true };
}

// the board id in a message may be the database's or the spelling the socket asked with (upper case, say)
export function isOnBoard(socket: RealtimeSocket, claimed: unknown) {
  const { boardId, requestedId } = socket.data;
  return Boolean(boardId) && (claimed === boardId || claimed === requestedId);
}

export async function handleDeparture(boardId: string) {
  if (!boardId) return;
  const remaining = io.sockets.adapter.rooms.get(boardId)?.size ?? 0;
  if (remaining === 0) {
    await closeSession(boardId);
  } else {
    await broadcastPresence(boardId);
  }
}

export async function broadcastPresence(boardId: string) {
  const sockets = await io.in(boardId).fetchSockets();
  // the board id comes second so older browsers, which expect just the list, still read it
  io.to(boardId).emit(
    "presence",
    sockets
      .filter((s) => !s.data.embed)
      .map((s) => ({ socketId: s.id, ...personOf(s), ...(s.data.presenting && { presenting: true }) })),
    { boardId },
  );
}

export function socketsIn(room: string) {
  const ids = io?.sockets.adapter.rooms.get(room) ?? [];
  // drops the ids of sockets that have gone since
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean) as RealtimeSocket[];
}
