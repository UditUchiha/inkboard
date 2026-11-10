import type { Server as HttpServer } from "node:http";
import { createLimiter, LIMITS } from "./rate-limit.ts";
import { flushAllSessions } from "./sessions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { createHub, io } from "./hub.ts";
import { addressOf, authenticate } from "./identity.ts";
import { registerModes } from "./modes.ts";
import { registerSuggestions } from "./suggestion-events.ts";
import { registerOperations } from "./take-operation.ts";
import { registerRequests } from "./board-requests.ts";
import { registerPresence } from "./presence.ts";
import { registerJoinLeave } from "./join-leave.ts";

// Socket.IO entry: attaches the server, authenticates connections, and wires each area's handlers (one file per area).

export function attachRealtime(httpServer: HttpServer) {
  const server = createHub(httpServer);
  server.use(authenticate);
  server.on("connection", handleConnection);
  return server;
}

export { flushAllSessions };
export { heldGroupBytes } from "./held-groups.ts";
export { cleanGuestName } from "./identity.ts";
export { applyOperation } from "./take-operation.ts";
export {
  closeBoard,
  disconnectUser,
  emitToSignedIn,
  notifyMetaChanged,
  notifyUser,
  refreshUser,
  replaceElements,
  syncAccess,
  watchLinkExpiry,
} from "./hooks.ts";

// disconnecting saves what was still being written, hence the second flush
export async function closeRealtime() {
  await flushAllSessions();
  await io?.close();
  await flushAllSessions();
}

function handleConnection(socket: RealtimeSocket) {
  const limits: SocketLimits = Object.fromEntries(
    Object.entries(LIMITS).map(([name, limit]) => [name, createLimiter(limit)]),
  );
  socket.data.sender = socket.data.user ? `user:${socket.data.user.id}` : `address:${addressOf(socket)}`;
  // a private room per account, for notifications and profile changes
  if (socket.data.user) socket.join(`user:${socket.data.user.id}`);

  registerJoinLeave(socket);
  registerOperations(socket, limits);
  registerRequests(socket, limits);
  registerPresence(socket, limits);
  registerModes(socket, limits);
  registerSuggestions(socket, limits);
}
