import { getSession } from "./sessions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { io, personOf, broadcastPresence } from "./hub.ts";
import { cleanGuestName } from "./identity.ts";
import { announceClassroom } from "./modes.ts";

// Who is where: pointers, views and following, presenting, and a guest's name.

const finite = (value: unknown) => Number.isFinite(Number(value));

export function registerPresence(socket: RealtimeSocket, limits: SocketLimits) {
  socket.on("cursor", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.cursor()) return;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const visible = Number.isFinite(x) && Number.isFinite(y);
    const laser = payload?.laser === true ? { laser: true as const } : {};
    socket
      .to(boardId)
      .volatile.emit("cursor", visible ? { socketId: socket.id, x, y, ...laser } : { socketId: socket.id });
  });

  socket.on("viewport", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.viewport()) return;
    if (!(["x", "y", "zoom", "width", "height"] as const).every((key) => finite(payload?.[key]))) return;
    const zoom = Number(payload!.zoom);
    if (zoom <= 0) return;
    // `source`: whose own view this is, when taken from someone they follow (see useBoardSync)
    const source = typeof payload!.source === "string" && payload!.source.length <= 64 ? payload!.source : socket.id;
    socket.to(boardId).volatile.emit("viewport", {
      boardId,
      socketId: socket.id,
      source,
      x: Number(payload!.x),
      y: Number(payload!.y),
      zoom,
      width: Number(payload!.width),
      height: Number(payload!.height),
    });
  });

  // someone started following this person: they send their view right away
  socket.on("viewport:request", (payload) => {
    const boardId = socket.data.boardId;
    if (!limits.followRequest()) return;
    const target = io.sockets.sockets.get(String(payload?.socketId ?? ""));
    if (boardId && target?.data.boardId === boardId) target.emit("viewport:request", { boardId });
  });

  // the others follow the presenter's view (see useFollow)
  socket.on("present", async (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.present()) return;
    socket.data.presenting = payload?.on === true;
    await broadcastPresence(boardId);
  });

  socket.on("guest:rename", async (payload) => {
    if (socket.data.user) return;
    socket.data.guest!.name = cleanGuestName(payload?.name);
    if (!socket.data.boardId) return;
    // a frame they claimed in classroom mode shows their new name
    const session = getSession(socket.data.boardId);
    const { userId, name } = personOf(socket);
    const claims = session?.classroom?.claims;
    if (session && claims && [...claims.values()].some((claim) => claim.by === userId)) {
      for (const [frameId, claim] of claims) if (claim.by === userId) claims.set(frameId, { ...claim, name });
      announceClassroom(session);
    }
    await broadcastPresence(socket.data.boardId);
  });
}
