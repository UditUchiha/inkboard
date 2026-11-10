import type { Classroom, PrivateMode } from "@inkboard/shared/socket";
import type { Suggestion } from "@inkboard/shared/suggestions";
import { canEdit, isMemberRole } from "../services/boards.ts";
import type { Role } from "../services/boards.ts";
import { classroomFor, nextClassroom, zoneOf } from "./classroom.ts";
import { countdownAt, nextCountdown } from "./countdown.ts";
import { nextVoting, votingFor } from "./voting.ts";
import { getSession, markFacilitationDirty } from "./sessions.ts";
import type { Session } from "./sessions.ts";
import { sameAuthor, suggestionList } from "./suggestions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { io, personOf, socketsIn } from "./hub.ts";

// Roles under embeds, private mode and classroom mode, and the events that run voting, the timer, private mode and
// classroom mode.

// an embed only views, even on an edit link
export const roleFor = (socket: Pick<RealtimeSocket, "data">, role: Role | null): Role | null =>
  role && socket.data.embed ? "viewer" : role;

// Private mode: everyone who could edit, bar whoever turned it on, suggests instead, and their suggestions go only to
// themselves until it's turned off.
export function effectiveRole(socket: Pick<RealtimeSocket, "data">, session: Session | undefined): Role | null {
  const role = socket.data.boardRole ?? null;
  const by = session?.privateMode?.by;
  return by && canEdit(role) && personOf(socket).userId !== by ? "suggester" : role;
}

// Classroom mode (see classroom.ts): a student is an editor who isn't a member, limited to the frame they claimed.
export const isStudent = (role: Role | null | undefined) => canEdit(role ?? null) && !isMemberRole(role ?? null);
export const frameIn = (session: Session) => (id: string) => {
  const element = session.index.get(id);
  return element?.type === "frame" ? element : undefined;
};
const restrictedIn = (session: Session, role: Role | null | undefined) =>
  Boolean(session.classroom?.on) && isStudent(role);
export const classroomOf = (session: Session, socket: Pick<RealtimeSocket, "data">): Classroom | null =>
  classroomFor(session.classroom, personOf(socket).userId, restrictedIn(session, socket.data.boardRole), (id) =>
    Boolean(frameIn(session)(id)),
  );
export const zoneIn = (session: Session, userId: string, role: Role | null | undefined) =>
  zoneOf(session.classroom, userId, restrictedIn(session, role), frameIn(session));

export function announceClassroom(session: Session) {
  markFacilitationDirty(session);
  for (const socket of socketsIn(session.boardId)) {
    socket.emit("classroom", { boardId: session.boardId, classroom: classroomOf(session, socket) });
  }
}

export const privateModeFor = (session: Session, socket: Pick<RealtimeSocket, "data">): PrivateMode | null =>
  session.privateMode && { by: session.privateMode.name, canEnd: isMemberRole(socket.data.boardRole ?? null) };

// in private mode only its author is shown a suggestion
export const showsSuggestion = (session: Session, socket: Pick<RealtimeSocket, "data">) => (suggestion: Suggestion) =>
  !session.privateMode || sameAuthor(suggestion.author, personOf(socket));

export function registerModes(socket: RealtimeSocket, limits: SocketLimits) {
  // Dot voting (see voting.ts): anyone votes, editors run the round, and each person sees only their own votes while
  // it's open.
  socket.on("vote", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || socket.data.embed || !limits.vote()) return;
    const session = getSession(boardId);
    if (!session) return;
    const next = nextVoting(session.voting, payload, {
      id: personOf(socket).userId,
      canRun: canEdit(socket.data.role),
      typeOf: (id) => session.index.get(id)?.type,
    });
    if (next === undefined) return;
    session.voting = next;
    markFacilitationDirty(session);
    for (const other of socketsIn(boardId)) {
      other.emit("voting", { boardId, voting: votingFor(next, personOf(other).userId) });
    }
  });

  // the board's timer (see countdown.ts): editors set it, everyone is told
  socket.on("countdown", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.countdown() || !canEdit(socket.data.role)) return;
    const session = getSession(boardId);
    if (!session) return;
    const now = Date.now();
    const next = nextCountdown(session.countdown, payload, now);
    if (next === undefined) return;
    session.countdown = next;
    markFacilitationDirty(session);
    io.to(boardId).emit("countdown", { boardId, countdown: countdownAt(next, now) });
  });

  // Private mode: a member (owner or invited editor, not an edit-link guest) turns it on or off. On: the other editors
  // become suggesters and rejoin as such. Off: they're editors again and everyone sees every suggestion.
  socket.on("private", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.privateMode() || !isMemberRole(socket.data.boardRole ?? null)) return;
    const session = getSession(boardId);
    const on = payload?.on === true;
    if (!session || on === Boolean(session.privateMode)) return;
    const { userId, name } = personOf(socket);
    session.privateMode = on ? { by: userId, name } : null;
    markFacilitationDirty(session);
    for (const other of socketsIn(boardId)) {
      const role = effectiveRole(other, session);
      if (role !== other.data.role) {
        other.data.role = role;
        other.emit("board:role", { boardId, role: role! });
      }
      other.emit("private", { boardId, privateMode: privateModeFor(session, other) });
    }
    if (!on) io.to(boardId).emit("suggestion:upsert", { boardId, suggestions: suggestionList(session.suggestions) });
  });

  // Classroom mode (see classroom.ts): members start and stop it and free frames; a student claims an empty frame, and
  // a frame two students reach for at once goes to the first (the reply says whether it was done).
  socket.on("classroom", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    const session = boardId && !socket.data.embed && limits.classroom() ? getSession(boardId) : undefined;
    if (!session) return reply({ ok: false });
    const { userId, name } = personOf(socket);
    const next = nextClassroom(session.classroom, payload, {
      id: userId,
      name,
      member: isMemberRole(socket.data.boardRole ?? null),
      student: isStudent(socket.data.boardRole),
      isFrame: (id) => Boolean(frameIn(session)(id)),
    });
    if (next === undefined) return reply({ ok: false });
    session.classroom = next;
    announceClassroom(session);
    reply({ ok: true });
  });
}
