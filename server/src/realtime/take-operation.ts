import type { OpMessage, OpRefusal, OpReply, PieceGroup } from "@inkboard/shared/socket";
import type { Element, FrameElement } from "@inkboard/shared/types";
import { effectOf, planOperation } from "@inkboard/shared/board-merge";
import { canEdit } from "../services/boards.ts";
import type { Role } from "../services/boards.ts";
import { outsideZone } from "./classroom.ts";
import { holdPiece, isOversized, mergedTyping, prepareOperation, sanitizeOperation } from "./operations.ts";
import type { GroupError, RawOperation } from "./operations.ts";
import { acquireSession, admit, closeSession, getSession, holdSession, updateSession } from "./sessions.ts";
import type { Session } from "./sessions.ts";
import { settleSuggestions } from "./suggestions.ts";
import type { RealtimeSocket, SocketLimits } from "./types.ts";
import { io, personOf, isOnBoard } from "./hub.ts";
import { holdGroup } from "./held-groups.ts";
import { ROOM_REFRESH_MS, ownerEntry, lookUpRoom, ownerRoom } from "./owner-room.ts";
import { watchRemovals } from "./link-alerts.ts";
import { zoneIn } from "./modes.ts";
import { announceSettled } from "./suggestion-events.ts";

// Taking a change in: the replies, the checks, the merge, and who hears of it (a browser, or the public API).

// older browsers (open during an update) look for `tooLarge` and `readOnly`
const TOO_LARGE: OpRefusal = { ok: false, reason: "tooLarge", tooLarge: true };
const FORBIDDEN: OpRefusal = { ok: false, reason: "forbidden", readOnly: true };
// "expired": the server dropped the rest of the group, so the sender resends the whole change (see holdPiece)
const GROUP_REFUSED: Record<GroupError, OpRefusal> = {
  invalid: { ok: false, reason: "invalid" },
  tooLarge: TOO_LARGE,
  expired: { ok: false, reason: "expired" },
};

// `tooLarge` is for older browsers, which don't know "ownerFull" and would resend forever: they undo the change
const OWNER_FULL: OpRefusal = { ok: false, reason: "ownerFull", tooLarge: true };

// Where a change comes from: a browser on the board, or the public API (see applyOperation).
interface Sender {
  boardId: string;
  legacy?: boolean | undefined;
  // classroom mode: the student's frame (null: none); `whole` refuses the whole change if any of it is outside
  zone?: FrameElement | null | undefined;
  whole?: boolean;
  broadcast: (message: OpMessage) => void;
  present: () => boolean;
  // told how many elements were removed, and the board before, for senders who came through the link
  removed?: (count: number, before: Element[]) => void;
}

function socketSender(socket: RealtimeSocket): Sender {
  const boardId = socket.data.boardId!;
  return {
    boardId,
    legacy: socket.data.legacy,
    broadcast: (message) => socket.to(boardId).emit("board:op", message),
    present: () => socket.data.boardId === boardId,
    zone: (() => {
      const session = getSession(boardId);
      return session && zoneIn(session, personOf(socket).userId, socket.data.boardRole);
    })(),
    ...(socket.data.role === "contributor" && {
      removed: (count: number, before: Element[]) => {
        const session = getSession(boardId);
        if (session && !session.classroom?.on) watchRemovals(session, count, before);
      },
    }),
  };
}

// `refresh`: a refusal for lack of space may first be checked against a newer figure; that lookup is the only wait,
// after which the change is planned again from the board as it then is.
function takeOperation(
  sender: Sender,
  session: Session,
  operation: RawOperation | null | undefined,
  reply: (reply: OpReply) => void,
  refresh: boolean,
) {
  const { boardId } = sender;
  if (isOversized(operation)) return reply(TOO_LARGE);
  const sanitized = sanitizeOperation(operation);
  if (!sanitized) return reply({ ok: false, reason: "invalid" });
  let op = prepareOperation(session.elements, sanitized, session.tombstones, {
    legacy: sender.legacy,
    index: session.index,
  });
  let plan = planOperation(session.elements, op, session.tombstones, { index: session.index, remember: false });
  // classroom mode: what a student would change outside their frame is left out, and they're told
  const outside =
    sender.zone === undefined
      ? null
      : outsideZone(plan, (id) => session.index.get(id) ?? session.tombstones.get(id)?.element, sender.zone);
  if (outside && outside.upsert.length + outside.remove.length > 0) {
    if (sender.whole) return reply({ ok: false, reason: "outside" });
    const skipped = new Set([...outside.upsert, ...outside.remove]);
    op = {
      ...op,
      upsert: op.upsert.filter((element) => !skipped.has(element.id)),
      remove: op.remove.filter((removal) => !skipped.has(removal.id)),
    };
    plan = planOperation(session.elements, op, session.tombstones, { index: session.index, remember: false });
  }
  // edits that newer ones already replaced are left out; the rest go out as the server now has them, merged
  const effect = effectOf(plan);
  const before = session.bytes;
  const room = ownerRoom(session);
  const refused = admit(
    session,
    { upsert: [...plan.shown.values()], remove: effect.remove },
    [...plan.buried.values()],
    room,
  );
  // refused for the owner's room only when it's a figure, which a board without an owner never has
  if (refused === "owner" && refresh && Date.now() - ownerEntry(session.owner!).at > ROOM_REFRESH_MS) {
    lookUpRoom(session.owner!).then(() => {
      // nothing is taken for a socket that left, or a board that closed, meanwhile
      if (sender.present() && getSession(boardId) === session) {
        takeOperation(sender, session, operation, reply, false);
      } else reply({ ok: false, reason: "noSession" });
    });
    return;
  }
  if (refused) return reply(refused === "owner" ? OWNER_FULL : TOO_LARGE);
  // a finite room is the figure ownerRoom read from the owner's entry
  if (Number.isFinite(room)) ownerEntry(session.owner!).room! -= Math.max(0, session.bytes - before);

  const board = session.elements; // as it was before this change
  const dropped = new Set(updateSession(session, plan));
  if (effect.remove.length > 0) sender.removed?.(effect.remove.length, board);
  if (dropped.size > 0) effect.upsert = effect.upsert.filter((element) => !dropped.has(element.id));
  if (effect.upsert.length > 0 || effect.remove.length > 0) {
    sender.broadcast({ boardId, op: effect });
    // a suggested element now on the board was accepted; suggestions about removed elements go too
    const touched = [...effect.upsert.map((element) => element.id), ...effect.remove.map((removal) => removal.id)];
    announceSettled(session, settleSuggestions(session.suggestions, session, touched));
  }

  // the sender drew these on its own screen, so it's told where the board differs, its typing merged with others'
  const typed = mergedTyping(op.upsert, (id) => session.index.get(id));
  const merged = new Set(typed.map((element) => element.id));
  const cleaned = [...sanitized.changed.filter((element) => !merged.has(element.id)), ...typed];
  for (const id of [...sanitized.refused, ...(outside?.upsert ?? [])]) {
    const stored = session.index.get(id);
    if (stored) cleaned.push(stored);
    else dropped.add(id);
  }
  // what a student removed outside their frame is still on the board
  const restored = (outside?.remove ?? []).flatMap((id) => session.index.get(id) ?? []);
  reply({
    ok: true,
    ...(cleaned.length > 0 ? { cleaned } : {}),
    ...(dropped.size > 0 ? { dropped: [...dropped] } : {}),
    ...(restored.length > 0 ? { restored } : {}),
    ...(outside && outside.upsert.length + outside.remove.length > 0 ? { outside: true as const } : {}),
  });
}

// Takes a change from outside a browser (the public API): opens the board as a join does, and saves and releases it if
// nobody else has it open. Resolves to the reply a browser would get, and the session.
export async function applyOperation(
  boardId: string,
  operation: RawOperation,
  writer: { userId: string; role: Role | null },
) {
  let session: Session;
  do session = await acquireSession(boardId);
  while (!holdSession(session)); // closed, and saved, since: open it again
  const sender: Sender = {
    boardId,
    broadcast: (message) => io.to(boardId).emit("board:op", message),
    present: () => true,
    // classroom mode: a student's change is taken whole, inside their frame, or not at all
    zone: zoneIn(session, writer.userId, writer.role),
    whole: true,
  };
  const reply = await new Promise<OpReply>((resolve) => takeOperation(sender, session, operation, resolve, true));
  if (!io.sockets.adapter.rooms.get(boardId)?.size) await closeSession(boardId);
  return { reply, session };
}

export function registerOperations(socket: RealtimeSocket, limits: SocketLimits) {
  socket.on("board:op", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!limits.op()) return reply({ ok: false, reason: "rate" });
    const session = isOnBoard(socket, payload?.boardId) ? getSession(socket.data.boardId!) : null;
    if (!session) return reply({ ok: false, reason: "noSession" });
    if (!canEdit(socket.data.role)) return reply(FORBIDDEN);
    // the op is unchecked: takeOperation sanitizes it
    let operation = payload!.op as RawOperation | null | undefined;
    if (payload!.group !== undefined) {
      // one piece of a change sent in several: nothing is taken in until the last arrives (holdPiece checks the label)
      const piece = holdPiece(
        socket.data.heldGroup,
        payload!.group as PieceGroup | null | undefined,
        payload!.op as RawOperation | null | undefined,
      );
      if (!holdGroup(socket, piece.held)) return reply({ ok: false, reason: "rate" });
      if (piece.error) return reply(GROUP_REFUSED[piece.error] ?? GROUP_REFUSED.invalid);
      if (!piece.op) return reply({ ok: true });
      operation = piece.op;
    }
    takeOperation(socketSender(socket), session, operation, reply, true);
  });
}
