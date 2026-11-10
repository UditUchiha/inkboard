import type { NotificationItem, PublicUser, Thread } from "@inkboard/shared/api";
import type { ThreadRemoval } from "@inkboard/shared/socket";
import type { Element } from "@inkboard/shared/types";
import { isMemberRole, linkLock, populateMembers, roleOf, serializeMeta } from "../services/boards.ts";
import type { PopulatedMembers } from "../services/boards.ts";
import { Board } from "../models/board.model.ts";
import { acquireSession, closeSession, discardSession, getSession, removedStamps, resetSession } from "./sessions.ts";
import { settleSuggestions } from "./suggestions.ts";
import { io, handleDeparture, broadcastPresence, socketsIn } from "./hub.ts";
import { holdGroup } from "./held-groups.ts";
import { roleFor, effectiveRole, classroomOf } from "./modes.ts";
import { announceSettled } from "./suggestion-events.ts";

// What the REST API calls so open boards react at once: access, details, restores, comments, notifications, deletion.

// Hooks used by the REST API so open boards react to changes immediately.

type BoardDetails = Parameters<typeof serializeMeta>[0];

// only members see email addresses
export function notifyMetaChanged(board: BoardDetails) {
  for (const socket of socketsIn(board.id)) {
    socket.emit("board:meta", serializeMeta(board, { redact: !isMemberRole(socket.data.role) }));
  }
}

// Re-checks everyone with the board open after an access change: drops those who lost access, re-roles the rest.
export async function syncAccess(board: BoardDetails) {
  if (!io) return;
  let dropped = false;
  for (const socket of socketsIn(board.id)) {
    const userId = socket.data.user?.id ?? null;
    const role = roleFor(socket, roleOf(board, userId, socket.data.pass));
    if (!role) {
      // names the link's password or expiry, so the person can give the password or knows why
      const locked = (board.linkAccess !== "restricted" && linkLock(board, userId, socket.data.pass)) || undefined;
      socket.emit("board:revoked", { boardId: board.id, ...(locked && { locked }) });
      socket.leave(board.id);
      socket.data.boardId = null;
      holdGroup(socket, null);
      dropped = true;
    } else {
      socket.data.boardRole = role;
      const session = getSession(board.id);
      const effective = effectiveRole(socket, session);
      if (effective !== socket.data.role) {
        socket.data.role = effective;
        socket.emit("board:role", { boardId: board.id, role: effective! });
      }
      // invited or not, they may have become a student in classroom mode, or stopped being one
      if (session?.classroom) socket.emit("classroom", { boardId: board.id, classroom: classroomOf(session, socket) });
    }
  }
  if (dropped) await handleDeparture(board.id);
  notifyMetaChanged(board);
}

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
// setTimeout can't wait longer than this; a later expiry is watched once someone joins nearer the time.
const LONGEST_TIMER_MS = 2 ** 31 - 1;

// Drops people who opened by the link when it expires (see syncAccess), not at their next reconnect. Called when the
// expiry is set and on join.
export function watchLinkExpiry(board: { id: string; linkExpiresAt?: Date | null }) {
  clearTimeout(expiryTimers.get(board.id));
  expiryTimers.delete(board.id);
  const wait = (board.linkExpiresAt?.getTime() ?? Infinity) - Date.now();
  if (wait > LONGEST_TIMER_MS) return;
  const timer = setTimeout(
    async () => {
      expiryTimers.delete(board.id);
      try {
        const current = await Board.findOne({ _id: board.id, deletedAt: null })
          .select("-elements")
          .populate<PopulatedMembers>(populateMembers);
        if (current) await syncAccess(current);
      } catch (error) {
        console.error(`Couldn't close an expired link: ${(error as Error).message}`);
      }
    },
    Math.max(0, wait) + 100,
  );
  timer.unref();
  expiryTimers.set(board.id, timer);
}

export async function replaceElements(boardId: string, snapshot: Element[], actor?: { name: string } | null) {
  // always through the open board, so someone opening it right now can't put the old one back
  const session = await acquireSession(boardId);
  const elements = resetSession(session, snapshot);
  io?.to(boardId).emit("board:reset", {
    boardId,
    elements,
    removed: removedStamps(session.tombstones),
    by: actor?.name ?? null,
  });
  // suggestions about elements the restore took away go; suggested additions it brought back are on the board
  if (io) announceSettled(session, settleSuggestions(session.suggestions, session));
  // with nobody on it the board is saved and released (someone opening it meanwhile keeps it open)
  if (!io?.sockets.adapter.rooms.has(boardId)) await closeSession(boardId);
  return elements;
}

// comments are shown only to signed-in people
export function emitToSignedIn(boardId: string, event: "thread:upsert", payload: Thread): void;
export function emitToSignedIn(boardId: string, event: "thread:delete", payload: ThreadRemoval): void;
export function emitToSignedIn(
  boardId: string,
  event: "thread:upsert" | "thread:delete",
  payload: Thread | ThreadRemoval,
) {
  for (const socket of socketsIn(boardId)) {
    // the overloads already match event to payload, which emit can't follow from a union
    if (socket.data.user) socket.emit(event as "thread:upsert", payload as Thread);
  }
}

export function notifyUser(userId: string, notification: NotificationItem) {
  io?.to(`user:${userId}`).emit("notification", notification);
}

export function disconnectUser(userId: string) {
  for (const socket of socketsIn(`user:${userId}`)) socket.disconnect(true);
}

export async function refreshUser(user: { id: string; toPublic(): PublicUser }) {
  const boards = new Set<string>();
  for (const socket of socketsIn(`user:${user.id}`)) {
    socket.data.user = user.toPublic();
    if (socket.data.boardId) boards.add(socket.data.boardId);
  }
  await Promise.all([...boards].map(broadcastPresence));
}

// A trashed board keeps its latest changes so it can be restored as it was.
export async function closeBoard(boardId: string, { keepChanges = false }: { keepChanges?: boolean } = {}) {
  if (!io) return;
  io.to(boardId).emit("board:deleted", { boardId });
  const sockets = await io.in(boardId).fetchSockets();
  for (const remote of sockets) {
    const socket = io.sockets.sockets.get(remote.id);
    if (socket) {
      socket.data.boardId = null;
      holdGroup(socket, null);
    }
  }
  io.in(boardId).socketsLeave(boardId);
  if (keepChanges) await closeSession(boardId);
  else discardSession(boardId);
}
