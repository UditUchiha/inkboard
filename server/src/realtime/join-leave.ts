import type { JoinPayload, JoinReply } from "@inkboard/shared/socket";
import { keyedQueue } from "../lib/keyed-queue.ts";
import {
  findBoardForViewing,
  isMemberRole,
  LinkLockedError,
  recordOpen,
  rememberUnlock,
  roleOf,
  serializeBoard,
} from "../services/boards.ts";
import { warnOwner } from "../services/notifications.ts";
import { countdownAt } from "./countdown.ts";
import { noteVisitor } from "./link-watch.ts";
import { SYNC_FORMAT } from "./operations.ts";
import { votingFor } from "./voting.ts";
import { acquireSession, getSession, holdSession, removedStamps } from "./sessions.ts";
import { suggestionList } from "./suggestions.ts";
import type { Untrusted, RealtimeSocket } from "./types.ts";
import { personOf, handleDeparture, broadcastPresence } from "./hub.ts";
import { holdGroup } from "./held-groups.ts";
import { openOwner } from "./owner-room.ts";
import { watchOf, VISITORS_WARNING } from "./link-alerts.ts";
import { roleFor, effectiveRole, classroomOf, privateModeFor, showsSuggestion } from "./modes.ts";
import { watchLinkExpiry } from "./hooks.ts";

// Joining and leaving a board, run one at a time per connection.

// the database and services throw HttpErrors, which carry a status
type Failure = Error & { status?: number };

// join and leave run one at a time per connection, so a quick join, leave, join can't leave a socket in two rooms
const turns = keyedQueue();

async function joinBoard(socket: RealtimeSocket, payload: Untrusted<JoinPayload>, ack?: (reply: JoinReply) => void) {
  const reply = typeof ack === "function" ? ack : () => {};
  const requestedId = String(payload?.boardId ?? "");
  try {
    const userId = socket.data.user?.id ?? null;
    const pass = typeof payload?.pass === "string" ? payload.pass.slice(0, 200) : undefined;
    const board = await findBoardForViewing(requestedId, userId, { pass });
    // The database's id: the request may spell it differently (upper case hex), and a board must have one session and
    // room
    // however it was asked for, or two people would save over each other and events would miss some.
    const boardId = board.id;
    // joining the board it's already on only refreshes it; otherwise leave first, so the elements read include what it
    // just did
    if (socket.data.boardId !== boardId) await leaveBoard(socket);
    // before the socket is on the board: changes aren't queued behind a join, so one sent meanwhile is checked against
    // this role
    socket.data.embed = payload?.embed === true;
    socket.data.boardRole = roleFor(socket, roleOf(board, userId, pass));
    socket.data.role = effectiveRole(socket, getSession(boardId));
    socket.data.pass = pass;
    // older browsers merge by older rules (see prepareOperation)
    socket.data.legacy = payload?.sync !== SYNC_FORMAT;
    socket.data.presenting = payload?.presenting === true;
    const session = await enterBoard(socket, boardId, requestedId);
    socket.data.role = effectiveRole(socket, session); // the board may have been opened just now, in private mode
    // many edit-link visitors may mean the link spread further than meant, so the owner is told (not in classroom mode,
    // where the link goes to a whole class)
    if (
      socket.data.boardRole === "contributor" &&
      !session.classroom?.on &&
      noteVisitor(watchOf(session), personOf(socket).userId)
    ) {
      warnOwner(boardId, "visitors", VISITORS_WARNING).catch((error: unknown) => console.error(error));
    }
    await openOwner(session); // looked up now, so it's known by the time they draw
    watchLinkExpiry(board);
    if (userId && !socket.data.embed) recordOpen(userId, boardId); // a board seen on another site isn't "opened"
    // they gave the password as a guest and have since logged in: they no longer need the pass
    if (userId && board.linkKey && !isMemberRole(socket.data.role)) await rememberUnlock(board, userId);

    // with the stamps of recently removed elements, so a change to one still on its way can't bring it back here
    reply({
      ok: true,
      board: serializeBoard(board, userId, session.elements, undefined, socket.data.role!),
      removed: removedStamps(session.tombstones),
      suggestions: suggestionList(session.suggestions).filter(showsSuggestion(session, socket)),
      countdown: countdownAt(session.countdown, Date.now()),
      privateMode: privateModeFor(session, socket),
      classroom: classroomOf(session, socket),
    });
    // a voting round under way, sent after the reply (which clears any this browser had)
    if (session.voting) socket.emit("voting", { boardId, voting: votingFor(session.voting, personOf(socket).userId) });
    await broadcastPresence(boardId);
  } catch (error) {
    if (!(error as Failure).status) console.error(error);
    reply({
      ok: false,
      status: (error as Failure).status ?? 500,
      error: (error as Failure).status ? (error as Failure).message : "This board couldn't be opened. Try again.",
      // a link needing a password, or expired, says which
      ...(error instanceof LinkLockedError && { locked: error.locked }),
    });
  }
}

// Joins the room and returns the open session, in one turn so it can't close in between. `requestedId` is the
// spelling the socket may keep using.
async function enterBoard(socket: RealtimeSocket, boardId: string, requestedId: string) {
  for (;;) {
    const session = await acquireSession(boardId);
    if (!holdSession(session)) continue; // it was closed, and saved, since: open it again
    socket.join(boardId);
    socket.data.boardId = boardId;
    socket.data.requestedId = requestedId;
    return session;
  }
}

async function leaveBoard(socket: RealtimeSocket) {
  holdGroup(socket, null);
  const boardId = socket.data.boardId;
  if (!boardId) return;
  socket.leave(boardId);
  socket.data.boardId = null;
  await handleDeparture(boardId);
}

export function registerJoinLeave(socket: RealtimeSocket) {
  const inTurn = (task: () => Promise<void>) => turns(socket.id, task).catch((error: unknown) => console.error(error));

  socket.on("board:join", (payload, ack) => inTurn(() => joinBoard(socket, payload, ack)));
  socket.on("board:leave", () => inTurn(() => leaveBoard(socket)));

  // in turn too: a join still under way may put the socket in a room after it went
  socket.on("disconnect", () => inTurn(() => leaveBoard(socket)));
}
